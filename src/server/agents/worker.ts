import type { AgentJobDto, LabelDto } from "../../shared/types";
import type { Repositories } from "../db/repositories";
import { runLabelAutomation } from "../services/label-automation";
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
        isCanceled: async () => {
          const current = await this.repos.agentJobs.get(runningJob.projectId, runningJob.id);
          return current?.status === "canceled";
        },
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
            body: activity.body ?? undefined,
            payload: activity.payload ?? undefined
          });
        }
      });

      const currentJob = await this.repos.agentJobs.get(runningJob.projectId, runningJob.id);
      if (currentJob?.status === "canceled" && result.status !== "canceled") {
        const target = normalizeActivityTarget(runningJob);
        if (target) {
          await this.repos.activities.create({
            projectId: runningJob.projectId,
            agentJobId: runningJob.id,
            targetType: target.targetType,
            targetId: target.targetId,
            activityType: "system",
            title: "Agent job canceled",
            body: "The job was canceled before its result was applied."
          });
        }
        return;
      }

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
    let output = result;

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
        body: activity.body ?? undefined,
        payload: activity.payload ?? undefined
      });
    }

    if (output.status === "canceled") {
      await this.repos.agentJobs.updateStatus(job.projectId, job.id, "canceled", {
        output: output as unknown as Record<string, unknown>,
        error: null
      });
      return;
    }

    if (output.status === "waiting_human" && target) {
      output = await this.enterHumanGate(job, output, target);
    }

    if (output.comment) {
      await this.repos.comments.create({
        projectId: job.projectId,
        targetType: output.comment.targetType,
        targetId: output.comment.targetId,
        authorType: "agent",
        agentType: job.agentType,
        body: output.comment.body,
        metadata: output.metadata ?? undefined
      });
    } else if (output.questions?.length && target) {
      await this.repos.comments.create({
        projectId: job.projectId,
        targetType: target.targetType,
        targetId: target.targetId,
        authorType: "agent",
        agentType: job.agentType,
        body: output.questions.map((question, index) => `${index + 1}. ${question}`).join("\n"),
        metadata: output.metadata ?? undefined
      });
    } else if (output.message && target) {
      await this.repos.comments.create({
        projectId: job.projectId,
        targetType: target.targetType,
        targetId: target.targetId,
        authorType: "agent",
        agentType: job.agentType,
        body: output.message,
        metadata: output.metadata ?? undefined
      });
    }

    if (output.status !== "waiting_human") {
      await this.applyMetadata(job, output);
    }
    await this.repos.agentJobs.updateStatus(job.projectId, job.id, output.status, {
      output: output as unknown as Record<string, unknown>,
      error: output.status === "failed" ? output.message : null
    });
  }

  private async enterHumanGate(
    job: AgentJobDto,
    result: AgentRunResult,
    target: { targetType: "issue" | "pull_request"; targetId: number }
  ): Promise<AgentRunResult> {
    const previousLabels = await this.getTargetLabels(job);
    const confirmationLabel = await this.repos.labels.findByName(job.projectId, "確認待ち");
    if (confirmationLabel) {
      if (target.targetType === "issue") {
        await this.repos.issues.update(job.projectId, target.targetId, { labelIds: [confirmationLabel.id] });
      } else {
        await this.repos.pullRequests.update(job.projectId, target.targetId, { labelIds: [confirmationLabel.id] });
      }
    }

    await this.repos.activities.create({
      projectId: job.projectId,
      agentJobId: job.id,
      targetType: target.targetType,
      targetId: target.targetId,
      activityType: "progress",
      title: "Waiting for human input",
      body: "The agent paused and is waiting for a user reply."
    });

    return {
      ...result,
      metadata: {
        ...(result.metadata ?? {}),
        humanGate: {
          previousLabelIds: previousLabels.map((label) => label.id),
          previousLabelNames: previousLabels.map((label) => label.name)
        }
      }
    };
  }

  private async getTargetLabels(job: AgentJobDto): Promise<LabelDto[]> {
    if (job.targetType === "issue") {
      return (await this.repos.issues.get(job.projectId, job.targetId))?.labels ?? [];
    }
    if (job.targetType === "pull_request") {
      return (await this.repos.pullRequests.get(job.projectId, job.targetId))?.labels ?? [];
    }
    return [];
  }

  private async applyMetadata(job: AgentJobDto, result: AgentRunResult): Promise<void> {
    const nextLabel = result.metadata?.nextLabel;
    if (typeof nextLabel === "string") {
      const label = await this.repos.labels.findByName(job.projectId, nextLabel);
      if (label && job.targetType === "issue") {
        const previousIssue = await this.repos.issues.get(job.projectId, job.targetId);
        const issue = await this.repos.issues.update(job.projectId, job.targetId, { labelIds: [label.id] });
        if (issue) {
          await runLabelAutomation(this.repos, {
            projectId: job.projectId,
            targetType: "issue",
            targetId: job.targetId,
            labels: issue.labels,
            previousLabels: previousIssue?.labels ?? [],
            triggerType: "label_transition"
          });
        }
      }
      if (label && job.targetType === "pull_request") {
        const previousPullRequest = await this.repos.pullRequests.get(job.projectId, job.targetId);
        const pullRequest = await this.repos.pullRequests.update(job.projectId, job.targetId, { labelIds: [label.id] });
        if (pullRequest) {
          await runLabelAutomation(this.repos, {
            projectId: job.projectId,
            targetType: "pull_request",
            targetId: job.targetId,
            labels: pullRequest.labels,
            previousLabels: previousPullRequest?.labels ?? [],
            triggerType: "label_transition"
          });
        }
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
        const pullRequest = await this.repos.pullRequests.create({
          projectId: job.projectId,
          issueId: typeof pr.issueId === "number" ? pr.issueId : job.targetType === "issue" ? job.targetId : null,
          title: pr.title,
          body: typeof pr.body === "string" ? pr.body : "",
          sourceBranch: pr.sourceBranch,
          targetBranch: pr.targetBranch,
          labelIds: reviewLabel ? [reviewLabel.id] : []
        });
        await runLabelAutomation(this.repos, {
          projectId: job.projectId,
          targetType: "pull_request",
          targetId: pullRequest.id,
          labels: pullRequest.labels,
          triggerType: "pull_request_created"
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
