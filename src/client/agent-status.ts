import type { AgentJobDto } from "../shared/types";
import type { DevelopmentLoopDto } from "../shared/development-loop";
import { t } from "./i18n";

const activeAgentStatuses = new Set<AgentJobDto["status"]>(["queued", "running", "waiting_provider", "waiting_human"]);
const retryableAgentStatuses = new Set<AgentJobDto["status"]>(["failed", "canceled"]);

export type AgentHeaderStatus = "ready" | "queued" | "running" | "waiting" | "failed";
export type AgentHeaderState = {
  status: AgentHeaderStatus;
  label: string;
  count: number;
  title: string;
};

export function isActiveAgentJob(job: AgentJobDto): boolean {
  return activeAgentStatuses.has(job.status);
}

export function canRetryAgentJob(job: AgentJobDto): boolean {
  if (job.input.developmentLoopId && job.status === "canceled") return false;
  return retryableAgentStatuses.has(job.status);
}

export function formatJobTarget(job: AgentJobDto): string {
  return job.targetType === "project" ? "project" : `${job.targetType} #${job.targetId}`;
}

export function summarizeAgentJobs(jobs: AgentJobDto[], loops?: DevelopmentLoopDto[]): AgentHeaderState {
  if (loops) {
    const current = [...loops].sort((a, b) => a.id - b.id).find((loop) => !["succeeded", "canceled"].includes(loop.status));
    if (!current) return { status: "ready", label: t("status.ready"), count: 0, title: t("status.ready") };
    const status = current.status === "running" ? "running" : current.status === "queued" ? "queued" : current.status === "failed" ? "failed" : "waiting";
    return { status, label: t(`development.${current.status}`), count: 1, title: `Loop #${current.id} · ${t(`development.${current.phase}`)}` };
  }
  const runningJobs = jobs.filter((job) => job.status === "running");
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
    title: t("status.ready")
  };
}

function agentHeaderState(status: AgentHeaderStatus, label: string, jobs: AgentJobDto[]): AgentHeaderState {
  const firstJob = jobs[0];
  const suffix = jobs.length > 1 ? ` ${jobs.length}` : "";
  return {
    status,
    label: `${label}${suffix}`,
    count: jobs.length,
    title: firstJob ? `#${firstJob.id} ${firstJob.agentType} ${formatJobTarget(firstJob)}` : label
  };
}
