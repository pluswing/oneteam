import type { AgentJobDto, ObjectiveRunDto } from "../../shared/types";
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

type ProviderEventTarget = {
  targetType: "issue" | "pull_request";
  targetId: number;
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

  const targets = await providerEventTargets(repos, job, objective);
  for (const target of targets) {
    await repos.activities.create({
      projectId: job.projectId,
      agentJobId: job.id,
      targetType: target.targetType,
      targetId: target.targetId,
      activityType: "system",
      title: "Waiting for AI provider usage",
      body: message,
      payload: { ...decision, providerWaitEvent: "wait_started" }
    });
    if (decision.retryCount === 1 || decision.retryCount % 3 === 0) {
      await createProviderEventComment(repos, {
        projectId: job.projectId,
        target,
        body: message,
        key: `provider-wait:${job.id}:attempt:${decision.retryCount}`,
        metadata: {
          agentJobId: job.id,
          providerWait: decision,
          providerWaitEvent: "wait_started"
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
  trigger: "automatic" | "manual",
  aiProvider = job.aiProvider
): Promise<AgentJobDto | null> {
  const resumed = await repos.agentJobs.resumeProviderWait(job.projectId, job.id, aiProvider);
  if (!resumed) {
    return null;
  }

  const objective = await objectiveForJob(repos, job);
  if (objective?.status === "waiting_provider") {
    await repos.objectives.update(job.projectId, objective.id, {
      status: "running",
      stopReason: null,
      summary: `${trigger === "manual" ? "Manual" : "Automatic"} provider retry queued for job #${job.id} using ${resumed.aiProvider}.`
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

  const retryCount = numericMetadata(job.waitMetadata, "retryCount") ?? 0;
  const providerChanged = job.aiProvider !== resumed.aiProvider;
  const message = buildProviderRetryComment(job, trigger, resumed.aiProvider);
  const targets = await providerEventTargets(repos, job, objective);
  for (const target of targets) {
    await repos.activities.create({
      projectId: job.projectId,
      agentJobId: job.id,
      targetType: target.targetType,
      targetId: target.targetId,
      activityType: "system",
      title: providerChanged ? "AI provider switched and retry queued" : "AI provider retry queued",
      body: message,
      payload: {
        trigger,
        previousNextRetryAt: job.nextRetryAt,
        providerWaitEvent: "retry_queued",
        retryCount,
        previousProvider: job.aiProvider,
        provider: resumed.aiProvider
      }
    });
    if (trigger === "manual" || retryCount === 1 || retryCount % 3 === 0) {
      await createProviderEventComment(repos, {
        projectId: job.projectId,
        target,
        body: message,
        key: `provider-wait:${job.id}:retry:${retryCount}:${trigger}:${resumed.aiProvider}`,
        metadata: {
          agentJobId: job.id,
          providerWaitEvent: "retry_queued",
          trigger,
          retryCount,
          previousProvider: job.aiProvider,
          provider: resumed.aiProvider,
          previousNextRetryAt: job.nextRetryAt
        }
      });
    }
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

  const message = buildProviderWaitCanceledComment(job);
  const targets = await providerEventTargets(repos, job, objective);
  for (const target of targets) {
    await repos.activities.create({
      projectId: job.projectId,
      agentJobId: job.id,
      targetType: target.targetType,
      targetId: target.targetId,
      activityType: "system",
      title: "AI provider wait canceled",
      body: message,
      payload: { providerWaitEvent: "wait_canceled", previousNextRetryAt: job.nextRetryAt }
    });
    await createProviderEventComment(repos, {
      projectId: job.projectId,
      target,
      body: message,
      key: `provider-wait:${job.id}:canceled`,
      metadata: {
        agentJobId: job.id,
        providerWaitEvent: "wait_canceled",
        previousNextRetryAt: job.nextRetryAt
      }
    });
  }
}

export function buildProviderRetryComment(
  job: AgentJobDto,
  trigger: "automatic" | "manual",
  aiProvider = job.aiProvider
): string {
  const retryCount = numericMetadata(job.waitMetadata, "retryCount") ?? 0;
  const providerChanged = job.aiProvider !== aiProvider;
  return buildSystemComment({
    title: providerChanged ? "AI provider switched and retry queued" : "AI provider retry queued",
    outcome: "info",
    summary: `${trigger === "manual" ? "A user" : "The scheduler"} resumed the preserved Agent Job for another provider attempt.`,
    fields: [
      { label: "Job", value: `#${job.id}`, code: true },
      { label: "Agent", value: job.agentType, code: true },
      { label: "Provider", value: aiProvider, code: true },
      providerChanged ? { label: "Previous provider", value: job.aiProvider, code: true } : null,
      { label: "Resume trigger", value: trigger, code: true },
      { label: "Retry attempt", value: retryCount },
      job.nextRetryAt ? { label: "Previous retry time", value: job.nextRetryAt, code: true } : null
    ],
    sections: [
      {
        title: "Preserved state",
        items: [
          "The same job input, Objective, worktree association, and available provider session metadata remain attached.",
          "The provider wait did not consume an Objective round."
        ]
      }
    ],
    nextStep: "OneTeam will run the queued Agent Job. If capacity is still unavailable, it will calculate the next bounded retry without treating the attempt as an implementation failure."
  });
}

export function buildProviderWaitCanceledComment(job: AgentJobDto): string {
  return buildSystemComment({
    title: "AI provider wait canceled",
    outcome: "info",
    summary: "A user canceled the preserved Agent Job while it was waiting for provider capacity.",
    fields: [
      { label: "Job", value: `#${job.id}`, code: true },
      { label: "Agent", value: job.agentType, code: true },
      { label: "Provider", value: job.aiProvider, code: true },
      job.nextRetryAt ? { label: "Canceled retry time", value: job.nextRetryAt, code: true } : null
    ],
    sections: [
      {
        title: "State change",
        items: ["The Agent Job and its Loop step were canceled.", "The connected Objective was canceled when it owned this provider wait."]
      }
    ],
    nextStep: "Start a new Objective or explicitly retry the work if this delivery should continue."
  });
}

async function providerEventTargets(
  repos: Repositories,
  job: AgentJobDto,
  objective: ObjectiveRunDto | null
): Promise<ProviderEventTarget[]> {
  if (job.targetType === "project") return [];
  const targets: ProviderEventTarget[] = [{ targetType: job.targetType, targetId: job.targetId }];
  if (job.targetType !== "pull_request") return targets;
  const pullRequest = await repos.pullRequests.get(job.projectId, job.targetId);
  const issueId = objective?.issueId ?? pullRequest?.issueId ?? null;
  if (issueId !== null) targets.push({ targetType: "issue", targetId: issueId });
  return targets;
}

async function createProviderEventComment(
  repos: Repositories,
  input: {
    projectId: string;
    target: ProviderEventTarget;
    body: string;
    key: string;
    metadata: Record<string, unknown>;
  }
): Promise<void> {
  const comments = await repos.comments.list(input.projectId, input.target.targetType, input.target.targetId);
  if (comments.some((comment) => comment.metadata?.providerWaitEventKey === input.key)) return;
  await repos.comments.create({
    projectId: input.projectId,
    targetType: input.target.targetType,
    targetId: input.target.targetId,
    authorType: "system",
    body: input.body,
    bodyFormat: "markdown",
    metadata: { ...input.metadata, providerWaitEventKey: input.key }
  });
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
