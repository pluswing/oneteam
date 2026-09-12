export function providerWaitRemainingSeconds(nextRetryAt: string | null, now = Date.now()): number | null {
  if (!nextRetryAt) return null;
  const retryAt = Date.parse(nextRetryAt);
  if (!Number.isFinite(retryAt)) return null;
  return Math.max(0, Math.ceil((retryAt - now) / 1_000));
}

export function providerWaitDurationParts(totalSeconds: number): {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
} {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  return {
    days: Math.floor(safeSeconds / 86_400),
    hours: Math.floor((safeSeconds % 86_400) / 3_600),
    minutes: Math.floor((safeSeconds % 3_600) / 60),
    seconds: safeSeconds % 60
  };
}
