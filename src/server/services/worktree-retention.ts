import type { AgentJobDto, ProjectDto } from "../../shared/types";
import type { AgentEvidenceResult, AgentRunResult } from "../agents/types";
import type { Repositories } from "../db/repositories";
import { cleanupWorktree, type PreparedWorktree } from "./worktree-service";

export type WorktreeLifecycleState =
  | AgentRunResult["status"]
  | "waiting_provider"
  | "paused"
  | "recoverable_error"
  | "runtime_error";

export type WorktreeDisposition = {
  action: "cleanup" | "retain";
  reason: "completed" | "canceled" | "human_gate" | "provider_gate" | "paused" | "failed" | "recoverable_error";
};

export type WorktreeRetentionRecord = WorktreeDisposition & {
  worktreePath: string;
  branchName: string | null;
};

export function decideWorktreeDisposition(state: WorktreeLifecycleState): WorktreeDisposition {
  if (state === "succeeded") return { action: "cleanup", reason: "completed" };
  if (state === "canceled") return { action: "cleanup", reason: "canceled" };
  if (state === "waiting_human") return { action: "retain", reason: "human_gate" };
  if (state === "waiting_provider") return { action: "retain", reason: "provider_gate" };
  if (state === "paused") return { action: "retain", reason: "paused" };
  if (state === "recoverable_error") return { action: "retain", reason: "recoverable_error" };
  return { action: "retain", reason: "failed" };
}

export async function applyWorktreeDisposition(
  repos: Repositories,
  input: {
    job: AgentJobDto;
    project: Pick<ProjectDto, "id" | "repoPath">;
    worktree: Pick<PreparedWorktree, "worktreePath"> & Partial<Pick<PreparedWorktree, "branchName">>;
    state: WorktreeLifecycleState;
  }
): Promise<WorktreeRetentionRecord> {
  const disposition = decideWorktreeDisposition(input.state);
  const record: WorktreeRetentionRecord = {
    ...disposition,
    worktreePath: input.worktree.worktreePath,
    branchName: input.worktree.branchName ?? null
  };
  const retentionEvidence: AgentEvidenceResult = {
    type: "worktree_retention",
    title: record.action === "cleanup" ? "Worktree cleaned up" : "Worktree retained",
    summary: record.action === "cleanup"
      ? `Removed the isolated worktree after ${record.reason}.`
      : `Preserved the isolated worktree for ${record.reason}.`,
    payload: { ...record }
  };
  if (disposition.action === "cleanup") {
    await cleanupWorktree(input.project, input.worktree.worktreePath);
  }

  const step = await repos.loopSteps.getByAgentJob(input.job.projectId, input.job.id);
  if (step) {
    const stepEvidence = appendEvidenceItem(step.evidence, retentionEvidence);
    await Promise.all([
      repos.loopSteps.updateForAgentJob(input.job.projectId, input.job.id, { evidence: stepEvidence }),
      (async () => {
        const run = await repos.loopRuns.get(input.job.projectId, step.loopRunId);
        await repos.loopRuns.setWorktreeState(input.job.projectId, step.loopRunId, {
          worktreePath: disposition.action === "cleanup" ? null : input.worktree.worktreePath,
          evidence: appendEvidenceItem(run?.evidence ?? null, retentionEvidence)
        });
      })()
    ]);
  }

  const target = input.job.targetType === "issue" || input.job.targetType === "pull_request"
    ? { targetType: input.job.targetType, targetId: input.job.targetId }
    : null;
  if (target) {
    await repos.activities.create({
      projectId: input.job.projectId,
      agentJobId: input.job.id,
      targetType: target.targetType,
      targetId: target.targetId,
      activityType: "system",
      title: disposition.action === "cleanup" ? "Worktree cleaned up" : "Worktree retained",
      body: disposition.action === "cleanup"
        ? `Removed ${input.worktree.worktreePath} after ${disposition.reason}.`
        : `Preserved ${input.worktree.worktreePath} for ${disposition.reason}.`,
      payload: { worktreeRetention: record }
    });
  }
  return record;
}

export function appendWorktreeRetentionEvidence(
  result: AgentRunResult,
  record: WorktreeRetentionRecord
): AgentRunResult {
  const evidence: AgentEvidenceResult = {
    type: "worktree_retention",
    title: record.action === "cleanup" ? "Worktree cleaned up" : "Worktree retained",
    summary: record.action === "cleanup"
      ? `Removed the isolated worktree after ${record.reason}.`
      : `Preserved the isolated worktree for ${record.reason}.`,
    payload: { ...record }
  };
  return {
    ...result,
    evidence: [...(result.evidence ?? []), evidence],
    metadata: {
      ...(result.metadata ?? {}),
      worktreeRetention: record
    }
  };
}

function appendEvidenceItem(
  current: Record<string, unknown> | null,
  item: AgentEvidenceResult
): Record<string, unknown> {
  const items = Array.isArray(current?.items)
    ? current.items.filter((value): value is AgentEvidenceResult => typeof value === "object" && value !== null)
    : [];
  return { items: [...items, item].slice(-80) };
}

export async function cleanupInactiveJobWorktree(
  repos: Repositories,
  job: AgentJobDto
): Promise<WorktreeRetentionRecord | null> {
  const step = await repos.loopSteps.getByAgentJob(job.projectId, job.id);
  if (!step) return null;
  const run = await repos.loopRuns.get(job.projectId, step.loopRunId);
  if (!run?.worktreePath) return null;
  const project = await repos.projects.get(job.projectId);
  if (!project) return null;
  return applyWorktreeDisposition(repos, {
    job,
    project,
    worktree: { worktreePath: run.worktreePath },
    state: "canceled"
  });
}
