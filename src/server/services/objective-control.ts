import type { AgentJobDto, LoopRunStatus, ObjectiveRunDto } from "../../shared/types";
import type { Repositories } from "../db/repositories";
import { buildSystemComment } from "./system-comment";
import { cleanupInactiveJobWorktree } from "./worktree-retention";

type ObjectiveControlAction = "pause" | "resume" | "cancel";

export type ObjectiveControlResult = {
  jobs: AgentJobDto[];
  objective: ObjectiveRunDto;
};

function objectiveIdFromJob(job: AgentJobDto): number | null {
  const value = job.input.objectiveRunId;
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

async function jobsForObjective(repos: Repositories, objective: ObjectiveRunDto): Promise<AgentJobDto[]> {
  const jobs = await repos.agentJobs.list({ projectId: objective.projectId });
  return jobs.filter((job) => objectiveIdFromJob(job) === objective.id);
}

async function syncLoopStatus(
  repos: Repositories,
  job: AgentJobDto,
  status: LoopRunStatus,
  summary: string,
  stopReason: string | null
): Promise<void> {
  const step = await repos.loopSteps.getByAgentJob(job.projectId, job.id);
  if (!step) return;
  await Promise.all([
    repos.loopSteps.updateForAgentJob(job.projectId, job.id, { status }),
    repos.loopRuns.updateStatus(job.projectId, step.loopRunId, status, { summary, stopReason })
  ]);
}

function targetForObjective(objective: ObjectiveRunDto): {
  targetId: number;
  targetType: "issue" | "pull_request";
} | null {
  if (objective.pullRequestId) return { targetType: "pull_request", targetId: objective.pullRequestId };
  if (objective.issueId) return { targetType: "issue", targetId: objective.issueId };
  return null;
}

async function recordControl(
  repos: Repositories,
  objective: ObjectiveRunDto,
  action: ObjectiveControlAction,
  jobs: AgentJobDto[]
): Promise<void> {
  const target = targetForObjective(objective);
  if (!target) return;
  const titles = {
    pause: "Objective paused",
    resume: "Objective resumed",
    cancel: "Objective canceled"
  } as const;
  const summaries = {
    pause: "Automatic execution is paused. Preserved jobs will not run until this Objective is resumed.",
    resume: "Preserved jobs were returned to the queue and automatic execution may continue.",
    cancel: "Automatic execution was canceled. No paused or queued job from this Objective will continue."
  } as const;
  await Promise.all([
    repos.activities.create({
      projectId: objective.projectId,
      targetType: target.targetType,
      targetId: target.targetId,
      activityType: "system",
      title: titles[action],
      body: summaries[action],
      payload: { action, jobIds: jobs.map((job) => job.id), objectiveRunId: objective.id }
    }),
    repos.comments.create({
      projectId: objective.projectId,
      targetType: target.targetType,
      targetId: target.targetId,
      authorType: "system",
      body: buildSystemComment({
        title: titles[action],
        outcome: action === "cancel" ? "info" : action === "pause" ? "waiting" : "ready",
        summary: summaries[action],
        fields: [
          { label: "Objective", value: `#${objective.id}`, code: true },
          { label: "Affected jobs", value: jobs.length ? jobs.map((job) => `#${job.id}`).join(", ") : "None" },
          { label: "Round", value: `${objective.roundCount}/${objective.maxRounds}`, code: true }
        ],
        nextStep:
          action === "pause"
            ? "Resume the Objective when automatic execution should continue."
            : action === "resume"
              ? "OneTeam will continue from the preserved workflow state."
              : "Create or explicitly restart work only after reviewing the canceled Objective."
      }),
      metadata: { objectiveControl: action, objectiveRunId: objective.id }
    })
  ]);
}

export async function pauseObjective(
  repos: Repositories,
  objective: ObjectiveRunDto
): Promise<ObjectiveControlResult> {
  const jobs = (await jobsForObjective(repos, objective)).filter((job) =>
    ["queued", "running", "waiting_provider", "waiting_human"].includes(job.status)
  );
  const pausedJobs = (
    await Promise.all(jobs.map((job) => repos.agentJobs.pause(job.projectId, job.id)))
  ).filter((job): job is AgentJobDto => Boolean(job));
  await Promise.all(pausedJobs.map((job) =>
    syncLoopStatus(repos, job, "paused", `Objective #${objective.id} was paused by the user.`, "paused_by_user")
  ));
  const updated = await repos.objectives.update(objective.projectId, objective.id, {
    status: "paused",
    stopReason: "paused_by_user",
    summary: "Automatic execution was paused by the user. Preserved jobs can be resumed without spending a round."
  });
  if (!updated) throw new Error("Objective disappeared while it was being paused.");
  await recordControl(repos, updated, "pause", pausedJobs);
  return { objective: updated, jobs: pausedJobs };
}

export async function resumeObjective(
  repos: Repositories,
  objective: ObjectiveRunDto
): Promise<ObjectiveControlResult> {
  const jobs = (await jobsForObjective(repos, objective)).filter((job) => job.status === "paused");
  const resumedJobs = (
    await Promise.all(jobs.map((job) => repos.agentJobs.resumePaused(job.projectId, job.id)))
  ).filter((job): job is AgentJobDto => Boolean(job));
  await Promise.all(resumedJobs.map((job) =>
    syncLoopStatus(repos, job, "queued", `Objective #${objective.id} was resumed by the user.`, null)
  ));
  const updated = await repos.objectives.update(objective.projectId, objective.id, {
    status: "running",
    stopReason: null,
    summary: resumedJobs.length
      ? `Resumed ${resumedJobs.length} preserved agent job${resumedJobs.length === 1 ? "" : "s"}.`
      : "Objective resumed; workflow labels will be re-evaluated.",
    finishedAt: null
  });
  if (!updated) throw new Error("Objective disappeared while it was being resumed.");
  await recordControl(repos, updated, "resume", resumedJobs);
  return { objective: updated, jobs: resumedJobs };
}

export async function cancelObjective(
  repos: Repositories,
  objective: ObjectiveRunDto
): Promise<ObjectiveControlResult> {
  const jobs = (await jobsForObjective(repos, objective)).filter((job) =>
    ["queued", "running", "paused", "waiting_provider", "waiting_human"].includes(job.status)
  );
  const canceledJobs = (
    await Promise.all(jobs.map((job) => repos.agentJobs.updateStatus(job.projectId, job.id, "canceled", {
      error: "Canceled with Objective by the user."
    })))
  ).filter((job): job is AgentJobDto => Boolean(job));
  await Promise.all(
    jobs
      .filter((job) => job.status !== "running")
      .map((job) => cleanupInactiveJobWorktree(repos, job))
  );
  await Promise.all(canceledJobs.map((job) =>
    syncLoopStatus(repos, job, "canceled", `Objective #${objective.id} was canceled by the user.`, "canceled_by_user")
  ));
  const updated = await repos.objectives.update(objective.projectId, objective.id, {
    status: "canceled",
    stopReason: "canceled_by_user",
    summary: "Objective and preserved automatic work were canceled by the user.",
    finishedAt: new Date().toISOString()
  });
  if (!updated) throw new Error("Objective disappeared while it was being canceled.");
  await recordControl(repos, updated, "cancel", canceledJobs);
  return { objective: updated, jobs: canceledJobs };
}
