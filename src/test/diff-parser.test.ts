import { describe, expect, it } from "vitest";
import {
  buildSplitDiffRows,
  diffAnchorMatchesPath,
  diffFileAnchor,
  diffLineAnchor,
  diffWordSegments,
  limitDiffHunks,
  parseDiffLineAnchor,
  parseDiffPatch
} from "../client/diff-parser";
import { calculateDiffVirtualRange } from "../client/diff-virtualization";

describe("diff parser", () => {
  it("parses hunks and assigns old and new line numbers", () => {
    const parsed = parseDiffPatch([
      "diff --git a/example.ts b/example.ts",
      "--- a/example.ts",
      "+++ b/example.ts",
      "@@ -10,4 +10,5 @@ function example() {",
      " const stable = true;",
      "-const result = oldValue;",
      "+const result = newValue;",
      "+const added = true;",
      " return result;",
      "\\ No newline at end of file"
    ].join("\n"));

    expect(parsed.hunks).toHaveLength(1);
    expect(parsed.hunks[0].lines).toEqual([
      { kind: "context", content: "const stable = true;", oldLineNumber: 10, newLineNumber: 10 },
      { kind: "deletion", content: "const result = oldValue;", oldLineNumber: 11, newLineNumber: null },
      { kind: "addition", content: "const result = newValue;", oldLineNumber: null, newLineNumber: 11 },
      { kind: "addition", content: "const added = true;", oldLineNumber: null, newLineNumber: 12 },
      { kind: "context", content: "return result;", oldLineNumber: 12, newLineNumber: 13 },
      { kind: "meta", content: "\\ No newline at end of file", oldLineNumber: null, newLineNumber: null }
    ]);
  });

  it("pairs deletion and addition blocks for split rendering", () => {
    const lines = parseDiffPatch([
      "@@ -1,3 +1,3 @@",
      "-first old",
      "-second old",
      "+first new",
      " unchanged"
    ].join("\n")).hunks[0].lines;

    const rows = buildSplitDiffRows(lines);

    expect(rows).toHaveLength(3);
    expect(rows[0].left?.content).toBe("first old");
    expect(rows[0].right?.content).toBe("first new");
    expect(rows[1].left?.content).toBe("second old");
    expect(rows[1].right).toBeNull();
    expect(rows[2].left?.kind).toBe("context");
    expect(rows[2].right?.kind).toBe("context");
  });

  it("marks only changed tokens in modified lines", () => {
    const segments = diffWordSegments("const total = oldValue + 1;", "const total = newValue + 1;");

    expect(segments.before.filter((segment) => segment.changed).map((segment) => segment.value).join(""))
      .toBe("oldValue");
    expect(segments.after.filter((segment) => segment.changed).map((segment) => segment.value).join(""))
      .toBe("newValue");
  });

  it("creates stable file and line deep-link anchors", () => {
    const path = "src/client/example.ts";
    const fileAnchor = diffFileAnchor(path);
    const lineAnchor = diffLineAnchor(path, "R", 42);

    expect(diffAnchorMatchesPath(fileAnchor, path)).toBe(true);
    expect(diffAnchorMatchesPath(lineAnchor, path)).toBe(true);
    expect(diffAnchorMatchesPath(lineAnchor, "src/client/other.ts")).toBe(false);
    expect(parseDiffLineAnchor(lineAnchor, path)).toEqual({ side: "R", line: 42 });
    expect(parseDiffLineAnchor(fileAnchor, path)).toBeNull();
    expect(parseDiffLineAnchor(lineAnchor, "src/client/other.ts")).toBeNull();
  });

  it("detects binary patches", () => {
    expect(parseDiffPatch("Binary files a/image.png and b/image.png differ").binary).toBe(true);
  });

  it("limits rendered lines while preserving a focused line window", () => {
    const patch = [
      "@@ -1,2000 +1,2000 @@",
      ...Array.from({ length: 2000 }, (_, index) => ` line ${index + 1}`)
    ].join("\n");
    const parsed = parseDiffPatch(patch);
    const limited = limitDiffHunks(parsed.hunks, 100, { side: "R", line: 1500 });

    expect(limited.totalLines).toBe(2000);
    expect(limited.truncated).toBe(true);
    expect(limited.focusedWindowAdded).toBe(true);
    expect(limited.hunks[0].lines).toHaveLength(100);
    expect(limited.hunks[1].lines.some((line) => line.newLineNumber === 1500)).toBe(true);
    expect(limited.renderedLines).toBeLessThanOrEqual(141);
  });

  it("does not duplicate a focused line that is already visible", () => {
    const parsed = parseDiffPatch("@@ -1,3 +1,3 @@\n first\n second\n third");
    const limited = limitDiffHunks(parsed.hunks, 2, { side: "R", line: 2 });

    expect(limited.focusedWindowAdded).toBe(false);
    expect(limited.hunks).toHaveLength(1);
    expect(limited.renderedLines).toBe(2);
  });

  it("calculates bounded diff virtualization windows with overscan and spacers", () => {
    const middle = calculateDiffVirtualRange({
      itemCount: 5_000,
      scrollTop: 24_000,
      viewportHeight: 480,
      estimatedRowHeight: 24,
      overscan: 20
    });
    expect(middle).toEqual({
      start: 980,
      end: 1_040,
      beforeHeight: 23_520,
      afterHeight: 95_040
    });

    const end = calculateDiffVirtualRange({
      itemCount: 100,
      scrollTop: 10_000,
      viewportHeight: 480,
      estimatedRowHeight: 24,
      overscan: 20
    });
    expect(end.start).toBe(100);
    expect(end.end).toBe(100);
    expect(end.afterHeight).toBe(0);
  });
});
