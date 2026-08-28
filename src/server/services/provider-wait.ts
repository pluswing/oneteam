import type { AgentJobDto } from "../../shared/types";
import type { AgentRunResult } from "../agents/types";
import type { Repositories } from "../db/repositories";
import { objectiveForJob } from "./objective-runs";
import { buildSystemComment } from "./system-comment";

export const providerQuotaWaitReason = "provider_quota_exhausted";

export type ProviderWaitDecision = {
  reason: typeof providerQuotaWaitReason;
  provider: AgentJobDto["aiProvider"];
  model: string | null;
  sessionId: string | null;
  usageSnapshot: Record<string, unknown> | null;
  detectedAt: string;
  resetAt: string | null;
  nextRetryAt: string;
  retryCount: number;
  retryDelayMs: number;
  jitterMs: number;
  providerMessage: string;
};

const providerQuotaPatterns = [
  /you(?:'ve| have) hit your usage limit/i,
  /usage limit (?:has been )?(?:reached|exceeded)/i,
  /(?:quota|rate limit)(?:_exceeded| has been)? (?:reached|exceeded)/i,
  /too many requests/i,
  /(?:http|status|error)?\s*429\b/i,
  /no (?:usage|weighted )?tokens? (?:remaining|left)/i
];

export function classifyProviderWait(
  job: AgentJobDto,
  result: Pick<AgentRunResult, "status" | "message" | "metadata">,
  currentTime = new Date(),
  random = Math.random
): ProviderWaitDecision | null {
  if (result.status !== "failed" || !providerQuotaPatterns.some((pattern) => pattern.test(result.message))) {
    return null;
  }

  const detectedAt = currentTime.toISOString();
  const previousRetryCount = numericMetadata(job.waitMetadata, "retryCount") ?? 0;
  const retryCount = previousRetryCount + 1;
  const providerExecution = result.metadata?.providerExecution;
  const usageSnapshot = providerExecution?.usage ?? null;
  const resetAt = resetAtFromUsage(usageSnapshot) ?? parseResetAt(result.message, currentTime);
  const backoffMs = Math.min(5 * 60_000 * 2 ** (retryCount - 1), 60 * 60_000);
  const jitterFactor = 0.9 + Math.min(Math.max(random(), 0), 1) * 0.2;
  const jitteredBackoffMs = Math.round(backoffMs * jitterFactor);
  const jitterMs = jitteredBackoffMs - backoffMs;
  const parsedResetMs = resetAt ? Date.parse(resetAt) : Number.NaN;
  const hasFutureReset = Number.isFinite(parsedResetMs) && parsedResetMs > currentTime.getTime();
  const nextRetryMs = hasFutureReset ? parsedResetMs + 5_000 : currentTime.getTime() + jitteredBackoffMs;

  return {
    reason: providerQuotaWaitReason,
    provider: job.aiProvider,
    model: providerExecution?.model ?? null,
    sessionId: providerExecution?.sessionId ?? null,
    usageSnapshot,
    detectedAt,
    resetAt,
    nextRetryAt: new Date(nextRetryMs).toISOString(),
    retryCount,
    retryDelayMs: nextRetryMs - currentTime.getTime(),
    jitterMs: hasFutureReset ? 0 : jitterMs,
    providerMessage: result.message.slice(0, 4000)
  };
}

export async function enterProviderWait(
  repos: Repositories,
  job: AgentJobDto,
  decision: ProviderWaitDecision
): Promise<AgentJobDto | null> {
  const target = job.targetType === "project" ? null : { targetType: job.targetType, targetId: job.targetId };
  const message = buildProviderWaitComment(job, decision);
  const output = {
    status: "waiting_provider",
    message,
    stopReason: decision.reason,
    evidence: [
      {
        type: "provider_wait",
        title: "AI provider usage exhausted",
        summary: `Automatic retry scheduled for ${decision.nextRetryAt}.`,
        payload: decision
      }
    ],
    metadata: {
      providerWait: decision
    }
  };
  const waitingJob = await repos.agentJobs.waitForProvider(job.projectId, job.id, {
    reason: decision.reason,
    metadata: decision,
    nextRetryAt: decision.nextRetryAt,
    output
  });
  if (!waitingJob) {
    return null;
  }

  const objective = await objectiveForJob(repos, job);
  if (objective) {
    await repos.objectives.update(job.projectId, objective.id, {
      status: "waiting_provider",
      lastAgentJobId: job.id,
      stopReason: decision.reason,
      summary: `Waiting for ${job.aiProvider} usage allowance; retry at ${decision.nextRetryAt}.`
    });
  }

  const step = await repos.loopSteps.getByAgentJob(job.projectId, job.id);
  if (step) {
    await repos.loopSteps.updateForAgentJob(job.projectId, job.id, {
      status: "waiting_provider",
      output,
      evidence: { items: output.evidence }
    });
    await repos.loopRuns.updateStatus(job.projectId, step.loopRunId, "waiting_provider", {
      summary: message,
      stopReason: decision.reason,
      evidence: { items: output.evidence }
    });
  }

  if (target) {
    await repos.activities.create({
      projectId: job.projectId,
      agentJobId: job.id,
      targetType: target.targetType,
      targetId: target.targetId,
      activityType: "system",
      title: "Waiting for AI provider usage",
      body: message,
      payload: decision
    });
    if (decision.retryCount === 1 || decision.retryCount % 3 === 0) {
      await repos.comments.create({
        projectId: job.projectId,
        targetType: target.targetType,
        targetId: target.targetId,
        authorType: "system",
        body: message,
        bodyFormat: "markdown",
        metadata: {
          agentJobId: job.id,
          providerWait: decision
        }
      });
    }
  }

  return waitingJob;
}

export function buildProviderWaitComment(job: AgentJobDto, decision: ProviderWaitDecision): string {
  return buildSystemComment({
    title: "AI provider usage wait",
    outcome: "waiting",
    summary: `The ${job.aiProvider} usage allowance is unavailable. OneTeam preserved the job state and scheduled an automatic retry.`,
    fields: [
      { label: "Job", value: `#${job.id}`, code: true },
      { label: "Agent", value: job.agentType, code: true },
      { label: "Provider", value: decision.provider, code: true },
      decision.model ? { label: "Model", value: decision.model, code: true } : null,
      decision.sessionId ? { label: "Session", value: decision.sessionId, code: true } : null,
      { label: "Stop reason", value: decision.reason, code: true },
      { label: "Retry attempt", value: decision.retryCount },
      { label: "Detected at", value: decision.detectedAt, code: true },
      {
        label: "Provider reset",
        value: decision.resetAt ?? "Not reported; bounded exponential backoff is active",
        code: Boolean(decision.resetAt)
      },
      { label: "Next retry", value: decision.nextRetryAt, code: true }
    ],
    sections: [
      decision.usageSnapshot
        ? {
            title: "Usage snapshot",
            body: `\`\`\`json\n${JSON.stringify(decision.usageSnapshot, null, 2)}\n\`\`\``
          }
        : {
            title: "Usage snapshot",
            body: "The provider did not return structured usage telemetry for this attempt."
          },
      {
        title: "Loop accounting",
        items: [
          "This provider wait does not consume an Objective round.",
          "The worktree, job input, Objective, and available provider session identifier remain attached to the job."
        ]
      }
    ],
    nextStep: "OneTeam will queue the same job after the retry time. Use **Resume now** to retry sooner, or **Cancel** to stop this Objective.",
    recordedAt: new Date(decision.detectedAt)
  });
}

export async function resumeProviderWait(
  repos: Repositories,
  job: AgentJobDto,
  trigger: "automatic" | "manual"
): Promise<AgentJobDto | null> {
  const resumed = await repos.agentJobs.resumeProviderWait(job.projectId, job.id);
  if (!resumed) {
    return null;
  }

  const objective = await objectiveForJob(repos, job);
  if (objective?.status === "waiting_provider") {
    await repos.objectives.update(job.projectId, objective.id, {
      status: "running",
      stopReason: null,
      summary: `${trigger === "manual" ? "Manual" : "Automatic"} provider retry queued for job #${job.id}.`
    });
  }

  const step = await repos.loopSteps.getByAgentJob(job.projectId, job.id);
  if (step) {
    await repos.loopSteps.updateForAgentJob(job.projectId, job.id, { status: "queued" });
    await repos.loopRuns.updateStatus(job.projectId, step.loopRunId, "queued", {
      summary: `${trigger === "manual" ? "Manual" : "Automatic"} provider retry queued.`,
      stopReason: null
    });
  }

  if (job.targetType !== "project") {
    await repos.activities.create({
      projectId: job.projectId,
      agentJobId: job.id,
      targetType: job.targetType,
      targetId: job.targetId,
      activityType: "system",
      title: "AI provider retry queued",
      body: `${trigger === "manual" ? "A user" : "The scheduler"} resumed job #${job.id}.`,
      payload: { trigger, previousNextRetryAt: job.nextRetryAt }
    });
  }
  return resumed;
}

export async function recordProviderWaitCanceled(repos: Repositories, job: AgentJobDto): Promise<void> {
  const objective = await objectiveForJob(repos, job);
  if (objective?.status === "waiting_provider") {
    await repos.objectives.update(job.projectId, objective.id, {
      status: "canceled",
      stopReason: "canceled",
      summary: `Provider wait for job #${job.id} was canceled by the user.`,
      finishedAt: new Date().toISOString()
    });
  }

  const step = await repos.loopSteps.getByAgentJob(job.projectId, job.id);
  if (step) {
    await repos.loopSteps.updateForAgentJob(job.projectId, job.id, { status: "canceled" });
    await repos.loopRuns.updateStatus(job.projectId, step.loopRunId, "canceled", {
      summary: `Provider wait for job #${job.id} was canceled by the user.`,
      stopReason: "canceled"
    });
  }
}

function numericMetadata(value: Record<string, unknown> | null, key: string): number | null {
  const item = value?.[key];
  return typeof item === "number" && Number.isFinite(item) ? item : null;
}

function parseResetAt(message: string, currentTime: Date): string | null {
  const isoMatch = message.match(/(?:reset(?:s| at)?|try again (?:after|at))[^\n]*?(\d{4}-\d{2}-\d{2}[T ][0-9:.+-]+Z?)/i);
  if (isoMatch) {
    const timestamp = Date.parse(isoMatch[1]);
    if (Number.isFinite(timestamp)) {
      return new Date(timestamp).toISOString();
    }
  }

  const durationMatch = message.match(
    /try again in\s+(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?\s*(?:(\d+)\s*s(?:ec(?:onds?)?)?)?/i
  );
  if (durationMatch && (durationMatch[1] || durationMatch[2] || durationMatch[3])) {
    const durationMs =
      (Number(durationMatch[1] ?? 0) * 60 * 60 +
        Number(durationMatch[2] ?? 0) * 60 +
        Number(durationMatch[3] ?? 0)) *
      1000;
    return new Date(currentTime.getTime() + durationMs).toISOString();
  }
  return null;
}

function resetAtFromUsage(usage: Record<string, unknown> | null): string | null {
  if (!usage) {
    return null;
  }
  const value = usage.resetAt ?? usage.reset_at ?? usage.resetsAt ?? usage.resets_at;
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const timestamp = value < 10_000_000_000 ? value * 1000 : value;
    return new Date(timestamp).toISOString();
  }
  return null;
}
