import type { AgentJobDto, ObjectiveRunDto, ProjectDto, PullRequestDto } from "../../shared/types";
import {
  evidenceGateFailureSummary,
  evaluateEvidenceRequirements,
  normalizeEvidenceRequirements,
  type EvidenceGateEvaluation
} from "../../shared/evidence-requirements";
import type { Repositories } from "../db/repositories";
import { appendLoopMemoryNote } from "./knowledge-files";
import { getRevisionHash } from "./git-service";
import type { AgentEvidenceResult, AgentRunResult } from "../agents/types";
import { workflowStageAfterResult, workflowStageForAgent } from "./objective-workflow";

const terminalObjectiveStatuses = new Set(["succeeded", "canceled"]);

export function objectiveRunIdFromJob(job: AgentJobDto): number | null {
  const value = job.input.objectiveRunId;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function ensureObjectiveForTarget(
  repos: Repositories,
  input: {
    projectId: string;
    targetType: "issue" | "pull_request" | "project";
    targetId: number;
  }
): Promise<ObjectiveRunDto | null> {
  if (input.targetType === "issue") {
    const issue = await repos.issues.get(input.projectId, input.targetId);
    if (!issue) {
      return null;
    }
    const existing = await repos.objectives.findByIssue(input.projectId, issue.id);
    const objective = await repos.objectives.ensureForIssue({
      projectId: input.projectId,
      issueId: issue.id,
      title: issue.title,
      goal: issue.body
    });
    if (!existing) {
      await rememberObjectiveEvent(repos, input.projectId, {
        title: `Objective created for issue #${issue.id}`,
        body: issue.title,
        tags: ["objective", "issue", "discovery"]
      });
    }
    return objective;
  }

  if (input.targetType === "pull_request") {
    const pullRequest = await repos.pullRequests.get(input.projectId, input.targetId);
    if (!pullRequest) {
      return null;
    }
    const existing = await repos.objectives.findByPullRequest(input.projectId, pullRequest.id);
    const issue = pullRequest.issueId ? await repos.issues.get(input.projectId, pullRequest.issueId) : null;
    const objective = await repos.objectives.ensureForPullRequest({
      projectId: input.projectId,
      pullRequestId: pullRequest.id,
      issueId: pullRequest.issueId,
      title: issue?.title ?? pullRequest.title,
      goal: issue?.body ?? pullRequest.body
    });
    if (!existing) {
      await rememberObjectiveEvent(repos, input.projectId, {
        title: `Objective connected to pull request #${pullRequest.id}`,
        body: pullRequest.title,
        tags: ["objective", "pull_request", "handoff"]
      });
    }
    return objective;
  }

  return null;
}

export async function preflightObjectiveJob(repos: Repositories, job: AgentJobDto): Promise<AgentRunResult | null> {
  const objective = await objectiveForJob(repos, job);
  if (!objective) {
    return null;
  }

  if (terminalObjectiveStatuses.has(objective.status)) {
    return {
      status: "waiting_human",
      message: `Objective #${objective.id} is already ${objective.status}.`,
      questions: ["Review the objective state before running more agent work."],
      stopReason: "waiting_human",
      evidence: [
        {
          type: "objective",
          title: "Objective already terminal",
          summary: `Objective #${objective.id} is ${objective.status}.`,
          payload: { objectiveRunId: objective.id, status: objective.status }
        }
      ]
    };
  }

  if (objective.roundCount >= objective.maxRounds) {
    await repos.objectives.update(job.projectId, objective.id, {
      status: "waiting_human",
      stopReason: "max_rounds_exceeded",
      summary: `Objective #${objective.id} reached max rounds (${objective.maxRounds}).`
    });
    await rememberObjectiveEvent(repos, job.projectId, {
      title: `Objective #${objective.id} stopped at max rounds`,
      body: `Max rounds: ${objective.maxRounds}`,
      tags: ["objective", "budget", "human_gate"]
    });
    return {
      status: "waiting_human",
      message: `Objective #${objective.id} reached max rounds (${objective.maxRounds}).`,
      questions: ["Review the remaining work, then raise the round limit or continue manually."],
      stopReason: "max_rounds_exceeded",
      evidence: [
        {
          type: "objective",
          title: "Max rounds exceeded",
          summary: `Objective #${objective.id} used ${objective.roundCount}/${objective.maxRounds} rounds.`,
          payload: { objectiveRunId: objective.id, roundCount: objective.roundCount, maxRounds: objective.maxRounds }
        }
      ]
    };
  }

  await repos.objectives.update(job.projectId, objective.id, {
    status: "running",
    workflowStage: workflowStageForAgent(job.agentType) ?? objective.workflowStage,
    lastAgentJobId: job.id
  });
  return null;
}

export async function applyObjectiveHardGate(
  repos: Repositories,
  job: AgentJobDto,
  result: AgentRunResult
): Promise<AgentRunResult> {
  const objective = await objectiveForJob(repos, job);
  if (!objective || result.status !== "succeeded") {
    return result;
  }

  if (job.agentType === "implementation" && !hasEvidence(result)) {
    return gateFailureResult(result, {
      message: "Implementation cannot finish without evidence from changed files, commands, tests, or risk checks.",
      title: "Implementation evidence missing",
      objectiveRunId: objective.id
    });
  }

  if (job.agentType === "requirements" && result.metadata && "goalContract" in result.metadata) {
    const requirements = normalizeEvidenceRequirements(result.metadata.goalContract?.evidenceRequired);
    if (!requirements.some((requirement) => requirement.required)) {
      return gateFailureResult(result, {
        message: "Requirements cannot finish without at least one valid required Evidence Required rule.",
        title: "Goal Contract evidence rules missing",
        objectiveRunId: objective.id
      });
    }
  }

  if (job.agentType === "verifier") {
    const verifier = result.metadata?.verifier;
    const objectiveEvidenceCount = evidenceItems(objective.evidence).length + (result.evidence?.length ?? 0);
    if (verifier?.stopConditionMet !== true) {
      return gateFailureResult(result, {
        message: "Verifier cannot mark the objective passed without a met stop condition and collected evidence.",
        title: "Verifier gate blocked",
        objectiveRunId: objective.id
      });
    }
    const evidenceContext = await resolveEvidenceContext(repos, job, objective);
    const evidenceGate = evaluateEvidenceRequirements(
      objective.evidenceRequirements,
      [
        ...evidenceItems(objective.evidence),
        ...stampEvidence(result.evidence, evidenceContext),
        stampEvidenceItem({
          type: "agent_job",
          title: `verifier job ${result.status}`,
          summary: result.message,
          payload: {
            agentJobId: job.id,
            agentType: job.agentType,
            stopReason: result.stopReason ?? null
          }
        }, evidenceContext)
      ],
      evidenceContext
    );
    if (!evidenceGate.passed) {
      const missing = evidenceGateFailureSummary(evidenceGate);
      return gateFailureResult(result, {
        message: `Evidence Required is not satisfied: ${missing}.`,
        title: "Evidence Required gate blocked",
        objectiveRunId: objective.id,
        evidenceGate
      });
    }
    if (objectiveEvidenceCount === 0) {
      return gateFailureResult(result, {
        message: "Verifier cannot mark the objective passed without a met stop condition and collected evidence.",
        title: "Verifier gate blocked",
        objectiveRunId: objective.id
      });
    }
    return {
      ...result,
      evidence: [
        ...(result.evidence ?? []),
        {
          type: "judge",
          title: "Judge separation recorded",
          summary: `Verifier job #${job.id} judged objective #${objective.id}.`,
          payload: {
            objectiveRunId: objective.id,
            judgeAgentJobId: job.id,
            judgeAiProvider: job.aiProvider,
            evidenceGate
          }
        }
      ]
    };
  }

  return result;
}

export async function recordObjectiveJobResult(
  repos: Repositories,
  input: {
    job: AgentJobDto;
    result: AgentRunResult;
  }
): Promise<ObjectiveRunDto | null> {
  const objective = await objectiveForJob(repos, input.job);
  if (!objective) {
    return null;
  }

  const result = input.result;
  const evidenceContext = await resolveEvidenceContext(repos, input.job, objective);
  const stampedResultEvidence = stampEvidence(result.evidence, evidenceContext);
  const roundCount = objective.roundCount + 1;
  const signature = result.status === "failed" ? failureSignature(result) : null;
  const repeatedFailureCount =
    signature && signature === objective.lastFailureSignature ? objective.repeatedFailureCount + 1 : signature ? 1 : 0;
  const status = deriveObjectiveStatus(input.job, result, repeatedFailureCount, roundCount, objective.maxRounds);
  const stopReason =
    repeatedFailureCount >= 2
      ? "waiting_human"
      : roundCount >= objective.maxRounds && status === "waiting_human"
        ? "max_rounds_exceeded"
        : (result.stopReason ?? objective.stopReason);
  const evidenceRequirements = input.job.agentType === "requirements" && result.status === "succeeded" && result.metadata?.goalContract
    ? normalizeEvidenceRequirements(result.metadata.goalContract.evidenceRequired)
    : objective.evidenceRequirements;
  const evidence = mergeEvidence(objective.evidence, stampedResultEvidence, stampEvidenceItem({
    type: "agent_job",
    title: `${input.job.agentType} job ${result.status}`,
    summary: result.message,
    payload: {
      agentJobId: input.job.id,
      agentType: input.job.agentType,
      aiProvider: input.job.aiProvider,
      stopReason: result.stopReason ?? null
    }
  }, evidenceContext));

  const updated = await repos.objectives.update(input.job.projectId, objective.id, {
    status,
    workflowStage: workflowStageAfterResult(input.job, result, objective.workflowStage),
    roundCount,
    lastAgentJobId: input.job.id,
    judgeAgentJobId: input.job.agentType === "verifier" ? input.job.id : objective.judgeAgentJobId,
    generatorAiProvider: input.job.agentType === "implementation" ? input.job.aiProvider : objective.generatorAiProvider,
    judgeAiProvider: input.job.agentType === "verifier" ? input.job.aiProvider : objective.judgeAiProvider,
    lastFailureSignature: signature,
    repeatedFailureCount,
    stopReason,
    evidenceRequirements,
    evidence,
    summary: result.message,
    finishedAt: ["succeeded", "failed", "canceled"].includes(status) ? new Date().toISOString() : objective.finishedAt
  });

  if (updated && shouldRememberObjectiveStatus(status, repeatedFailureCount)) {
    await rememberObjectiveEvent(repos, input.job.projectId, {
      title: `Objective #${updated.id} ${status}`,
      body: result.message,
      tags: ["objective", input.job.agentType, status]
    });
  }

  return updated;
}

export async function markObjectiveMerged(
  repos: Repositories,
  input: {
    project: ProjectDto;
    pullRequest: PullRequestDto;
    mergeCommit: string;
  }
): Promise<void> {
  const objective = await repos.objectives.findByPullRequest(input.project.id, input.pullRequest.id);
  if (!objective) {
    return;
  }
  await repos.objectives.update(input.project.id, objective.id, {
    status: "succeeded",
    workflowStage: "merged",
    stopReason: "passed",
    summary: `Pull request #${input.pullRequest.id} merged at ${input.mergeCommit.slice(0, 12)}.`,
    evidence: mergeEvidence(objective.evidence, null, {
      type: "merge",
      title: "Pull request merged",
      summary: `Merged ${input.pullRequest.sourceBranch} into ${input.pullRequest.targetBranch}.`,
      payload: {
        pullRequestId: input.pullRequest.id,
        mergeCommit: input.mergeCommit
      }
    }),
    finishedAt: new Date().toISOString()
  });
  await appendLoopMemoryNote(input.project.repoPath, {
    title: `Objective #${objective.id} merged`,
    body: `Pull request #${input.pullRequest.id} merged at ${input.mergeCommit.slice(0, 12)}.`,
    tags: ["objective", "merge", "passed"]
  }).catch(() => undefined);
}

export async function appendObjectiveEvidence(
  repos: Repositories,
  objective: ObjectiveRunDto,
  items: AgentEvidenceResult[]
): Promise<ObjectiveRunDto | null> {
  return repos.objectives.update(objective.projectId, objective.id, {
    evidence: {
      items: [...evidenceItems(objective.evidence), ...items].slice(-80)
    }
  });
}

export async function objectiveForJob(repos: Repositories, job: AgentJobDto): Promise<ObjectiveRunDto | null> {
  const objectiveRunId = objectiveRunIdFromJob(job);
  if (objectiveRunId) {
    return repos.objectives.get(job.projectId, objectiveRunId);
  }
  if (job.targetType === "issue") {
    return repos.objectives.findByIssue(job.projectId, job.targetId);
  }
  if (job.targetType === "pull_request") {
    return repos.objectives.findByPullRequest(job.projectId, job.targetId);
  }
  return null;
}

function gateFailureResult(
  result: AgentRunResult,
  input: {
    message: string;
    title: string;
    objectiveRunId: number;
    evidenceGate?: EvidenceGateEvaluation;
  }
): AgentRunResult {
  return {
    ...result,
    status: "waiting_human",
    message: `${result.message}\n\nHard verification gate: ${input.message}`,
    questions: [input.message],
    stopReason: "waiting_human",
    metadata: {
      ...(result.metadata ?? {}),
      nextLabel: null
    },
    evidence: [
      ...(result.evidence ?? []),
      {
        type: "objective_gate",
        title: input.title,
        summary: input.message,
        payload: {
          objectiveRunId: input.objectiveRunId,
          ...(input.evidenceGate ? { evidenceGate: input.evidenceGate } : {})
        }
      }
    ]
  };
}

function hasEvidence(result: AgentRunResult): boolean {
  return Boolean(result.evidence?.length || result.changedFiles?.length || result.testResults?.length);
}

function evidenceItems(value: Record<string, unknown> | null): AgentEvidenceResult[] {
  const items = value?.items;
  return Array.isArray(items)
    ? items.filter((item): item is AgentEvidenceResult => typeof item === "object" && item !== null)
    : [];
}

function mergeEvidence(
  existing: Record<string, unknown> | null,
  next: AgentEvidenceResult[] | null | undefined,
  extra: AgentEvidenceResult
): Record<string, unknown> {
  const items = [...evidenceItems(existing), ...(next ?? []), extra].slice(-80);
  return { items };
}

type EvidenceContext = {
  capturedAt: string;
  sourceBranch: string | null;
  sourceCommit: string | null;
  targetBranch: string | null;
  targetCommit: string | null;
};

async function resolveEvidenceContext(
  repos: Repositories,
  job: AgentJobDto,
  objective: ObjectiveRunDto
): Promise<EvidenceContext> {
  const capturedAt = new Date().toISOString();
  const project = await repos.projects.get(job.projectId);
  const pullRequest = objective.pullRequestId
    ? await repos.pullRequests.get(job.projectId, objective.pullRequestId)
    : job.targetType === "pull_request"
      ? await repos.pullRequests.get(job.projectId, job.targetId)
      : null;
  if (!project || !pullRequest) {
    return { capturedAt, sourceBranch: null, sourceCommit: null, targetBranch: null, targetCommit: null };
  }

  const [sourceCommit, targetCommit] = await Promise.all([
    getRevisionHash(project.repoPath, pullRequest.sourceBranch).catch(() => null),
    getRevisionHash(project.repoPath, pullRequest.targetBranch).catch(() => null)
  ]);
  return {
    capturedAt,
    sourceBranch: pullRequest.sourceBranch,
    sourceCommit,
    targetBranch: pullRequest.targetBranch,
    targetCommit
  };
}

function stampEvidence(items: AgentEvidenceResult[] | null | undefined, context: EvidenceContext): AgentEvidenceResult[] {
  return (items ?? []).map((item) => stampEvidenceItem(item, context));
}

function stampEvidenceItem(item: AgentEvidenceResult, context: EvidenceContext): AgentEvidenceResult {
  return {
    ...item,
    payload: {
      ...(item.payload ?? {}),
      capturedAt: context.capturedAt,
      sourceBranch: context.sourceBranch,
      sourceCommit: context.sourceCommit,
      targetBranch: context.targetBranch,
      targetCommit: context.targetCommit
    }
  };
}

function failureSignature(result: AgentRunResult): string {
  const commandText = (result.testResults ?? [])
    .map((item) => [item.command, item.status, item.exitCode].filter(Boolean).join(":"))
    .join("|");
  return [result.stopReason ?? "failed", commandText, result.message.slice(0, 500)].filter(Boolean).join("\n");
}

function deriveObjectiveStatus(
  job: AgentJobDto,
  result: AgentRunResult,
  repeatedFailureCount: number,
  roundCount: number,
  maxRounds: number
): ObjectiveRunDto["status"] {
  if (result.status === "canceled") {
    return "canceled";
  }
  if (job.agentType === "verifier" && result.metadata?.verifier?.stopConditionMet === true) {
    return "ready_to_merge";
  }
  if (result.status === "waiting_human" || repeatedFailureCount >= 2 || roundCount >= maxRounds) {
    return "waiting_human";
  }
  if (result.status === "failed") {
    return "failed";
  }
  return "running";
}

function shouldRememberObjectiveStatus(status: ObjectiveRunDto["status"], repeatedFailureCount: number): boolean {
  return status === "ready_to_merge" || status === "waiting_human" || status === "failed" || repeatedFailureCount >= 2;
}

async function rememberObjectiveEvent(
  repos: Repositories,
  projectId: string,
  input: {
    title: string;
    body: string;
    tags: string[];
  }
): Promise<void> {
  await repos.loopMemory.create({
    projectId,
    sourceType: "agent_job",
    title: input.title,
    body: input.body,
    tags: input.tags
  });
  const project = await repos.projects.get(projectId);
  if (project) {
    await appendLoopMemoryNote(project.repoPath, input).catch(() => undefined);
  }
}
