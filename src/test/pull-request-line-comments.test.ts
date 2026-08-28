import { describe, expect, it } from "vitest";
import type { CommentDto } from "../shared/types";
import {
  collectPullRequestLineComments,
  diffPatchContainsLine,
  lineCommentMetadata,
  toPullRequestLineComment
} from "../server/services/pull-request-line-comments";

function comment(metadata: Record<string, unknown> | null): CommentDto {
  return {
    id: 1,
    targetType: "pull_request",
    targetId: 2,
    authorType: "user",
    agentType: null,
    body: "Please cover this branch.",
    bodyFormat: "markdown",
    metadata,
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z"
  };
}

describe("pull request line comments", () => {
  const position = {
    path: "src/example.ts",
    line: 3,
    side: "R" as const,
    sourceCommit: "source",
    targetCommit: "target"
  };

  it("maps valid metadata and excludes ordinary comments", () => {
    const mapped = toPullRequestLineComment(comment(lineCommentMetadata(position)));

    expect(mapped).toMatchObject(position);
    expect(collectPullRequestLineComments([comment(null), comment(lineCommentMetadata(position))])).toHaveLength(1);
  });

  it("finds only lines that exist on the requested side", () => {
    const patch = [
      "diff --git a/src/example.ts b/src/example.ts",
      "@@ -1,3 +1,4 @@",
      " context",
      "-removed",
      "+added",
      "+second addition",
      " trailing"
    ].join("\n");

    expect(diffPatchContainsLine(patch, "L", 2)).toBe(true);
    expect(diffPatchContainsLine(patch, "R", 2)).toBe(true);
    expect(diffPatchContainsLine(patch, "R", 3)).toBe(true);
    expect(diffPatchContainsLine(patch, "L", 4)).toBe(false);
    expect(diffPatchContainsLine(patch, "R", 8)).toBe(false);
  });
});
