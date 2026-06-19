import type { AgentJobDto, LabelDto, LoopDto, ProjectCommandDto, ProjectDto } from "../../shared/types";
import { workflowLabelNames } from "../../shared/workflow-labels";
import type { Repositories } from "../db/repositories";
import {
  commitAllChanges,
  detectMergeConflicts,
  getChangedFilesSince,
  getDiffLineCountSince,
  getRepositoryStatus
} from "../services/git-service";
import { runLabelAutomation } from "../services/label-automation";
import { appendLoopMemoryNote } from "../services/knowledge-files";
import { runVerificationCommands, type VerificationCommandResult } from "../services/verification-runner";
import { cleanupWorktree, prepareIssueWorktree, preparePullRequestWorktree } from "../services/worktree-service";
import type { AgentAdapter, AgentActivityResult, AgentEvidenceResult, AgentRunResult, AgentStopReason } from "./types";
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
    await this.repos.loopSteps.updateForAgentJob(runningJob.projectId, runningJob.id, { status: "running" });
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
      const worktree = await this.prepareWorktreeForJob(runningJob, project);
      const result = await this.adapter.run({
        job: runningJob,
        repoPath: worktree?.repoPath ?? project.repoPath,
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

      let finalizedResult = await this.finalizeImplementationResult(runningJob, project, worktree?.repoPath ?? project.repoPath, result);
      finalizedResult = await this.finalizePullRequestWorkflowResult(runningJob, project, worktree?.repoPath ?? project.repoPath, finalizedResult);
      await this.applyResult(runningJob, finalizedResult);
      if (worktree && ["succeeded", "canceled"].includes(finalizedResult.status)) {
        await cleanupWorktree(project, worktree.worktreePath);
      }
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
      await this.repos.agentJobs.updateStatus(runningJob.projectId, runningJob.id, "failed", {
        output: {
          status: "failed",
          message,
          stopReason: "failed",
          evidence: [
            {
              type: "error",
              title: "Agent job failed",
              summary: message,
              payload: null
            }
          ]
        },
        error: message
      });
      await this.updateLoopForResult(runningJob, {
        status: "failed",
        message,
        stopReason: "failed",
        evidence: [
          {
            type: "error",
            title: "Agent job failed",
            summary: message,
            payload: null
          }
        ]
      });
    }
  }

  private async getLoopContextForJob(job: AgentJobDto): Promise<{ loop: LoopDto } | null> {
    const step = await this.repos.loopSteps.getByAgentJob(job.projectId, job.id);
    if (!step) {
      return null;
    }
    const run = await this.repos.loopRuns.get(job.projectId, step.loopRunId);
    if (!run) {
      return null;
    }
    const loop = await this.repos.loops.get(job.projectId, run.loopId);
    return loop ? { loop } : null;
  }

  private async finalizeImplementationResult(
    job: AgentJobDto,
    project: ProjectDto,
    repoPath: string,
    result: AgentRunResult
  ): Promise<AgentRunResult> {
    if (job.agentType !== "implementation" || job.targetType !== "issue" || result.status !== "succeeded") {
      return result;
    }

    const loopContext = await this.getLoopContextForJob(job);
    const riskPolicy = normalizeRiskPolicy(loopContext?.loop.riskPolicy);
    const commands = await this.repos.commands.list(project.id);
    const commandPolicy = applyVerificationCommandPolicy(commands, riskPolicy);
    const commandTimeoutMs = loopContext?.loop.timeBudgetMinutes
      ? Math.max(loopContext.loop.timeBudgetMinutes * 60 * 1000, 1)
      : undefined;
    const commandResults = await runVerificationCommands(repoPath, commandPolicy.commands, commandTimeoutMs);
    const changedFiles = uniqueStrings([
      ...(result.changedFiles ?? []),
      ...(await getChangedFilesSince(repoPath, project.defaultBranch))
    ]);
    const diffLineCount = await getDiffLineCountSince(repoPath, project.defaultBranch);
    const riskSignals = [
      ...commandPolicy.riskSignals,
      ...(await implementationRiskSignals({
        job,
        loop: loopContext?.loop ?? null,
        repoPath,
        project,
        changedFiles,
        diffLineCount,
        riskPolicy
      }))
    ];
    const activities = [
      ...(result.activities ?? []),
      ...changedFileActivities(changedFiles),
      ...verificationActivities(commandResults),
      ...riskSignalActivities(riskSignals)
    ];
    const evidence = [
      ...(result.evidence ?? []),
      ...changedFileEvidence(changedFiles),
      ...verificationEvidence(commandResults),
      ...riskSignalEvidence(riskSignals)
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
        stopReason: "failed",
        evidence,
        metadata: {
          ...(result.metadata ?? {}),
          nextLabel: null,
          pullRequest: null
        }
      };
    }

    if (riskSignals.length && riskPolicy.humanGateOnRisk) {
      const stopReason = riskSignals.find((signal) => signal.stopReason)?.stopReason ?? "risk_detected";
      return {
        ...result,
        status: "waiting_human",
        message: `${result.message}\n\nHuman gate: ${riskSignals.map((signal) => signal.summary).join("; ")}`,
        questions: ["Review the loop risk signals and decide whether to adjust the loop policy or continue manually."],
        activities,
        changedFiles,
        testResults,
        stopReason,
        evidence,
        metadata: {
          ...(result.metadata ?? {}),
          nextLabel: null,
          pullRequest: null,
          riskSignals: riskSignals.map((signal) => ({
            title: signal.title,
            summary: signal.summary,
            payload: signal.payload,
            stopReason: signal.stopReason ?? "risk_detected"
          }))
        }
      };
    }

    const commitResult = await commitAllChanges(repoPath, `Implement issue #${job.targetId}`);
    const commitActivity = commitResult.commitHash
      ? [
          {
            type: "command" as const,
            title: "Implementation changes committed",
            body: `Committed ${commitResult.changedFiles.length} changed file(s).\n\nCommit: ${commitResult.commitHash.slice(0, 12)}`,
            payload: {
              commitHash: commitResult.commitHash,
              changedFiles: commitResult.changedFiles
            }
          }
        ]
      : [];

    return {
      ...result,
      activities: [...activities, ...commitActivity],
      changedFiles,
      testResults,
      stopReason: result.stopReason ?? "passed",
      evidence,
      metadata: riskSignals.length
        ? {
            ...(result.metadata ?? {}),
            riskSignals: riskSignals.map((signal) => ({
              title: signal.title,
              summary: signal.summary,
              payload: signal.payload,
              stopReason: signal.stopReason ?? "risk_detected"
            }))
          }
        : result.metadata
    };
  }

  private async finalizePullRequestWorkflowResult(
    job: AgentJobDto,
    project: ProjectDto,
    repoPath: string,
    result: AgentRunResult
  ): Promise<AgentRunResult> {
    if (
      job.targetType !== "pull_request" ||
      result.status !== "succeeded" ||
      !["review", "fix", "qa", "verifier"].includes(job.agentType)
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
      const conflicts = await detectMergeConflicts(repoPath, pullRequest.sourceBranch, pullRequest.targetBranch);
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
          stopReason: "failed",
          evidence: [
            ...(result.evidence ?? []),
            {
              type: "risk",
              title: "Merge conflicts remain",
              summary: conflicts.files.map((file) => `${file.path}: ${file.reason}`).join(", "),
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

    metadata.nextLabel = normalizePullRequestNextLabel(
      job.agentType,
      metadata.nextLabel ?? derivePullRequestNextLabel(job.agentType, metadata) ?? null
    );
    return {
      ...result,
      activities: [...(result.activities ?? []), ...pullRequestWorkflowActivities(job.agentType, metadata)],
      metadata
    };
  }

  private async prepareWorktreeForJob(
    job: AgentJobDto,
    project: ProjectDto
  ): Promise<{ repoPath: string; branchName: string; worktreePath: string } | null> {
    if (job.agentType === "implementation" && job.targetType === "issue") {
      const issue = await this.repos.issues.get(project.id, job.targetId);
      if (!issue) {
        throw new Error(`Issue was not found: ${job.targetId}`);
      }
      const worktree = await prepareIssueWorktree(project, issue);
      await this.recordWorktreeActivity(job, "issue", issue.id, worktree);
      await this.recordLoopWorktree(job, worktree.worktreePath);
      return worktree;
    }

    if (job.agentType === "fix" && job.targetType === "pull_request") {
      const pullRequest = await this.repos.pullRequests.get(project.id, job.targetId);
      if (!pullRequest) {
        throw new Error(`Pull request was not found: ${job.targetId}`);
      }
      const worktree = await preparePullRequestWorktree(project, pullRequest);
      await this.recordWorktreeActivity(job, "pull_request", pullRequest.id, worktree);
      await this.recordLoopWorktree(job, worktree.worktreePath);
      return worktree;
    }

    return null;
  }

  private async recordLoopWorktree(job: AgentJobDto, worktreePath: string): Promise<void> {
    const step = await this.repos.loopSteps.getByAgentJob(job.projectId, job.id);
    if (step) {
      await this.repos.loopRuns.updateStatus(job.projectId, step.loopRunId, "running", { worktreePath });
    }
  }

  private async recordWorktreeActivity(
    job: AgentJobDto,
    targetType: "issue" | "pull_request",
    targetId: number,
    worktree: { branchName: string; worktreePath: string }
  ): Promise<void> {
    await this.repos.activities.create({
      projectId: job.projectId,
      agentJobId: job.id,
      targetType,
      targetId,
      activityType: "progress",
      title: "Worktree ready",
      body: `Prepared ${worktree.branchName} in ${worktree.worktreePath}.`,
      payload: worktree
    });
  }

  private async applyResult(job: AgentJobDto, result: AgentRunResult): Promise<void> {
    const target = normalizeActivityTarget(job);
    let output = withDefaultStopReason(result);

    for (const activity of output.activities ?? []) {
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

    const commentMetadata = {
      ...(output.metadata ?? {}),
      agentJobId: job.id
    };

    if (output.comment) {
      await this.repos.comments.create({
        projectId: job.projectId,
        targetType: output.comment.targetType,
        targetId: output.comment.targetId,
        authorType: "agent",
        agentType: job.agentType,
        body: output.comment.body,
        metadata: commentMetadata
      });
    } else if (output.questions?.length && target) {
      await this.repos.comments.create({
        projectId: job.projectId,
        targetType: target.targetType,
        targetId: target.targetId,
        authorType: "agent",
        agentType: job.agentType,
        body: output.questions.map((question, index) => `${index + 1}. ${question}`).join("\n"),
        metadata: commentMetadata
      });
    } else if (output.message && target) {
      await this.repos.comments.create({
        projectId: job.projectId,
        targetType: target.targetType,
        targetId: target.targetId,
        authorType: "agent",
        agentType: job.agentType,
        body: output.message,
        metadata: commentMetadata
      });
    }

    if (output.status === "succeeded") {
      await this.applyMetadata(job, output);
    }
    await this.repos.agentJobs.updateStatus(job.projectId, job.id, output.status, {
      output: output as unknown as Record<string, unknown>,
      error: output.status === "failed" ? output.message : null
    });
    await this.updateLoopForResult(job, output);
  }

  private async updateLoopForResult(job: AgentJobDto, result: AgentRunResult): Promise<void> {
    const step = await this.repos.loopSteps.getByAgentJob(job.projectId, job.id);
    if (!step) {
      return;
    }

    const status = loopStatusFromAgentStatus(result.status);
    await this.repos.loopSteps.updateForAgentJob(job.projectId, job.id, {
      status,
      output: result as unknown as Record<string, unknown>,
      evidence: result.evidence ? { items: result.evidence } : null
    });

    const run = await this.repos.loopRuns.updateStatus(job.projectId, step.loopRunId, status, {
      summary: result.message,
      stopReason: result.stopReason ?? null,
      evidence: result.evidence ? { items: result.evidence } : null
    });

    if (run && ["succeeded", "failed", "canceled"].includes(status)) {
      const memoryInput = {
        projectId: job.projectId,
        loopId: run.loopId,
        loopRunId: run.id,
        sourceType: "loop_run" as const,
        sourceId: run.id,
        title: `${job.agentType} loop ${status}`,
        body: result.message,
        tags: ["loop", job.agentType, status]
      };
      await this.repos.loopMemory.create(memoryInput);
      const project = await this.repos.projects.get(job.projectId);
      if (project) {
        await appendLoopMemoryNote(project.repoPath, {
          title: memoryInput.title,
          body: memoryInput.body,
          tags: memoryInput.tags
        }).catch(() => undefined);
      }
    }
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
        const wasReadyToMerge =
          previousPullRequest?.labels.some((previousLabel) => previousLabel.name === workflowLabelNames.readyToMerge) ?? false;
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
          if (job.agentType === "verifier" && label.name === workflowLabelNames.readyToMerge && !wasReadyToMerge) {
            await this.notifyPullRequestReadyToMerge(job);
          }
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

  private async notifyPullRequestReadyToMerge(job: AgentJobDto): Promise<void> {
    const body = "Verifier confirmed the stop condition and evidence. This pull request is ready for user merge.";
    await this.repos.comments.create({
      projectId: job.projectId,
      targetType: "pull_request",
      targetId: job.targetId,
      authorType: "system",
      body,
      metadata: {
        agentJobId: job.id,
        nextLabel: workflowLabelNames.readyToMerge
      }
    });
    await this.repos.activities.create({
      projectId: job.projectId,
      agentJobId: job.id,
      targetType: "pull_request",
      targetId: job.targetId,
      activityType: "system",
      title: "Pull request ready to merge",
      body
    });
  }
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

function changedFileEvidence(changedFiles: string[]): AgentEvidenceResult[] {
  if (!changedFiles.length) {
    return [];
  }

  return [
    {
      type: "file_change",
      title: "Changed files captured",
      summary: `${changedFiles.length} changed file(s) captured for review.`,
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

function verificationEvidence(results: VerificationCommandResult[]): AgentEvidenceResult[] {
  return results.map((result) => ({
    type: result.commandType,
    title: `${result.commandType} command ${result.status}`,
    summary: `${result.command} finished with status ${result.status} and exit code ${result.exitCode ?? "none"}.`,
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

type LoopRiskPolicy = {
  humanGateOnRisk: boolean;
  maxChangedFiles: number | null;
  maxDiffLines: number | null;
  allowedCommands: string[];
  deniedCommands: string[];
  protectedPaths: string[];
  protectedBranches: string[];
};

type RiskSignal = {
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  stopReason?: AgentStopReason;
};

function normalizeRiskPolicy(value: unknown): LoopRiskPolicy {
  const policy = objectValue(value);
  return {
    humanGateOnRisk: policy?.humanGateOnRisk !== false,
    maxChangedFiles: positiveNumber(policy?.maxChangedFiles),
    maxDiffLines: positiveNumber(policy?.maxDiffLines),
    allowedCommands: stringArrayValue(policy?.allowedCommands),
    deniedCommands: stringArrayValue(policy?.deniedCommands),
    protectedPaths: stringArrayValue(policy?.protectedPaths),
    protectedBranches: stringArrayValue(policy?.protectedBranches)
  };
}

function applyVerificationCommandPolicy(
  commands: ProjectCommandDto[],
  policy: LoopRiskPolicy
): { commands: ProjectCommandDto[]; riskSignals: RiskSignal[] } {
  const allowed: ProjectCommandDto[] = [];
  const riskSignals: RiskSignal[] = [];

  for (const command of commands) {
    if (!command.isRequired || !command.isAvailable || !command.command) {
      allowed.push(command);
      continue;
    }

    const deniedPattern = policy.deniedCommands.find((pattern) => matchesPattern(command.command ?? "", pattern));
    const allowedByList =
      policy.allowedCommands.length === 0 ||
      policy.allowedCommands.some((pattern) => matchesPattern(command.command ?? "", pattern));

    if (deniedPattern || !allowedByList) {
      riskSignals.push({
        title: "Verification command blocked",
        summary: `${command.commandType} command was blocked by loop command policy.`,
        payload: {
          commandType: command.commandType,
          command: command.command,
          deniedPattern: deniedPattern ?? null,
          allowedCommands: policy.allowedCommands
        },
        stopReason: "risk_detected"
      });
      continue;
    }

    allowed.push(command);
  }

  return { commands: allowed, riskSignals };
}

async function implementationRiskSignals(input: {
  job: AgentJobDto;
  loop: LoopDto | null;
  repoPath: string;
  project: ProjectDto;
  changedFiles: string[];
  diffLineCount: number;
  riskPolicy: LoopRiskPolicy;
}): Promise<RiskSignal[]> {
  const signals: RiskSignal[] = [];
  const { job, loop, repoPath, changedFiles, diffLineCount, riskPolicy } = input;

  if (typeof riskPolicy.maxChangedFiles === "number" && changedFiles.length > riskPolicy.maxChangedFiles) {
    signals.push({
      title: "Changed file budget exceeded",
      summary: `${changedFiles.length} changed file(s) exceeded the limit of ${riskPolicy.maxChangedFiles}.`,
      payload: {
        changedFiles,
        maxChangedFiles: riskPolicy.maxChangedFiles
      },
      stopReason: "budget_exceeded"
    });
  }

  if (typeof riskPolicy.maxDiffLines === "number" && diffLineCount > riskPolicy.maxDiffLines) {
    signals.push({
      title: "Diff line budget exceeded",
      summary: `${diffLineCount} diff line(s) exceeded the limit of ${riskPolicy.maxDiffLines}.`,
      payload: {
        diffLineCount,
        maxDiffLines: riskPolicy.maxDiffLines
      },
      stopReason: "budget_exceeded"
    });
  }

  const protectedFiles = changedFiles.filter((file) =>
    riskPolicy.protectedPaths.some((pattern) => matchesPathPattern(file, pattern))
  );
  if (protectedFiles.length) {
    signals.push({
      title: "Protected path changed",
      summary: `Changes touched protected path(s): ${protectedFiles.join(", ")}.`,
      payload: {
        protectedFiles,
        protectedPaths: riskPolicy.protectedPaths
      },
      stopReason: "risk_detected"
    });
  }

  const status = await getRepositoryStatus(repoPath).catch(() => null);
  if (status && riskPolicy.protectedBranches.some((pattern) => matchesPattern(status.branch, pattern))) {
    signals.push({
      title: "Protected branch execution",
      summary: `Loop job is running on protected branch ${status.branch}.`,
      payload: {
        branch: status.branch,
        protectedBranches: riskPolicy.protectedBranches
      },
      stopReason: "risk_detected"
    });
  }

  if (loop?.timeBudgetMinutes && job.startedAt) {
    const elapsedMs = Date.now() - Date.parse(job.startedAt);
    if (elapsedMs > loop.timeBudgetMinutes * 60 * 1000) {
      signals.push({
        title: "Time budget exceeded",
        summary: `Loop job exceeded the ${loop.timeBudgetMinutes} minute time budget.`,
        payload: {
          elapsedMs,
          timeBudgetMinutes: loop.timeBudgetMinutes
        },
        stopReason: "timeout"
      });
    }
  }

  return signals;
}

function riskSignalActivities(signals: RiskSignal[]): AgentActivityResult[] {
  return signals.map((signal) => ({
    type: "error",
    title: signal.title,
    body: signal.summary,
    payload: signal.payload
  }));
}

function riskSignalEvidence(signals: RiskSignal[]): AgentEvidenceResult[] {
  return signals.map((signal) => ({
    type: "risk",
    title: signal.title,
    summary: signal.summary,
    payload: signal.payload
  }));
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function matchesPathPattern(value: string, pattern: string): boolean {
  return matchesPattern(value, pattern) || value.startsWith(`${pattern.replace(/\/+$/, "")}/`);
}

function matchesPattern(value: string, pattern: string): boolean {
  if (!pattern) {
    return false;
  }
  if (pattern.includes("*")) {
    const escaped = pattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return new RegExp(`^${escaped}$`).test(value);
  }
  return value === pattern || value.includes(pattern);
}

function uniqueStrings(items: string[]): string[] {
  return Array.from(new Set(items));
}

function withDefaultStopReason(result: AgentRunResult): AgentRunResult {
  return {
    ...result,
    stopReason: result.stopReason ?? defaultStopReason(result.status),
    evidence: result.evidence ?? []
  };
}

function defaultStopReason(status: AgentRunResult["status"]): AgentStopReason {
  if (status === "succeeded") {
    return "passed";
  }
  if (status === "waiting_human") {
    return "waiting_human";
  }
  if (status === "canceled") {
    return "canceled";
  }
  return "failed";
}

function loopStatusFromAgentStatus(status: AgentRunResult["status"]): "succeeded" | "waiting_human" | "failed" | "canceled" {
  if (status === "succeeded") {
    return "succeeded";
  }
  if (status === "waiting_human") {
    return "waiting_human";
  }
  if (status === "canceled") {
    return "canceled";
  }
  return "failed";
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

  if (agentType === "verifier") {
    const verifier = objectValue(metadata.verifier);
    const verdict = stringValue(verifier?.verdict);
    if (verifier?.stopConditionMet === true || verdict === "passed") {
      return workflowLabelNames.readyToMerge;
    }
    if (verdict === "failed") {
      return workflowLabelNames.fixing;
    }
    if (verdict === "missing_evidence") {
      return workflowLabelNames.needsInput;
    }
  }

  return null;
}

function normalizePullRequestNextLabel(agentType: AgentJobDto["agentType"], nextLabel: unknown): string | null {
  if (typeof nextLabel !== "string") {
    return null;
  }
  if (agentType === "verifier" && nextLabel === workflowLabelNames.done) {
    return workflowLabelNames.readyToMerge;
  }
  return nextLabel;
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

  if (agentType === "verifier") {
    const verifier = objectValue(metadata.verifier);
    if (!verifier) {
      return [];
    }
    const missingEvidence = stringArrayValue(verifier.missingEvidence);
    const notes = stringArrayValue(verifier.notes);
    const verdict = stringValue(verifier.verdict) ?? "unknown";
    return [
      {
        type: missingEvidence.length ? "error" : "test",
        title: missingEvidence.length ? "Verifier missing evidence" : "Verifier stop condition checked",
        body: [structuredActivityBody(`verdict: ${verdict}`, missingEvidence), ...notes.map((note) => `- ${note}`)].join("\n"),
        payload: {
          verifier
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
