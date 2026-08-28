import type { CommentDto, PullRequestLineCommentDto } from "../../shared/types";

export type PullRequestLineCommentPosition = Pick<
  PullRequestLineCommentDto,
  "line" | "path" | "side" | "sourceCommit" | "targetCommit"
>;

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function toPullRequestLineComment(comment: CommentDto): PullRequestLineCommentDto | null {
  const value = comment.metadata?.diffLineComment;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const metadata = value as Record<string, unknown>;
  const path = stringValue(metadata.path);
  const line = metadata.line;
  const side = metadata.side;
  const sourceCommit = stringValue(metadata.sourceCommit);
  const targetCommit = stringValue(metadata.targetCommit);
  if (
    !path ||
    typeof line !== "number" ||
    !Number.isInteger(line) ||
    line < 1 ||
    (side !== "L" && side !== "R") ||
    !sourceCommit ||
    !targetCommit
  ) {
    return null;
  }
  return { ...comment, path, line, side, sourceCommit, targetCommit };
}

export function collectPullRequestLineComments(comments: CommentDto[]): PullRequestLineCommentDto[] {
  return comments.flatMap((comment) => {
    const lineComment = toPullRequestLineComment(comment);
    return lineComment ? [lineComment] : [];
  });
}

export function diffPatchContainsLine(patch: string, side: "L" | "R", requestedLine: number): boolean {
  let oldLine: number | null = null;
  let newLine: number | null = null;
  for (const patchLine of patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(patchLine);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      continue;
    }
    if (oldLine === null || newLine === null || patchLine.startsWith("\\")) {
      continue;
    }
    if (patchLine.startsWith("+")) {
      if (side === "R" && newLine === requestedLine) return true;
      newLine += 1;
      continue;
    }
    if (patchLine.startsWith("-")) {
      if (side === "L" && oldLine === requestedLine) return true;
      oldLine += 1;
      continue;
    }
    if (patchLine.startsWith(" ")) {
      if ((side === "L" && oldLine === requestedLine) || (side === "R" && newLine === requestedLine)) return true;
      oldLine += 1;
      newLine += 1;
      continue;
    }
    oldLine = null;
    newLine = null;
  }
  return false;
}

export function lineCommentMetadata(position: PullRequestLineCommentPosition): Record<string, unknown> {
  return { diffLineComment: position };
}
