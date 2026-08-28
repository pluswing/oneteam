import type { AgentJobDto, AgentJobStatus, AgentType, LabelDto } from "../../shared/types";
import { workflowLabelNames } from "../../shared/workflow-labels";
import type { Repositories } from "../db/repositories";
import { ensureSystemLoop, startLoopRun } from "./loop-runner";
import { ensureObjectiveForTarget } from "./objective-runs";
import {
  canTransitionWorkflowStage,
  expectedAgentForWorkflowStage,
  workflowStageForLabel
} from "./objective-workflow";

const activeStatuses = new Set<AgentJobStatus>(["queued", "running", "waiting_provider", "waiting_human"]);

const issueLabelAgents = new Map<string, AgentType>([
  [workflowLabelNames.requirements, "requirements"],
  [workflowLabelNames.readyForImplementation, "implementation"]
]);

const pullRequestLabelAgents = new Map<string, AgentType>([
  [workflowLabelNames.reviewing, "review"],
  [workflowLabelNames.fixing, "fix"],
  [workflowLabelNames.resolvingConflicts, "fix"],
  [workflowLabelNames.testing, "qa"],
  [workflowLabelNames.done, "verifier"]
]);

export type LabelAutomationInput = {
  projectId: string;
  targetType: "issue" | "pull_request";
  targetId: number;
  labels: LabelDto[];
  previousLabels?: LabelDto[];
  triggerType?: string;
};

export async function runLabelAutomation(
  repos: Repositories,
  input: LabelAutomationInput
): Promise<AgentJobDto[]> {
  const previousNames = new Set(input.previousLabels?.map((label) => label.name) ?? []);
  const addedLabels = input.previousLabels
    ? input.labels.filter((label) => !previousNames.has(label.name))
    : input.labels;
  const agentMap = input.targetType === "issue" ? issueLabelAgents : pullRequestLabelAgents;
  const createdJobs: AgentJobDto[] = [];

  for (const label of addedLabels) {
    const agentType = agentMap.get(label.name);
    if (!agentType || (await hasActiveJob(repos, input, agentType))) {
      continue;
    }

    const loop = await ensureSystemLoop(repos, {
      projectId: input.projectId,
      name: `Label: ${label.name}`,
      purpose: `Run the ${agentType} agent when "${label.name}" is applied to a ${input.targetType}.`,
      triggerType: "label",
      targetScope: `${input.targetType}:${label.name}`
    });
    if (loop.status === "disabled") {
      continue;
    }

    const objective = await ensureObjectiveForTarget(repos, {
      projectId: input.projectId,
      targetType: input.targetType,
      targetId: input.targetId
    });
    if (!objective || ["paused", "canceled", "succeeded"].includes(objective.status)) {
      continue;
    }
    const labelStage = workflowStageForLabel(label.name);
    const stagedObjective = labelStage && labelStage !== objective.workflowStage &&
      canTransitionWorkflowStage(objective.workflowStage, labelStage)
      ? (await repos.objectives.update(input.projectId, objective.id, { workflowStage: labelStage })) ?? objective
      : objective;
    const expectedAgent = expectedAgentForWorkflowStage(stagedObjective.workflowStage);
    if (expectedAgent && expectedAgent !== agentType) {
      continue;
    }

    const started = await startLoopRun(repos, {
      projectId: input.projectId,
      loopId: loop.id,
      agentType,
      targetType: input.targetType,
      targetId: input.targetId,
      triggerType: input.triggerType ?? "label_applied",
      objectiveRunId: objective?.id ?? null,
      jobInput: {
        automation: "label",
        labelName: label.name,
        loopId: loop.id,
        objectiveRunId: objective?.id ?? null
      }
    });
    await repos.activities.create({
      projectId: input.projectId,
      agentJobId: started.job.id,
      targetType: input.targetType,
      targetId: input.targetId,
      activityType: "system",
      title: "Agent job queued",
      body: `Queued ${agentType} agent via Loop #${loop.id} because label "${label.name}" was applied.`,
      payload: {
        loopId: loop.id,
        loopRunId: started.run.id,
        loopStepId: started.step.id,
        labelName: label.name
      }
    });
    createdJobs.push(started.job);
  }

  return createdJobs;
}

async function hasActiveJob(
  repos: Repositories,
  input: Pick<LabelAutomationInput, "projectId" | "targetType" | "targetId">,
  agentType: AgentType
): Promise<boolean> {
  const jobs = await repos.agentJobs.list({
    projectId: input.projectId,
    targetType: input.targetType,
    targetId: input.targetId
  });
  return jobs.some((job) => job.agentType === agentType && activeStatuses.has(job.status));
}
