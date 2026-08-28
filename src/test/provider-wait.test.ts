import { describe, expect, it } from "vitest";
import { buildProviderWaitComment, classifyProviderWait } from "../server/services/provider-wait";
import type { AgentJobDto } from "../shared/types";

describe("provider wait classification", () => {
  it("uses provider reset telemetry and preserves execution metadata", () => {
    const currentTime = new Date("2026-08-28T00:00:00.000Z");
    const resetAt = "2026-08-28T02:00:00.000Z";
    const decision = classifyProviderWait(
      fakeJob(),
      {
        status: "failed",
        message: "Usage limit exceeded.",
        metadata: {
          providerExecution: {
            model: "gpt-test",
            sessionId: "thread-123",
            usage: { reset_at: resetAt, remaining: 0 }
          }
        }
      },
      currentTime,
      () => 0
    );

    expect(decision).toMatchObject({
      provider: "codex",
      model: "gpt-test",
      sessionId: "thread-123",
      resetAt,
      nextRetryAt: "2026-08-28T02:00:05.000Z",
      retryCount: 1,
      jitterMs: 0,
      detectionSource: "message",
      usageSnapshot: { remaining: 0 }
    });
  });

  it("detects quota exhaustion from nested usage telemetry without matching message text", () => {
    const decision = classifyProviderWait(
      fakeJob(),
      {
        status: "failed",
        message: "Codex turn could not start.",
        metadata: {
          providerExecution: {
            usage: {
              rate_limits: {
                primary: { weighted_tokens_left: 0, resets_at: 1_777_600_000 }
              }
            }
          }
        }
      },
      new Date("2026-04-30T00:00:00.000Z"),
      () => 0.5
    );

    expect(decision).toMatchObject({
      detectionSource: "usage",
      resetAt: "2026-05-01T01:46:40.000Z",
      nextRetryAt: "2026-05-01T01:46:45.000Z"
    });
    expect(
      classifyProviderWait(fakeJob(), {
        status: "failed",
        message: "Compilation failed.",
        metadata: { providerExecution: { usage: { output_tokens: 0 } } }
      })
    ).toBeNull();
  });

  it("applies bounded jitter to exponential backoff when no reset is reported", () => {
    const currentTime = new Date("2026-08-28T00:00:00.000Z");
    const first = classifyProviderWait(
      fakeJob(),
      { status: "failed", message: "You've hit your usage limit. Try again later." },
      currentTime,
      () => 0
    );
    const second = classifyProviderWait(
      fakeJob({ retryCount: 1 }),
      { status: "failed", message: "You've hit your usage limit. Try again later." },
      currentTime,
      () => 1
    );

    expect(first).toMatchObject({ retryCount: 1, retryDelayMs: 270_000, jitterMs: -30_000 });
    expect(second).toMatchObject({ retryCount: 2, retryDelayMs: 660_000, jitterMs: 60_000 });
  });

  it("parses relative reset durations from provider messages", () => {
    const decision = classifyProviderWait(
      fakeJob(),
      { status: "failed", message: "Rate limit exceeded. Try again in 1 hour 5 minutes 10 seconds." },
      new Date("2026-08-28T00:00:00.000Z"),
      () => 0.5
    );

    expect(decision?.resetAt).toBe("2026-08-28T01:05:10.000Z");
    expect(decision?.nextRetryAt).toBe("2026-08-28T01:05:15.000Z");
  });

  it("formats provider waits as an outcome-first durable comment", () => {
    const job = fakeJob();
    const decision = classifyProviderWait(
      job,
      {
        status: "failed",
        message: "Usage limit exceeded.",
        metadata: { providerExecution: { usage: { remaining: 0 }, sessionId: "session-1", model: "gpt-test" } }
      },
      new Date("2026-08-28T00:00:00.000Z"),
      () => 0.5
    );

    expect(decision).not.toBeNull();
    const comment = buildProviderWaitComment(job, decision!);
    expect(comment).toContain("## AI provider usage wait");
    expect(comment).toContain("> **Outcome · WAITING**");
    expect(comment).toContain("| Session | `session-1` |");
    expect(comment).toContain("| Detection source | `message` |");
    expect(comment).toContain("### Usage snapshot");
    expect(comment).toContain('"remaining": 0');
    expect(comment).toContain("### Next step");
  });
});

function fakeJob(waitMetadata: Record<string, unknown> | null = null): AgentJobDto {
  return {
    id: 1,
    projectId: "project-1",
    aiProvider: "codex",
    aiModel: "gpt-test",
    agentType: "implementation",
    targetType: "issue",
    targetId: 1,
    status: "running",
    triggerType: "manual",
    parentJobId: null,
    input: {},
    output: null,
    error: null,
    attempt: 1,
    lockKey: null,
    waitReason: null,
    waitMetadata,
    nextRetryAt: null,
    createdAt: "2026-08-28T00:00:00.000Z",
    startedAt: "2026-08-28T00:00:00.000Z",
    finishedAt: null
  };
}
