import { describe, expect, it } from "vitest";
import { extractImportantDiffReferences } from "../server/services/important-diff-references";

describe("important diff references", () => {
  it("selects the first substantive added line for each changed file", () => {
    const references = extractImportantDiffReferences([
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -2,2 +2,4 @@",
      " unchanged",
      "+",
      "+export const answer = 42;",
      " old",
      "diff --git a/docs/old.md b/docs/old.md",
      "--- a/docs/old.md",
      "+++ /dev/null",
      "@@ -7,2 +0,0 @@",
      "-obsolete",
      "-content"
    ].join("\n"));

    expect(references).toEqual([
      { path: "src/a.ts", side: "R", line: 4, kind: "addition" },
      { path: "docs/old.md", side: "L", line: 7, kind: "deletion" }
    ]);
  });

  it("ignores metadata-only patches and enforces the reference limit", () => {
    const patch = [1, 2, 3].map((index) => [
      `diff --git a/file-${index}.txt b/file-${index}.txt`,
      `--- a/file-${index}.txt`,
      `+++ b/file-${index}.txt`,
      "@@ -0,0 +1 @@",
      `+value ${index}`
    ].join("\n")).join("\n");

    expect(extractImportantDiffReferences(patch, 2).map((item) => item.path)).toEqual([
      "file-1.txt",
      "file-2.txt"
    ]);
    expect(extractImportantDiffReferences("diff --git a/logo.png b/logo.png\nBinary files differ")).toEqual([]);
  });
});
