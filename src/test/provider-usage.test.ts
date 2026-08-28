import { describe, expect, it } from "vitest";
import { addProviderUsage, normalizeProviderUsage } from "../shared/provider-usage";

describe("provider usage normalization", () => {
  it("normalizes OpenAI-compatible usage without estimating cost", () => {
    expect(normalizeProviderUsage({
      usage: {
        prompt_tokens: 120,
        completion_tokens: 30,
        total_tokens: 150,
        completion_tokens_details: { reasoning_tokens: 12 }
      }
    })).toEqual({
      inputTokens: 120,
      cachedInputTokens: 0,
      outputTokens: 30,
      reasoningTokens: 12,
      totalTokens: 150,
      costUsd: 0,
      requestCount: 1
    });
  });

  it("combines Claude cache token fields and explicit USD cost", () => {
    expect(normalizeProviderUsage({
      input_tokens: 80,
      cache_read_input_tokens: 40,
      cache_creation_input_tokens: 10,
      output_tokens: 25,
      total_cost_usd: 0.0043219
    })).toEqual({
      inputTokens: 80,
      cachedInputTokens: 50,
      outputTokens: 25,
      reasoningTokens: 0,
      totalTokens: 105,
      costUsd: 0.004322,
      requestCount: 1
    });
  });

  it("adds normalized request totals", () => {
    const total = addProviderUsage(
      normalizeProviderUsage({ input_tokens: 10, output_tokens: 5, total_cost_usd: 0.1 }),
      normalizeProviderUsage({ prompt_tokens: 20, completion_tokens: 7 })
    );
    expect(total).toMatchObject({
      inputTokens: 30,
      outputTokens: 12,
      totalTokens: 42,
      costUsd: 0.1,
      requestCount: 2
    });
  });
});
