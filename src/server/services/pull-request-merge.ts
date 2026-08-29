import type {
  AgentJobDto,
  LoopMemoryEntryDto,
  ObjectiveRunDto,
  ProjectDto,
  ProjectSettingsDto,
  PullRequestDto
} from "../../shared/types";
import { diffFileAnchor, diffLineAnchor } from "../../shared/diff-anchors";
import { workflowLabelNames } from "../../shared/workflow-labels";
import { repositoryCommitPath } from "../../shared/repository-anchors";
import { evidenceGateFailureSummary, evaluateEvidenceRequirements } from "../../shared/evidence-requirements";
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
  mergeBranch,
  type GitRetryEvent
} from "./git-service";
import { riskSignalsAtOrAbove, scanScoreManipulationRisks } from "./diff-risk-scanner";
import { runLabelAutomation } from "./label-automation";
import { appendObjectiveEvidence, markObjectiveMerged } from "./objective-runs";
import { readAutomationSettings } from "./automation-settings";
import { buildSystemComment, markdownCode, type SystemCommentSection } from "./system-comment";
import { runVerificationCommands, type VerificationCommandResult } from "./verification-runner";
import { cleanupWorktree, preparePullRequestWorktree } from "./worktree-service";
import { ensureSystemLoop, startLoopRun } from "./loop-runner";
import {
  applyAutomaticMergeCommandPolicy,
  evaluateAutomaticMergeLoopDiffPolicy,
  resolveAutomaticMergeLoopContext
} from "./automatic-merge-risk-policy";
import {
  extractImportantDiffReferences,
  type ImportantDiffReference
} from "./important-diff-references";

export type PullRequestMergeResult =
  | { state: "merged"; pullRequest: PullRequestDto; mergeCommit: string; output: string }
  | { state: "requeued"; reason: string; verifierJob: AgentJobDto }
  | { state: "blocked"; reason: string }
  | { state: "skipped"; reason: string };

class AutomaticMergeSnapshotDriftError extends Error {
  constructor(
    message: string,
    readonly currentSourceHead: string,
    readonly currentTargetHead: string
  ) {
    super(message);
    this.name = "AutomaticMergeSnapshotDriftError";
  }
}

function commitReference(hash: string): string {
  const path = repositoryCommitPath(hash);
  return path ? `[${markdownCode(hash)}](${path})` : markdownCode(hash);
}

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
  const automation = await readAutomationSettings(repos);
  if (mode === "automatic") {
    const gate = await checkAutomaticMergeGate(repos, project, pullRequest, automation, input.verifierJob);
    if (gate) {
      if (gate.reverification && input.verifierJob) {
        return requestAutomaticMergeReverification(repos, {
          project,
          pullRequest,
          verifierJob: input.verifierJob,
          reason: gate.reason,
          currentSourceHead: gate.currentSourceHead,
          currentTargetHead: gate.currentTargetHead
        });
      }
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
      mergeBase,
      automation.autoMergeRiskThreshold
    );
    automaticGateEvidence = verification.evidence;
    if (verification.blockedReason) {
      if (verification.reverification) {
        const [currentSourceHead, currentTargetHead] = await Promise.all([
          getRevisionHash(project.repoPath, pullRequest.sourceBranch),
          getRevisionHash(project.repoPath, pullRequest.targetBranch)
        ]);
        return requestAutomaticMergeReverification(repos, {
          project,
          pullRequest,
          verifierJob: input.verifierJob,
          reason: verification.blockedReason,
          currentSourceHead,
          currentTargetHead
        });
      }
      await recordAutomaticMergeBlock(
        repos,
        project,
        pullRequest,
        input.verifierJob,
        verification.blockedReason,
        false,
        verification.stopReason,
        verification.evidence
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
      return requestAutomaticMergeReverification(repos, {
        project,
        pullRequest,
        verifierJob: input.verifierJob!,
        reason,
        previousSourceHead: sourceHead,
        previousTargetHead: targetHead,
        currentSourceHead,
        currentTargetHead
      });
    }
    return { state: "blocked", reason };
  }

  const mergeRetries: GitRetryEvent[] = [];
  let mergeResult: Awaited<ReturnType<typeof mergeBranch>>;
  try {
    mergeResult = await mergeBranch(
      project.repoPath,
      pullRequest.sourceBranch,
      pullRequest.targetBranch,
      automation.autoMergeStrategy,
      mode === "automatic"
        ? {
            delaysMs: [500, 2_000, 5_000],
            onRetry: async (event) => {
              mergeRetries.push(event);
              await recordAutomaticMergeRetry(repos, project, pullRequest, input.verifierJob ?? null, event);
            },
            beforeRetry: async () => {
              const [retrySourceHead, retryTargetHead] = await Promise.all([
                getRevisionHash(project.repoPath, pullRequest.sourceBranch),
                getRevisionHash(project.repoPath, pullRequest.targetBranch)
              ]);
              if (retrySourceHead !== sourceHead || retryTargetHead !== targetHead) {
                throw new AutomaticMergeSnapshotDriftError(
                  "Source or target branch changed during automatic merge retry backoff. Fresh verification is required.",
                  retrySourceHead,
                  retryTargetHead
                );
              }
            }
          }
        : undefined
    );
  } catch (error) {
    if (mode === "automatic" && error instanceof AutomaticMergeSnapshotDriftError) {
      return requestAutomaticMergeReverification(repos, {
        project,
        pullRequest,
        verifierJob: input.verifierJob!,
        reason: error.message,
        previousSourceHead: sourceHead,
        previousTargetHead: targetHead,
        currentSourceHead: error.currentSourceHead,
        currentTargetHead: error.currentTargetHead
      });
    }
    throw error;
  }
  const doneLabel = await repos.labels.findByName(project.id, workflowLabelNames.done);
  const mergedPullRequest = await repos.pullRequests.update(project.id, pullRequest.id, {
    status: "merged",
    labelIds: doneLabel ? [doneLabel.id] : undefined
  });
  if (!mergedPullRequest) {
    throw new Error("Pull request disappeared after its branches were merged.");
  }
  const memoryEntry = await markObjectiveMerged(repos, {
    project,
    pullRequest: mergedPullRequest,
    mergeCommit: mergeResult.mergeCommit,
    verifierJob: input.verifierJob ?? null,
    importantDiffs: (automaticGateEvidence?.importantDiffs ?? []).map((reference) => ({
      path: reference.path,
      line: reference.line,
      href: `/pulls/${pullRequest.id}#${diffLineAnchor(reference.path, reference.side, reference.line)}`
    })),
    mergeRetries
  });

  const mergeBody = buildSystemComment({
    title: mode === "automatic" ? "Automatically merged" : "Merged",
    outcome: "success",
    summary: `Merged ${pullRequest.sourceBranch} into ${pullRequest.targetBranch}. The recorded commit snapshots identify the exact candidate that passed the merge decision.`,
    fields: [
      { label: "Pull request", value: `#${pullRequest.id}`, code: true },
      pullRequest.issueId
        ? {
            label: "Linked issue",
            value: `[#${pullRequest.issueId} — completion summary](/issues/${pullRequest.issueId}#completion-summary)`
          }
        : null,
      { label: "Merge mode", value: mode, code: true },
      { label: "Merge strategy", value: automation.autoMergeStrategy, code: true },
      { label: "Source branch", value: pullRequest.sourceBranch, code: true },
      { label: "Target branch", value: pullRequest.targetBranch, code: true },
      { label: "Merge commit", value: commitReference(mergeResult.mergeCommit) },
      { label: "Source snapshot", value: commitReference(sourceHead) },
      { label: "Target snapshot", value: commitReference(targetHead) },
      { label: "Merge base", value: commitReference(mergeBase) },
      { label: "Transient merge retries", value: mergeResult.retryCount },
      memoryEntry
        ? { label: "Loop Memory", value: `[Memory #${memoryEntry.id}](/loops#memory-${memoryEntry.id})` }
        : null,
      input.verifierJob ? { label: "Verifier job", value: `#${input.verifierJob.id}`, code: true } : null
    ],
    sections: automaticGateEvidence ? automaticMergeEvidenceSections(automaticGateEvidence, pullRequest.id) : [],
    nextStep: pullRequest.issueId
      ? `Review the linked [Issue #${pullRequest.issueId} completion summary](/issues/${pullRequest.issueId}#completion-summary) for the final Objective state and audit evidence.`
      : "No linked Issue requires an update. The Pull Request and Objective retain the merge evidence for audit."
  });
  await repos.comments.create({
    projectId: project.id,
    targetType: "pull_request",
    targetId: pullRequest.id,
    authorType: "system",
    body: mergeBody,
    bodyFormat: "markdown",
    metadata: {
      summaryAnchor: "merge-summary",
      mergeMode: mode,
      mergeStrategy: automation.autoMergeStrategy,
      mergeCommit: mergeResult.mergeCommit,
      sourceHead,
      targetHead,
      mergeBase,
      automaticGateEvidence,
      mergeRetries,
      memoryEntryId: memoryEntry?.id ?? null,
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
      mergeStrategy: automation.autoMergeStrategy,
      mergeCommit: mergeResult.mergeCommit,
      sourceHead,
      targetHead,
      mergeBase,
      automaticGateEvidence,
      mergeRetries,
      memoryEntryId: memoryEntry?.id ?? null
    }
  });
  await closeLinkedIssue(repos, {
    project,
    pullRequest: mergedPullRequest,
    mergeCommit: mergeResult.mergeCommit,
    mode,
    mergeStrategy: automation.autoMergeStrategy,
    sourceHead,
    targetHead,
    mergeBase,
    verifierJob: input.verifierJob ?? null,
    automaticGateEvidence,
    mergeRetries,
    memoryEntry
  });

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
  importantDiffs: ImportantDiffReference[];
  diffLineCount: number;
  commandResults: Array<Omit<VerificationCommandResult, "output"> & { outputExcerpt: string }>;
  riskSignals: Array<{ title: string; summary: string; payload: Record<string, unknown>; blocking: boolean }>;
  riskThreshold: ProjectSettingsDto["automation"]["autoMergeRiskThreshold"];
  verifierEvidenceCapturedAt: string;
  loopPolicy: {
    loopId: number;
    loopRunId: number;
    loopName: string;
    humanGateOnRisk: boolean;
  } | null;
};

function automaticMergeEvidenceSections(evidence: AutomaticGateEvidence, pullRequestId: number): SystemCommentSection[] {
  const commandItems = evidence.commandResults.length
    ? evidence.commandResults.map(
        (result) =>
          `[${result.status === "passed" ? "PASS" : "FAIL"}] ${markdownCode(result.command)} — exit ${
            result.exitCode ?? "none"
          }, ${result.durationMs} ms${result.timedOut ? ", timed out" : ""}`
      )
    : ["No required lint, test, or build command was executed; review the Risk decision for policy blocks."];
  return [
    {
      title: "Verification evidence",
      items: [
        `Verifier evidence captured at ${markdownCode(evidence.verifierEvidenceCapturedAt)}.`,
        ...commandItems,
        `${evidence.changedFiles.length} changed files and ${evidence.diffLineCount} changed lines were evaluated.`,
        evidence.loopPolicy
          ? `Loop policy: [${markdownCode(`#${evidence.loopPolicy.loopId} — ${evidence.loopPolicy.loopName}`)}](/loops/${evidence.loopPolicy.loopId}), run ${markdownCode(`#${evidence.loopPolicy.loopRunId}`)}.`
          : "No Loop-specific risk policy was linked to the verifier job.",
        changedFileLinks(evidence.changedFiles, pullRequestId)
      ]
    },
    ...(evidence.importantDiffs.length
      ? [{
          title: "Important diff",
          items: evidence.importantDiffs.map((reference) =>
            `[${markdownCode(`${reference.path}:${reference.line}`)}](/pulls/${pullRequestId}#${diffLineAnchor(reference.path, reference.side, reference.line)}) — first substantive ${reference.kind} in this file.`
          )
        }]
      : []),
    {
      title: "Risk decision",
      items: evidence.riskSignals.length
        ? evidence.riskSignals.map(
            (signal) =>
              `[${signal.blocking ? "BLOCK" : "OBSERVE"} · ${String(signal.payload.severity ?? "unknown").toUpperCase()}] **${signal.title}** — ${signal.summary}`
          )
        : [`[PASS] No diff risk signal met the ${markdownCode(evidence.riskThreshold)} automatic-merge threshold.`]
    }
  ];
}

function changedFileLinks(paths: string[], pullRequestId: number): string {
  if (!paths.length) {
    return "No changed file path was recorded by the merge gate.";
  }
  const visiblePaths = paths.slice(0, 20);
  const links = visiblePaths.map(
    (path) => `[${markdownCode(path)}](/pulls/${pullRequestId}#${diffFileAnchor(path)})`
  );
  const remaining = paths.length - visiblePaths.length;
  return `Changed files: ${links.join(", ")}${remaining > 0 ? `, and ${remaining} more` : ""}.`;
}

async function verifyAutomaticMergeCandidate(
  repos: Repositories,
  project: ProjectDto,
  pullRequest: PullRequestDto,
  verifierJob: AgentJobDto,
  sourceHead: string,
  targetHead: string,
  mergeBase: string,
  riskThreshold: ProjectSettingsDto["automation"]["autoMergeRiskThreshold"]
): Promise<{
  blockedReason: string | null;
  evidence: AutomaticGateEvidence;
  reverification: boolean;
  stopReason?: "risk_detected";
}> {
  const objective = await repos.objectives.findByPullRequest(project.id, pullRequest.id);
  const verifierEvidence = objective ? currentVerifierEvidence(objective, verifierJob, sourceHead) : null;
  const capturedAt = new Date().toISOString();
  const commands = await repos.commands.list(project.id);
  const loopContext = await resolveAutomaticMergeLoopContext(repos, verifierJob);
  const commandPolicy = applyAutomaticMergeCommandPolicy(commands, loopContext);
  const missingRequiredCommands = commands.filter(
    (command) => command.isRequired && (!command.isAvailable || !command.command)
  );
  const emptyEvidence: AutomaticGateEvidence = {
    capturedAt,
    sourceHead,
    targetHead,
    mergeBase,
    changedFiles: [],
    importantDiffs: [],
    diffLineCount: 0,
    commandResults: [],
    riskSignals: [],
    riskThreshold,
    verifierEvidenceCapturedAt: verifierEvidence?.capturedAt ?? "",
    loopPolicy: loopContext
      ? {
          loopId: loopContext.loop.id,
          loopRunId: loopContext.loopRunId,
          loopName: loopContext.loop.name,
          humanGateOnRisk: loopContext.policy.humanGateOnRisk
        }
      : null
  };

  if (!objective || !verifierEvidence) {
    const reason = "Verifier evidence is stale or does not reference the current source commit.";
    await persistAutomaticGateEvidence(repos, objective, emptyEvidence, "failed", reason);
    return { blockedReason: reason, evidence: emptyEvidence, reverification: true };
  }
  if (missingRequiredCommands.length) {
    const reason = `Required commands are unavailable: ${missingRequiredCommands
      .map((command) => command.commandType)
      .join(", ")}.`;
    await persistAutomaticGateEvidence(repos, objective, emptyEvidence, "failed", reason);
    return { blockedReason: reason, evidence: emptyEvidence, reverification: false };
  }

  const worktree = await preparePullRequestWorktree(project, pullRequest);
  try {
    const beforeStatus = await getRepositoryStatus(worktree.repoPath);
    if (!beforeStatus.clean) {
      const reason = `Source worktree contains uncommitted changes: ${beforeStatus.changedFiles.join(", ")}.`;
      await persistAutomaticGateEvidence(repos, objective, emptyEvidence, "failed", reason);
      return { blockedReason: reason, evidence: emptyEvidence, reverification: false };
    }

    const commandResults = await runVerificationCommands(worktree.repoPath, commandPolicy.commands);
    const [changedFiles, diffLineCount, diffPatch] = await Promise.all([
      getChangedFilesSince(worktree.repoPath, pullRequest.targetBranch),
      getDiffLineCountSince(worktree.repoPath, pullRequest.targetBranch),
      getDiffPatchSince(worktree.repoPath, pullRequest.targetBranch)
    ]);
    const scoreRiskSignals = scanScoreManipulationRisks(diffPatch);
    const importantDiffs = extractImportantDiffReferences(diffPatch);
    const blockingScoreRiskSignals = riskSignalsAtOrAbove(scoreRiskSignals, riskThreshold);
    const loopRiskSignals = [
      ...commandPolicy.riskSignals,
      ...evaluateAutomaticMergeLoopDiffPolicy({
        context: loopContext,
        sourceBranch: pullRequest.sourceBranch,
        changedFiles,
        diffLineCount
      })
    ];
    const blockingLoopRiskSignals = loopRiskSignals.filter((signal) => signal.blocking);
    const evidence: AutomaticGateEvidence = {
      ...emptyEvidence,
      capturedAt: new Date().toISOString(),
      changedFiles,
      importantDiffs,
      diffLineCount,
      commandResults: commandResults.map(({ output, ...result }) => ({
        ...result,
        outputExcerpt: output.slice(0, 2000)
      })),
      riskSignals: [
        ...scoreRiskSignals.map((signal) => ({
          title: signal.title,
          summary: signal.summary,
          payload: signal.payload,
          blocking: blockingScoreRiskSignals.includes(signal)
        })),
        ...loopRiskSignals
      ]
    };
    const failedCommands = commandResults.filter((result) => result.status === "failed");
    if (failedCommands.length) {
      const reason = `Required commands failed: ${failedCommands.map((result) => result.commandType).join(", ")}.`;
      await persistAutomaticGateEvidence(repos, objective, evidence, "failed", reason);
      return { blockedReason: reason, evidence, reverification: false };
    }
    if (blockingScoreRiskSignals.length || blockingLoopRiskSignals.length) {
      const reason = `Risk signals block automatic merge: ${[
        ...blockingScoreRiskSignals.map((signal) => signal.title),
        ...blockingLoopRiskSignals.map((signal) => signal.title)
      ]
        .join(", ")}.`;
      await persistAutomaticGateEvidence(repos, objective, evidence, "failed", reason);
      return { blockedReason: reason, evidence, reverification: false, stopReason: "risk_detected" };
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
      return {
        blockedReason: reason,
        evidence,
        reverification: currentSourceHead !== sourceHead
      };
    }

    await persistAutomaticGateEvidence(repos, objective, evidence, "passed", "All automatic merge checks passed.");
    return { blockedReason: null, evidence, reverification: false };
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
  const snapshot = verifierEvidenceSnapshot(objective, verifierJob);
  if (!snapshot) return null;
  const capturedAtMs = Date.parse(snapshot.capturedAt);
  const maximumAgeMs = 24 * 60 * 60 * 1000;
  return Number.isFinite(capturedAtMs) &&
    Date.now() - capturedAtMs <= maximumAgeMs &&
    snapshot.sourceHead === sourceHead
    ? { capturedAt: snapshot.capturedAt }
    : null;
}

function verifierEvidenceSnapshot(
  objective: ObjectiveRunDto,
  verifierJob: AgentJobDto
): { capturedAt: string; sourceHead: string | null; targetHead: string | null } | null {
  const items = Array.isArray(objective.evidence?.items) ? objective.evidence.items : [];
  for (const item of [...items].reverse()) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const payload = "payload" in item && typeof item.payload === "object" && item.payload !== null ? item.payload : null;
    if (!payload) {
      continue;
    }
    const capturedAt = "capturedAt" in payload && typeof payload.capturedAt === "string" ? payload.capturedAt : null;
    const sourceCommit = "sourceCommit" in payload && typeof payload.sourceCommit === "string" ? payload.sourceCommit : null;
    const targetCommit = "targetCommit" in payload && typeof payload.targetCommit === "string" ? payload.targetCommit : null;
    const judgeAgentJobId = "judgeAgentJobId" in payload ? payload.judgeAgentJobId : null;
    const agentJobId = "agentJobId" in payload ? payload.agentJobId : null;
    if (
      capturedAt &&
      (judgeAgentJobId === verifierJob.id || agentJobId === verifierJob.id)
    ) {
      return { capturedAt, sourceHead: sourceCommit, targetHead: targetCommit };
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
  automation: ProjectSettingsDto["automation"],
  verifierJob?: AgentJobDto
): Promise<{
  state: "blocked" | "skipped";
  reason: string;
  conflicts: boolean;
  reverification?: boolean;
  currentSourceHead?: string;
  currentTargetHead?: string;
} | null> {
  if (!automation.autoMergeEnabled) {
    return { state: "skipped", reason: "Automatic merge is disabled in project settings.", conflicts: false };
  }
  if (
    automation.autoMergeTargetBranches.length > 0 &&
    !automation.autoMergeTargetBranches.includes(pullRequest.targetBranch)
  ) {
    return {
      state: "skipped",
      reason: `Target branch ${pullRequest.targetBranch} is outside the automatic merge policy.`,
      conflicts: false
    };
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
  if (objective.evidenceRequirements.length) {
    const [sourceCommit, targetCommit] = await Promise.all([
      getRevisionHash(project.repoPath, pullRequest.sourceBranch),
      getRevisionHash(project.repoPath, pullRequest.targetBranch)
    ]);
    const evidenceGate = evaluateEvidenceRequirements(objective.evidenceRequirements, evidence, {
      sourceCommit,
      targetCommit
    });
    if (!evidenceGate.passed) {
      const reverification = evidenceGate.checks.some(
        (check) => check.requirement.required && ["commit_mismatch", "stale"].includes(check.status)
      );
      return {
        state: "blocked",
        reason: `Evidence Required became invalid before merge: ${evidenceGateFailureSummary(evidenceGate)}.`,
        conflicts: false,
        reverification,
        currentSourceHead: sourceCommit,
        currentTargetHead: targetCommit
      };
    }
  }
  return null;
}

async function requestAutomaticMergeReverification(
  repos: Repositories,
  input: {
    project: ProjectDto;
    pullRequest: PullRequestDto;
    verifierJob: AgentJobDto;
    reason: string;
    previousSourceHead?: string;
    previousTargetHead?: string;
    currentSourceHead?: string;
    currentTargetHead?: string;
  }
): Promise<PullRequestMergeResult> {
  const { project, pullRequest, verifierJob, reason } = input;
  const objective = await repos.objectives.findByPullRequest(project.id, pullRequest.id);
  if (!objective) {
    const blockedReason = `${reason} No Objective is available to queue fresh verification.`;
    await recordAutomaticMergeBlock(repos, project, pullRequest, verifierJob, blockedReason, false);
    return { state: "blocked", reason: blockedReason };
  }
  const priorVerifierSnapshot = verifierEvidenceSnapshot(objective, verifierJob);
  const priorLoopContext = await resolveAutomaticMergeLoopContext(repos, verifierJob);
  const previousSourceHead = input.previousSourceHead ?? priorVerifierSnapshot?.sourceHead ?? undefined;
  const previousTargetHead = input.previousTargetHead ?? priorVerifierSnapshot?.targetHead ?? undefined;

  const existingJobs = await repos.agentJobs.list({
    projectId: project.id,
    targetType: "pull_request",
    targetId: pullRequest.id
  });
  const haltedVerifier = existingJobs.find(
    (job) => job.agentType === "verifier" && ["waiting_human", "paused"].includes(job.status)
  );
  if (haltedVerifier) {
    const blockedReason = `${reason} Verifier job #${haltedVerifier.id} is ${haltedVerifier.status} and must be resolved before automatic re-verification.`;
    await recordAutomaticMergeBlock(repos, project, pullRequest, verifierJob, blockedReason, false);
    return { state: "blocked", reason: blockedReason };
  }
  const activeVerifier = existingJobs.find(
    (job) => job.agentType === "verifier" && ["queued", "running", "waiting_provider"].includes(job.status)
  );
  let nextVerifier = activeVerifier ?? null;
  let reverifyLoop: Awaited<ReturnType<typeof ensureSystemLoop>> | null = null;
  let loopId: number | null = null;
  let loopRunId: number | null = null;
  if (!nextVerifier) {
    reverifyLoop = await ensureSystemLoop(repos, {
      projectId: project.id,
      name: priorLoopContext
        ? `Automatic merge re-verification for Loop #${priorLoopContext.loop.id}`
        : "Automatic merge re-verification",
      purpose: "Refresh verifier evidence when source or target snapshots change during the automatic merge gate.",
      triggerType: "automatic_merge_snapshot_drift",
      targetScope: priorLoopContext
        ? `pull_request:snapshot_drift:loop:${priorLoopContext.loop.id}`
        : "pull_request:snapshot_drift",
      riskPolicy: priorLoopContext?.loop.riskPolicy
    });
    if (reverifyLoop.status === "disabled") {
      const blockedReason = `${reason} The automatic merge re-verification Loop is disabled.`;
      await recordAutomaticMergeBlock(repos, project, pullRequest, verifierJob, blockedReason, false);
      return { state: "blocked", reason: blockedReason };
    }
    loopId = reverifyLoop.id;
  }

  const verifyingLabel = await repos.labels.findByName(project.id, workflowLabelNames.done);
  const updatedPullRequest = verifyingLabel
    ? (await repos.pullRequests.update(project.id, pullRequest.id, { labelIds: [verifyingLabel.id] })) ?? pullRequest
    : pullRequest;
  await repos.objectives.update(project.id, objective.id, {
    status: "running",
    workflowStage: "verification",
    judgeAgentJobId: null,
    stopReason: "automatic_merge_reverification",
    summary: reason,
    finishedAt: null
  });
  if (!nextVerifier && reverifyLoop) {
    const started = await startLoopRun(repos, {
      projectId: project.id,
      loopId: reverifyLoop.id,
      agentType: "verifier",
      targetType: "pull_request",
      targetId: pullRequest.id,
      triggerType: "automatic_merge_snapshot_drift",
      objectiveRunId: objective.id,
      jobInput: {
        objectiveRunId: objective.id,
        automaticMergeReverification: true,
        previousVerifierJobId: verifierJob.id,
        previousLoopId: priorLoopContext?.loop.id ?? null,
        previousLoopRunId: priorLoopContext?.loopRunId ?? null,
        reason,
        previousSourceHead: previousSourceHead ?? null,
        previousTargetHead: previousTargetHead ?? null,
        currentSourceHead: input.currentSourceHead ?? null,
        currentTargetHead: input.currentTargetHead ?? null
      }
    });
    nextVerifier = started.job;
    loopRunId = started.run.id;
  }
  if (!nextVerifier) {
    throw new Error("Automatic merge re-verification could not resolve or queue a verifier job.");
  }

  const eventKey = [
    "automatic-merge-reverification",
    pullRequest.id,
    previousSourceHead ?? "unknown",
    previousTargetHead ?? "unknown",
    input.currentSourceHead ?? "unknown",
    input.currentTargetHead ?? "unknown"
  ].join(":");
  const body = buildSystemComment({
    title: "Automatic merge verification restarted",
    outcome: "waiting",
    summary: `${reason} The unverified candidate was not merged; OneTeam queued a fresh verifier run instead of opening a Human Gate.`,
    fields: [
      { label: "Pull request", value: `[#${pullRequest.id} — ${pullRequest.title}](/pulls/${pullRequest.id})` },
      { label: "Previous verifier", value: `#${verifierJob.id}`, code: true },
      { label: "Reverification job", value: `#${nextVerifier.id}`, code: true },
      priorLoopContext
        ? { label: "Preserved risk policy", value: `Loop #${priorLoopContext.loop.id} — ${priorLoopContext.loop.name}` }
        : null,
      previousSourceHead ? { label: "Previous source", value: commitReference(previousSourceHead) } : null,
      input.currentSourceHead ? { label: "Current source", value: commitReference(input.currentSourceHead) } : null,
      previousTargetHead ? { label: "Previous target", value: commitReference(previousTargetHead) } : null,
      input.currentTargetHead ? { label: "Current target", value: commitReference(input.currentTargetHead) } : null
    ],
    sections: [
      {
        title: "Safety decision",
        items: [
          "The prior verifier decision and automatic-merge snapshot are no longer accepted for merge.",
          "The new verifier must collect Evidence against the current branch snapshots.",
          "Queueing this recovery does not itself consume an Objective round; the verifier run follows the normal round and budget gates."
        ]
      }
    ],
    nextStep: "OneTeam will run the queued verifier and automatically re-enter the merge gate only if the refreshed Stop Condition and Evidence pass."
  });
  const targets: Array<{ targetType: "pull_request" | "issue"; targetId: number }> = [
    { targetType: "pull_request", targetId: pullRequest.id },
    ...(pullRequest.issueId ? [{ targetType: "issue" as const, targetId: pullRequest.issueId }] : [])
  ];
  for (const target of targets) {
    const comments = await repos.comments.list(project.id, target.targetType, target.targetId);
    if (comments.some((comment) => comment.metadata?.automaticMergeEventKey === eventKey)) continue;
    await repos.comments.create({
      projectId: project.id,
      targetType: target.targetType,
      targetId: target.targetId,
      authorType: "system",
      body,
      bodyFormat: "markdown",
      metadata: {
        automaticMerge: "reverification_queued",
        automaticMergeEventKey: eventKey,
        pullRequestId: pullRequest.id,
        previousVerifierJobId: verifierJob.id,
        verifierJobId: nextVerifier.id,
        loopId,
        loopRunId,
        previousLoopId: priorLoopContext?.loop.id ?? null,
        previousLoopRunId: priorLoopContext?.loopRunId ?? null,
        previousSourceHead: previousSourceHead ?? null,
        previousTargetHead: previousTargetHead ?? null,
        currentSourceHead: input.currentSourceHead ?? null,
        currentTargetHead: input.currentTargetHead ?? null
      }
    });
    await repos.activities.create({
      projectId: project.id,
      agentJobId: nextVerifier.id,
      targetType: target.targetType,
      targetId: target.targetId,
      activityType: "system",
      title: "Automatic merge re-verification queued",
      body,
      payload: {
        automaticMergeEventKey: eventKey,
        pullRequestId: pullRequest.id,
        previousVerifierJobId: verifierJob.id,
        verifierJobId: nextVerifier.id,
        loopId,
        loopRunId,
        previousLoopId: priorLoopContext?.loop.id ?? null,
        previousLoopRunId: priorLoopContext?.loopRunId ?? null
      }
    });
  }
  await appendObjectiveEvidence(repos, objective, [
    {
      type: "automatic_merge_reverification",
      title: "Automatic merge re-verification queued",
      summary: reason,
      payload: {
        capturedAt: new Date().toISOString(),
        previousVerifierJobId: verifierJob.id,
        verifierJobId: nextVerifier.id,
        loopId,
        loopRunId,
        previousLoopId: priorLoopContext?.loop.id ?? null,
        previousLoopRunId: priorLoopContext?.loopRunId ?? null,
        previousSourceHead: previousSourceHead ?? null,
        previousTargetHead: previousTargetHead ?? null,
        currentSourceHead: input.currentSourceHead ?? null,
        currentTargetHead: input.currentTargetHead ?? null,
        pullRequestLabel: updatedPullRequest.labels[0]?.name ?? null
      }
    }
  ]);

  return { state: "requeued", reason, verifierJob: nextVerifier };
}

async function recordAutomaticMergeRetry(
  repos: Repositories,
  project: ProjectDto,
  pullRequest: PullRequestDto,
  verifierJob: AgentJobDto | null,
  event: GitRetryEvent
): Promise<void> {
  const body = buildSystemComment({
    title: "Automatic merge transient retry",
    outcome: "waiting",
    summary: `A temporary local Git lock or resource-busy error interrupted ${event.operation}. The verified candidate remains unchanged and will be retried after a short backoff.`,
    fields: [
      { label: "Pull request", value: `#${pullRequest.id}`, code: true },
      { label: "Operation", value: event.operation, code: true },
      { label: "Failed attempt", value: event.failedAttempt },
      { label: "Next attempt", value: event.nextAttempt },
      { label: "Backoff", value: `${event.delayMs} ms`, code: true },
      verifierJob ? { label: "Verifier job", value: `#${verifierJob.id}`, code: true } : null
    ],
    sections: [
      {
        title: "Safety check",
        items: [
          "Source and target commit snapshots are checked again after the backoff and before the retry.",
          "A snapshot change cancels retry and requires fresh verification.",
          "Only recognized transient lock or busy errors are retried; policy, conflict, and verification failures are not."
        ]
      }
    ],
    nextStep: `OneTeam will retry attempt ${event.nextAttempt} automatically. No provider turn or Objective round is consumed.`
  });
  const targets: Array<{ targetType: "pull_request" | "issue"; targetId: number }> = [
    { targetType: "pull_request", targetId: pullRequest.id },
    ...(pullRequest.issueId ? [{ targetType: "issue" as const, targetId: pullRequest.issueId }] : [])
  ];
  await Promise.all(targets.map((target) => repos.activities.create({
    projectId: project.id,
    agentJobId: verifierJob?.id ?? null,
    targetType: target.targetType,
    targetId: target.targetId,
    activityType: "system",
    title: "Automatic merge transient retry",
    body,
    payload: {
      automaticMergeEvent: "transient_retry",
      pullRequestId: pullRequest.id,
      ...event
    }
  })));
}

async function recordAutomaticMergeBlock(
  repos: Repositories,
  project: ProjectDto,
  pullRequest: PullRequestDto,
  verifierJob: AgentJobDto | null,
  reason: string,
  conflicts: boolean,
  stopReasonOverride?: "risk_detected",
  automaticGateEvidence?: AutomaticGateEvidence
): Promise<void> {
  const stopReason = conflicts ? "merge_conflict" : stopReasonOverride ?? "automatic_merge_blocked";
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
      workflowStage: conflicts ? "fix" : objective.workflowStage,
      stopReason,
      summary: reason
    });
  }
  const body = buildSystemComment({
    title: "Automatic merge paused",
    outcome: "blocked",
    summary: reason,
    fields: [
      {
        label: "Pull request",
        value: `[#${pullRequest.id} — ${pullRequest.title}](/pulls/${pullRequest.id})`
      },
      { label: "Source branch", value: pullRequest.sourceBranch, code: true },
      { label: "Target branch", value: pullRequest.targetBranch, code: true },
      { label: "Stop reason", value: stopReason, code: true },
      verifierJob ? { label: "Verifier job", value: `#${verifierJob.id}`, code: true } : null
    ],
    sections: [
      ...(automaticGateEvidence ? automaticMergeEvidenceSections(automaticGateEvidence, pullRequest.id) : []),
      {
        title: "Decision",
        items: conflicts
          ? [
              "The conflict-resolution workflow is queued.",
              "The changed candidate must pass verification again before merge."
            ]
          : [
              "The verified candidate was not merged.",
              "Repository state or policy must be corrected before the automatic gate can run again."
            ]
      }
    ],
    nextStep: conflicts
      ? "Wait for conflict resolution, then review the new evidence from the repeated verifier run."
      : "Review the recorded reason, correct the repository or policy state, and resume the workflow. Manual merge remains an explicit fallback."
  });
  const eventKey = `automatic-merge-block:${pullRequest.id}:${verifierJob?.id ?? "none"}:${conflicts ? "conflict" : "gate"}:${reason}`;
  const targets: Array<{ targetType: "pull_request" | "issue"; targetId: number }> = [
    { targetType: "pull_request", targetId: pullRequest.id },
    ...(pullRequest.issueId ? [{ targetType: "issue" as const, targetId: pullRequest.issueId }] : [])
  ];
  for (const target of targets) {
    const comments = await repos.comments.list(project.id, target.targetType, target.targetId);
    if (comments.some((comment) => comment.metadata?.automaticMergeEventKey === eventKey)) continue;
    await repos.comments.create({
      projectId: project.id,
      targetType: target.targetType,
      targetId: target.targetId,
      authorType: "system",
      body,
      bodyFormat: "markdown",
      metadata: {
        automaticMerge: "blocked",
        automaticMergeEventKey: eventKey,
        pullRequestId: pullRequest.id,
        reason,
        conflicts,
        stopReason,
        automaticGateEvidence: automaticGateEvidence ?? null,
        verifierJobId: verifierJob?.id ?? null
      }
    });
    await repos.activities.create({
      projectId: project.id,
      agentJobId: verifierJob?.id ?? null,
      targetType: target.targetType,
      targetId: target.targetId,
      activityType: "system",
      title: "Automatic merge paused",
      body,
      payload: {
        automaticMergeEventKey: eventKey,
        pullRequestId: pullRequest.id,
        reason,
        conflicts,
        stopReason,
        automaticGateEvidence: automaticGateEvidence ?? null
      }
    });
  }
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
  input: {
    project: ProjectDto;
    pullRequest: PullRequestDto;
    mergeCommit: string;
    mode: "automatic" | "manual";
    mergeStrategy: ProjectSettingsDto["automation"]["autoMergeStrategy"];
    sourceHead: string;
    targetHead: string;
    mergeBase: string;
    verifierJob: AgentJobDto | null;
    automaticGateEvidence: AutomaticGateEvidence | null;
    mergeRetries: GitRetryEvent[];
    memoryEntry: LoopMemoryEntryDto | null;
  }
): Promise<void> {
  const { project, pullRequest } = input;
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
  const eventKey = `objective-completed:pull-request:${pullRequest.id}:merge:${input.mergeCommit}`;
  const comments = await repos.comments.list(project.id, "issue", issue.id);
  if (comments.some((comment) => comment.metadata?.mergeCompletionEventKey === eventKey)) return;
  const body = buildSystemComment({
    title: "Objective completed",
    outcome: "success",
    summary: `Pull request #${pullRequest.id} was merged and this linked Issue was closed. The snapshots below identify the exact candidate and policy decision.`,
    fields: [
      {
        label: "Pull request",
        value: `[#${pullRequest.id} — ${pullRequest.title}](/pulls/${pullRequest.id}#merge-summary)`
      },
      { label: "Merge mode", value: input.mode, code: true },
      { label: "Merge strategy", value: input.mergeStrategy, code: true },
      { label: "Merge commit", value: commitReference(input.mergeCommit) },
      { label: "Source branch", value: pullRequest.sourceBranch, code: true },
      { label: "Source snapshot", value: commitReference(input.sourceHead) },
      { label: "Target branch", value: pullRequest.targetBranch, code: true },
      { label: "Target snapshot", value: commitReference(input.targetHead) },
      { label: "Merge base", value: commitReference(input.mergeBase) },
      { label: "Transient merge retries", value: input.mergeRetries.length },
      input.memoryEntry
        ? { label: "Loop Memory", value: `[Memory #${input.memoryEntry.id}](/loops#memory-${input.memoryEntry.id})` }
        : null,
      input.verifierJob ? { label: "Verifier job", value: `#${input.verifierJob.id}`, code: true } : null
    ],
    sections: [
      ...(input.automaticGateEvidence
        ? automaticMergeEvidenceSections(input.automaticGateEvidence, pullRequest.id)
        : []),
      {
        title: "Final state",
        items: [
          `[Pull request #${pullRequest.id} merge summary](/pulls/${pullRequest.id}#merge-summary) records the merge decision and exact snapshots.`,
          "The Objective is marked as succeeded with its final merge evidence.",
          "This Issue is closed with its original description preserved."
        ]
      }
    ],
    nextStep: "Use the linked changed files, Pull Request timeline, and Objective evidence when auditing the implementation or planning follow-up work."
  });
  const metadata = {
    summaryAnchor: "completion-summary",
    mergeCompletionEventKey: eventKey,
    pullRequestId: pullRequest.id,
    mergeMode: input.mode,
    mergeStrategy: input.mergeStrategy,
    mergeCommit: input.mergeCommit,
    sourceHead: input.sourceHead,
    targetHead: input.targetHead,
    mergeBase: input.mergeBase,
    verifierJobId: input.verifierJob?.id ?? null,
    automaticGateEvidence: input.automaticGateEvidence,
    mergeRetries: input.mergeRetries,
    memoryEntryId: input.memoryEntry?.id ?? null
  };
  await repos.comments.create({
    projectId: project.id,
    targetType: "issue",
    targetId: issue.id,
    authorType: "system",
    body,
    bodyFormat: "markdown",
    metadata
  });
  await repos.activities.create({
    projectId: project.id,
    agentJobId: input.verifierJob?.id ?? null,
    targetType: "issue",
    targetId: issue.id,
    activityType: "system",
    title: "Objective completed",
    body,
    payload: metadata
  });
}
