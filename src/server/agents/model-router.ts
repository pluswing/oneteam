import type { AgentJobDto } from "../../shared/types";
import type { Repositories } from "../db/repositories";
import type { CodexModel } from "./codex-rpc";
import type { ModelSelection, ModelSelector } from "./codex-runtime";
import { readModelSettings } from "../services/model-settings";
import { completedLoopCost, observedCompletionCosts, reviewedModelRates, type CompletionCostSample } from "./model-economics";

type Tier = "light" | "standard" | "advanced";
export const modelPolicyVersion = "2026-10-27-completion-cost-v4";
export const preferredCodexModel = "gpt-6.1-sol";
export type TaskFeatures = { text: string; fileCount: number; qualityFailures: number; role: AgentJobDto["agentType"]; completionCosts?: CompletionCostSample[] };

function solVersion(model: string): number[] | null {
  const match = /^gpt-(\d+)(?:\.(\d+))?-sol(?:-\d{4}-\d{2}-\d{2})?$/.exec(model);
  return match ? [Number(match[1]), Number(match[2] ?? 0)] : null;
}
function newerSol(left: string, right: string): boolean {
  const a = solVersion(left), b = solVersion(right);
  return Boolean(a && b && (a[0] > b[0] || a[0] === b[0] && a[1] > b[1]));
}

function recommendedSuccessor(model: CodexModel, available: CodexModel[]): CodexModel {
  const seen = new Set<string>();
  while (!seen.has(model.model)) {
    seen.add(model.model);
    const id = model.upgrade ?? model.upgradeInfo?.model;
    const next = available.find((candidate) => candidate.model === id && !seen.has(candidate.model));
    if (!next) break;
    model = next;
  }
  return model;
}

export function taskTier(features: TaskFeatures): Tier {
  const complex = /architect|migration|authenticat|authoriz|concurren|race condition|security|redesign|rebuild|データ移行|認証|認可|設計変更|作り直|作り替|並行|競合|セキュリティ/i.test(features.text);
  const simple = /typo|spelling|readme|documentation|copy change|誤字|文言|ドキュメント|表記/i.test(features.text);
  return complex || features.fileCount > 8 || features.qualityFailures > 0 ? "advanced"
    : simple && features.fileCount <= 3 && features.role !== "retrospective" ? "light" : "standard";
}

export function assertAutomaticModelFallback(model: string, rejected: ReadonlySet<string>): void {
  if (rejected.has(preferredCodexModel) && (/^gpt-5(?:[.-]|$)/.test(model) || model === "gpt-6-sol")) {
    throw new Error("GPT-6.1 Solを利用できないため、自動実行を停止しました。高コストの旧モデルへ自動変更しません。Codexのログイン・契約・ワークスペースのモデル許可を確認してください。旧モデルを使う場合はモデルを明示指定してください。");
  }
}

/** A verified preference, not a claim that model/list grants account access.
 * GPT-6.1 Sol: https://developers.openai.com/api/docs/models/gpt-6.1-sol
 * GPT-5.6 Sol: https://developers.openai.com/api/docs/models/gpt-5.6-sol
 * Reviewed 2026-10-27: prefer the newer balanced model over the older Sol defaults.
 */
export function modelSelectionCandidates(catalog: CodexModel[]): CodexModel[] {
  const available = catalog.filter((model) => !model.hidden && model.model.trim());
  const recommended = available.find((model) => model.isDefault) ?? available[0];
  // Catalogs can lag model releases. Probe only this explicitly reviewed upgrade;
  // do not invent model names by sorting version numbers or replacing suffixes.
  if (!recommended || catalog.some((model) => model.model === preferredCodexModel)
    || !["gpt-5.6", "gpt-5.6-sol", "gpt-6-sol"].includes(recommended.model)) return available;
  return [...available, {
    id: preferredCodexModel, model: preferredCodexModel, displayName: "GPT-6.1 Sol", hidden: false, isDefault: false,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"].map((reasoningEffort) => ({ reasoningEffort }))
  }];
}

export function selectTaskModel(models: CodexModel[], features: TaskFeatures): ModelSelection {
  const available = models.filter((model) => !model.hidden && model.model.trim());
  if (!available.length) throw new Error("No available Codex models. Reconnect and retry.");
  const tier = taskTier(features);
  let desiredEffort = tier === "advanced" ? "high" : tier === "light" ? "low" : "medium";
  const currentDefault = available.find((model) => model.isDefault) ?? available[0];
  const reviewed = available.find((model) => model.model === preferredCodexModel);
  const latestSol = available.filter((model) => solVersion(model.model)).reduce<CodexModel | undefined>((best, model) => !best || newerSol(model.model, best.model) ? model : best, reviewed);
  // An official successor/default can introduce a completely new model family.
  // A newly listed Sol also becomes eligible without an application release.
  const defaultSuccessor = recommendedSuccessor(currentDefault, available);
  const reviewedSuccessor = reviewed ? recommendedSuccessor(reviewed, available) : null;
  const unknownDefault = !reviewedModelRates[currentDefault.model] && !solVersion(currentDefault.model)
    && !["gpt-6-sol", "gpt-5.6", "gpt-5.5", "gpt-5.4"].includes(currentDefault.model);
  let preferred = reviewedSuccessor && reviewedSuccessor !== reviewed ? reviewedSuccessor
    : defaultSuccessor !== currentDefault ? defaultSuccessor
      : unknownDefault && currentDefault.isDefault ? currentDefault : latestSol ?? currentDefault;
  const focused = features.qualityFailures === 0 && (features.role === "command_detection"
    || tier === "light" && ["implementation", "fix"].includes(features.role));
  const efficient = focused ? available.find((model) => model.model === "gpt-6-luna") : null;
  if (efficient) { preferred = recommendedSuccessor(efficient, available); desiredEffort = "high"; }
  // Repeated quality failures justify moving beyond the balanced model. A larger
  // token price can be cheaper than repeating an unsuccessful implementation.
  if (features.qualityFailures >= 2) preferred = available.find((model) => model.model === "gpt-6-astra") ?? preferred;
  const observations = observedCompletionCosts(features.completionCosts ?? [], tier);
  const baseline = observations.get(preferred.model);
  let costEvidence = "";
  if (baseline && features.qualityFailures === 0 && ["implementation", "fix"].includes(features.role)) {
    const alternatives = available.filter((model) => observations.has(model.model) && observations.get(model.model)!.completionRate >= baseline.completionRate
      && (model.model === preferred.model || newerSol(model.model, preferredCodexModel) || [preferredCodexModel, "gpt-6-astra"].includes(model.model) || focused && model.model === "gpt-6-luna"));
    const cheaper = alternatives.sort((a, b) => observations.get(a.model)!.mean - observations.get(b.model)!.mean)[0];
    if (cheaper && observations.get(cheaper.model)!.mean < baseline.mean * 0.8) {
      preferred = cheaper;
      const stats = observations.get(cheaper.model)!;
      costEvidence = ` Verified workflow history: ${stats.count} comparable completed tasks; estimated total API cost including retries/review/QA/verification averages $${stats.mean.toFixed(4)}, over 20% below the baseline. This is an estimate, not a billing or future-cost guarantee.`;
    }
  }
  // Keep unknown models usable and restrict effort to the selected model's capabilities.
  // Never abandon a better model solely because effort labels differ across
  // generations. Use its closest supported effort instead of a legacy model.
  const selected = preferred;
  const efforts = selected.supportedReasoningEfforts.map((option) => option.reasoningEffort);
  const effort = efforts.includes(desiredEffort) ? desiredEffort : efforts.includes(selected.defaultReasoningEffort) ? selected.defaultReasoningEffort : efforts[0] ?? null;
  const reason = features.qualityFailures > 0
    ? `Higher reasoning capacity after ${features.qualityFailures} quality failure(s).`
    : features.fileCount > 8 ? `Change spans ${features.fileCount} files.`
        : tier === "light" ? "A bounded documentation or wording change favors lower latency."
          : tier === "advanced" ? "Architecture, data, security, or concurrency changes require deeper reasoning."
            : "Standard development task; balance reasoning quality and execution time.";
  const source = selected.model === preferredCodexModel
    ? "Preferring GPT-6.1 Sol for coding quality and token cost (policy reviewed 2026-10-27)."
    : newerSol(selected.model, preferredCodexModel) || selected === defaultSuccessor && defaultSuccessor !== currentDefault || selected === reviewedSuccessor && reviewedSuccessor !== reviewed
      ? "Using a current catalog successor; future prices and completion cost remain unverified until measured."
      : selected.model === "gpt-6-luna" ? "Using the current efficient model for focused, repeatable work, with high reasoning and downstream verification."
      : selected.model === "gpt-6-astra" ? "Escalating capability to avoid repeated quality failures."
        : selected.isDefault ? "Using Codex's current recommended default." : "Using an available current catalog candidate.";
  return { model: selected.model, effort, reason: `${reason} ${source}${costEvidence}${available.length === 1 ? " Only one model is available." : ""}`, policyVersion: modelPolicyVersion };
}

export function createModelSelector(repos: Repositories): ModelSelector {
  return async (models, input) => {
    const job = input.job;
    const settings = await readModelSettings(repos, job.projectId);
    const override = job.input.modelOverride as { model?: string | null; effort?: string | null } | undefined;
    const requestedModel = override?.model ?? settings.roles[job.agentType]?.model ?? settings.model;
    const requestedEffort = override?.effort ?? settings.roles[job.agentType]?.effort ?? settings.effort;
    const loop = typeof job.input.developmentLoopId === "number" ? await repos.development.get(job.projectId, job.input.developmentLoopId) : null;
    const issue = loop ? await repos.issues.get(job.projectId, loop.issueId) : job.targetType === "issue" ? await repos.issues.get(job.projectId, job.targetId) : null;
    const projectJobs = await repos.agentJobs.list({ projectId: job.projectId });
    const jobs = loop ? projectJobs.filter((item) => item.input.developmentLoopId === loop.id) : [];
    const paths = new Set(jobs.flatMap((item) => Array.isArray(item.output?.changedFiles) ? item.output.changedFiles.filter((value): value is string => typeof value === "string") : []));
    const feedback = jobs.filter((item) => ["requirements", "review", "qa", "fix"].includes(item.agentType)).map((item) => String(item.output?.message ?? "")).join("\n");
    const qualityFailures = Number(job.input.qualityFailures ?? 0) + jobs.filter((item) => {
      const metadata = item.output?.metadata as { review?: { verdict?: string }; qa?: { verdict?: string } } | undefined;
      return metadata?.review?.verdict === "changes_requested" || metadata?.qa?.verdict === "defects_found";
    }).length;
    const completionCosts: CompletionCostSample[] = [];
    if (!requestedModel) {
      const completed = (await repos.development.list(job.projectId)).filter((item) => ["succeeded", "failed"].includes(item.status)).slice(0, 100);
      if (completed.length) {
        const executions = await repos.development.executions.recent(job.projectId);
        for (const item of completed) {
          const source = await repos.issues.get(job.projectId, item.issueId);
          if (!source) continue;
          const sample = completedLoopCost(item, projectJobs, executions, taskTier({ text: `${source.title}\n${source.body}`, fileCount: 0, qualityFailures: 0, role: "implementation" }));
          if (sample) completionCosts.push(sample);
        }
      }
    }
    const features = { text: `${issue?.title ?? ""}\n${issue?.body ?? ""}\n${feedback}`, fileCount: paths.size, qualityFailures, role: job.agentType, completionCosts };
    const selection = selectTaskModel(models, features);
    if (!requestedModel && !requestedEffort) return selection;
    const candidate = models.find((model) => model.model === (requestedModel ?? selection.model));
    if (!candidate) throw new Error(`The requested model is not available: ${requestedModel}. Review the Job or project model settings.`);
    const efforts = candidate.supportedReasoningEfforts.map((option) => option.reasoningEffort);
    if (requestedEffort && !efforts.includes(requestedEffort)) throw new Error(`${candidate.model} does not support reasoning effort ${requestedEffort}.`);
    const taskSelection = requestedModel ? selectTaskModel([candidate], features) : selection;
    return { ...selection, model: candidate.model, effort: requestedEffort ?? taskSelection.effort,
      reason: `User model settings: ${candidate.model}, ${requestedEffort ?? "task-appropriate reasoning"}.` };
  };
}
