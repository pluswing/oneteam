import type { AgentJobDto } from "../../shared/types";
import type { Repositories } from "../db/repositories";
import type { CodexModel } from "./codex-rpc";
import type { ModelSelection, ModelSelector } from "./codex-runtime";

type Tier = "light" | "standard" | "advanced";
export const modelPolicyVersion = "2026-09-11-v1";
// An explicit, versioned policy: catalog order and model names are not capability scores.
const preferences: Record<Tier, string[]> = {
  light: ["gpt-5.4-mini"],
  standard: ["gpt-5.4", "gpt-5.3-codex"],
  advanced: ["gpt-5.5"]
};
export type TaskFeatures = { text: string; fileCount: number; qualityFailures: number; role: AgentJobDto["agentType"] };

export function selectTaskModel(models: CodexModel[], features: TaskFeatures): ModelSelection {
  if (!models.length) throw new Error("No available Codex models. Reconnect and retry.");
  const complex = /architect|migration|authenticat|authoriz|concurren|race condition|security|redesign|rebuild|データ移行|認証|認可|設計変更|作り直|作り替|並行|競合|セキュリティ/i.test(features.text);
  const simple = /typo|spelling|readme|documentation|copy change|誤字|文言|ドキュメント|表記/i.test(features.text);
  let tier: Tier = complex || features.fileCount > 8 || features.qualityFailures > 0 ? "advanced" : simple && features.fileCount <= 3 ? "light" : "standard";
  if (features.role === "retrospective" && tier === "light") tier = "standard";
  const tiers: Tier[] = tier === "advanced" ? ["advanced", "standard", "light"] : tier === "light" ? ["light", "standard", "advanced"] : ["standard", "advanced", "light"];
  const requested = tiers.flatMap((candidate) => preferences[candidate]).map((id) => models.find((model) => model.model === id)).find(Boolean);
  const selected = requested ?? models.find((model) => model.isDefault) ?? (models.length === 1 ? models[0] : null);
  if (!selected) throw new Error("The Codex catalog has no recognized or default model. Update OneTeam's model policy before running.");
  const desiredEffort = tier === "advanced" ? "high" : tier === "light" ? "low" : "medium";
  const efforts = selected.supportedReasoningEfforts.map((option) => option.reasoningEffort);
  const effort = efforts.includes(desiredEffort) ? desiredEffort : efforts.includes(selected.defaultReasoningEffort) ? selected.defaultReasoningEffort : efforts[0] ?? null;
  const reason = features.qualityFailures > 0
    ? `Higher reasoning capacity after ${features.qualityFailures} quality failure(s).`
    : complex ? "Architecture, data, security, or concurrency changes require deeper reasoning."
      : features.fileCount > 8 ? `Change spans ${features.fileCount} files.`
        : tier === "light" ? "A bounded documentation or wording change favors lower latency."
          : "Standard development task; balance reasoning quality and execution time.";
  return { model: selected.model, effort, reason: `${reason}${!preferences[tier].includes(selected.model) ? ` Preferred ${tier} models are unavailable; using ${selected.model}.` : ""}${models.length === 1 ? " Only one model is available." : ""}${requested ? "" : " Using Codex's available default."}`, policyVersion: modelPolicyVersion };
}

export function createModelSelector(repos: Repositories): ModelSelector {
  return async (models, input) => {
    const job = input.job;
    const loop = typeof job.input.developmentLoopId === "number" ? await repos.development.get(job.projectId, job.input.developmentLoopId) : null;
    const issue = loop ? await repos.issues.get(job.projectId, loop.issueId) : job.targetType === "issue" ? await repos.issues.get(job.projectId, job.targetId) : null;
    const jobs = loop ? (await repos.agentJobs.list({ projectId: job.projectId })).filter((item) => item.input.developmentLoopId === loop.id) : [];
    const paths = new Set(jobs.flatMap((item) => Array.isArray(item.output?.changedFiles) ? item.output.changedFiles.filter((value): value is string => typeof value === "string") : []));
    const feedback = jobs.filter((item) => ["requirements", "review", "qa", "fix"].includes(item.agentType)).map((item) => String(item.output?.message ?? "")).join("\n");
    const qualityFailures = Number(job.input.qualityFailures ?? 0) + jobs.filter((item) => {
      const metadata = item.output?.metadata as { review?: { verdict?: string }; qa?: { verdict?: string } } | undefined;
      return metadata?.review?.verdict === "changes_requested" || metadata?.qa?.verdict === "defects_found";
    }).length;
    return selectTaskModel(models, { text: `${issue?.title ?? ""}\n${issue?.body ?? ""}\n${feedback}`, fileCount: paths.size, qualityFailures, role: job.agentType });
  };
}
