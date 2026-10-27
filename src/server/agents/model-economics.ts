import type { AgentExecutionDto, DevelopmentLoopDto } from "../../shared/development-loop";
import type { AgentJobDto } from "../../shared/types";

// Standard short-context API rates, reviewed 2026-10-27. These are estimates,
// never Codex subscription charges. Unknown models/rates remain unknown.
export const reviewedModelRates: Record<string, { input: number; cached: number; output: number }> = {
  "gpt-6.1-sol": { input: 2, cached: 0.1, output: 10 },
  "gpt-5.6-sol": { input: 4, cached: 0.4, output: 20 },
  "gpt-5.6": { input: 4, cached: 0.4, output: 20 },
  "gpt-6-astra": { input: 10, cached: 1, output: 50 },
  "gpt-6-luna": { input: 0.1, cached: 0.01, output: 0.5 }
};

export type CompletionCostSample = { model: string; tier: string; estimatedUsd: number; completed?: boolean };

export function estimatedExecutionCost(execution: AgentExecutionDto): number | null {
  const usage = execution.usage;
  const rate = execution.resolvedModel ? reviewedModelRates[execution.resolvedModel] : undefined;
  if (!usage || !rate) return null;
  const input = usage.input_tokens, output = usage.output_tokens, cached = usage.cached_input_tokens ?? 0, writes = usage.cache_write_input_tokens ?? 0;
  if (![input, output, cached, writes].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)
    || Number(cached) + Number(writes) > Number(input) || Number(input) + Number(output) === 0) return null;
  // Long context rates apply to the entire request. The aggregate counters do not
  // identify individual requests; avoid understating their cost with a short rate.
  if (Number(input) > 272_000 || usage.costBasis !== "turn_total") return null;
  return ((Number(input) - Number(cached) - Number(writes)) * rate.input + Number(cached) * rate.cached + Number(writes) * rate.input * 1.25 + Number(output) * rate.output) / 1_000_000;
}

/** Attribute a completed workflow only when its implementation/fixes used one
 * model. Include requirements, review, QA, verifier and every retry in the cost.
 * Self-reported implementation success is insufficient evidence of completion.
 */
export function completedLoopCost(loop: DevelopmentLoopDto, jobs: AgentJobDto[], executions: AgentExecutionDto[], tier: string): CompletionCostSample | null {
  if (!["succeeded", "failed"].includes(loop.status)) return null;
  const completed = loop.status === "succeeded" && Boolean(loop.mergeCommit);
  const loopJobs = jobs.filter((job) => job.input.developmentLoopId === loop.id && job.agentType !== "retrospective");
  const verifier = loopJobs.filter((job) => job.agentType === "verifier").sort((a, b) => b.id - a.id)[0];
  const metadata = verifier?.output?.metadata as { verifier?: { stopConditionMet?: boolean } } | undefined;
  if (loop.status === "succeeded" && (!completed || verifier?.status !== "succeeded" || metadata?.verifier?.stopConditionMet !== true)) return null;
  const jobIds = new Set(loopJobs.map((job) => job.id));
  const attempts = executions.filter((execution) => jobIds.has(execution.jobId));
  if (loopJobs.some((job) => !attempts.some((execution) => execution.jobId === job.id))) return null;
  const implementationIds = new Set(loopJobs.filter((job) => ["implementation", "fix"].includes(job.agentType)).map((job) => job.id));
  const generators = new Set(attempts.filter((execution) => implementationIds.has(execution.jobId)).map((execution) => execution.resolvedModel));
  if (generators.size !== 1 || generators.has(null)) return null;
  const costs = attempts.map(estimatedExecutionCost);
  if (!costs.length || costs.some((cost) => cost === null)) return null;
  return { model: [...generators][0]!, tier, completed, estimatedUsd: costs.reduce<number>((sum, cost) => sum + cost!, 0) };
}

export function observedCompletionCosts(samples: CompletionCostSample[], tier: string): Map<string, { count: number; mean: number; completionRate: number }> {
  const grouped = new Map<string, CompletionCostSample[]>();
  for (const sample of samples) {
    if (sample.tier !== tier || !Number.isFinite(sample.estimatedUsd) || sample.estimatedUsd <= 0) continue;
    const values = grouped.get(sample.model) ?? [];
    values.push(sample); grouped.set(sample.model, values);
  }
  return new Map([...grouped].flatMap(([model, costs]) => {
    const completed = costs.filter((cost) => cost.completed !== false).length;
    return completed < 8 ? [] : [[model, { count: completed, mean: costs.reduce((sum, value) => sum + value.estimatedUsd, 0) / completed, completionRate: completed / costs.length }] as const];
  }));
}
