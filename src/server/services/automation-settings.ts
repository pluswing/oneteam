import type { ProjectSettingsDto } from "../../shared/types";
import type { Repositories } from "../db/repositories";

export const defaultAutomationSettings: ProjectSettingsDto["automation"] = {
  autoMergeEnabled: true,
  autoMergeTargetBranches: [],
  autoMergeStrategy: "merge",
  autoMergeRiskThreshold: "medium"
};

export async function readAutomationSettings(repos: Repositories): Promise<ProjectSettingsDto["automation"]> {
  const stored = await repos.settings.get("automation");
  return {
    autoMergeEnabled:
      typeof stored?.autoMergeEnabled === "boolean"
        ? stored.autoMergeEnabled
        : defaultAutomationSettings.autoMergeEnabled,
    autoMergeTargetBranches: Array.isArray(stored?.autoMergeTargetBranches)
      ? Array.from(
          new Set(
            stored.autoMergeTargetBranches
              .filter((branch): branch is string => typeof branch === "string")
              .map((branch) => branch.trim())
              .filter(Boolean)
          )
        )
      : defaultAutomationSettings.autoMergeTargetBranches,
    autoMergeStrategy: stored?.autoMergeStrategy === "squash" ? "squash" : "merge",
    autoMergeRiskThreshold: ["medium", "high", "none"].includes(String(stored?.autoMergeRiskThreshold))
      ? (stored?.autoMergeRiskThreshold as ProjectSettingsDto["automation"]["autoMergeRiskThreshold"])
      : defaultAutomationSettings.autoMergeRiskThreshold
  };
}

export async function saveAutomationSettings(
  repos: Repositories,
  settings: ProjectSettingsDto["automation"]
): Promise<void> {
  await repos.settings.set("automation", settings as unknown as Record<string, unknown>);
}
