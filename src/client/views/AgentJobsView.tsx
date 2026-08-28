import { Play, RotateCcw, Square } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { aiProviderLabel, aiProviders, type AiProvider } from "../../shared/ai-providers";
import type { ActivityDto, AgentJobDto, ProjectDto } from "../../shared/types";
import { api } from "../api";
import { agentJobMessage } from "../agent-job-message";
import { canRetryAgentJob, formatJobTarget, isActiveAgentJob } from "../agent-status";
import { MarkdownContent } from "../components/MarkdownContent";
import { AsyncState } from "../components/AsyncState";
import { formatDateTime } from "../formatters";
import { t } from "../i18n";
import { numberValue, recordArrayValue, recordValue, stringArrayValue, stringValue } from "../value-parsers";
import { providerWaitDurationParts, providerWaitRemainingSeconds } from "../provider-wait-countdown";
import { diffFileAnchor } from "../../shared/diff-anchors";

type AgentJobScreen = { name: "list" } | { name: "detail"; jobId: number };

function ProviderWaitCountdown(props: { nextRetryAt: string | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [props.nextRetryAt]);
  const remaining = providerWaitRemainingSeconds(props.nextRetryAt, now);
  if (remaining === null) return <strong>-</strong>;
  if (remaining === 0) return <strong>{t("agents.retryDue")}</strong>;
  const duration = providerWaitDurationParts(remaining);
  const parts = [
    duration.days ? `${duration.days}${t("agents.daysShort")}` : null,
    duration.hours ? `${duration.hours}${t("agents.hoursShort")}` : null,
    duration.minutes || duration.days || duration.hours ? `${duration.minutes}${t("agents.minutesShort")}` : null,
    `${duration.seconds}${t("agents.secondsShort")}`
  ].filter((part): part is string => Boolean(part));
  return <strong>{parts.join(" ")}</strong>;
}

function AgentJobActions(props: {
  job: AgentJobDto;
  busyJobId: number | null;
  onCancel: (jobId: number) => Promise<void>;
  resumeProvider: AiProvider;
  onResumeProviderChange: (provider: AiProvider) => void;
  onResume: (jobId: number, provider: AiProvider) => Promise<void>;
  onRetry: (jobId: number) => Promise<void>;
}) {
  return (
    <div className="job-actions">
      {isActiveAgentJob(props.job) ? (
        <button
          className="danger-button"
          disabled={props.busyJobId === props.job.id}
          onClick={(event) => {
            event.stopPropagation();
            void props.onCancel(props.job.id);
          }}
          title={t("agents.cancelJob")}
          type="button"
        >
          <Square size={14} />
          {t("actions.cancel")}
        </button>
      ) : null}
      {canRetryAgentJob(props.job) ? (
        <button
          className="secondary-button"
          disabled={props.busyJobId === props.job.id}
          onClick={(event) => {
            event.stopPropagation();
            void props.onRetry(props.job.id);
          }}
          title={t("agents.retryJob")}
          type="button"
        >
          <RotateCcw size={14} />
          {t("agents.retryJob")}
        </button>
      ) : null}
      {props.job.status === "waiting_provider" ? (
        <div className="provider-resume-actions">
          <label>
            <span>{t("agents.resumeProvider")}</span>
            <select
              aria-label={t("agents.resumeProvider")}
              disabled={props.busyJobId === props.job.id}
              onChange={(event) => props.onResumeProviderChange(event.target.value as AiProvider)}
              value={props.resumeProvider}
            >
              {aiProviders.map((provider) => (
                <option key={provider} value={provider}>{aiProviderLabel(provider)}</option>
              ))}
            </select>
          </label>
          <button
            className="primary-button"
            disabled={props.busyJobId === props.job.id}
            onClick={(event) => {
              event.stopPropagation();
              void props.onResume(props.job.id, props.resumeProvider);
            }}
            title={props.resumeProvider === props.job.aiProvider ? t("agents.resumeNow") : t("agents.switchAndResume")}
            type="button"
          >
            <Play size={14} />
            {props.resumeProvider === props.job.aiProvider ? t("agents.resumeNow") : t("agents.switchAndResume")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

const noisyAgentActivityTitles = new Set([
  "Agent job queued",
  "Started Codex CLI",
  "Codex thread started",
  "Codex turn started",
  "Codex turn completed",
  "Codex CLI completed",
  "Codex CLI failed",
  "Codex error",
  "Codex turn failed",
  "Codex command started",
  "Codex command completed",
  "Codex thinking summary",
  "AI provider selected",
  "Started Claude Code",
  "Claude Code session started",
  "Claude Code completed",
  "Started LM Studio"
]);

function isRelevantAgentActivity(job: AgentJobDto, activity: ActivityDto): boolean {
  if (activity.title === `${job.agentType} agent started`) {
    return false;
  }

  if (noisyAgentActivityTitles.has(activity.title)) {
    return false;
  }

  return true;
}

function ActivityLog(props: { activities: ActivityDto[] }) {
  if (props.activities.length === 0) {
    return <div className="empty-state">{t("activities.none")}</div>;
  }

  return (
    <div className="activity-list">
      {props.activities.map((activity) => (
        <article className="activity-item" key={activity.id}>
          <header>
            <strong>
              {activity.title}
              {activity.occurrenceCount > 1 ? (
                <span className="activity-occurrence-count">×{activity.occurrenceCount}</span>
              ) : null}
            </strong>
            <span>{formatDateTime(activity.lastOccurredAt)}</span>
          </header>
          {activity.body ? <MarkdownContent content={activity.body} /> : null}
        </article>
      ))}
    </div>
  );
}

type EvidenceImageArtifactView = {
  status: "available" | "unavailable";
  name: string;
  caption: string | null;
  url: string | null;
  mediaType: string | null;
  byteSize: number | null;
  reason: string | null;
};

function evidenceImageArtifact(job: AgentJobDto, item: Record<string, unknown>): EvidenceImageArtifactView | null {
  const artifact = recordValue(recordValue(item.payload)?.artifact);
  const status = stringValue(artifact?.status);
  if (artifact?.kind !== "image" || (status !== "available" && status !== "unavailable")) return null;
  const rawUrl = stringValue(artifact.url);
  const expectedUrlPrefix = `/api/projects/${encodeURIComponent(job.projectId)}/agent-jobs/${job.id}/artifacts/`;
  return {
    status,
    name: stringValue(artifact.name) ?? t("agents.screenshot"),
    caption: stringValue(artifact.caption),
    url: status === "available" && rawUrl?.startsWith(expectedUrlPrefix) ? rawUrl : null,
    mediaType: stringValue(artifact.mediaType),
    byteSize: numberValue(artifact.byteSize),
    reason: stringValue(artifact.reason)
  };
}

function formatArtifactSize(byteSize: number | null): string | null {
  if (byteSize === null) return null;
  if (byteSize < 1_024) return `${byteSize} B`;
  return `${(byteSize / 1_024).toFixed(byteSize < 10_240 ? 1 : 0)} KB`;
}

function AgentJobResultSummary(props: { job: AgentJobDto; activities: ActivityDto[] }) {
  const output = props.job.output ?? {};
  const message = agentJobMessage(props.job, props.activities);
  const comment = recordValue(output.comment);
  const commentBody = stringValue(comment?.body);
  const questions = stringArrayValue(output.questions);
  const changedFiles = stringArrayValue(output.changedFiles);
  const testResults = recordArrayValue(output.testResults);
  const stopReason = stringValue(output.stopReason);
  const evidence = recordArrayValue(output.evidence);
  const hasSummary =
    message || commentBody || questions.length || changedFiles.length || testResults.length || stopReason || evidence.length;

  if (!hasSummary) {
    return <div className="empty-state">{t("agents.noSummary")}</div>;
  }

  return (
    <div className="agent-job-result">
      {message ? (
        <MarkdownContent
          className={props.job.status === "failed" ? "job-error" : "agent-job-message"}
          content={message}
        />
      ) : null}
      {commentBody ? <MarkdownContent content={commentBody} /> : null}
      {questions.length ? (
        <div className="result-block">
          <h3>{t("agents.questions")}</h3>
          <ul className="result-list">
            {questions.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {stopReason ? (
        <div className="result-block">
          <h3>{t("agents.stopReason")}</h3>
          <p>{stopReason}</p>
        </div>
      ) : null}
      {changedFiles.length ? (
        <div className="result-block" id="job-changed-files">
          <h3>{t("agents.changedFiles")}</h3>
          <ul className="result-list">
            {changedFiles.map((file) => (
              <li key={file}>
                {props.job.targetType === "pull_request" ? (
                  <a href={`/pulls/${props.job.targetId}#${diffFileAnchor(file)}`}>{file}</a>
                ) : file}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {testResults.length ? (
        <div className="result-block" id="job-checks">
          <h3>{t("agents.tests")}</h3>
          <div className="test-result-list">
            {testResults.map((result, index) => {
              const command = stringValue(result.command) ?? `${t("agents.test")} ${index + 1}`;
              const status = stringValue(result.status) ?? "-";
              const exitCode = numberValue(result.exitCode);
              const outputText = stringValue(result.output);
              return (
                <article className="test-result-row" key={`${command}-${index}`}>
                  <header>
                    <strong>{command}</strong>
                    <span className={`status-pill status-${status}`}>{status}</span>
                  </header>
                  {exitCode !== null ? <span className="muted-text">exit code: {exitCode}</span> : null}
                  {outputText ? <p>{outputText}</p> : null}
                </article>
              );
            })}
          </div>
        </div>
      ) : null}
      {evidence.length ? (
        <div className="result-block" id="job-evidence">
          <h3>{t("agents.evidence")}</h3>
          <div className="test-result-list">
            {evidence.map((item, index) => {
              const title = stringValue(item.title) ?? `${t("agents.evidenceItem")} ${index + 1}`;
              const type = stringValue(item.type);
              const summary = stringValue(item.summary);
              const artifact = evidenceImageArtifact(props.job, item);
              const artifactSize = artifact ? formatArtifactSize(artifact.byteSize) : null;
              return (
                <article className="test-result-row" key={`${title}-${index}`}>
                  <header>
                    <strong>{title}</strong>
                    {type ? <span className="status-pill">{type}</span> : null}
                  </header>
                  {summary ? <p>{summary}</p> : null}
                  {artifact ? (
                    <figure className={`evidence-image-artifact artifact-${artifact.status}`}>
                      {artifact.url ? (
                        <a href={artifact.url} rel="noreferrer noopener" target="_blank">
                          <img alt={artifact.caption ?? title} loading="lazy" src={artifact.url} />
                        </a>
                      ) : (
                        <div className="evidence-artifact-unavailable">
                          {artifact.reason ?? t("agents.artifactUnavailable")}
                        </div>
                      )}
                      <figcaption>
                        <strong>{artifact.caption ?? artifact.name}</strong>
                        <span>{[artifact.mediaType, artifactSize].filter(Boolean).join(" · ")}</span>
                      </figcaption>
                    </figure>
                  ) : null}
                </article>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AgentJobsListScreen(props: { project: ProjectDto; onOpen: (jobId: number) => void }) {
  const [jobs, setJobs] = useState<AgentJobDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setLoading] = useState(true);

  async function load() {
    try {
      setJobs(await api.listAgentJobs(props.project.id));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : "Failed to load agent jobs."));
  }, [props.project.id]);

  const hasActiveJobs = jobs.some(isActiveAgentJob);
  useEffect(() => {
    if (!hasActiveJobs) {
      return;
    }
    const interval = window.setInterval(() => {
      void load().catch((err) => setError(err instanceof Error ? err.message : "Failed to load agent jobs."));
    }, 3000);
    return () => window.clearInterval(interval);
  }, [hasActiveJobs, props.project.id]);

  return (
    <section className="page-section">
      <div className="section-header">
        <h1>{t("agents.title")}</h1>
      </div>
      {error ? <AsyncState kind="error" message={error} /> : null}
      <div className="agent-job-list">
        {isLoading ? <AsyncState kind="loading" message={t("status.loading")} /> : null}
        {!isLoading && !error && jobs.length === 0 ? <AsyncState kind="empty" message={t("agents.noJobs")} /> : null}
        {jobs.map((job) => (
          <button className="agent-job-summary" key={job.id} onClick={() => props.onOpen(job.id)} type="button">
            <span className="agent-job-title">#{job.id} {job.agentType}</span>
            <span className={`status-pill status-${job.status}`}>{job.status}</span>
            <span>{formatJobTarget(job)}</span>
            <span>{formatDateTime(job.createdAt)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function AgentJobDetailScreen(props: {
  project: ProjectDto;
  jobId: number;
  onOpen: (jobId: number) => void;
}) {
  const [job, setJob] = useState<AgentJobDto | null>(null);
  const [activities, setActivities] = useState<ActivityDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyJobId, setBusyJobId] = useState<number | null>(null);
  const [resumeProvider, setResumeProvider] = useState<AiProvider>("codex");

  async function load() {
    const [jobResponse, activityResponse] = await Promise.all([
      api.getAgentJob(props.project.id, props.jobId),
      api.listAgentJobActivities(props.project.id, props.jobId)
    ]);
    setJob(jobResponse);
    setActivities(activityResponse.filter((activity) => activity.agentJobId === jobResponse.id));
  }

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : "Failed to load agent job."));
  }, [props.project.id, props.jobId]);

  useEffect(() => {
    if (job) setResumeProvider(job.aiProvider);
  }, [job?.id, job?.aiProvider]);

  const isActive = job ? isActiveAgentJob(job) : false;
  useEffect(() => {
    if (!isActive) {
      return;
    }
    const interval = window.setInterval(() => {
      void load().catch((err) => setError(err instanceof Error ? err.message : "Failed to load agent job."));
    }, 3000);
    return () => window.clearInterval(interval);
  }, [isActive, props.project.id, props.jobId]);

  async function cancelJob(jobId: number) {
    setBusyJobId(jobId);
    setError(null);
    try {
      setJob(await api.cancelAgentJob(props.project.id, jobId));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel agent job.");
    } finally {
      setBusyJobId(null);
    }
  }

  async function retryJob(jobId: number) {
    setBusyJobId(jobId);
    setError(null);
    try {
      const retriedJobId = await api.retryAgentJob(props.project.id, jobId);
      props.onOpen(retriedJobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to retry agent job.");
    } finally {
      setBusyJobId(null);
    }
  }

  async function resumeJob(jobId: number, provider: AiProvider) {
    setBusyJobId(jobId);
    setError(null);
    try {
      setJob(await api.resumeAgentJob(props.project.id, jobId, provider));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resume agent job.");
    } finally {
      setBusyJobId(null);
    }
  }

  const visibleActivities = useMemo(
    () => (job ? activities.filter((activity) => isRelevantAgentActivity(job, activity)) : []),
    [activities, job]
  );

  useEffect(() => {
    if (!job) return;
    const anchor = window.location.hash.slice(1);
    if (!/^job-(?:result|changed-files|checks|evidence|activities)$/.test(anchor)) return;
    let animationFrame = 0;
    let attempts = 0;
    function reveal(): void {
      const target = document.getElementById(anchor);
      if (target) {
        target.scrollIntoView({ block: "start" });
        return;
      }
      attempts += 1;
      if (attempts < 4) animationFrame = window.requestAnimationFrame(reveal);
    }
    animationFrame = window.requestAnimationFrame(reveal);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [job, visibleActivities.length]);

  return (
    <div className="detail-page">
      <div className="page-toolbar">
        <div className="page-title-block">
          <h1>{job ? `#${job.id} ${job.agentType}` : t("agents.detail")}</h1>
          {job ? <span className={`status-pill status-${job.status}`}>{job.status}</span> : null}
        </div>
      </div>
      {error ? <div className="error-banner">{error}</div> : null}
      <section className="page-section agent-job-detail-section">
        {job ? (
          <>
            <div className="agent-job-details-summary">
              <div className="agent-job-details-header">
                <h2>{t("agents.details")}</h2>
                <AgentJobActions
                  job={job}
                  busyJobId={busyJobId}
                  onCancel={cancelJob}
                  onResume={resumeJob}
                  onResumeProviderChange={setResumeProvider}
                  onRetry={retryJob}
                  resumeProvider={resumeProvider}
                />
              </div>
              {job.status === "waiting_provider" ? (
                <div className="provider-wait-banner">
                  <strong>{t("agents.waitingProvider")}</strong>
                  <span className="provider-wait-countdown">
                    {t("agents.remainingUntilRetry")}: <ProviderWaitCountdown nextRetryAt={job.nextRetryAt} />
                  </span>
                  <span>{t("agents.nextRetry")}: {formatDateTime(job.nextRetryAt)}</span>
                  <span>{t("agents.waitReason")}: {job.waitReason ?? "-"}</span>
                  <span>{t("agents.lastChecked")}: {formatDateTime(stringValue(job.waitMetadata?.detectedAt))}</span>
                  <span>{t("agents.retryCount")}: {numberValue(job.waitMetadata?.retryCount) ?? 0}</span>
                </div>
              ) : null}
              <dl className="agent-job-detail-facts">
                <div>
                  <dt>{t("agents.target")}</dt>
                  <dd>{formatJobTarget(job)}</dd>
                </div>
                <div>
                  <dt>{t("agents.trigger")}</dt>
                  <dd>{job.triggerType}</dd>
                </div>
                <div>
                  <dt>{t("agents.provider")}</dt>
                  <dd>{aiProviderLabel(job.aiProvider)}</dd>
                </div>
                <div>
                  <dt>{t("agents.attempt")}</dt>
                  <dd>{job.attempt}</dd>
                </div>
                <div>
                  <dt>{t("agents.created")}</dt>
                  <dd>{formatDateTime(job.createdAt)}</dd>
                </div>
                <div>
                  <dt>{t("agents.started")}</dt>
                  <dd>{formatDateTime(job.startedAt)}</dd>
                </div>
                <div>
                  <dt>{t("agents.finished")}</dt>
                  <dd>{formatDateTime(job.finishedAt)}</dd>
                </div>
              </dl>
            </div>
            <div className="agent-job-main-content">
              <h2 id="job-result">{t("agents.result")}</h2>
              <AgentJobResultSummary job={job} activities={activities} />
              <h2 id="job-activities">{t("agents.activities")}</h2>
              <ActivityLog activities={visibleActivities} />
            </div>
          </>
        ) : null}
      </section>
    </div>
  );
}

export function AgentJobsView(props: {
  project: ProjectDto;
  routeJobId: number | null;
  onOpenAgentJob: (jobId: number) => void;
}) {
  const [screen, setScreen] = useState<AgentJobScreen>({ name: "list" });

  useEffect(() => {
    setScreen(props.routeJobId === null ? { name: "list" } : { name: "detail", jobId: props.routeJobId });
  }, [props.routeJobId]);

  if (screen.name === "detail") {
    return (
      <AgentJobDetailScreen
        project={props.project}
        jobId={screen.jobId}
        onOpen={(jobId) => {
          setScreen({ name: "detail", jobId });
          props.onOpenAgentJob(jobId);
        }}
      />
    );
  }

  return <AgentJobsListScreen project={props.project} onOpen={props.onOpenAgentJob} />;
}
