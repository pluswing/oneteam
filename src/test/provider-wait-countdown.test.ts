import { describe, expect, it } from "vitest";
import { providerWaitDurationParts, providerWaitRemainingSeconds } from "../client/provider-wait-countdown";

describe("provider wait countdown", () => {
  it("counts down to a persisted retry timestamp and clamps overdue waits", () => {
    const now = Date.parse("2026-08-28T00:00:00.000Z");
    expect(providerWaitRemainingSeconds("2026-08-28T01:02:03.000Z", now)).toBe(3_723);
    expect(providerWaitRemainingSeconds("2026-08-27T23:59:59.000Z", now)).toBe(0);
    expect(providerWaitRemainingSeconds("invalid", now)).toBeNull();
    expect(providerWaitRemainingSeconds(null, now)).toBeNull();
  });

  it("splits long waits into stable display units", () => {
    expect(providerWaitDurationParts(90_061)).toEqual({ days: 1, hours: 1, minutes: 1, seconds: 1 });
  });
});
