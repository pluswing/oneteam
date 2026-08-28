import { describe, expect, it } from "vitest";
import {
  canTransitionWorkflowStage,
  expectedAgentForWorkflowStage,
  workflowStageAfterResult,
  workflowStageForLabel
} from "../server/services/objective-workflow";
import type { AgentJobDto } from "../shared/types";

function job(agentType: AgentJobDto["agentType"]): AgentJobDto {
  return {
    id: 1,
    projectId: "project",
    aiProvider: "codex",
    aiModel: null,
    agentType,
    targetType: "pull_request",
    targetId: 1,
    status: "running",
    triggerType: "label_transition",
    parentJobId: null,
    input: {},
    output: null,
    error: null,
    attempt: 1,
    lockKey: null,
    waitReason: null,
    waitMetadata: null,
    nextRetryAt: null,
    createdAt: "2026-08-28T00:00:00.000Z",
    startedAt: "2026-08-28T00:00:00.000Z",
    finishedAt: null
  };
}

describe("objective workflow stages", () => {
  it("maps workflow labels to durable stages and expected agents", () => {
    expect(workflowStageForLabel("ready-for-implementation")).toBe("implementation");
    expect(workflowStageForLabel("reviewing")).toBe("review");
    expect(workflowStageForLabel("fixing")).toBe("fix");
    expect(workflowStageForLabel("testing")).toBe("qa");
    expect(workflowStageForLabel("done")).toBe("verification");
    expect(workflowStageForLabel("ready-to-merge")).toBe("ready_to_merge");
    expect(expectedAgentForWorkflowStage("verification")).toBe("verifier");
    expect(expectedAgentForWorkflowStage("merged")).toBeNull();
    expect(canTransitionWorkflowStage("review", "fix")).toBe(true);
    expect(canTransitionWorkflowStage("requirements", "qa")).toBe(false);
  });

  it("advances review, QA, and verifier results deterministically", () => {
    expect(workflowStageAfterResult(job("review"), {
      status: "succeeded",
      message: "Changes requested.",
      metadata: { nextLabel: "fixing" }
    }, "review")).toBe("fix");
    expect(workflowStageAfterResult(job("qa"), {
      status: "succeeded",
      message: "QA passed.",
      metadata: { nextLabel: "done" }
    }, "qa")).toBe("verification");
    expect(workflowStageAfterResult(job("verifier"), {
      status: "succeeded",
      message: "Verified.",
      metadata: { verifier: { verdict: "passed", stopConditionMet: true } }
    }, "verification")).toBe("ready_to_merge");
  });
});
