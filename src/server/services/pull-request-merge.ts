import type { AgentJobDto, ProjectDto, PullRequestDto } from "../../shared/types";
import { workflowLabelNames } from "../../shared/workflow-labels";
import type { Repositories } from "../db/repositories";
import {
  commitAllChanges,
  detectMergeConflicts,
  getRepositoryStatus,
  getRevisionHash,
  mergeBranch
} from "./git-service";
import { runLabelAutomation } from "./label-automation";
import { markObjectiveMerged } from "./objective-runs";
import { readAutomationSettings } from "./automation-settings";

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
      targetHead
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
