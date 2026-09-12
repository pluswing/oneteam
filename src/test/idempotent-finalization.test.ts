import { describe, expect, it } from "vitest";
import { runIdempotentFinalizationWithBackoff } from "../server/services/idempotent-finalization";

describe("idempotent merge finalization", () => {
  it("retries local finalization with bounded backoff", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const result = await runIdempotentFinalizationWithBackoff(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("database is temporarily busy");
        return "complete";
      },
      {
        delaysMs: [500, 2_000, 5_000],
        sleep: async (delayMs) => { delays.push(delayMs); }
      }
    );

    expect(result).toEqual({ value: "complete", retryCount: 2 });
    expect(delays).toEqual([500, 2_000]);
  });

  it("stops after the configured retry budget", async () => {
    let attempts = 0;
    await expect(runIdempotentFinalizationWithBackoff(
      async () => {
        attempts += 1;
        throw new Error("persistent failure");
      },
      { delaysMs: [1, 2], sleep: async () => undefined }
    )).rejects.toThrow("persistent failure");
    expect(attempts).toBe(3);
  });
});
