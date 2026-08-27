import type { AgentJobDto, ObjectiveRunDto, ProjectDto, PullRequestDto } from "../../shared/types";
import { workflowLabelNames } from "../../shared/workflow-labels";
import type { Repositories } from "../db/repositories";
import {
  commitAllChanges,
  detectMergeConflicts,
  getChangedFilesSince,
  getDiffLineCountSince,
  getDiffPatchSince,
  getMergeBase,
  getRepositoryStatus,
  getRevisionHash,
  mergeBranch
} from "./git-service";
import { scanScoreManipulationRisks } from "./diff-risk-scanner";
import { runLabelAutomation } from "./label-automation";
import { appendObjectiveEvidence, markObjectiveMerged } from "./objective-runs";
import { readAutomationSettings } from "./automation-settings";
import { runVerificationCommands, type VerificationCommandResult } from "./verification-runner";
import { cleanupWorktree, preparePullRequestWorktree } from "./worktree-service";

export type PullRequestMergeResult =
  | { state: "merged"; pullRequest: PullRequestDto; mergeCommit: string; output: string }
  | { state: "blocked"; reason: string }
  | { state: "skipped"; reason: string };

export async function mergePullRequest(
  repos: Repositories,
  input: {
    project: ProjectDto;
    pullRequest: PullRequestDto;
    mode: "automatic" | "manual";
    verifierJob?: AgentJobDto;
  }
): Promise<PullRequestMergeResult> {
  const { project, pullRequest, mode } = input;
  if (mode === "automatic") {
    const gate = await checkAutomaticMergeGate(repos, project, pullRequest, input.verifierJob);
    if (gate) {
      if (gate.state === "blocked") {
        await recordAutomaticMergeBlock(repos, project, pullRequest, input.verifierJob ?? null, gate.reason, gate.conflicts);
      }
      return { state: gate.state, reason: gate.reason };
    }
  } else if (pullRequest.status !== "open") {
    return { state: "blocked", reason: "Only open pull requests can be merged." };
  }

  let repositoryStatus = await getRepositoryStatus(project.repoPath);
  if (!repositoryStatus.clean) {
    if (mode === "manual" && repositoryStatus.branch === pullRequest.sourceBranch) {
      await commitAllChanges(project.repoPath, `Prepare pull request #${pullRequest.id}: ${pullRequest.title}`);
      repositoryStatus = await getRepositoryStatus(project.repoPath);
    }
    if (!repositoryStatus.clean) {
      const reason = `Working tree must be clean before merge. Changed files: ${repositoryStatus.changedFiles.join(", ")}`;
      if (mode === "automatic") {
        await recordAutomaticMergeBlock(repos, project, pullRequest, input.verifierJob ?? null, reason, false);
      }
      return { state: "blocked", reason };
    }
  }

  const sourceHead = await getRevisionHash(project.repoPath, pullRequest.sourceBranch);
  const targetHead = await getRevisionHash(project.repoPath, pullRequest.targetBranch);
  const mergeBase = await getMergeBase(project.repoPath, pullRequest.targetBranch, pullRequest.sourceBranch);
  let automaticGateEvidence: AutomaticGateEvidence | null = null;
  if (mode === "automatic" && input.verifierJob) {
    const verification = await verifyAutomaticMergeCandidate(
      repos,
      project,
      pullRequest,
      input.verifierJob,
      sourceHead,
      targetHead,
      mergeBase
    );
    automaticGateEvidence = verification.evidence;
    if (verification.blockedReason) {
      await recordAutomaticMergeBlock(
        repos,
        project,
        pullRequest,
        input.verifierJob,
        verification.blockedReason,
        false
      );
      return { state: "blocked", reason: verification.blockedReason };
    }
  }
  const conflicts = await detectMergeConflicts(project.repoPath, pullRequest.sourceBranch, pullRequest.targetBranch);
  if (conflicts.hasConflicts) {
    const reason = `Merge conflicts detected: ${conflicts.files.map((file) => file.path).join(", ")}`;
    if (mode === "automatic") {
      await recordAutomaticMergeBlock(repos, project, pullRequest, input.verifierJob ?? null, reason, true);
    }
    return { state: "blocked", reason };
  }

  const [currentSourceHead, currentTargetHead] = await Promise.all([
    getRevisionHash(project.repoPath, pullRequest.sourceBranch),
    getRevisionHash(project.repoPath, pullRequest.targetBranch)
  ]);
  if (sourceHead !== currentSourceHead || targetHead !== currentTargetHead) {
    const reason = "Source or target branch changed during the automatic merge gate. A fresh verification is required.";
    if (mode === "automatic") {
      await recordAutomaticMergeBlock(repos, project, pullRequest, input.verifierJob ?? null, reason, false);
    }
    return { state: "blocked", reason };
  }

  const mergeResult = await mergeBranch(project.repoPath, pullRequest.sourceBranch, pullRequest.targetBranch);
  const doneLabel = await repos.labels.findByName(project.id, workflowLabelNames.done);
  const mergedPullRequest = await repos.pullRequests.update(project.id, pullRequest.id, {
    status: "merged",
    labelIds: doneLabel ? [doneLabel.id] : undefined
  });
  if (!mergedPullRequest) {
    throw new Error("Pull request disappeared after its branches were merged.");
  }

  const mergeBody = [
    `## ${mode === "automatic" ? "Automatically merged" : "Merged"}`,
    "",
    `Merged \`${pullRequest.sourceBranch}\` into \`${pullRequest.targetBranch}\`.`,
    "",
    `- Merge commit: \`${mergeResult.mergeCommit.slice(0, 12)}\``,
    `- Source snapshot: \`${sourceHead.slice(0, 12)}\``,
    `- Target snapshot: \`${targetHead.slice(0, 12)}\``,
    `- Merge base: \`${mergeBase.slice(0, 12)}\``,
    automaticGateEvidence
      ? `- Required checks: ${automaticGateEvidence.commandResults.length || "none configured"}`
      : null,
    input.verifierJob ? `- Verifier job: \`#${input.verifierJob.id}\`` : null
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
  await repos.comments.create({
    projectId: project.id,
    targetType: "pull_request",
    targetId: pullRequest.id,
    authorType: "system",
    body: mergeBody,
    bodyFormat: "markdown",
    metadata: {
      mergeMode: mode,
      mergeCommit: mergeResult.mergeCommit,
      sourceHead,
      targetHead,
      mergeBase,
      automaticGateEvidence,
      verifierJobId: input.verifierJob?.id ?? null
    }
  });
  await repos.activities.create({
    projectId: project.id,
    agentJobId: input.verifierJob?.id ?? null,
    targetType: "pull_request",
    targetId: pullRequest.id,
    activityType: "system",
    title: mode === "automatic" ? "Pull request automatically merged" : "Pull request merged",
    body: mergeBody,
    payload: {
      mergeMode: mode,
      mergeCommit: mergeResult.mergeCommit,
      sourceHead,
      targetHead,
      mergeBase,
      automaticGateEvidence
    }
  });

  await markObjectiveMerged(repos, {
    project,
    pullRequest: mergedPullRequest,
    mergeCommit: mergeResult.mergeCommit
  });
  await closeLinkedIssue(repos, project, mergedPullRequest, mergeResult.mergeCommit);

  return {
    state: "merged",
    pullRequest: mergedPullRequest,
    mergeCommit: mergeResult.mergeCommit,
    output: mergeResult.output
  };
}

type AutomaticGateEvidence = {
  capturedAt: string;
  sourceHead: string;
  targetHead: string;
  mergeBase: string;
  changedFiles: string[];
  diffLineCount: number;
  commandResults: Array<Omit<VerificationCommandResult, "output"> & { outputExcerpt: string }>;
  riskSignals: Array<{ title: string; summary: string; payload: Record<string, unknown> }>;
  verifierEvidenceCapturedAt: string;
};

async function verifyAutomaticMergeCandidate(
  repos: Repositories,
  project: ProjectDto,
  pullRequest: PullRequestDto,
  verifierJob: AgentJobDto,
  sourceHead: string,
  targetHead: string,
  mergeBase: string
): Promise<{ blockedReason: string | null; evidence: AutomaticGateEvidence }> {
  const objective = await repos.objectives.findByPullRequest(project.id, pullRequest.id);
  const verifierEvidence = objective ? currentVerifierEvidence(objective, verifierJob, sourceHead) : null;
  const capturedAt = new Date().toISOString();
  const commands = await repos.commands.list(project.id);
  const missingRequiredCommands = commands.filter(
    (command) => command.isRequired && (!command.isAvailable || !command.command)
  );
  const emptyEvidence: AutomaticGateEvidence = {
    capturedAt,
    sourceHead,
    targetHead,
    mergeBase,
    changedFiles: [],
    diffLineCount: 0,
    commandResults: [],
    riskSignals: [],
    verifierEvidenceCapturedAt: verifierEvidence?.capturedAt ?? ""
  };

  if (!objective || !verifierEvidence) {
    const reason = "Verifier evidence is stale or does not reference the current source commit.";
    await persistAutomaticGateEvidence(repos, objective, emptyEvidence, "failed", reason);
    return { blockedReason: reason, evidence: emptyEvidence };
  }
  if (missingRequiredCommands.length) {
    const reason = `Required commands are unavailable: ${missingRequiredCommands
      .map((command) => command.commandType)
      .join(", ")}.`;
    await persistAutomaticGateEvidence(repos, objective, emptyEvidence, "failed", reason);
    return { blockedReason: reason, evidence: emptyEvidence };
  }

  const worktree = await preparePullRequestWorktree(project, pullRequest);
  try {
    const beforeStatus = await getRepositoryStatus(worktree.repoPath);
    if (!beforeStatus.clean) {
      const reason = `Source worktree contains uncommitted changes: ${beforeStatus.changedFiles.join(", ")}.`;
      await persistAutomaticGateEvidence(repos, objective, emptyEvidence, "failed", reason);
      return { blockedReason: reason, evidence: emptyEvidence };
    }

    const commandResults = await runVerificationCommands(worktree.repoPath, commands);
    const [changedFiles, diffLineCount, diffPatch] = await Promise.all([
      getChangedFilesSince(worktree.repoPath, pullRequest.targetBranch),
      getDiffLineCountSince(worktree.repoPath, pullRequest.targetBranch),
      getDiffPatchSince(worktree.repoPath, pullRequest.targetBranch)
    ]);
    const riskSignals = scanScoreManipulationRisks(diffPatch);
    const evidence: AutomaticGateEvidence = {
      ...emptyEvidence,
      capturedAt: new Date().toISOString(),
      changedFiles,
      diffLineCount,
      commandResults: commandResults.map(({ output, ...result }) => ({
        ...result,
        outputExcerpt: output.slice(0, 2000)
      })),
      riskSignals: riskSignals.map((signal) => ({
        title: signal.title,
        summary: signal.summary,
        payload: signal.payload
      }))
    };
    const failedCommands = commandResults.filter((result) => result.status === "failed");
    if (failedCommands.length) {
      const reason = `Required commands failed: ${failedCommands.map((result) => result.commandType).join(", ")}.`;
      await persistAutomaticGateEvidence(repos, objective, evidence, "failed", reason);
      return { blockedReason: reason, evidence };
    }
    if (riskSignals.length) {
      const reason = `Risk signals block automatic merge: ${riskSignals.map((signal) => signal.title).join(", ")}.`;
      await persistAutomaticGateEvidence(repos, objective, evidence, "failed", reason);
      return { blockedReason: reason, evidence };
    }

    const [currentSourceHead, afterStatus] = await Promise.all([
      getRevisionHash(project.repoPath, pullRequest.sourceBranch),
      getRepositoryStatus(worktree.repoPath)
    ]);
    if (currentSourceHead !== sourceHead || !afterStatus.clean) {
      const reason = currentSourceHead !== sourceHead
        ? "Source branch changed while merge verification was running."
        : `Required commands modified tracked files: ${afterStatus.changedFiles.join(", ")}.`;
      await persistAutomaticGateEvidence(repos, objective, evidence, "failed", reason);
      return { blockedReason: reason, evidence };
    }

    await persistAutomaticGateEvidence(repos, objective, evidence, "passed", "All automatic merge checks passed.");
    return { blockedReason: null, evidence };
  } finally {
    if (!worktree.recovered) {
      await cleanupWorktree(project, worktree.worktreePath);
    }
  }
}

function currentVerifierEvidence(
  objective: ObjectiveRunDto,
  verifierJob: AgentJobDto,
  sourceHead: string
): { capturedAt: string } | null {
  const items = Array.isArray(objective.evidence?.items) ? objective.evidence.items : [];
  const maximumAgeMs = 24 * 60 * 60 * 1000;
  for (const item of items) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const payload = "payload" in item && typeof item.payload === "object" && item.payload !== null ? item.payload : null;
    if (!payload) {
      continue;
    }
    const capturedAt = "capturedAt" in payload && typeof payload.capturedAt === "string" ? payload.capturedAt : null;
    const capturedAtMs = capturedAt ? Date.parse(capturedAt) : Number.NaN;
    const sourceCommit = "sourceCommit" in payload ? payload.sourceCommit : null;
    const judgeAgentJobId = "judgeAgentJobId" in payload ? payload.judgeAgentJobId : null;
    const agentJobId = "agentJobId" in payload ? payload.agentJobId : null;
    if (
      capturedAt &&
      Number.isFinite(capturedAtMs) &&
      Date.now() - capturedAtMs <= maximumAgeMs &&
      sourceCommit === sourceHead &&
      (judgeAgentJobId === verifierJob.id || agentJobId === verifierJob.id)
    ) {
      return { capturedAt };
    }
  }
  return null;
}

async function persistAutomaticGateEvidence(
  repos: Repositories,
  objective: ObjectiveRunDto | null,
  evidence: AutomaticGateEvidence,
  status: "passed" | "failed",
  summary: string
): Promise<void> {
  if (!objective) {
    return;
  }
  await appendObjectiveEvidence(repos, objective, [
    {
      type: "automatic_merge_gate",
      title: `Automatic merge gate ${status}`,
      summary,
      payload: {
        ...evidence,
        status
      }
    }
  ]);
}

async function checkAutomaticMergeGate(
  repos: Repositories,
  project: ProjectDto,
  pullRequest: PullRequestDto,
  verifierJob?: AgentJobDto
): Promise<{ state: "blocked" | "skipped"; reason: string; conflicts: boolean } | null> {
  const automation = await readAutomationSettings(repos);
  if (!automation.autoMergeEnabled) {
    return { state: "skipped", reason: "Automatic merge is disabled in project settings.", conflicts: false };
  }
  if (!verifierJob || verifierJob.agentType !== "verifier") {
    return { state: "skipped", reason: "A successful verifier job is required for automatic merge.", conflicts: false };
  }
  if (pullRequest.status !== "open") {
    return { state: "skipped", reason: "The pull request is no longer open.", conflicts: false };
  }
  const labelNames = new Set(pullRequest.labels.map((label) => label.name));
  if (!labelNames.has(workflowLabelNames.readyToMerge)) {
    return { state: "skipped", reason: "The pull request is not marked ready-to-merge.", conflicts: false };
  }
  if (labelNames.has(workflowLabelNames.needsInput)) {
    return { state: "blocked", reason: "The pull request still requires human input.", conflicts: false };
  }
  const objective = await repos.objectives.findByPullRequest(project.id, pullRequest.id);
  if (!objective) {
    return {
      state: "skipped",
      reason: "No Objective is linked to this pull request, so it remains ready for manual merge.",
      conflicts: false
    };
  }
  const evidence = objective?.evidence?.items;
  if (
    objective.status !== "ready_to_merge" ||
    objective.judgeAgentJobId !== verifierJob.id ||
    !Array.isArray(evidence) ||
    evidence.length === 0
  ) {
    return {
      state: "blocked",
      reason: "The Objective does not have a current verifier decision and evidence snapshot.",
      conflicts: false
    };
  }
  return null;
}

async function recordAutomaticMergeBlock(
  repos: Repositories,
  project: ProjectDto,
  pullRequest: PullRequestDto,
  verifierJob: AgentJobDto | null,
  reason: string,
  conflicts: boolean
): Promise<void> {
  const labelName = conflicts ? workflowLabelNames.resolvingConflicts : workflowLabelNames.needsInput;
  const label = await repos.labels.findByName(project.id, labelName);
  let updatedPullRequest = pullRequest;
  if (label) {
    updatedPullRequest =
      (await repos.pullRequests.update(project.id, pullRequest.id, { labelIds: [label.id] })) ?? pullRequest;
  }
  const objective = await repos.objectives.findByPullRequest(project.id, pullRequest.id);
  if (objective) {
    await repos.objectives.update(project.id, objective.id, {
      status: conflicts ? "running" : "waiting_human",
      stopReason: conflicts ? "merge_conflict" : "automatic_merge_blocked",
      summary: reason
    });
  }
  const body = [
    "## Automatic merge paused",
    "",
    reason,
    "",
    conflicts
      ? "OneTeam queued the conflict-resolution workflow. Verification must pass again before merge."
      : "Review the repository state, then resume the workflow or merge manually.",
    verifierJob ? `\nVerifier job: \`#${verifierJob.id}\`` : null
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
  await repos.comments.create({
    projectId: project.id,
    targetType: "pull_request",
    targetId: pullRequest.id,
    authorType: "system",
    body,
    bodyFormat: "markdown",
    metadata: { automaticMerge: "blocked", reason, conflicts, verifierJobId: verifierJob?.id ?? null }
  });
  await repos.activities.create({
    projectId: project.id,
    agentJobId: verifierJob?.id ?? null,
    targetType: "pull_request",
    targetId: pullRequest.id,
    activityType: "system",
    title: "Automatic merge paused",
    body,
    payload: { reason, conflicts }
  });
  if (conflicts) {
    await runLabelAutomation(repos, {
      projectId: project.id,
      targetType: "pull_request",
      targetId: pullRequest.id,
      labels: updatedPullRequest.labels,
      previousLabels: pullRequest.labels,
      triggerType: "automatic_merge_conflict"
    });
  }
}

async function closeLinkedIssue(
  repos: Repositories,
  project: ProjectDto,
  pullRequest: PullRequestDto,
  mergeCommit: string
): Promise<void> {
  if (!pullRequest.issueId) {
    return;
  }
  const issue = await repos.issues.get(project.id, pullRequest.issueId);
  if (!issue) {
    return;
  }
  const doneLabel = await repos.labels.findByName(project.id, workflowLabelNames.done);
  await repos.issues.update(project.id, issue.id, {
    status: "closed",
    labelIds: doneLabel ? [doneLabel.id] : undefined
  });
  await repos.comments.create({
    projectId: project.id,
    targetType: "issue",
    targetId: issue.id,
    authorType: "system",
    body: [
      "## Objective completed",
      "",
      `Pull request #${pullRequest.id} was merged and the linked Issue was closed.`,
      "",
      `- Merge commit: \`${mergeCommit.slice(0, 12)}\``,
      `- Source branch: \`${pullRequest.sourceBranch}\``,
      `- Target branch: \`${pullRequest.targetBranch}\``
    ].join("\n"),
    bodyFormat: "markdown",
    metadata: { pullRequestId: pullRequest.id, mergeCommit }
  });
}
