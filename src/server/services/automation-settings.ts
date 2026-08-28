import type { ProjectSettingsDto } from "../../shared/types";
import type { Repositories } from "../db/repositories";

export const defaultAutomationSettings: ProjectSettingsDto["automation"] = {
  autoMergeEnabled: true,
  autoMergeTargetBranches: [],
  autoMergeStrategy: "merge",
  autoMergeRiskThreshold: "medium",
  objectiveMaxRounds: 12,
  objectiveTokenBudget: null,
  objectiveCostBudgetUsd: null,
  agentTimeBudgetMinutes: null,
  verificationCommandTimeoutMinutes: 5
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
      : defaultAutomationSettings.autoMergeRiskThreshold,
    objectiveMaxRounds: boundedInteger(
      stored?.objectiveMaxRounds,
      1,
      1_000,
      defaultAutomationSettings.objectiveMaxRounds
    ),
    objectiveTokenBudget: positiveIntegerOrNull(stored?.objectiveTokenBudget),
    objectiveCostBudgetUsd: positiveNumberOrNull(stored?.objectiveCostBudgetUsd),
    agentTimeBudgetMinutes: positiveNumberOrNull(stored?.agentTimeBudgetMinutes),
    verificationCommandTimeoutMinutes:
      positiveNumberOrNull(stored?.verificationCommandTimeoutMinutes) ??
      defaultAutomationSettings.verificationCommandTimeoutMinutes
  };
}

export async function saveAutomationSettings(
  repos: Repositories,
  settings: ProjectSettingsDto["automation"]
): Promise<void> {
  await repos.settings.set("automation", settings as unknown as Record<string, unknown>);
}

function positiveIntegerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function positiveNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}
