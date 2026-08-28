export type ProviderUsageTotals = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUsd: number;
  requestCount: number;
};

export const emptyProviderUsage: ProviderUsageTotals = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  requestCount: 0
};

const aliases = {
  inputTokens: new Set(["inputtokens", "prompttokens"]),
  cachedInputTokens: new Set(["cachedinputtokens"]),
  cacheReadInputTokens: new Set(["cachereadinputtokens"]),
  cacheCreationInputTokens: new Set(["cachecreationinputtokens"]),
  outputTokens: new Set(["outputtokens", "completiontokens"]),
  reasoningTokens: new Set(["reasoningoutputtokens", "reasoningtokens"]),
  totalTokens: new Set(["totaltokens"]),
  costUsd: new Set(["totalcostusd", "costusd", "usdollarcost"])
} as const;

export function normalizeProviderUsage(value: unknown): ProviderUsageTotals {
  const record = objectValue(value);
  if (!record) return { ...emptyProviderUsage };
  const inputTokens = nonnegativeMetric(record, aliases.inputTokens);
  const canonicalCachedInputTokens = nonnegativeMetric(record, aliases.cachedInputTokens);
  const cachedInputTokens = canonicalCachedInputTokens || (
    nonnegativeMetric(record, aliases.cacheReadInputTokens) +
    nonnegativeMetric(record, aliases.cacheCreationInputTokens)
  );
  const outputTokens = nonnegativeMetric(record, aliases.outputTokens);
  const reasoningTokens = nonnegativeMetric(record, aliases.reasoningTokens);
  const reportedTotal = nonnegativeMetric(record, aliases.totalTokens);
  const costUsd = nonnegativeMetric(record, aliases.costUsd);
  const reportedRequestCount = directNonnegative(record.requestCount);
  const hasUsage = [inputTokens, cachedInputTokens, outputTokens, reasoningTokens, reportedTotal, costUsd]
    .some((metric) => metric > 0);
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens: reportedTotal || inputTokens + outputTokens,
    costUsd: roundCost(costUsd),
    requestCount: Math.floor(reportedRequestCount || (hasUsage ? 1 : 0))
  };
}

export function addProviderUsage(
  current: ProviderUsageTotals | null | undefined,
  delta: ProviderUsageTotals | null | undefined
): ProviderUsageTotals {
  const left = current ?? emptyProviderUsage;
  const right = delta ?? emptyProviderUsage;
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    costUsd: roundCost(left.costUsd + right.costUsd),
    requestCount: left.requestCount + right.requestCount
  };
}

export function normalizeProviderUsageTotals(value: unknown): ProviderUsageTotals {
  const record = objectValue(value);
  if (!record) return { ...emptyProviderUsage };
  return {
    inputTokens: directNonnegative(record.inputTokens),
    cachedInputTokens: directNonnegative(record.cachedInputTokens),
    outputTokens: directNonnegative(record.outputTokens),
    reasoningTokens: directNonnegative(record.reasoningTokens),
    totalTokens: directNonnegative(record.totalTokens),
    costUsd: roundCost(directNonnegative(record.costUsd)),
    requestCount: Math.floor(directNonnegative(record.requestCount))
  };
}

function nonnegativeMetric(record: Record<string, unknown>, keys: ReadonlySet<string>): number {
  let result = 0;
  walk(record, (key, value) => {
    if (result || !keys.has(normalizeKey(key))) return;
    const metric = directNonnegative(value);
    if (metric > 0) result = metric;
  });
  return result;
}

function walk(value: Record<string, unknown>, visit: (key: string, value: unknown) => void): void {
  for (const [key, item] of Object.entries(value)) {
    visit(key, item);
    if (objectValue(item)) walk(item as Record<string, unknown>, visit);
    if (Array.isArray(item)) {
      for (const nested of item) {
        const record = objectValue(nested);
        if (record) walk(record, visit);
      }
    }
  }
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function directNonnegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function roundCost(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
