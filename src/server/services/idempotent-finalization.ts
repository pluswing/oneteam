export type FinalizationRetryEvent = {
  failedAttempt: number;
  nextAttempt: number;
  delayMs: number;
  message: string;
};

export async function runIdempotentFinalizationWithBackoff<T>(
  execute: () => Promise<T>,
  options: {
    delaysMs: number[];
    onRetry?: (event: FinalizationRetryEvent) => Promise<void> | void;
    sleep?: (delayMs: number) => Promise<void>;
  }
): Promise<{ value: T; retryCount: number }> {
  let failedAttempt = 0;
  while (true) {
    try {
      return { value: await execute(), retryCount: failedAttempt };
    } catch (error) {
      failedAttempt += 1;
      const delayMs = options.delaysMs[failedAttempt - 1];
      if (delayMs === undefined) throw error;
      const event: FinalizationRetryEvent = {
        failedAttempt,
        nextAttempt: failedAttempt + 1,
        delayMs,
        message: error instanceof Error ? error.message.slice(0, 4_000) : "Merge finalization failed."
      };
      await options.onRetry?.(event);
      await (options.sleep ?? sleep)(delayMs);
    }
  }
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
