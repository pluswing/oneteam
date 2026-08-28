import type {
  AgentJobDto,
  AgentType,
  ObjectiveRunDto,
  ObjectiveWorkflowStage
} from "../../shared/types";
import { workflowLabelNames } from "../../shared/workflow-labels";
import type { AgentRunResult } from "../agents/types";
import type { Repositories } from "../db/repositories";

const agentStages: Partial<Record<AgentType, ObjectiveWorkflowStage>> = {
  requirements: "requirements",
  implementation: "implementation",
  review: "review",
  fix: "fix",
  qa: "qa",
  verifier: "verification"
};

const stageAgents: Partial<Record<ObjectiveWorkflowStage, AgentType>> = {
  requirements: "requirements",
  implementation: "implementation",
  review: "review",
  fix: "fix",
  qa: "qa",
  verification: "verifier"
};

const allowedTransitions: Record<ObjectiveWorkflowStage, ReadonlySet<ObjectiveWorkflowStage>> = {
  requirements: new Set(["requirements", "implementation"]),
  implementation: new Set(["implementation", "review"]),
  review: new Set(["review", "fix", "qa"]),
  fix: new Set(["fix", "review", "qa"]),
  qa: new Set(["qa", "fix", "verification"]),
  verification: new Set(["verification", "fix", "ready_to_merge"]),
  ready_to_merge: new Set(["verification", "ready_to_merge", "fix", "merged"]),
  merged: new Set(["merged"])
};

export function workflowStageForAgent(agentType: AgentType): ObjectiveWorkflowStage | null {
  return agentStages[agentType] ?? null;
}

export function expectedAgentForWorkflowStage(stage: ObjectiveWorkflowStage): AgentType | null {
  return stageAgents[stage] ?? null;
}

export function canTransitionWorkflowStage(
  currentStage: ObjectiveWorkflowStage,
  nextStage: ObjectiveWorkflowStage
): boolean {
  return allowedTransitions[currentStage].has(nextStage);
}

export function workflowStageForLabel(label: unknown): ObjectiveWorkflowStage | null {
  if (typeof label !== "string") return null;
  if (label === workflowLabelNames.requirements) return "requirements";
  if (label === workflowLabelNames.readyForImplementation || label === workflowLabelNames.implementing) {
    return "implementation";
  }
  if (label === workflowLabelNames.pullRequestCreated || label === workflowLabelNames.reviewing) return "review";
  if (label === workflowLabelNames.fixing || label === workflowLabelNames.resolvingConflicts) return "fix";
  if (label === workflowLabelNames.testing) return "qa";
  if (label === workflowLabelNames.done) return "verification";
  if (label === workflowLabelNames.readyToMerge) return "ready_to_merge";
  return null;
}

export function workflowStageAfterResult(
  job: AgentJobDto,
  result: AgentRunResult,
  currentStage: ObjectiveWorkflowStage
): ObjectiveWorkflowStage {
  if (result.status !== "succeeded") return workflowStageForAgent(job.agentType) ?? currentStage;
  const labelStage = workflowStageForLabel(result.metadata?.nextLabel);
  if (labelStage && canTransitionWorkflowStage(currentStage, labelStage)) return labelStage;
  if (job.agentType === "requirements") return "implementation";
  if (job.agentType === "implementation" && result.metadata?.pullRequest) return "review";
  if (job.agentType === "fix") return "review";
  if (job.agentType === "verifier" && result.metadata?.verifier?.stopConditionMet === true) return "ready_to_merge";
  return workflowStageForAgent(job.agentType) ?? currentStage;
}

export async function advanceObjectiveWorkflowStage(
  repos: Repositories,
  job: AgentJobDto,
  result: AgentRunResult
): Promise<ObjectiveRunDto | null> {
  const objectiveRunId = job.input.objectiveRunId;
  const objective = typeof objectiveRunId === "number"
    ? await repos.objectives.get(job.projectId, objectiveRunId)
    : job.targetType === "issue"
      ? await repos.objectives.findByIssue(job.projectId, job.targetId)
      : job.targetType === "pull_request"
        ? await repos.objectives.findByPullRequest(job.projectId, job.targetId)
        : null;
  if (!objective) return null;
  const workflowStage = workflowStageAfterResult(job, result, objective.workflowStage);
  if (workflowStage === objective.workflowStage) return objective;
  return repos.objectives.update(job.projectId, objective.id, { workflowStage });
}
