import { describe, expect, it } from "vitest";
import {
  buildSplitDiffRows,
  diffAnchorMatchesPath,
  diffFileAnchor,
  diffLineAnchor,
  diffWordSegments,
  parseDiffPatch
} from "../client/diff-parser";

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
  });

  it("detects binary patches", () => {
    expect(parseDiffPatch("Binary files a/image.png and b/image.png differ").binary).toBe(true);
  });
});
