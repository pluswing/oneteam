import { copyFile, mkdir, open, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentEvidenceResult } from "../agents/types";
import type { AgentJobDto, ProjectDto } from "../../shared/types";

const maximumArtifactBytes = 10 * 1024 * 1024;
const imageMediaTypes = new Map([
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"]
]);

export type StoredEvidenceArtifact = {
  absolutePath: string;
  byteSize: number;
  mediaType: string;
};

export async function normalizeEvidenceArtifacts(input: {
  project: ProjectDto;
  job: AgentJobDto;
  executionRepoPath: string;
  evidence: AgentEvidenceResult[] | null | undefined;
}): Promise<AgentEvidenceResult[] | null | undefined> {
  if (!input.evidence?.length) return input.evidence;
  const normalized: AgentEvidenceResult[] = [];
  for (const [index, evidence] of input.evidence.entries()) {
    normalized.push(await normalizeEvidenceItem(input, evidence, index));
  }
  return normalized;
}

export async function readStoredEvidenceArtifact(
  project: ProjectDto,
  jobId: number,
  fileName: string
): Promise<StoredEvidenceArtifact | null> {
  if (basename(fileName) !== fileName) return null;
  const mediaType = imageMediaTypes.get(extname(fileName).toLowerCase());
  if (!mediaType) return null;
  const root = artifactRoot(project, jobId);
  const absolutePath = resolve(root, fileName);
  if (!isWithin(root, absolutePath)) return null;
  try {
    const [storedRoot, storedPath, fileStats] = await Promise.all([realpath(root), realpath(absolutePath), stat(absolutePath)]);
    if (!isWithin(storedRoot, storedPath) || !fileStats.isFile() || fileStats.size > maximumArtifactBytes) return null;
    if (!matchesImageSignature(await readHeader(storedPath), mediaType)) return null;
    return { absolutePath: storedPath, byteSize: fileStats.size, mediaType };
  } catch {
    return null;
  }
}

export function agentJobReferencesArtifact(job: AgentJobDto, fileName: string): boolean {
  const evidence = Array.isArray(job.output?.evidence) ? job.output.evidence : [];
  return evidence.some((item) => {
    const artifact = recordValue(recordValue(recordValue(item)?.payload)?.artifact);
    return artifact?.kind === "image" && artifact.status === "available" && artifact.name === fileName;
  });
}

async function normalizeEvidenceItem(
  input: {
    project: ProjectDto;
    job: AgentJobDto;
    executionRepoPath: string;
  },
  evidence: AgentEvidenceResult,
  index: number
): Promise<AgentEvidenceResult> {
  const artifact = recordValue(evidence.payload?.artifact);
  if (artifact?.kind !== "image" || typeof artifact.path !== "string") return evidence;
  const sourceName = basename(artifact.path);
  const unavailable = (reason: string): AgentEvidenceResult => ({
    ...evidence,
    payload: {
      ...evidence.payload,
      artifact: {
        kind: "image",
        status: "unavailable",
        name: sourceName || "screenshot",
        caption: typeof artifact.caption === "string" ? artifact.caption : null,
        reason
      }
    }
  });

  const mediaType = imageMediaTypes.get(extname(sourceName).toLowerCase());
  if (!mediaType) return unavailable("Only PNG, JPEG, GIF, and WebP screenshot artifacts are supported.");

  try {
    const executionRoot = await realpath(input.executionRepoPath);
    const requestedPath = isAbsolute(artifact.path)
      ? resolve(artifact.path)
      : resolve(executionRoot, artifact.path);
    const sourcePath = await realpath(requestedPath);
    if (!isWithin(executionRoot, sourcePath)) return unavailable("The screenshot path is outside the Agent workspace.");
    const fileStats = await stat(sourcePath);
    if (!fileStats.isFile()) return unavailable("The screenshot artifact is not a file.");
    if (fileStats.size > maximumArtifactBytes) return unavailable("The screenshot artifact exceeds the 10 MB limit.");
    if (!matchesImageSignature(await readHeader(sourcePath), mediaType)) return unavailable("The screenshot content does not match its image extension.");

    const safeName = `${String(index + 1).padStart(2, "0")}-${sanitizeFileName(sourceName)}`;
    const destinationRoot = artifactRoot(input.project, input.job.id);
    await mkdir(destinationRoot, { recursive: true });
    await copyFile(sourcePath, join(destinationRoot, safeName));
    return {
      ...evidence,
      payload: {
        ...evidence.payload,
        artifact: {
          kind: "image",
          status: "available",
          name: safeName,
          caption: typeof artifact.caption === "string" ? artifact.caption : null,
          mediaType,
          byteSize: fileStats.size,
          url: `/api/projects/${encodeURIComponent(input.project.id)}/agent-jobs/${input.job.id}/artifacts/${encodeURIComponent(safeName)}`
        }
      }
    };
  } catch {
    return unavailable("The screenshot artifact could not be read from the Agent workspace.");
  }
}

function artifactRoot(project: ProjectDto, jobId: number): string {
  return join(project.repoPath, ".oneteam", "data", "artifacts", `job-${jobId}`);
}

function isWithin(root: string, target: string): boolean {
  const path = relative(resolve(root), resolve(target));
  return path === "" || (!isAbsolute(path) && !path.startsWith(`..${sep}`) && path !== "..");
}

function sanitizeFileName(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || "screenshot.png";
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function matchesImageSignature(value: Uint8Array, mediaType: string): boolean {
  if (mediaType === "image/png") return value.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => value[index] === byte);
  if (mediaType === "image/jpeg") return value.length >= 3 && value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff;
  if (mediaType === "image/gif") return new TextDecoder().decode(value.subarray(0, 6)) === "GIF87a" || new TextDecoder().decode(value.subarray(0, 6)) === "GIF89a";
  if (mediaType === "image/webp") return new TextDecoder().decode(value.subarray(0, 4)) === "RIFF" && new TextDecoder().decode(value.subarray(8, 12)) === "WEBP";
  return false;
}

async function readHeader(path: string): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(12);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
