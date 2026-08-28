import { describe, expect, it } from "vitest";
import { buildAgentMilestoneComment } from "../server/services/agent-milestone-comment";
import { diffLineAnchor } from "../shared/diff-anchors";
import type { AgentJobDto } from "../shared/types";

describe("agent milestone comment", () => {
  it("builds an outcome-first review artifact with finding deep links", () => {
    const job = fakeJob("review");
    const comment = buildAgentMilestoneComment(
      job,
      {
        status: "succeeded",
        message: "Review found one blocking issue.",
        stopReason: "passed",
        comment: {
          targetType: "pull_request",
          targetId: 7,
          body: "The input path bypasses validation.",
          bodyFormat: "markdown"
        },
        evidence: [{ type: "test", title: "Focused test", summary: "Reproduced the invalid save." }],
        metadata: {
          nextLabel: "fixing",
          providerExecution: { model: "gpt-test", sessionId: "thread-1" },
          review: {
            verdict: "changes_requested",
            findings: [
              {
                severity: "high",
                path: "src/form.ts",
                line: 42,
                side: "right",
                title: "Missing validation",
                body: "Reject an empty value."
              }
            ],
            checked: ["requirements", "tests"]
          }
        }
      },
      new Date("2026-08-28T02:00:00.000Z")
    );

    expect(comment).toContain("## review completed");
    expect(comment).toContain("> **Outcome · BLOCKED**");
    expect(comment).toContain("| Model | `gpt-test` |");
    expect(comment).toContain("### Agent summary\n\nThe input path bypasses validation.");
    expect(comment).toContain("### Evidence");
    expect(comment).toContain(`/pulls/7#${diffLineAnchor("src/form.ts", "R", 42)}`);
    expect(comment).toContain("OneTeam will continue the workflow using the `fixing` state.");
    expect(comment).toContain("Recorded by review Agent via OneTeam");
  });

  it("renders human questions and resume guidance", () => {
    const comment = buildAgentMilestoneComment(
      fakeJob("requirements"),
      {
        status: "waiting_human",
        message: "A product decision is required.",
        stopReason: "waiting_human",
        questions: ["Should archived users retain access?"]
      },
      new Date("2026-08-28T02:00:00.000Z")
    );

    expect(comment).toContain("> **Outcome · WAITING**");
    expect(comment).toContain("### Questions\n\n- Should archived users retain access?");
    expect(comment).toContain("resume it after the response is recorded");
  });
});

function fakeJob(agentType: AgentJobDto["agentType"]): AgentJobDto {
  return {
    id: 9,
    projectId: "project-1",
    aiProvider: "codex",
    agentType,
    targetType: "pull_request",
    targetId: 7,
    status: "running",
    triggerType: "automatic",
    parentJobId: null,
    input: {},
    output: null,
    error: null,
    attempt: 1,
    lockKey: null,
    waitReason: null,
    waitMetadata: null,
    nextRetryAt: null,
    createdAt: "2026-08-28T01:00:00.000Z",
    startedAt: "2026-08-28T01:00:00.000Z",
    finishedAt: null
  };
}
