import { formatDisplayValue } from "./formatters";
import type { AgentJobDto } from "../shared/types";
import type { DevelopmentLoopDto } from "../shared/development-loop";
import type { AppRoute } from "./routes";
import { t } from "./i18n";

const activeAgentStatuses = new Set<AgentJobDto["status"]>(["queued", "running", "waiting_provider", "waiting_human"]);
const retryableAgentStatuses = new Set<AgentJobDto["status"]>(["failed", "canceled"]);

export type AgentHeaderStatus = "ready" | "queued" | "running" | "waiting" | "failed";
export type AgentHeaderState = {
  status: AgentHeaderStatus;
  label: string;
  count: number;
  title: string;
  targetRoute: AppRoute | null;
};

export function isActiveAgentJob(job: AgentJobDto): boolean {
  return activeAgentStatuses.has(job.status);
}

export function canRetryAgentJob(job: AgentJobDto): boolean {
  if (job.input.developmentLoopId && job.status === "canceled") return false;
  return retryableAgentStatuses.has(job.status);
}

export function formatJobTarget(job: AgentJobDto): string {
  return job.targetType === "project" ? formatDisplayValue("project") : `${formatDisplayValue(job.targetType)} #${job.targetId}`;
}

export function summarizeAgentJobs(jobs: AgentJobDto[], loops?: DevelopmentLoopDto[]): AgentHeaderState {
  const orderedLoops = [...(loops ?? [])].sort((a, b) => a.id - b.id);
  const current = orderedLoops.find((loop) => loop.status === "running")
    ?? orderedLoops.find((loop) => !["succeeded", "canceled"].includes(loop.status));
  const runningJobs = jobs.filter((job) => job.status === "running");
  if (current && (current.status === "running" || !runningJobs.length)) {
    const status = current.status === "running" ? "running" : current.status === "queued" ? "queued" : current.status === "failed" ? "failed" : "waiting";
    const currentJob = jobs.find((job) => job.id === current.currentJobId && (isActiveAgentJob(job) || job.status === current.status));
    const targetRoute: AppRoute = currentJob ? { name: "agentJob", jobId: currentJob.id }
      : current.pullRequestId && ["merging", "reflecting"].includes(current.phase) ? { name: "pullRequest", pullRequestId: current.pullRequestId }
      : { name: "issue", issueId: current.issueId };
    return { status, label: t(`development.${current.status}`), count: 1,
      title: `${t("loops.item")} #${current.id} · ${t(`development.${current.phase}`)}`, targetRoute };
  }
  if (runningJobs.length) {
    return agentHeaderState("running", t("status.running"), runningJobs);
  }

  const waitingJobs = jobs.filter((job) => job.status === "waiting_human");
  if (waitingJobs.length) {
    return agentHeaderState("waiting", t("status.waiting"), waitingJobs);
  }

  const providerWaitingJobs = jobs.filter((job) => job.status === "waiting_provider");
  if (providerWaitingJobs.length) {
    return agentHeaderState("waiting", t("status.waitingProvider"), providerWaitingJobs);
  }

  const pausedJobs = jobs.filter((job) => job.status === "paused");
  if (pausedJobs.length) {
    return agentHeaderState("waiting", t("status.paused"), pausedJobs);
  }

  const queuedJobs = jobs.filter((job) => job.status === "queued");
  if (queuedJobs.length) {
    return agentHeaderState("queued", t("status.queued"), queuedJobs);
  }

  const latestJob = jobs[0] ?? null;
  if (latestJob?.status === "failed") {
    return agentHeaderState("failed", t("status.failed"), [latestJob]);
  }

  return {
    status: "ready",
    label: t("status.ready"),
    count: 0,
    title: t("status.ready"),
    targetRoute: null
  };
}

function agentHeaderState(status: AgentHeaderStatus, label: string, jobs: AgentJobDto[]): AgentHeaderState {
  const firstJob = jobs[0];
  const suffix = jobs.length > 1 ? ` ${jobs.length}` : "";
  return {
    status,
    label: `${label}${suffix}`,
    count: jobs.length,
    title: firstJob ? `#${firstJob.id} ${formatDisplayValue(firstJob.agentType)} ${formatJobTarget(firstJob)}` : label,
    targetRoute: firstJob ? { name: "agentJob", jobId: firstJob.id } : null
  };
}
