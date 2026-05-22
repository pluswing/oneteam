import type { AgentJobDto, LabelDto, ProjectDto } from "../../shared/types";
import { workflowLabelNames } from "../../shared/workflow-labels";
import type { Repositories } from "../db/repositories";
import { detectMergeConflicts, getChangedFilesSince } from "../services/git-service";
import { prepareImplementationBranch } from "../services/implementation-preflight";
import { runLabelAutomation } from "../services/label-automation";
import { runVerificationCommands, type VerificationCommandResult } from "../services/verification-runner";
import type { AgentAdapter, AgentActivityResult, AgentRunResult } from "./types";
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
      const preflightResult = await this.prepareImplementationJob(runningJob);
      if (preflightResult) {
        await this.applyResult(runningJob, preflightResult);
        return;
      }

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

      let finalizedResult = await this.finalizeImplementationResult(runningJob, project, result);
      finalizedResult = await this.finalizePullRequestWorkflowResult(runningJob, project, finalizedResult);
      await this.applyResult(runningJob, finalizedResult);
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

  private async finalizeImplementationResult(
    job: AgentJobDto,
    project: ProjectDto,
    result: AgentRunResult
  ): Promise<AgentRunResult> {
    if (job.agentType !== "implementation" || job.targetType !== "issue" || result.status !== "succeeded") {
      return result;
    }

    const commands = await this.repos.commands.list(project.id);
    const commandResults = await runVerificationCommands(project.repoPath, commands);
    const changedFiles = uniqueStrings([
      ...(result.changedFiles ?? []),
      ...(await getChangedFilesSince(project.repoPath, project.defaultBranch))
    ]);
    const activities = [
      ...(result.activities ?? []),
      ...changedFileActivities(changedFiles),
      ...verificationActivities(commandResults)
    ];
    const testResults: Array<Record<string, unknown>> = [
      ...(result.testResults ?? []),
      ...commandResults.map((commandResult) => ({ ...commandResult }))
    ];
    const failedCommands = commandResults.filter((commandResult) => commandResult.status === "failed");

    if (failedCommands.length) {
      return {
        ...result,
        status: "failed",
        message: `${result.message}\n\nVerification failed: ${failedCommands
          .map((commandResult) => commandResult.command)
          .join(", ")}`,
        activities,
        changedFiles,
        testResults,
        metadata: {
          ...(result.metadata ?? {}),
          nextLabel: null,
          pullRequest: null
        }
      };
    }

    return {
      ...result,
      activities,
      changedFiles,
      testResults
    };
  }

  private async finalizePullRequestWorkflowResult(
    job: AgentJobDto,
    project: ProjectDto,
    result: AgentRunResult
  ): Promise<AgentRunResult> {
    if (
      job.targetType !== "pull_request" ||
      result.status !== "succeeded" ||
      !["review", "fix", "qa"].includes(job.agentType)
    ) {
      return result;
    }

    const pullRequest = await this.repos.pullRequests.get(project.id, job.targetId);
    if (!pullRequest) {
      throw new Error(`Pull request was not found: ${job.targetId}`);
    }

    const metadata: NonNullable<AgentRunResult["metadata"]> = { ...(result.metadata ?? {}) };
    if (
      job.agentType === "fix" &&
      pullRequest.labels.some((label) => label.name === workflowLabelNames.resolvingConflicts)
    ) {
      const conflicts = await detectMergeConflicts(project.repoPath, pullRequest.sourceBranch, pullRequest.targetBranch);
      if (conflicts.hasConflicts) {
        return {
          ...result,
          status: "failed",
          message: `${result.message}\n\nMerge conflicts remain: ${conflicts.files.map((file) => file.path).join(", ")}`,
          activities: [
            ...(result.activities ?? []),
            {
              type: "error",
              title: "Merge conflicts remain",
              body: conflicts.files.map((file) => `- ${file.path}: ${file.reason}`).join("\n"),
              payload: {
                conflicts
              }
            }
          ],
          metadata: {
            ...metadata,
            nextLabel: null
          }
        };
      }
    }

    metadata.nextLabel = metadata.nextLabel ?? derivePullRequestNextLabel(job.agentType, metadata) ?? null;
    return {
      ...result,
      activities: [...(result.activities ?? []), ...pullRequestWorkflowActivities(job.agentType, metadata)],
      metadata
    };
  }

  private async prepareImplementationJob(job: AgentJobDto): Promise<AgentRunResult | null> {
    if (job.agentType !== "implementation" || job.targetType !== "issue") {
      return null;
    }

    const project = await this.repos.projects.get(job.projectId);
    if (!project) {
      throw new Error(`Project was not found: ${job.projectId}`);
    }

    const issue = await this.repos.issues.get(project.id, job.targetId);
    if (!issue) {
      throw new Error(`Issue was not found: ${job.targetId}`);
    }

    const result = await prepareImplementationBranch(project, issue);
    if (result.status === "ready") {
      await this.repos.activities.create({
        projectId: job.projectId,
        agentJobId: job.id,
        targetType: "issue",
        targetId: issue.id,
        activityType: "progress",
        title: "Implementation branch ready",
        body: formatImplementationBranchAction(result.action, result.branchName),
        payload: {
          branchName: result.branchName,
          action: result.action,
          previousBranch: result.repositoryStatus.branch
        }
      });
      return null;
    }

    const changedFiles = result.repositoryStatus.changedFiles;
    const changedFilesBody = changedFiles.length ? `\n\nChanged files:\n${changedFiles.map((file) => `- ${file}`).join("\n")}` : "";

    return {
      status: "waiting_human",
      message: "Implementation is blocked because the repository has uncommitted changes.",
      questions: [
        `Please commit, stash, or discard the uncommitted changes on ${result.repositoryStatus.branch}, then comment to resume. Target branch: ${result.branchName}.`
      ],
      activities: [
        {
          type: "error",
          title: "Implementation branch blocked",
          body: `Cannot switch to ${result.branchName} while ${result.repositoryStatus.branch} has uncommitted changes.${changedFilesBody}`,
          payload: {
            branchName: result.branchName,
            currentBranch: result.repositoryStatus.branch,
            changedFiles
          }
        }
      ],
      metadata: {
        implementationBranch: {
          branchName: result.branchName,
          currentBranch: result.repositoryStatus.branch,
          changedFiles,
          reason: result.reason
        }
      }
    };
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

    if (output.status === "succeeded") {
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
    const confirmationLabel = await this.repos.labels.findByName(job.projectId, workflowLabelNames.needsInput);
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
        const reviewLabel = await this.repos.labels.findByName(job.projectId, workflowLabelNames.reviewing);
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

function formatImplementationBranchAction(action: string, branchName: string): string {
  if (action === "already_on_branch") {
    return `Already on ${branchName}.`;
  }
  if (action === "checked_out") {
    return `Checked out existing branch ${branchName}.`;
  }
  return `Created and checked out ${branchName}.`;
}

function changedFileActivities(changedFiles: string[]): AgentActivityResult[] {
  if (!changedFiles.length) {
    return [];
  }

  return [
    {
      type: "file_change",
      title: "Changed files captured",
      body: changedFiles.map((file) => `- ${file}`).join("\n"),
      payload: {
        changedFiles
      }
    }
  ];
}

function verificationActivities(results: VerificationCommandResult[]): AgentActivityResult[] {
  return results.map((result) => ({
    type: result.status === "passed" ? (result.commandType === "test" ? "test" : "command") : "error",
    title: `${result.commandType} command ${result.status}`,
    body: commandResultBody(result),
    payload: {
      commandType: result.commandType,
      command: result.command,
      status: result.status,
      exitCode: result.exitCode,
      signal: result.signal,
      durationMs: result.durationMs,
      timedOut: result.timedOut
    }
  }));
}

function commandResultBody(result: VerificationCommandResult): string {
  const lines = [
    result.command,
    `status: ${result.status}`,
    `exit code: ${result.exitCode ?? "none"}`,
    `duration: ${result.durationMs}ms`
  ];
  if (result.timedOut) {
    lines.push("timed out: true");
  }
  if (result.output) {
    lines.push("", result.output);
  }
  return lines.join("\n");
}

function uniqueStrings(items: string[]): string[] {
  return Array.from(new Set(items));
}

function derivePullRequestNextLabel(
  agentType: AgentJobDto["agentType"],
  metadata: NonNullable<AgentRunResult["metadata"]>
): string | null {
  if (agentType === "review") {
    const verdict = stringValue(objectValue(metadata.review)?.verdict);
    if (verdict === "changes_requested") {
      return workflowLabelNames.fixing;
    }
    if (verdict === "approved") {
      return workflowLabelNames.testing;
    }
  }

  if (agentType === "fix") {
    return workflowLabelNames.reviewing;
  }

  if (agentType === "qa") {
    const verdict = stringValue(objectValue(metadata.qa)?.verdict);
    if (verdict === "defects_found") {
      return workflowLabelNames.fixing;
    }
    if (verdict === "passed") {
      return workflowLabelNames.done;
    }
  }

  return null;
}

function pullRequestWorkflowActivities(
  agentType: AgentJobDto["agentType"],
  metadata: NonNullable<AgentRunResult["metadata"]>
): AgentActivityResult[] {
  if (agentType === "review") {
    const review = objectValue(metadata.review);
    if (!review) {
      return [];
    }
    const findings = arrayValue(review.findings);
    const verdict = stringValue(review.verdict) ?? "unknown";
    return [
      {
        type: findings.length ? "error" : "progress",
        title: findings.length ? "Review findings captured" : "Review approval captured",
        body: structuredActivityBody(`verdict: ${verdict}`, findings),
        payload: {
          review
        }
      }
    ];
  }

  if (agentType === "fix") {
    const fix = objectValue(metadata.fix);
    if (!fix) {
      return [];
    }
    const resolvedFindings = stringArrayValue(fix.resolvedFindings);
    return [
      {
        type: "progress",
        title: "Fix summary captured",
        body: resolvedFindings.length ? resolvedFindings.map((item) => `- ${item}`).join("\n") : "Fix completed.",
        payload: {
          fix
        }
      }
    ];
  }

  if (agentType === "qa") {
    const qa = objectValue(metadata.qa);
    if (!qa) {
      return [];
    }
    const defects = arrayValue(qa.defects);
    const verdict = stringValue(qa.verdict) ?? "unknown";
    return [
      {
        type: defects.length ? "error" : "test",
        title: defects.length ? "QA defects captured" : "QA pass captured",
        body: structuredActivityBody(`verdict: ${verdict}`, defects),
        payload: {
          qa
        }
      }
    ];
  }

  return [];
}

function structuredActivityBody(header: string, items: unknown[]): string {
  if (!items.length) {
    return header;
  }
  return [header, "", ...items.map(formatStructuredItem)].join("\n");
}

function formatStructuredItem(item: unknown): string {
  const object = objectValue(item);
  if (!object) {
    return `- ${String(item)}`;
  }

  const severity = stringValue(object.severity);
  const path = stringValue(object.path);
  const line = numberValue(object.line);
  const title = stringValue(object.title) ?? "Untitled";
  const body = stringValue(object.body);
  const location = path ? `${path}${line ? `:${line}` : ""}` : null;
  const prefix = [severity ? `[${severity}]` : null, location].filter(Boolean).join(" ");
  const detail = body && body !== title ? ` - ${body}` : "";
  return `- ${prefix ? `${prefix} ` : ""}${title}${detail}`;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" ? value : null;
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
