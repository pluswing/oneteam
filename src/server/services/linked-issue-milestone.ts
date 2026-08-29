import type { AgentJobDto, ObjectiveRunDto, PullRequestDto } from "../../shared/types";
import type { AgentRunResult } from "../agents/types";
import type { Repositories } from "../db/repositories";
import {
  buildSystemComment,
  markdownCode,
  type SystemCommentOutcome
} from "./system-comment";
import { workflowStageForLabel } from "./objective-workflow";
import type { PreparedWorktree } from "./worktree-service";
import { verifyMarkdownReferences } from "./verified-markdown-references";

type LinkedIssueMilestone = {
  event: string;
  title: string;
  outcome: SystemCommentOutcome;
  summary: string;
  decisionItems: string[];
  nextStep: string;
};

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(stringValue).filter((item): item is string => item !== null)
    : [];
}

function recordArrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function milestoneForAgentResult(job: AgentJobDto, result: AgentRunResult): LinkedIssueMilestone | null {
  if (job.agentType === "review") {
    const review = result.metadata?.review;
    const verdict = stringValue(review?.verdict);
    if (verdict === "changes_requested") {
      return {
        event: "review-changes-requested",
        title: "Review requested changes",
        outcome: "blocked",
        summary: result.message,
        decisionItems: [
          `Verdict: ${markdownCode(verdict)}.`,
          `Findings: ${recordArrayLength(review?.findings)}.`,
          ...stringArray(review?.checked).map((item) => `Checked: ${item}`)
        ],
        nextStep: "OneTeam queued the fix stage. Findings and line-level details remain available on the linked Pull Request."
      };
    }
    if (verdict === "approved") {
      return {
        event: "review-approved",
        title: "Review approved",
        outcome: "success",
        summary: result.message,
        decisionItems: [
          `Verdict: ${markdownCode(verdict)}.`,
          ...stringArray(review?.checked).map((item) => `Checked: ${item}`)
        ],
        nextStep: "OneTeam queued the QA stage against the reviewed revision."
      };
    }
  }

  if (job.agentType === "fix") {
    const resolved = stringArray(result.metadata?.fix?.resolvedFindings);
    return {
      event: "fix-completed",
      title: "Fix stage completed",
      outcome: "success",
      summary: result.message,
      decisionItems: [
        `Resolved findings reported: ${resolved.length}.`,
        ...resolved.map((item) => `Resolved: ${item}`)
      ],
      nextStep: "OneTeam returned the Pull Request to review so the new revision can be evaluated independently."
    };
  }

  if (job.agentType === "qa") {
    const qa = result.metadata?.qa;
    const verdict = stringValue(qa?.verdict);
    if (verdict === "defects_found") {
      return {
        event: "qa-defects-found",
        title: "QA found defects",
        outcome: "blocked",
        summary: result.message,
        decisionItems: [
          `Verdict: ${markdownCode(verdict)}.`,
          `Defects: ${recordArrayLength(qa?.defects)}.`,
          ...stringArray(qa?.observations).map((item) => `Observation: ${item}`)
        ],
        nextStep: "OneTeam queued the fix stage. Defect details remain available on the linked Pull Request."
      };
    }
    if (verdict === "passed") {
      return {
        event: "qa-passed",
        title: "QA passed",
        outcome: "success",
        summary: result.message,
        decisionItems: [
          `Verdict: ${markdownCode(verdict)}.`,
          ...stringArray(qa?.observations).map((item) => `Observation: ${item}`)
        ],
        nextStep: "OneTeam queued final verification of the Objective and accumulated evidence."
      };
    }
  }

  if (job.agentType === "verifier") {
    const verifier = result.metadata?.verifier;
    const verdict = stringValue(verifier?.verdict) ?? "not reported";
    const missingEvidence = stringArray(verifier?.missingEvidence);
    const decisionItems = [
      `Verdict: ${markdownCode(verdict)}.`,
      `Stop condition met: ${verifier?.stopConditionMet === true ? "yes" : "no"}.`,
      ...missingEvidence.map((item) => `Missing evidence: ${item}`),
      ...stringArray(verifier?.notes).map((item) => `Note: ${item}`)
    ];
    if (verifier?.stopConditionMet === true || verdict === "passed") {
      return {
        event: "verification-passed",
        title: "Final verification passed",
        outcome: "ready",
        summary: result.message,
        decisionItems,
        nextStep: "OneTeam will evaluate the automatic merge gate against the current branch snapshots and repository policy."
      };
    }
    if (verdict === "failed") {
      return {
        event: "verification-failed",
        title: "Final verification returned work",
        outcome: "blocked",
        summary: result.message,
        decisionItems,
        nextStep: "OneTeam returned the Pull Request to the fix stage before another verification attempt."
      };
    }
    if (verdict === "missing_evidence") {
      return {
        event: "verification-missing-evidence",
        title: "Final verification needs evidence",
        outcome: "waiting",
        summary: result.message,
        decisionItems,
        nextStep: "Provide or capture the missing evidence on the Pull Request, then resume the Objective."
      };
    }
  }

  return null;
}

function milestoneKey(objective: ObjectiveRunDto, pullRequest: PullRequestDto, sourceKey: string): string {
  return `objective:${objective.id}:pull-request:${pullRequest.id}:${sourceKey}`;
}

async function resolveObjective(
  repos: Repositories,
  projectId: string,
  pullRequest: PullRequestDto
): Promise<ObjectiveRunDto> {
  let objective =
    (await repos.objectives.findByPullRequest(projectId, pullRequest.id)) ??
    (await repos.objectives.ensureForPullRequest({
      projectId,
      pullRequestId: pullRequest.id,
      issueId: pullRequest.issueId,
      title: pullRequest.title,
      goal: pullRequest.body
    }));
  const labelStage = pullRequest.labels.map((label) => workflowStageForLabel(label.name)).find((stage) => stage !== null);
  if (labelStage && labelStage !== objective.workflowStage) {
    objective = (await repos.objectives.update(projectId, objective.id, { workflowStage: labelStage })) ?? objective;
  }
  return objective;
}

async function createMilestone(
  repos: Repositories,
  input: {
    job: AgentJobDto;
    pullRequest: PullRequestDto;
    objective: ObjectiveRunDto;
    milestone: LinkedIssueMilestone;
    sourceKey: string;
  }
): Promise<void> {
  if (input.objective.issueId === null) return;
  const key = milestoneKey(input.objective, input.pullRequest, input.sourceKey);
  const comments = await repos.comments.list(input.job.projectId, "issue", input.objective.issueId);
  if (comments.some((comment) => comment.metadata?.workflowMilestoneKey === key)) return;

  const body = buildSystemComment({
    title: input.milestone.title,
    outcome: input.milestone.outcome,
    summary: input.milestone.summary,
    fields: [
      {
        label: "Pull request",
        value: `[#${input.pullRequest.id} — ${input.pullRequest.title}](/pulls/${input.pullRequest.id})`
      },
      { label: "Objective", value: `#${input.objective.id}`, code: true },
      { label: "Agent job", value: `#${input.job.id}`, code: true },
      { label: "Workflow stage", value: input.objective.workflowStage, code: true },
      { label: "Objective round", value: input.objective.roundCount, code: true }
    ],
    sections: [{ title: "Decision", items: input.milestone.decisionItems }],
    nextStep: input.milestone.nextStep,
    recordedBy: "OneTeam workflow"
  });
  const verified = await verifyMarkdownReferences(repos, {
    projectId: input.job.projectId,
    targetType: "issue",
    targetId: input.objective.issueId,
    body
  });
  await repos.comments.create({
    projectId: input.job.projectId,
    targetType: "issue",
    targetId: input.objective.issueId,
    authorType: "system",
    body: verified.body,
    metadata: {
      workflowMilestoneKey: key,
      workflowMilestoneEvent: input.milestone.event,
      objectiveRunId: input.objective.id,
      pullRequestId: input.pullRequest.id,
      agentJobId: input.job.id,
      workflowStage: input.objective.workflowStage,
      verifiedReferences: verified.references
    }
  });
  await repos.activities.create({
    projectId: input.job.projectId,
    agentJobId: input.job.id,
    targetType: "issue",
    targetId: input.objective.issueId,
    activityType: "system",
    title: input.milestone.title,
    body: verified.body,
    payload: {
      workflowMilestoneKey: key,
      pullRequestId: input.pullRequest.id,
      verifiedReferences: verified.references
    }
  });
}

export async function recordLinkedIssuePullRequestCreated(
  repos: Repositories,
  job: AgentJobDto,
  pullRequest: PullRequestDto
): Promise<void> {
  const objective = await resolveObjective(repos, job.projectId, pullRequest);
  await createMilestone(repos, {
    job,
    pullRequest,
    objective,
    sourceKey: "created",
    milestone: {
      event: "pull-request-created",
      title: "Pull request created",
      outcome: "success",
      summary: "Implementation produced a reviewable Pull Request and connected it to this Objective.",
      decisionItems: [
        `Source branch: ${markdownCode(pullRequest.sourceBranch)}.`,
        `Target branch: ${markdownCode(pullRequest.targetBranch)}.`
      ],
      nextStep: "OneTeam queued independent review of the linked Pull Request."
    }
  });
}

export async function recordIssueImplementationStarted(
  repos: Repositories,
  job: AgentJobDto,
  worktree: PreparedWorktree
): Promise<void> {
  if (job.agentType !== "implementation" || job.targetType !== "issue") return;
  const issue = await repos.issues.get(job.projectId, job.targetId);
  if (!issue) return;
  let objective =
    (await repos.objectives.findByIssue(job.projectId, issue.id)) ??
    (await repos.objectives.ensureForIssue({
      projectId: job.projectId,
      issueId: issue.id,
      title: issue.title,
      goal: issue.body
    }));
  objective =
    (await repos.objectives.update(job.projectId, objective.id, {
      status: "running",
      workflowStage: "implementation",
      lastAgentJobId: job.id,
      stopReason: null,
      summary: `Implementation job #${job.id} started in ${worktree.branchName}.`
    })) ?? objective;
  const key = `objective:${objective.id}:implementation-started:agent-job:${job.id}`;
  const comments = await repos.comments.list(job.projectId, "issue", issue.id);
  if (comments.some((comment) => comment.metadata?.workflowMilestoneKey === key)) return;

  const body = buildSystemComment({
    title: "Implementation started",
    outcome: "info",
    summary: "OneTeam passed the Objective preflight and prepared an isolated worktree for implementation.",
    fields: [
      { label: "Objective", value: `#${objective.id}`, code: true },
      { label: "Agent job", value: `#${job.id}`, code: true },
      { label: "Provider", value: job.aiProvider, code: true },
      job.aiModel ? { label: "Model", value: job.aiModel, code: true } : null,
      { label: "Workflow stage", value: objective.workflowStage, code: true },
      { label: "Objective round", value: objective.roundCount, code: true },
      { label: "Branch", value: worktree.branchName, code: true },
      { label: "Worktree", value: worktree.worktreePath, code: true }
    ],
    sections: [
      {
        title: "Execution state",
        items: [
          worktree.recovered
            ? "An existing OneTeam worktree was recovered for the same branch."
            : "A dedicated worktree was prepared from the project default branch.",
          "The original Issue description remains unchanged.",
          "The Objective round will be recorded when the Agent result is applied."
        ]
      }
    ],
    nextStep: "The implementation Agent will make and verify changes, commit the branch, and create a linked Pull Request when the evidence gates pass.",
    recordedBy: "OneTeam workflow"
  });
  await repos.comments.create({
    projectId: job.projectId,
    targetType: "issue",
    targetId: issue.id,
    authorType: "system",
    body,
    metadata: {
      workflowMilestoneKey: key,
      workflowMilestoneEvent: "implementation-started",
      objectiveRunId: objective.id,
      agentJobId: job.id,
      workflowStage: objective.workflowStage,
      branchName: worktree.branchName,
      worktreePath: worktree.worktreePath,
      recovered: worktree.recovered === true
    }
  });
  await repos.activities.create({
    projectId: job.projectId,
    agentJobId: job.id,
    targetType: "issue",
    targetId: issue.id,
    activityType: "system",
    title: "Implementation started",
    body,
    payload: { workflowMilestoneKey: key, objectiveRunId: objective.id, branchName: worktree.branchName }
  });
}

export async function recordLinkedIssueAgentMilestone(
  repos: Repositories,
  job: AgentJobDto,
  result: AgentRunResult
): Promise<void> {
  if (job.targetType !== "pull_request") return;
  const milestone = milestoneForAgentResult(job, result);
  if (!milestone) return;
  const pullRequest = await repos.pullRequests.get(job.projectId, job.targetId);
  if (!pullRequest) return;
  const objective = await resolveObjective(repos, job.projectId, pullRequest);
  await createMilestone(repos, {
    job,
    pullRequest,
    objective,
    milestone,
    sourceKey: `agent-job:${job.id}:${milestone.event}`
  });
}
