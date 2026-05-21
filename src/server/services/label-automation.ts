import type { AgentJobDto, AgentJobStatus, AgentType, LabelDto } from "../../shared/types";
import type { Repositories } from "../db/repositories";
import { resolveAgentJobLockKey } from "./agent-job-locks";

const activeStatuses = new Set<AgentJobStatus>(["queued", "running", "waiting_human"]);

const issueLabelAgents = new Map<string, AgentType>([
  ["要件定義中", "requirements"],
  ["実装待ち", "implementation"]
]);

const pullRequestLabelAgents = new Map<string, AgentType>([
  ["レビュー中", "review"],
  ["修正中", "fix"],
  ["コンフリクト修正中", "fix"],
  ["テスト中", "qa"]
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

    const job = await repos.agentJobs.create({
      projectId: input.projectId,
      agentType,
      targetType: input.targetType,
      targetId: input.targetId,
      triggerType: input.triggerType ?? "label_applied",
      input: {
        automation: "label",
        labelName: label.name
      },
      lockKey: resolveAgentJobLockKey({
        projectId: input.projectId,
        agentType,
        targetType: input.targetType,
        targetId: input.targetId
      })
    });
    await repos.activities.create({
      projectId: input.projectId,
      agentJobId: job.id,
      targetType: input.targetType,
      targetId: input.targetId,
      activityType: "system",
      title: "Agent job queued",
      body: `Queued ${agentType} agent because label "${label.name}" was applied.`
    });
    createdJobs.push(job);
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
