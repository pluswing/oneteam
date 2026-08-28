import { describe, expect, it } from "vitest";
import { extractAgentRunResult } from "../server/agents/codex-adapter";

describe("provider adapter guardrails", () => {
  it("normalizes a valid structured stop result", () => {
    expect(extractAgentRunResult(JSON.stringify({
      status: "succeeded",
      message: "Completed safely.",
      metadata: null
    }), "Test provider")).toMatchObject({
      status: "succeeded",
      stopReason: "passed",
      metadata: {
        adapterValidation: {
          hook: "stop",
          provider: "Test provider",
          passed: true,
          problems: []
        }
      }
    });
  });

  it("moves an unstructured provider response to a human gate", () => {
    const result = extractAgentRunResult("I think the work is done.", "Test provider");
    expect(result).toMatchObject({
      status: "waiting_human",
      stopReason: "waiting_human",
      metadata: { adapterValidation: { passed: false } }
    });
    expect(result.evidence?.[0]?.type).toBe("adapter_validation");
  });

  it("blocks contradictory command evidence and unsafe changed file paths", () => {
    const result = extractAgentRunResult(JSON.stringify({
      status: "succeeded",
      message: "Everything passed.",
      stopReason: "passed",
      changedFiles: ["../outside.txt"],
      testResults: [{ command: "npm test", status: "passed", exitCode: 1, output: "failed" }]
    }), "Test provider");

    expect(result.status).toBe("waiting_human");
    expect(result.message).toContain("non-zero exit code");
    expect(result.message).toContain("repository-relative");
    expect(result.metadata?.nextLabel).toBeNull();
  });
});
