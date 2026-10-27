import { expect, it } from "vitest";
import type { AgentExecutionDto, DevelopmentLoopDto } from "../shared/development-loop";
import type { AgentJobDto } from "../shared/types";
import { completedLoopCost, estimatedExecutionCost, observedCompletionCosts } from "../server/agents/model-economics";

const loop = { id: 1, status: "succeeded", mergeCommit: "merged" } as DevelopmentLoopDto;
const jobs = [
  { id: 1, agentType: "implementation", input: { developmentLoopId: 1 }, status: "succeeded" },
  { id: 2, agentType: "review", input: { developmentLoopId: 1 }, status: "succeeded" },
  { id: 3, agentType: "verifier", input: { developmentLoopId: 1 }, status: "succeeded", output: { metadata: { verifier: { stopConditionMet: true } } } }
].map((job) => ({ projectId: "project", aiProvider: "codex", aiModel: null, targetType: "issue", targetId: 1,
  triggerType: "test", parentJobId: null, output: null, error: null, attempt: 1, lockKey: null, waitReason: null,
  waitMetadata: null, nextRetryAt: null, createdAt: "2026-10-27", startedAt: null, finishedAt: null, ...job })) as AgentJobDto[];
const execution = (jobId: number, resolvedModel = "gpt-6.1-sol"): AgentExecutionDto => ({ jobId, resolvedModel,
  id: jobId, projectId: "project", selectedModel: resolvedModel, effort: "medium", selectionReason: "test", policyVersion: "test",
  threadId: null, turnId: null, status: "succeeded", startedAt: "2026-10-27", finishedAt: "2026-10-27",
  usage: { input_tokens: 1000, cached_input_tokens: 100, output_tokens: 100, costBasis: "turn_total" } });

it("estimates known complete usage and never treats missing or unknown costs as free", () => {
  expect(estimatedExecutionCost(execution(1))).toBeCloseTo(0.00281);
  expect(estimatedExecutionCost(execution(1, "future-model"))).toBeNull();
  expect(estimatedExecutionCost({ ...execution(1), usage: null })).toBeNull();
  for (const usage of [{ input_tokens: 1 }, { input_tokens: 10, output_tokens: 5, cached_input_tokens: 11 },
    { input_tokens: 300000, output_tokens: 5 }, { input_tokens: 1, output_tokens: 2, costBasis: "partial_turn" }]) {
    expect(estimatedExecutionCost({ ...execution(1), usage })).toBeNull();
  }
});

it("counts retries and every verification role only after independent verified completion", () => {
  const executions = [execution(1), execution(1), execution(2), execution(3)];
  expect(completedLoopCost(loop, jobs, executions, "standard")).toMatchObject({ model: "gpt-6.1-sol", completed: true, estimatedUsd: 4 * 0.00281 });
  expect(completedLoopCost({ ...loop, mergeCommit: null }, jobs, executions, "standard")).toBeNull();
  expect(completedLoopCost(loop, jobs.slice(0, 2), executions, "standard")).toBeNull();
  expect(completedLoopCost(loop, jobs, executions.slice(0, 3), "standard")).toBeNull();
  expect(completedLoopCost(loop, jobs, [...executions, execution(1, "gpt-6-astra")], "standard")).toBeNull();
  expect(completedLoopCost(loop, jobs, [...executions, execution(2, "unknown")], "standard")).toBeNull();
  expect(completedLoopCost({ ...loop, status: "failed" }, jobs, executions, "standard")).toMatchObject({ completed: false });
});

it("charges failed workflows against successful completions and requires eight completions", () => {
  const samples = Array.from({ length: 8 }, () => ({ model: "model", tier: "standard", estimatedUsd: 1 }));
  expect(observedCompletionCosts(samples.slice(0, 7), "standard").size).toBe(0);
  expect(observedCompletionCosts([...samples, { ...samples[0], estimatedUsd: 8, completed: false }], "standard").get("model"))
    .toEqual({ count: 8, mean: 2, completionRate: 8 / 9 });
});
