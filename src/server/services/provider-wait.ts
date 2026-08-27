import type { AgentJobDto } from "../../shared/types";
import type { AgentRunResult } from "../agents/types";
import type { Repositories } from "../db/repositories";
import { objectiveForJob } from "./objective-runs";

export const providerQuotaWaitReason = "provider_quota_exhausted";

export type ProviderWaitDecision = {
  reason: typeof providerQuotaWaitReason;
  detectedAt: string;
  resetAt: string | null;
  nextRetryAt: string;
  retryCount: number;
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
  result: Pick<AgentRunResult, "status" | "message">,
  currentTime = new Date()
): ProviderWaitDecision | null {
  if (result.status !== "failed" || !providerQuotaPatterns.some((pattern) => pattern.test(result.message))) {
    return null;
  }

  const detectedAt = currentTime.toISOString();
  const previousRetryCount = numericMetadata(job.waitMetadata, "retryCount") ?? 0;
  const retryCount = previousRetryCount + 1;
  const resetAt = parseResetAt(result.message, currentTime);
  const backoffMs = Math.min(5 * 60_000 * 2 ** (retryCount - 1), 60 * 60_000);
  const parsedResetMs = resetAt ? Date.parse(resetAt) : Number.NaN;
  const nextRetryMs = Number.isFinite(parsedResetMs) && parsedResetMs > currentTime.getTime()
    ? parsedResetMs + 5_000
    : currentTime.getTime() + backoffMs;

  return {
    reason: providerQuotaWaitReason,
    detectedAt,
    resetAt,
    nextRetryAt: new Date(nextRetryMs).toISOString(),
    retryCount,
    providerMessage: result.message.slice(0, 4000)
  };
}

export async function enterProviderWait(
  repos: Repositories,
  job: AgentJobDto,
  decision: ProviderWaitDecision
): Promise<AgentJobDto | null> {
  const target = job.targetType === "project" ? null : { targetType: job.targetType, targetId: job.targetId };
  const message = [
    "## AI provider usage wait",
    "",
    `The **${job.aiProvider}** usage allowance is currently unavailable. OneTeam preserved this job and will retry it automatically.`,
    "",
    `- Job: \`#${job.id}\` (${job.agentType})`,
    `- Reason: \`${decision.reason}\``,
    `- Retry attempt: ${decision.retryCount}`,
    `- Next retry: ${decision.nextRetryAt}`,
    decision.resetAt ? `- Provider reset: ${decision.resetAt}` : "- Provider reset: not reported; exponential backoff is active",
    "",
    "This wait does not consume an Objective round. You can also resume the job immediately from the Agent Job screen."
  ].join("\n");
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

  const durationMatch = message.match(/try again in\s+(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?/i);
  if (durationMatch && (durationMatch[1] || durationMatch[2])) {
    const durationMs = (Number(durationMatch[1] ?? 0) * 60 + Number(durationMatch[2] ?? 0)) * 60_000;
    return new Date(currentTime.getTime() + durationMs).toISOString();
  }
  return null;
}
