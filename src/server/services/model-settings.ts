import type { ModelPolicySettings } from "../../shared/chat";
import type { Repositories } from "../db/repositories";
import type { AgentJobDto } from "../../shared/types";

export const modelSettingsKey = (projectId: string) => `codex:model-policy:${projectId}`;
export async function readModelSettings(repos: Repositories, projectId: string): Promise<ModelPolicySettings> {
  const value = await repos.settings.get(modelSettingsKey(projectId));
  return { model: typeof value?.model === "string" ? value.model : null, effort: typeof value?.effort === "string" ? value.effort : null,
    roles: value?.roles && typeof value.roles === "object" ? value.roles as ModelPolicySettings["roles"] : {} };
}

export async function requestedJobModel(repos: Repositories, job: AgentJobDto): Promise<string | null> {
  const settings = await readModelSettings(repos, job.projectId);
  const override = job.input.modelOverride as { model?: string | null } | undefined;
  return override?.model ?? settings.roles[job.agentType]?.model ?? settings.model;
}
