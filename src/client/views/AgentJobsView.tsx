import { RotateCcw, Square } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ActivityDto, AgentJobDto, ProjectDto } from "../../shared/types";
import { api } from "../api";
import { agentJobMessage } from "../agent-job-message";
import { canRetryAgentJob, formatJobTarget, isActiveAgentJob } from "../agent-status";
import { MarkdownContent } from "../components/MarkdownContent";
import { formatDateTime } from "../formatters";
import { t } from "../i18n";
import { numberValue, recordArrayValue, recordValue, stringArrayValue, stringValue } from "../value-parsers";

type AgentJobScreen = { name: "list" } | { name: "detail"; jobId: number };

function AgentJobActions(props: {
  job: AgentJobDto;
  busyJobId: number | null;
  onCancel: (jobId: number) => Promise<void>;
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
  "Codex thinking summary"
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
            <strong>{activity.title}</strong>
            <span>{formatDateTime(activity.createdAt)}</span>
          </header>
          {activity.body ? <MarkdownContent content={activity.body} /> : null}
        </article>
      ))}
    </div>
  );
}

function AgentJobResultSummary(props: { job: AgentJobDto; activities: ActivityDto[] }) {
  const output = props.job.output ?? {};
  const message = agentJobMessage(props.job, props.activities);
  const comment = recordValue(output.comment);
  const commentBody = stringValue(comment?.body);
  const questions = stringArrayValue(output.questions);
  const changedFiles = stringArrayValue(output.changedFiles);
  const testResults = recordArrayValue(output.testResults);
  const hasSummary = message || commentBody || questions.length || changedFiles.length || testResults.length;

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
      {changedFiles.length ? (
        <div className="result-block">
          <h3>{t("agents.changedFiles")}</h3>
          <ul className="result-list">
            {changedFiles.map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {testResults.length ? (
        <div className="result-block">
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
    </div>
  );
}

function AgentJobsListScreen(props: { project: ProjectDto; onOpen: (jobId: number) => void }) {
  const [jobs, setJobs] = useState<AgentJobDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setJobs(await api.listAgentJobs(props.project.id));
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
      {error ? <div className="error-banner">{error}</div> : null}
      <div className="agent-job-list">
        {jobs.length === 0 ? <div className="empty-state">{t("agents.noJobs")}</div> : null}
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

  const visibleActivities = useMemo(
    () => (job ? activities.filter((activity) => isRelevantAgentActivity(job, activity)) : []),
    [activities, job]
  );

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
                <AgentJobActions job={job} busyJobId={busyJobId} onCancel={cancelJob} onRetry={retryJob} />
              </div>
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
              <h2>{t("agents.result")}</h2>
              <AgentJobResultSummary job={job} activities={activities} />
              <h2>{t("agents.activities")}</h2>
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
