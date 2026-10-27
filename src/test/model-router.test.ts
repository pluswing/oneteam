import { expect, it } from "vitest";
import type { CodexModel } from "../server/agents/codex-rpc";
import { modelSelectionCandidates, preferredCodexModel, selectTaskModel } from "../server/agents/model-router";

function model(id: string, efforts = ["low", "medium", "high"], isDefault = false): CodexModel {
  return { id, model: id, displayName: id, hidden: false, isDefault, defaultReasoningEffort: "medium",
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort })) };
}
const task = { text: "Add a filter", role: "implementation" as const, fileCount: 1, qualityFailures: 0 };

it.each([
  ["Fix a README typo", 0, "low"],
  ["Add a filter", 0, "medium"],
  ["Authentication migration", 0, "high"],
  ["Fix a README typo", 1, "high"]
] as const)("prefers GPT-6.1 Sol for %s over an older or more expensive default", (text, qualityFailures, effort) => {
  for (const oldDefault of ["gpt-5.6-sol", "gpt-6-sol", "gpt-6-astra"]) {
    const result = selectTaskModel([model(oldDefault, undefined, true), model(preferredCodexModel)], { ...task, text, qualityFailures });
    expect(result).toMatchObject({ model: preferredCodexModel, effort, policyVersion: "2026-10-27-completion-cost-v4" });
    expect(result.reason).toContain("coding quality and token cost");
  }
});

it("probes only the reviewed Sol upgrade when the catalog still recommends an older Sol", () => {
  for (const oldDefault of ["gpt-5.6", "gpt-5.6-sol", "gpt-6-sol"]) {
    const catalog = [model(oldDefault, undefined, true)];
    const candidates = modelSelectionCandidates(catalog);
    expect(catalog).toHaveLength(1);
    expect(selectTaskModel(candidates, task).model).toBe(preferredCodexModel);
    expect(candidates.find((candidate) => candidate.model === preferredCodexModel)?.supportedReasoningEfforts.map((entry) => entry.reasoningEffort))
      .toEqual(["low", "medium", "high", "xhigh", "max"]);
  }
  expect(modelSelectionCandidates([model("future-default", undefined, true)]).map((candidate) => candidate.model)).toEqual(["future-default"]);
  expect(modelSelectionCandidates([])).toEqual([]);
});

it("uses catalog capabilities for GPT-6.1 Sol and never reintroduces an explicitly hidden candidate", () => {
  const limited = model(preferredCodexModel, ["medium"], true);
  expect(modelSelectionCandidates([limited])).toEqual([limited]);
  expect(selectTaskModel([limited], { ...task, text: "security migration" })).toMatchObject({ model: preferredCodexModel, effort: "medium" });
  const hidden = { ...model(preferredCodexModel), hidden: true };
  const candidates = modelSelectionCandidates([model("gpt-5.6-sol", undefined, true), hidden]);
  expect(selectTaskModel(candidates, task).model).toBe("gpt-5.6-sol");
});

it("uses unknown future models and the current Codex recommendation instead of legacy model names", () => {
  expect(selectTaskModel([model("gpt-5.4"), model("future-recommended", undefined, true)], task)).toMatchObject({ model: "future-recommended", effort: "medium" });
  expect(selectTaskModel([model("future-only")], task)).toMatchObject({ model: "future-only", effort: "medium" });
});

it("keeps the recommended model when effort labels differ across generations", () => {
  const models = [model("future-default", ["low", "medium"], true), model("future-deep", ["high", "xhigh"])];
  expect(selectTaskModel(models, { ...task, qualityFailures: 1 })).toMatchObject({ model: "future-default", effort: "medium" });
});

it("limits effort to the current catalog and works without a default or known effort names", () => {
  expect(selectTaskModel([model("future-limited", ["medium"])], { ...task, text: "security migration" })).toMatchObject({ model: "future-limited", effort: "medium" });
  expect(selectTaskModel([model("future-effort", ["new-effort"])], task)).toMatchObject({ model: "future-effort", effort: "new-effort" });
  expect(selectTaskModel([model("no-effort", [])], task)).toMatchObject({ model: "no-effort", effort: null });
  expect(selectTaskModel([model("first"), model("second")], task).model).toBe("first");
});

it("never chooses hidden models and reports an empty catalog", () => {
  expect(selectTaskModel([{ ...model("hidden", undefined, true), hidden: true }, model("visible")], task).model).toBe("visible");
  expect(() => selectTaskModel([], task)).toThrow("No available Codex models");
});

it("follows a future default or listed Sol without freezing on 6.1 or inventing names", () => {
  expect(selectTaskModel([model(preferredCodexModel), model("future-recommended", undefined, true)], task).model).toBe("future-recommended");
  expect(selectTaskModel([model(preferredCodexModel, undefined, true), model("gpt-6.2-sol"), model("gpt-6.10-sol"), model("gpt-6.9-sol")], task).model).toBe("gpt-6.10-sol");
  expect(selectTaskModel([model(preferredCodexModel), model("gpt-99-luna")], task).model).toBe(preferredCodexModel);
});

it("uses official upgrade chains, ignores missing targets and terminates cycles", () => {
  const current = { ...model(preferredCodexModel, undefined, true), upgrade: "future-coder" };
  const successor = { ...model("future-coder"), upgradeInfo: { model: "next-coder" } };
  expect(selectTaskModel([current, successor, model("next-coder")], task).model).toBe("next-coder");
  expect(selectTaskModel([current], task).model).toBe(preferredCodexModel);
  expect(selectTaskModel([current, { ...successor, upgrade: preferredCodexModel }], task).model).toBe("future-coder");
  expect(selectTaskModel([current, { ...successor, hidden: true }], task).model).toBe(preferredCodexModel);
});

it("escalates repeated quality failures instead of endlessly retrying the same model", () => {
  expect(selectTaskModel([model(preferredCodexModel), model("gpt-6-astra")], { ...task, qualityFailures: 2 })).toMatchObject({ model: "gpt-6-astra", effort: "high" });
});

it("uses current Luna for focused work while preserving Sol for complex tasks and failed attempts", () => {
  const models = [model(preferredCodexModel, undefined, true), model("gpt-6-luna"), model("gpt-5.6-luna")];
  expect(selectTaskModel(models, { ...task, text: "README typo" })).toMatchObject({ model: "gpt-6-luna", effort: "high" });
  expect(selectTaskModel(models, { ...task, role: "command_detection" })).toMatchObject({ model: "gpt-6-luna", effort: "high" });
  expect(selectTaskModel(models, { ...task, text: "README typo", qualityFailures: 1 })).toMatchObject({ model: preferredCodexModel, effort: "high" });
  expect(selectTaskModel(models, { ...task, text: "Authentication migration" }).model).toBe(preferredCodexModel);
});

it("uses total completed-work cost with enough evidence, including failed work and a completion-rate guard", () => {
  const samples = (id: string, cost: number, count = 8) => Array.from({ length: count }, () => ({ model: id, tier: "standard", estimatedUsd: cost }));
  const models = [model(preferredCodexModel), model("gpt-6-astra")];
  // Higher token price can still yield a cheaper completed workflow.
  const completionCosts = [...samples(preferredCodexModel, 3), ...samples("gpt-6-astra", 1)];
  expect(selectTaskModel(models, { ...task, completionCosts })).toMatchObject({ model: "gpt-6-astra", reason: expect.stringContaining("including retries/review/QA/verification") });
  expect(selectTaskModel(models, { ...task, completionCosts: [...samples(preferredCodexModel, 3), ...samples("gpt-6-astra", 1, 7)] }).model).toBe(preferredCodexModel);
  expect(selectTaskModel(models, { ...task, completionCosts: [...completionCosts, { model: "gpt-6-astra", tier: "standard", estimatedUsd: 100, completed: false }] }).model).toBe(preferredCodexModel);
  expect(selectTaskModel(models, { ...task, completionCosts, role: "review" }).model).toBe(preferredCodexModel);
  expect(selectTaskModel(models, { ...task, completionCosts: completionCosts.map((sample) => ({ ...sample, tier: "advanced" })) }).model).toBe(preferredCodexModel);
});
