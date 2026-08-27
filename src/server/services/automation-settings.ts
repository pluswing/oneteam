import type { ProjectSettingsDto } from "../../shared/types";
import type { Repositories } from "../db/repositories";

export const defaultAutomationSettings: ProjectSettingsDto["automation"] = {
  autoMergeEnabled: true
};

export async function readAutomationSettings(repos: Repositories): Promise<ProjectSettingsDto["automation"]> {
  const stored = await repos.settings.get("automation");
  return {
    autoMergeEnabled:
      typeof stored?.autoMergeEnabled === "boolean"
        ? stored.autoMergeEnabled
        : defaultAutomationSettings.autoMergeEnabled
  };
}

export async function saveAutomationSettings(
  repos: Repositories,
  settings: ProjectSettingsDto["automation"]
): Promise<void> {
  await repos.settings.set("automation", settings as unknown as Record<string, unknown>);
}
