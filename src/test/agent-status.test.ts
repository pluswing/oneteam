import { beforeEach, expect, it } from "vitest";
import type { AgentJobDto } from "../shared/types";
import type { DevelopmentLoopDto } from "../shared/development-loop";
import { summarizeAgentJobs } from "../client/agent-status";
import { setLocale } from "../client/i18n";

const job: AgentJobDto = {
  id: 37, projectId: "fixture", aiProvider: "codex", aiModel: null, agentType: "implementation", targetType: "issue", targetId: 42,
  status: "running", triggerType: "fixture", parentJobId: null, input: {}, output: null, error: null, attempt: 1, lockKey: null,
  waitReason: null, waitMetadata: null, nextRetryAt: null, createdAt: "2026-10-27T00:00:00Z", startedAt: null, finishedAt: null
};
const loop: DevelopmentLoopDto = {
  id: 8, projectId: job.projectId, issueId: 42, pullRequestId: 24, objectiveId: null, phase: "implementing", status: "running",
  currentJobId: job.id, mergeCommit: null, sourceCommit: null, targetCommit: null, nextAgent: "implementation", failures: 0,
  summary: "", rounds: 1, createdAt: job.createdAt, updatedAt: job.createdAt, finishedAt: null
};
beforeEach(() => setLocale("en"));

it("links the displayed running Loop to its current Agent job", () => {
  expect(summarizeAgentJobs([job], [loop])).toMatchObject({ status: "running", targetRoute: { name: "agentJob", jobId: job.id } });
});

it("opens the Loop's Issue between Agent jobs instead of linking to an obsolete job", () => {
  for (const jobs of [[], [{ ...job, status: "succeeded" as const }], [{ ...job, status: "failed" as const }]]) {
    expect(summarizeAgentJobs(jobs, [loop]).targetRoute).toEqual({ name: "issue", issueId: loop.issueId });
  }
});

it.each(["merging", "reflecting"] as const)("opens the related PR during %s without an Agent job", (phase) => {
  expect(summarizeAgentJobs([], [{ ...loop, phase, currentJobId: null }]).targetRoute).toEqual({ name: "pullRequest", pullRequestId: loop.pullRequestId });
  expect(summarizeAgentJobs([], [{ ...loop, phase, pullRequestId: null }]).targetRoute).toEqual({ name: "issue", issueId: loop.issueId });
});

it.each(["queued", "running", "waiting_human", "waiting_provider", "paused", "failed"] as const)("links a standalone %s Agent even with no active Loops", (status) => {
  expect(summarizeAgentJobs([{ ...job, status }], []).targetRoute).toEqual({ name: "agentJob", jobId: job.id });
});

it("keeps waiting and failed Loop statuses linked to the corresponding Agent", () => {
  for (const [loopStatus, jobStatus] of [["waiting_input", "waiting_human"], ["waiting_capacity", "waiting_provider"], ["paused", "paused"], ["failed", "failed"]] as const) {
    expect(summarizeAgentJobs([{ ...job, status: jobStatus }], [{ ...loop, status: loopStatus }]).targetRoute).toEqual({ name: "agentJob", jobId: job.id });
  }
});

it("prefers currently running work to queued or blocked Loops", () => {
  expect(summarizeAgentJobs([job], [{ ...loop, id: 1, status: "queued", currentJobId: null }, loop]).targetRoute).toEqual({ name: "agentJob", jobId: job.id });
  expect(summarizeAgentJobs([job], [{ ...loop, status: "paused", currentJobId: null }])).toMatchObject({ status: "running", targetRoute: { name: "agentJob", jobId: job.id } });
});

it("has no task destination when all work has finished", () => {
  expect(summarizeAgentJobs([], [])).toMatchObject({ status: "ready", targetRoute: null });
  expect(summarizeAgentJobs([{ ...job, status: "succeeded" }], [{ ...loop, status: "succeeded" }])).toMatchObject({ status: "ready", targetRoute: null });
});
