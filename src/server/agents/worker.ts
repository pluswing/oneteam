import type { AgentJobDto } from "../../shared/types";
import type { Repositories } from "../db/repositories";
import type { AgentAdapter, AgentRunResult } from "./types";
import { buildPromptForJob } from "./context";

export type AgentWorkerOptions = {
  pollIntervalMs: number;
};

export class AgentWorker {
  private timer: NodeJS.Timeout | null = null;
  private isTicking = false;

  constructor(
    private readonly repos: Repositories,
    private readonly adapter: AgentAdapter,
    private readonly options: AgentWorkerOptions
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.pollIntervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    if (this.isTicking) {
      return;
    }

    this.isTicking = true;
    try {
      const job = await this.repos.agentJobs.nextQueued();
      if (!job) {
        return;
      }
      await this.runJob(job);
    } finally {
      this.isTicking = false;
    }
  }

  private async runJob(job: AgentJobDto): Promise<void> {
    const runningJob = await this.repos.agentJobs.updateStatus(job.projectId, job.id, "running");
    if (!runningJob) {
      return;
    }

    const activityTarget = normalizeActivityTarget(runningJob);
    if (activityTarget) {
      await this.repos.activities.create({
        projectId: runningJob.projectId,
        agentJobId: runningJob.id,
        targetType: activityTarget.targetType,
        targetId: activityTarget.targetId,
        activityType: "progress",
        title: `${runningJob.agentType} agent started`,
        body: `Job #${runningJob.id} started.`
      });
    }

    try {
      const { project, prompt } = await buildPromptForJob(this.repos, runningJob);
      const result = await this.adapter.run({
        job: runningJob,
        repoPath: project.repoPath,
        prompt,
        onActivity: async (activity) => {
          const target = normalizeActivityTarget(runningJob);
          if (!target) {
            return;
          }
          await this.repos.activities.create({
            projectId: runningJob.projectId,
            agentJobId: runningJob.id,
            targetType: target.targetType,
            targetId: target.targetId,
            activityType: activity.type,
            title: activity.title,
            body: activity.body,
            payload: activity.payload
          });
        }
      });

      await this.applyResult(runningJob, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Agent job failed.";
      const target = normalizeActivityTarget(runningJob);
      if (target) {
        await this.repos.activities.create({
          projectId: runningJob.projectId,
          agentJobId: runningJob.id,
          targetType: target.targetType,
          targetId: target.targetId,
          activityType: "error",
          title: "Agent job failed",
          body: message
        });
      }
      await this.repos.agentJobs.updateStatus(runningJob.projectId, runningJob.id, "failed", { error: message });
    }
  }

  private async applyResult(job: AgentJobDto, result: AgentRunResult): Promise<void> {
    const target = normalizeActivityTarget(job);

    for (const activity of result.activities ?? []) {
      if (!target) {
        continue;
      }
      await this.repos.activities.create({
        projectId: job.projectId,
        agentJobId: job.id,
        targetType: target.targetType,
        targetId: target.targetId,
        activityType: activity.type,
        title: activity.title,
        body: activity.body,
        payload: activity.payload
      });
    }

    if (result.comment) {
      await this.repos.comments.create({
        projectId: job.projectId,
        targetType: result.comment.targetType,
        targetId: result.comment.targetId,
        authorType: "agent",
        agentType: job.agentType,
        body: result.comment.body,
        metadata: result.metadata
      });
    } else if (result.questions?.length && target) {
      await this.repos.comments.create({
        projectId: job.projectId,
        targetType: target.targetType,
        targetId: target.targetId,
        authorType: "agent",
        agentType: job.agentType,
        body: result.questions.map((question, index) => `${index + 1}. ${question}`).join("\n"),
        metadata: result.metadata
      });
    } else if (result.message && target) {
      await this.repos.comments.create({
        projectId: job.projectId,
        targetType: target.targetType,
        targetId: target.targetId,
        authorType: "agent",
        agentType: job.agentType,
        body: result.message,
        metadata: result.metadata
      });
    }

    await this.applyMetadata(job, result);
    await this.repos.agentJobs.updateStatus(job.projectId, job.id, result.status, {
      output: result as unknown as Record<string, unknown>,
      error: result.status === "failed" ? result.message : null
    });
  }

  private async applyMetadata(job: AgentJobDto, result: AgentRunResult): Promise<void> {
    const nextLabel = result.metadata?.nextLabel;
    if (typeof nextLabel === "string") {
      const label = await this.repos.labels.findByName(job.projectId, nextLabel);
      if (label && job.targetType === "issue") {
        await this.repos.issues.update(job.projectId, job.targetId, { labelIds: [label.id] });
      }
      if (label && job.targetType === "pull_request") {
        await this.repos.pullRequests.update(job.projectId, job.targetId, { labelIds: [label.id] });
      }
    }

    const pullRequest = result.metadata?.pullRequest;
    if (pullRequest && typeof pullRequest === "object") {
      const pr = pullRequest as {
        title?: unknown;
        body?: unknown;
        sourceBranch?: unknown;
        targetBranch?: unknown;
        issueId?: unknown;
      };
      if (typeof pr.title === "string" && typeof pr.sourceBranch === "string" && typeof pr.targetBranch === "string") {
        const reviewLabel = await this.repos.labels.findByName(job.projectId, "レビュー中");
        await this.repos.pullRequests.create({
          projectId: job.projectId,
          issueId: typeof pr.issueId === "number" ? pr.issueId : job.targetType === "issue" ? job.targetId : null,
          title: pr.title,
          body: typeof pr.body === "string" ? pr.body : "",
          sourceBranch: pr.sourceBranch,
          targetBranch: pr.targetBranch,
          labelIds: reviewLabel ? [reviewLabel.id] : []
        });
      }
    }
  }
}

function normalizeActivityTarget(job: AgentJobDto): { targetType: "issue" | "pull_request"; targetId: number } | null {
  if (job.targetType === "issue" || job.targetType === "pull_request") {
    return {
      targetType: job.targetType,
      targetId: job.targetId
    };
  }
  return null;
}
