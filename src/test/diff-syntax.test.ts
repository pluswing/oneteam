import { describe, expect, it } from "vitest";
import { highlightDiffSyntax, syntaxLanguageForPath } from "../client/diff-syntax";

describe("diff syntax highlighting", () => {
  it("selects a language from common repository paths", () => {
    expect(syntaxLanguageForPath("src/client/App.tsx")).toBe("javascript");
    expect(syntaxLanguageForPath("scripts/release.py")).toBe("python");
    expect(syntaxLanguageForPath("Dockerfile")).toBe("shell");
    expect(syntaxLanguageForPath("docs/README.md")).toBe("markdown");
    expect(syntaxLanguageForPath("assets/image.bin")).toBe("plain");
  });

  it("tokenizes TypeScript without changing source content", () => {
    const content = 'const answer: number = 42; // verified';
    const tokens = highlightDiffSyntax("example.ts", content);

    expect(tokens.map((token) => token.value).join("")).toBe(content);
    expect(tokens).toContainEqual({ kind: "keyword", value: "const" });
    expect(tokens).toContainEqual({ kind: "number", value: "42" });
    expect(tokens).toContainEqual({ kind: "comment", value: "// verified" });
  });

  it("recognizes Markdown structure and inline code", () => {
    const heading = highlightDiffSyntax("README.md", "## Verification");
    const item = highlightDiffSyntax("README.md", "- Run `npm test`");

    expect(heading[0]).toEqual({ kind: "heading", value: "## " });
    expect(item).toContainEqual({ kind: "heading", value: "- " });
    expect(item).toContainEqual({ kind: "string", value: "`npm test`" });
  });

  it("leaves unsupported file types as plain text", () => {
    expect(highlightDiffSyntax("fixture.unknown", "const value = 1")).toEqual([
      { kind: "plain", value: "const value = 1" }
    ]);
  });
});
