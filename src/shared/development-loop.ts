export type DevelopmentPhase = "planning" | "implementing" | "reviewing" | "fixing" | "validating" | "merging" | "reflecting" | "completed";
export type DevelopmentStatus = "queued" | "running" | "waiting_input" | "waiting_capacity" | "paused" | "failed" | "canceled" | "succeeded";
export type DevelopmentLoopDto = {
  id: number; projectId: string; issueId: number; pullRequestId: number | null;
  objectiveId: number | null; phase: DevelopmentPhase; status: DevelopmentStatus;
  currentJobId: number | null; mergeCommit: string | null; sourceCommit: string | null; targetCommit: string | null;
  nextAgent: string; failures: number; summary: string; rounds: number; createdAt: string; updatedAt: string; finishedAt: string | null;
};
export type AgentExecutionDto = {
  id: number; projectId: string; jobId: number; selectedModel: string; resolvedModel: string | null;
  effort: string | null; selectionReason: string; policyVersion: string; threadId: string | null; turnId: string | null;
  status: string; usage: Record<string, unknown> | null; startedAt: string; finishedAt: string | null;
};
export type KnowledgeChange = { path: string; beforeHash: string | null; body: string | null; reason: string };
export type KnowledgeRevisionDto = {
  id: number; projectId: string; loopId: number; path: string; beforeBody: string | null; afterBody: string | null;
  reason: string; status: string; createdAt: string;
};
export type RetrospectiveDto = {
  id: number; projectId: string; loopId: number; mergeCommit: string; summary: string;
  body: string; changes: KnowledgeChange[]; status: "pending" | "applying" | "applied" | "failed";
  error: string | null; createdAt: string; appliedAt: string | null;
};
