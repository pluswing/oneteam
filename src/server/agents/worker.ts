import type { AgentJobDto, LabelDto, LoopDto, ProjectCommandDto, ProjectDto } from "../../shared/types";
import { workflowLabelNames } from "../../shared/workflow-labels";
import { repositoryCommitPath } from "../../shared/repository-anchors";
import type { Repositories } from "../db/repositories";
import {
  commitAllChanges,
  detectMergeConflicts,
  getChangedFilesSince,
  getDiffLineCountSince,
  getDiffPatchSince,
  getRepositoryStatus
} from "../services/git-service";
import { runLabelAutomation } from "../services/label-automation";
import { scanScoreManipulationRisks } from "../services/diff-risk-scanner";
import { appendLoopMemoryNote } from "../services/knowledge-files";
import { runVerificationCommands, type VerificationCommandResult } from "../services/verification-runner";
import {
  cleanupWorktree,
  prepareIssueWorktree,
  preparePullRequestWorktree,
  RecoverableWorktreeError,
  type PreparedWorktree
} from "../services/worktree-service";
import {
  applyObjectiveHardGate,
  markObjectiveJobStarted,
  preflightObjectiveJob,
  recordObjectiveJobResult
} from "../services/objective-runs";
import { classifyProviderWait, enterProviderWait, resumeProviderWait } from "../services/provider-wait";
import { mergePullRequest } from "../services/pull-request-merge";
import { buildSystemComment } from "../services/system-comment";
import { buildAgentMilestoneComment } from "../services/agent-milestone-comment";
import { normalizeEvidenceArtifacts } from "../services/evidence-artifacts";
import { advanceObjectiveWorkflowStage } from "../services/objective-workflow";
import {
  recordIssueImplementationStarted,
  recordLinkedIssueAgentMilestone,
  recordLinkedIssuePullRequestCreated
} from "../services/linked-issue-milestone";
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
      const dueProviderWaits = await this.repos.agentJobs.listDueProviderWaits(new Date().toISOString());
      for (const waitingJob of dueProviderWaits) {
        await resumeProviderWait(this.repos, waitingJob, "automatic");
      }
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
    const objectivePreflightResult = await preflightObjectiveJob(this.repos, job);
    if (objectivePreflightResult) {
      await this.applyResult(job, objectivePreflightResult);
      return;
    }

    const runningJob = await this.repos.agentJobs.updateStatus(job.projectId, job.id, "running");
    if (!runningJob) {
      return;
    }
    await markObjectiveJobStarted(this.repos, runningJob);

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
      const executionRepoPath = worktree?.repoPath ?? project.repoPath;
      if (worktree) {
        await recordIssueImplementationStarted(this.repos, runningJob, worktree);
      }
      const result = await this.adapter.run({
        job: runningJob,
        repoPath: executionRepoPath,
        prompt,
        isCanceled: async () => {
          const current = await this.repos.agentJobs.get(runningJob.projectId, runningJob.id);
          return current?.status === "canceled" || current?.status === "paused";
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
      if (currentJob?.status === "paused") {
        return;
      }
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

      const providerWait = classifyProviderWait(runningJob, result);
      if (providerWait) {
        await enterProviderWait(this.repos, runningJob, providerWait);
        return;
      }

      let finalizedResult = await this.finalizeImplementationResult(runningJob, project, executionRepoPath, result);
      finalizedResult = await this.finalizePullRequestWorkflowResult(runningJob, project, executionRepoPath, finalizedResult);
      finalizedResult = {
        ...finalizedResult,
        evidence: await normalizeEvidenceArtifacts({
          project,
          job: runningJob,
          executionRepoPath,
          evidence: finalizedResult.evidence
        })
      };
      finalizedResult = await applyObjectiveHardGate(this.repos, runningJob, finalizedResult);
      await this.applyResult(runningJob, finalizedResult);
      if (worktree && ["succeeded", "canceled"].includes(finalizedResult.status)) {
        await cleanupWorktree(project, worktree.worktreePath);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Agent job failed.";
      const providerWait = classifyProviderWait(runningJob, { status: "failed", message });
      if (providerWait) {
        await enterProviderWait(this.repos, runningJob, providerWait);
        return;
      }
      const recovery = classifyRecoverableRuntimeError(error);
      if (recovery) {
        await this.requeueAfterRecovery(runningJob, {
          ...recovery,
          message
        });
        return;
      }

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
      const failedResult: AgentRunResult = {
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
      };
      await this.updateLoopForResult(runningJob, failedResult);
      await recordObjectiveJobResult(this.repos, { job: runningJob, result: failedResult });
    }
  }

  private async requeueAfterRecovery(
    job: AgentJobDto,
    recovery: { code: string; message: string; payload?: Record<string, unknown> }
  ): Promise<void> {
    const currentJob = await this.repos.agentJobs.get(job.projectId, job.id);
    if (!currentJob || currentJob.status === "canceled") {
      return;
    }

    const recoveryMessage = `${recovery.message}\n\nOneTeam marked this as a recoverable runtime error and requeued the job automatically.`;
    const evidence = [
      {
        type: "error" as const,
        title: "Agent job auto-recovered",
        summary: recovery.message,
        payload: {
          code: recovery.code,
          ...(recovery.payload ?? {})
        }
      }
    ];
    const output = {
      status: "queued",
      message: recoveryMessage,
      stopReason: "auto_recovered",
      evidence,
      metadata: {
        autoRecovery: {
          code: recovery.code,
          attempt: currentJob.attempt + 1,
          payload: recovery.payload ?? null
        }
      }
    };
    const target = normalizeActivityTarget(job);
    if (target) {
      await this.repos.activities.create({
        projectId: job.projectId,
        agentJobId: job.id,
        targetType: target.targetType,
        targetId: target.targetId,
        activityType: "system",
        title: "Agent job auto-recovered",
        body: recoveryMessage,
        payload: {
          code: recovery.code,
          ...(recovery.payload ?? {})
        }
      });
    }

    await this.repos.agentJobs.requeueAfterRecovery(job.projectId, job.id, {
      output,
      error: recovery.message
    });

    const step = await this.repos.loopSteps.getByAgentJob(job.projectId, job.id);
    if (!step) {
      return;
    }

    await this.repos.loopSteps.updateForAgentJob(job.projectId, job.id, {
      status: "queued",
      output,
      evidence: { items: evidence }
    });
    await this.repos.loopRuns.updateStatus(job.projectId, step.loopRunId, "queued", {
      summary: recoveryMessage,
      stopReason: "auto_recovered",
      evidence: { items: evidence }
    });
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
            body: `Committed ${commitResult.changedFiles.length} changed file(s).\n\nCommit: [\`${commitResult.commitHash}\`](${repositoryCommitPath(commitResult.commitHash)})`,
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
      metadata: {
        ...(result.metadata ?? {}),
        implementationCommit: commitResult.commitHash,
        ...(riskSignals.length
          ? {
            riskSignals: riskSignals.map((signal) => ({
              title: signal.title,
              summary: signal.summary,
              payload: signal.payload,
              stopReason: signal.stopReason ?? "risk_detected"
            }))
          }
          : {})
      }
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
  ): Promise<PreparedWorktree | null> {
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
    worktree: PreparedWorktree
  ): Promise<void> {
    await this.repos.activities.create({
      projectId: job.projectId,
      agentJobId: job.id,
      targetType,
      targetId,
      activityType: "progress",
      title: "Worktree ready",
      body: worktree.recovered
        ? `Recovered ${worktree.branchName} in ${worktree.worktreePath}.`
        : `Prepared ${worktree.branchName} in ${worktree.worktreePath}.`,
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
        body:
          output.comment.bodyFormat === "html"
            ? output.comment.body
            : buildAgentMilestoneComment(job, output),
        bodyFormat: output.comment.bodyFormat === "html" ? "html" : "markdown",
        metadata: commentMetadata
      });
    } else if (output.questions?.length && target) {
      await this.repos.comments.create({
        projectId: job.projectId,
        targetType: target.targetType,
        targetId: target.targetId,
        authorType: "agent",
        agentType: job.agentType,
        body: buildAgentMilestoneComment(job, output),
        metadata: commentMetadata
      });
    } else if (output.message && target) {
      await this.repos.comments.create({
        projectId: job.projectId,
        targetType: target.targetType,
        targetId: target.targetId,
        authorType: "agent",
        agentType: job.agentType,
        body: buildAgentMilestoneComment(job, output),
        metadata: commentMetadata
      });
    }

    if (output.status === "succeeded") {
      await advanceObjectiveWorkflowStage(this.repos, job, output);
      await this.applyMetadata(job, output);
    }
    await this.repos.agentJobs.updateStatus(job.projectId, job.id, output.status, {
      output: output as unknown as Record<string, unknown>,
      error: output.status === "failed" ? output.message : null
    });
    await this.updateLoopForResult(job, output);
    await recordObjectiveJobResult(this.repos, { job, result: output });
    if (
      output.status === "succeeded" &&
      job.agentType === "verifier" &&
      job.targetType === "pull_request" &&
      output.metadata?.verifier?.stopConditionMet === true
    ) {
      await this.tryAutomaticMerge(job);
    }
  }

  private async tryAutomaticMerge(job: AgentJobDto): Promise<void> {
    const [project, pullRequest] = await Promise.all([
      this.repos.projects.get(job.projectId),
      this.repos.pullRequests.get(job.projectId, job.targetId)
    ]);
    if (!project || !pullRequest) {
      return;
    }
    try {
      await mergePullRequest(this.repos, {
        project,
        pullRequest,
        mode: "automatic",
        verifierJob: job
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Automatic merge failed unexpectedly.";
      const objective = await this.repos.objectives.findByPullRequest(job.projectId, pullRequest.id);
      if (objective) {
        await this.repos.objectives.update(job.projectId, objective.id, {
          status: "waiting_human",
          stopReason: "automatic_merge_failed",
          summary: message
        });
      }
      await this.repos.comments.create({
        projectId: job.projectId,
        targetType: "pull_request",
        targetId: pullRequest.id,
        authorType: "system",
        body: buildSystemComment({
          title: "Automatic merge failed",
          outcome: "failed",
          summary: message,
          fields: [
            { label: "Pull request", value: `#${pullRequest.id}`, code: true },
            { label: "Verifier job", value: `#${job.id}`, code: true },
            { label: "Source branch", value: pullRequest.sourceBranch, code: true },
            { label: "Target branch", value: pullRequest.targetBranch, code: true },
            { label: "Stop reason", value: "automatic_merge_failed", code: true }
          ],
          sections: [
            {
              title: "Preserved state",
              items: [
                "The verifier result and evidence remain attached to the Objective.",
                "No merge status was recorded for this Pull Request."
              ]
            }
          ],
          nextStep: "Inspect the repository and error details, then rerun verification before retrying merge."
        }),
        bodyFormat: "markdown",
        metadata: { agentJobId: job.id, automaticMerge: "failed" }
      });
    }
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
          createdByType: "agent",
          labelIds: reviewLabel ? [reviewLabel.id] : []
        });
        await runLabelAutomation(this.repos, {
          projectId: job.projectId,
          targetType: "pull_request",
          targetId: pullRequest.id,
          labels: pullRequest.labels,
          triggerType: "pull_request_created"
        });
        await recordLinkedIssuePullRequestCreated(this.repos, job, pullRequest);
      }
    }

    await recordLinkedIssueAgentMilestone(this.repos, job, result);
  }

  private async notifyPullRequestReadyToMerge(job: AgentJobDto): Promise<void> {
    const body = buildSystemComment({
      title: "Pull request ready to merge",
      outcome: "ready",
      summary: "The verifier confirmed the stop condition against the current evidence snapshot.",
      fields: [
        { label: "Pull request", value: `#${job.targetId}`, code: true },
        { label: "Verifier job", value: `#${job.id}`, code: true },
        { label: "Workflow state", value: workflowLabelNames.readyToMerge, code: true }
      ],
      sections: [
        {
          title: "Decision",
          items: [
            "The Pull Request reached the pre-merge state.",
            "Merge eligibility will still be rechecked against conflicts, branch snapshots, required commands, and risk policy."
          ]
        }
      ],
      nextStep: "OneTeam will attempt the automatic merge gate. If policy disables automatic merge or the gate cannot prove safety, the Pull Request remains available for manual review."
    });
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

type RuntimeRecovery = {
  code: string;
  message: string;
  payload?: Record<string, unknown>;
};

const recoverableRuntimeErrorPatterns: Array<{ code: string; pattern: RegExp }> = [
  {
    code: "git_worktree_branch_in_use",
    pattern: /already used by worktree|is already checked out at|is already used by worktree/i
  },
  {
    code: "git_lock",
    pattern: /index\.lock|cannot lock ref|could not lock|another git process|unable to create .*\.lock/i
  },
  {
    code: "sqlite_busy",
    pattern: /SQLITE_BUSY|database is locked/i
  },
  {
    code: "transient_process_io",
    pattern: /\b(?:EBUSY|EAGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|EPIPE|ENFILE|EMFILE)\b/i
  }
];

function classifyRecoverableRuntimeError(error: unknown): RuntimeRecovery | null {
  if (error instanceof RecoverableWorktreeError) {
    return {
      code: error.code,
      message: error.message,
      payload: error.payload
    };
  }

  const output = errorOutput(error);
  if (!output) {
    return null;
  }

  const match = recoverableRuntimeErrorPatterns.find((item) => item.pattern.test(output));
  if (!match) {
    return null;
  }

  return {
    code: match.code,
    message: error instanceof Error ? error.message : output,
    payload: {
      output: output.slice(0, 4000)
    }
  };
}

function errorOutput(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return typeof error === "string" ? error : "";
  }
  const output = error as { message?: unknown; stdout?: unknown; stderr?: unknown; code?: unknown };
  return [output.stderr, output.stdout, output.message, output.code]
    .filter((value): value is string | number => (typeof value === "string" && value.length > 0) || typeof value === "number")
    .map(String)
    .join("\n");
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
  const { job, loop, repoPath, project, changedFiles, diffLineCount, riskPolicy } = input;

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

  const diffPatch = await getDiffPatchSince(repoPath, project.defaultBranch).catch(() => "");
  signals.push(...scanScoreManipulationRisks(diffPatch));

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
