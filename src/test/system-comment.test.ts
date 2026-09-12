import { describe, expect, it } from "vitest";
import { buildSystemComment, markdownCode } from "../server/services/system-comment";

describe("system comment", () => {
  it("renders a durable outcome-first Markdown artifact", () => {
    const comment = buildSystemComment({
      title: "Automatic merge paused",
      outcome: "blocked",
      summary: "A required verification command failed.",
      fields: [
        { label: "Pull request", value: "#42", code: true },
        { label: "Reason", value: "test | build" }
      ],
      sections: [
        { title: "Evidence", items: ["[FAIL] `npm test` — exit 1"] },
        null
      ],
      nextStep: "Fix the failing test and run the verifier again.",
      recordedAt: new Date("2026-08-28T01:02:03.000Z")
    });

    expect(comment.startsWith("## Automatic merge paused\n\n> **Outcome · BLOCKED**")).toBe(true);
    expect(comment).toContain("| Pull request | `#42` |");
    expect(comment).toContain("| Reason | test \\| build |");
    expect(comment).toContain("### Evidence\n\n- [FAIL] `npm test` — exit 1");
    expect(comment).toContain("### Next step\n\nFix the failing test");
    expect(comment).toContain("_Recorded by OneTeam at `2026-08-28T01:02:03.000Z`._");
  });

  it("uses a safe inline-code fence for values containing backticks", () => {
    expect(markdownCode("a`b")).toBe("``a`b``");
  });
});
