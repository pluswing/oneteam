import { diffFileAnchor, diffLineAnchor } from "../../shared/diff-anchors";
import { repositoryCommitPath } from "../../shared/repository-anchors";
import type { PullRequestDto } from "../../shared/types";
import type { Repositories } from "../db/repositories";
import { getCommits, getDiffFilePatch, getDiffFiles, getRevisionHash } from "./git-service";
import { diffPatchContainsLine } from "./pull-request-line-comments";

const maxReferences = 100;
const commitPattern = /\b[0-9a-f]{7,64}\b/gi;
const pullRequestPattern = /\b(?:PR|Pull Request)\s*#(\d+)\b|プルリクエスト\s*#(\d+)\b/gi;

export type VerifiedMarkdownReference = {
  kind: "pull_request" | "commit" | "diff_file" | "diff_line";
  source: string;
  href: string;
  resolvedValue: string;
  pullRequestId?: number;
  path?: string;
  line?: number;
  side?: "L" | "R";
};

export type VerifiedMarkdownResult = {
  body: string;
  references: VerifiedMarkdownReference[];
};

type ReferenceCandidate = VerifiedMarkdownReference & {
  start: number;
  end: number;
  codeLabel: boolean;
};

type TextRange = {
  start: number;
  end: number;
};

type InlineCodeRange = TextRange & {
  contentStart: number;
  contentEnd: number;
};

export async function verifyMarkdownReferences(
  repos: Repositories,
  input: {
    projectId: string;
    targetType: "issue" | "pull_request";
    targetId: number;
    body: string;
  }
): Promise<VerifiedMarkdownResult> {
  if (!input.body.trim()) return { body: input.body, references: [] };
  try {
    const project = await repos.projects.get(input.projectId);
    if (!project) return { body: input.body, references: [] };
    const [pullRequest, commits] = await Promise.all([
      referencePullRequest(repos, input),
      getCommits(project.repoPath, "--all", 50).catch(() => [])
    ]);
    const candidates = [
      ...(await pullRequestCandidates(repos, input.projectId, input.body)),
      ...commitCandidates(input.body, commits),
      ...(pullRequest
        ? await diffCandidates(project.repoPath, pullRequest, input.body)
        : [])
    ];
    return applyVerifiedCandidates(input.body, candidates);
  } catch {
    return { body: input.body, references: [] };
  }
}

async function referencePullRequest(
  repos: Repositories,
  input: { projectId: string; targetType: "issue" | "pull_request"; targetId: number }
): Promise<PullRequestDto | null> {
  if (input.targetType === "pull_request") {
    return repos.pullRequests.get(input.projectId, input.targetId);
  }
  const linked = await repos.pullRequests.list({
    projectId: input.projectId,
    issueId: input.targetId,
    limit: 1,
    offset: 0
  });
  return linked.items[0] ?? null;
}

async function pullRequestCandidates(
  repos: Repositories,
  projectId: string,
  body: string
): Promise<ReferenceCandidate[]> {
  const matches = Array.from(body.matchAll(pullRequestPattern)).slice(0, maxReferences);
  const ids = Array.from(new Set(matches.map((match) => Number(match[1] ?? match[2]))));
  const valid = new Set<number>();
  await Promise.all(ids.map(async (id) => {
    if (Number.isInteger(id) && id > 0 && await repos.pullRequests.get(projectId, id)) valid.add(id);
  }));
  return matches.flatMap((match) => {
    const id = Number(match[1] ?? match[2]);
    if (!valid.has(id) || match.index === undefined) return [];
    const source = match[0];
    return [{
      kind: "pull_request" as const,
      source,
      href: `/pulls/${id}`,
      resolvedValue: String(id),
      pullRequestId: id,
      start: match.index,
      end: match.index + source.length,
      codeLabel: false
    }];
  });
}

function commitCandidates(
  body: string,
  commits: Array<{ hash: string }>
): ReferenceCandidate[] {
  const hashes = commits.map((commit) => commit.hash.toLowerCase());
  return Array.from(body.matchAll(commitPattern)).slice(0, maxReferences).flatMap((match) => {
    if (match.index === undefined) return [];
    const source = match[0];
    const normalized = source.toLowerCase();
    const matching = hashes.filter((hash) => hash.startsWith(normalized));
    if (matching.length !== 1) return [];
    const fullHash = matching[0];
    const href = repositoryCommitPath(fullHash);
    if (!href) return [];
    return [{
      kind: "commit" as const,
      source,
      href,
      resolvedValue: fullHash,
      start: match.index,
      end: match.index + source.length,
      codeLabel: true
    }];
  });
}

async function diffCandidates(
  repoPath: string,
  pullRequest: PullRequestDto,
  body: string
): Promise<ReferenceCandidate[]> {
  const [sourceCommit, targetCommit] = await Promise.all([
    getRevisionHash(repoPath, pullRequest.sourceBranch),
    getRevisionHash(repoPath, pullRequest.targetBranch)
  ]);
  const files = await getDiffFiles(repoPath, sourceCommit, targetCommit);
  const pathRecords = files.flatMap((file) => [
    { sourcePath: file.path, file },
    ...(file.previousPath ? [{ sourcePath: file.previousPath, file }] : [])
  ]).sort((left, right) => right.sourcePath.length - left.sourcePath.length);
  const patchCache = new Map<string, Promise<string>>();
  const candidates: ReferenceCandidate[] = [];

  for (const { sourcePath, file } of pathRecords) {
    let offset = 0;
    while (candidates.length < maxReferences) {
      const start = body.indexOf(sourcePath, offset);
      if (start < 0) break;
      offset = start + sourcePath.length;
      if (!hasPathBoundaries(body, start, offset)) continue;
      const lineMatch = /^:(\d+)/.exec(body.slice(offset));
      if (lineMatch) {
        const line = Number(lineMatch[1]);
        const patchPromise = patchCache.get(file.path) ?? getDiffFilePatch(
          repoPath,
          sourceCommit,
          targetCommit,
          file.path,
          { contextLines: 100_000, previousPath: file.previousPath }
        );
        patchCache.set(file.path, patchPromise);
        const patch = await patchPromise;
        const side = verifiedLineSide(patch, line);
        if (!side) continue;
        const source = `${sourcePath}:${line}`;
        candidates.push({
          kind: "diff_line",
          source,
          href: `/pulls/${pullRequest.id}#${diffLineAnchor(file.path, side, line)}`,
          resolvedValue: `${file.path}:${side}:${line}`,
          pullRequestId: pullRequest.id,
          path: file.path,
          line,
          side,
          start,
          end: start + source.length,
          codeLabel: true
        });
        continue;
      }
      candidates.push({
        kind: "diff_file",
        source: sourcePath,
        href: `/pulls/${pullRequest.id}#${diffFileAnchor(file.path)}`,
        resolvedValue: file.path,
        pullRequestId: pullRequest.id,
        path: file.path,
        start,
        end: offset,
        codeLabel: true
      });
    }
    if (candidates.length >= maxReferences) break;
  }
  return candidates;
}

function verifiedLineSide(patch: string, line: number): "L" | "R" | null {
  if (!Number.isInteger(line) || line < 1) return null;
  if (diffPatchContainsLine(patch, "R", line)) return "R";
  if (diffPatchContainsLine(patch, "L", line)) return "L";
  return null;
}

function hasPathBoundaries(body: string, start: number, end: number): boolean {
  const pathCharacter = /[\p{L}\p{N}_./-]/u;
  const before = start > 0 ? body[start - 1] : "";
  const after = end < body.length ? body[end] : "";
  return (!before || !pathCharacter.test(before)) && (!after || after === ":" || !pathCharacter.test(after));
}

function applyVerifiedCandidates(body: string, rawCandidates: ReferenceCandidate[]): VerifiedMarkdownResult {
  const fences = fencedCodeRanges(body);
  const hardProtected = [
    ...fences,
    ...regexRanges(body, /!?\[[^\]\n]*\]\([^\n)]*\)/g),
    ...regexRanges(body, /https?:\/\/[^\s<>)]+/g),
    ...regexRanges(body, /<[^>\n]+>/g)
  ];
  const inlineCode = inlineCodeRanges(body, fences);
  const accepted: ReferenceCandidate[] = [];
  const sorted = [...rawCandidates].sort((left, right) => left.start - right.start || right.end - left.end);

  for (const raw of sorted) {
    if (hardProtected.some((range) => overlaps(raw, range))) continue;
    let candidate = raw;
    const codeRange = inlineCode.find((range) => overlaps(raw, range));
    if (codeRange) {
      if (raw.start !== codeRange.contentStart || raw.end !== codeRange.contentEnd) continue;
      candidate = { ...raw, start: codeRange.start, end: codeRange.end, codeLabel: true };
    }
    if (accepted.some((item) => overlaps(candidate, item))) continue;
    accepted.push(candidate);
    if (accepted.length >= maxReferences) break;
  }

  let result = body;
  for (const candidate of [...accepted].sort((left, right) => right.start - left.start)) {
    const label = candidate.codeLabel
      ? `\`${candidate.source.replaceAll("`", "'")}\``
      : escapeMarkdownLabel(candidate.source);
    result = `${result.slice(0, candidate.start)}[${label}](${candidate.href})${result.slice(candidate.end)}`;
  }
  return {
    body: result,
    references: accepted.map(toVerifiedReference)
  };
}

function toVerifiedReference(candidate: ReferenceCandidate): VerifiedMarkdownReference {
  return {
    kind: candidate.kind,
    source: candidate.source,
    href: candidate.href,
    resolvedValue: candidate.resolvedValue,
    ...(candidate.pullRequestId === undefined ? {} : { pullRequestId: candidate.pullRequestId }),
    ...(candidate.path === undefined ? {} : { path: candidate.path }),
    ...(candidate.line === undefined ? {} : { line: candidate.line }),
    ...(candidate.side === undefined ? {} : { side: candidate.side })
  };
}

function fencedCodeRanges(body: string): TextRange[] {
  const ranges: TextRange[] = [];
  const lines = body.matchAll(/.*(?:\n|$)/g);
  let open: { marker: string; start: number } | null = null;
  for (const match of lines) {
    if (!match[0] || match.index === undefined) continue;
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(match[0]);
    if (!fence) continue;
    const marker = fence[1][0];
    if (!open) {
      open = { marker, start: match.index };
    } else if (open.marker === marker) {
      ranges.push({ start: open.start, end: match.index + match[0].length });
      open = null;
    }
  }
  if (open) ranges.push({ start: open.start, end: body.length });
  return ranges;
}

function inlineCodeRanges(body: string, fences: TextRange[]): InlineCodeRange[] {
  const ranges: InlineCodeRange[] = [];
  const pattern = /(`+)([^\n]*?)\1/g;
  for (const match of body.matchAll(pattern)) {
    if (match.index === undefined || fences.some((range) => match.index! >= range.start && match.index! < range.end)) continue;
    ranges.push({
      start: match.index,
      end: match.index + match[0].length,
      contentStart: match.index + match[1].length,
      contentEnd: match.index + match[1].length + match[2].length
    });
  }
  return ranges;
}

function regexRanges(body: string, pattern: RegExp): TextRange[] {
  return Array.from(body.matchAll(pattern)).flatMap((match) => match.index === undefined
    ? []
    : [{ start: match.index, end: match.index + match[0].length }]);
}

function overlaps(left: TextRange, right: TextRange): boolean {
  return left.start < right.end && right.start < left.end;
}

function escapeMarkdownLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}
