import {
  ArrowLeft,
  Bot,
  CheckCircle2,
  CircleAlert,
  CircleDot,
  Clock3,
  Files,
  FolderOpen,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  Link2,
  ListTodo,
  MessageCircle,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Save,
  Settings,
  Tag,
  Terminal,
  UserRound,
  XCircle
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type { AiProvider, RoleAiAgentType, RoleAiOverrides } from "../shared/ai-providers";
import {
  aiProviderLabel,
  aiProviders,
  defaultRoleAiOverrides,
  roleAiAgentTypes
} from "../shared/ai-providers";
import type { SupportedLocale } from "../shared/locales";
import { localeLabel, normalizeLocale, supportedLocales } from "../shared/locales";
import { repositoryCommitAnchor } from "../shared/repository-anchors";
import type {
  ActivityDto,
  AgentJobDto,
  CommentDto,
  CommentRevisionDto,
  IssueDto,
  KnownRepositoryDto,
  LabelDto,
  MergeConflictDto,
  ObjectiveRunDto,
  ObjectiveWorkflowStage,
  ProjectCommandDto,
  ProjectDto,
  ProjectSettingsDto,
  PullRequestFindingDto,
  PullRequestLineCommentDto,
  PullRequestDto,
  RepositoryCommitDto,
  RepositoryFileChangeDto,
  RepositoryStatusDto
} from "../shared/types";
import {
  issueWorkflowLabelNames as issueWorkflowLabels,
  pullRequestWorkflowLabelNames as pullRequestWorkflowLabels,
  workflowLabelNames
} from "../shared/workflow-labels";
import { api } from "./api";
import { agentJobMessage, isNoisyCodexText } from "./agent-job-message";
import { summarizeAgentJobs } from "./agent-status";
import { AppShell } from "./components/AppShell";
import { AsyncState } from "./components/AsyncState";
import { DiffViewer } from "./components/DiffViewer";
import { MarkdownContent } from "./components/MarkdownContent";
import { SetupWizard } from "./components/SetupWizard";
import { formatDateTime, formatPullRequestStatus } from "./formatters";
import { setLocale as setUiLocale, t } from "./i18n";
import { type AppRoute, type View, listRouteForView, parseRoute, routeToPath, viewForRoute } from "./routes";
import { numberValue, recordValue } from "./value-parsers";
import { AgentJobsView } from "./views/AgentJobsView";

const issueWorkflowLabelNames = new Set<string>(issueWorkflowLabels);
const pullRequestWorkflowLabelNames = new Set<string>(pullRequestWorkflowLabels);

function labelsForTarget(labels: LabelDto[], targetType: "issue" | "pull_request"): LabelDto[] {
  const workflowLabels = targetType === "issue" ? issueWorkflowLabelNames : pullRequestWorkflowLabelNames;
  return labels.filter((label) => label.kind === "custom" || workflowLabels.has(label.name));
}

function WorkItemLabels(props: { labels: LabelDto[] }) {
  if (!props.labels.length) {
    return null;
  }

  return (
    <span className="work-item-labels">
      {props.labels.map((label) => (
        <span className="label-pill" key={label.id} style={{ borderColor: label.color }}>
          {label.name}
        </span>
      ))}
    </span>
  );
}

function AgentCheckSummary(props: { status: AgentJobDto["status"] | null }) {
  return (
    <span className="work-item-check" title={t("issues.checks")}>
      <CheckCircle2 aria-hidden="true" size={15} />
      {props.status ? (
        <span className={`status-pill status-${props.status}`}>{props.status}</span>
      ) : (
        <span>{t("issues.noChecks")}</span>
      )}
    </span>
  );
}

function WorkItemAuthor(props: { type: IssueDto["createdByType"] }) {
  const label = props.type === "agent"
    ? t("issues.authorAgent")
    : props.type === "system"
      ? t("issues.authorSystem")
      : t("issues.authorUser");
  const Icon = props.type === "agent" ? Bot : props.type === "system" ? Settings : UserRound;

  return (
    <span className="work-item-author" title={`${t("issues.createdBy")} ${label}`}>
      <Icon aria-hidden="true" size={13} />
      <span>{label}</span>
    </span>
  );
}

function WorkItemDetailMeta(props: {
  item: Pick<IssueDto, "createdByType" | "createdAt" | "updatedAt" | "commentCount">;
}) {
  return (
    <div className="work-item-detail-meta">
      <WorkItemAuthor type={props.item.createdByType} />
      <span>
        <Clock3 aria-hidden="true" size={14} />
        {t("issues.created")} {formatDateTime(props.item.createdAt)}
      </span>
      <span>
        <RefreshCw aria-hidden="true" size={14} />
        {t("issues.updated")} {formatDateTime(props.item.updatedAt)}
      </span>
      <span>
        <MessageCircle aria-hidden="true" size={14} />
        {props.item.commentCount} {t("issues.comments")}
      </span>
    </div>
  );
}

function AutomationChecksSummary(props: {
  jobs: AgentJobDto[];
  objective: ObjectiveRunDto | null;
  onOpenAgentJob: (jobId: number) => void;
}) {
  const latestJobs = props.jobs.filter(
    (job, index, jobs) => jobs.findIndex((candidate) => candidate.agentType === job.agentType) === index
  );

  function openJobSection(jobId: number, anchor: string): void {
    props.onOpenAgentJob(jobId);
    window.history.replaceState(null, "", `/jobs/${jobId}#${anchor}`);
  }

  function hasOutputItems(job: AgentJobDto, key: "evidence" | "testResults" | "changedFiles"): boolean {
    return Array.isArray(job.output?.[key]) && job.output[key].length > 0;
  }

  return (
    <div className="automation-checks">
      {props.objective ? (
        <div className="automation-checks-objective">
          <span className={`status-pill status-${props.objective.status}`}>{props.objective.status}</span>
          <span>{objectiveWorkflowStageLabel(props.objective.workflowStage)}</span>
          <span>{objectiveEvidenceCount(props.objective)} {t("objectives.evidence")}</span>
          {props.objective.evidenceRequirements.length ? (
            <span>
              {props.objective.evidenceRequirements.filter((requirement) => requirement.required).length}/
              {props.objective.evidenceRequirements.length} {t("objectives.requiredEvidence")}
            </span>
          ) : null}
        </div>
      ) : null}
      {latestJobs.length ? (
        <div className="automation-check-list">
          {latestJobs.map((job) => (
            <div className="automation-check-row" key={job.id}>
              <button className="automation-check-main" onClick={() => props.onOpenAgentJob(job.id)} type="button">
                {job.status === "succeeded" ? (
                  <CheckCircle2 aria-hidden="true" className="ok-icon" size={16} />
                ) : job.status === "failed" || job.status === "waiting_human" || job.status === "waiting_provider" ? (
                  <CircleAlert aria-hidden="true" className="warn-icon" size={16} />
                ) : (
                  <Bot aria-hidden="true" size={16} />
                )}
                <strong>{job.agentType}</strong>
                <span className={`status-pill status-${job.status}`}>{job.status}</span>
              </button>
              <span className="automation-check-links">
                {hasOutputItems(job, "evidence") ? (
                  <button onClick={() => openJobSection(job.id, "job-evidence")} type="button">{t("agents.evidence")}</button>
                ) : null}
                {hasOutputItems(job, "testResults") ? (
                  <button onClick={() => openJobSection(job.id, "job-checks")} type="button">{t("agents.tests")}</button>
                ) : null}
                {hasOutputItems(job, "changedFiles") ? (
                  <button onClick={() => openJobSection(job.id, "job-changed-files")} type="button">{t("agents.changedFiles")}</button>
                ) : null}
                <button onClick={() => openJobSection(job.id, "job-activities")} type="button">{t("agents.activities")}</button>
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted-text">{t("issues.noChecks")}</p>
      )}
    </div>
  );
}

function AutomationGateBanner(props: {
  jobs: AgentJobDto[];
  objective: ObjectiveRunDto | null;
  onOpenAgentJob: (jobId: number) => void;
}) {
  const waitingJob = props.jobs.find((job) => job.status === "waiting_provider" || job.status === "waiting_human");
  const waitingStatus = waitingJob?.status
    ?? (props.objective?.status === "waiting_provider" || props.objective?.status === "waiting_human"
      ? props.objective.status
      : null);
  if (!waitingStatus) {
    return null;
  }

  const isProviderGate = waitingStatus === "waiting_provider";
  const reason = waitingJob?.waitReason ?? props.objective?.stopReason ?? "-";
  return (
    <section
      aria-live="polite"
      className={`automation-gate-banner ${isProviderGate ? "automation-gate-provider" : "automation-gate-human"}`}
    >
      <div className="automation-gate-icon" aria-hidden="true">
        {isProviderGate ? <Bot size={20} /> : <CircleAlert size={20} />}
      </div>
      <div className="automation-gate-content">
        <strong>{isProviderGate ? t("issues.providerGate") : t("issues.humanGate")}</strong>
        <span>{isProviderGate ? t("agents.waitingProvider") : t("issues.humanGateDescription")}</span>
        <span>{t("agents.waitReason")}: {reason}</span>
        {isProviderGate && waitingJob?.nextRetryAt ? (
          <span>{t("agents.nextRetry")}: {formatDateTime(waitingJob.nextRetryAt)}</span>
        ) : null}
      </div>
      {waitingJob ? (
        <button className="secondary-button" onClick={() => props.onOpenAgentJob(waitingJob.id)} type="button">
          {t("issues.openGate")}
        </button>
      ) : null}
    </section>
  );
}

type ConversationEntry =
  | { kind: "comment"; comment: CommentDto; timestamp: number }
  | { kind: "agent_job"; job: AgentJobDto; comments: CommentDto[]; timestamp: number }
  | { kind: "activity"; activity: ActivityDto; timestamp: number };

function timestampMs(value: string | null): number {
  if (!value) {
    return 0;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function commentAgentJobId(comment: CommentDto): number | null {
  const metadata = comment.metadata;
  if (!metadata) {
    return null;
  }
  const directJobId = numberValue(metadata.agentJobId) ?? numberValue(metadata.jobId);
  if (directJobId !== null) {
    return directJobId;
  }
  return numberValue(recordValue(metadata.agentJob)?.id);
}

function isCommentInsideJobWindow(comment: CommentDto, job: AgentJobDto): boolean {
  const commentTimestamp = timestampMs(comment.createdAt);
  const startTimestamp = timestampMs(job.createdAt) - 30_000;
  const endTimestamp = timestampMs(job.finishedAt ?? job.startedAt ?? job.createdAt);
  if (!endTimestamp || ["queued", "running", "waiting_provider", "waiting_human"].includes(job.status)) {
    return commentTimestamp >= startTimestamp;
  }
  return commentTimestamp >= startTimestamp && commentTimestamp <= endTimestamp + 120_000;
}

function findRelatedAgentJob(comment: CommentDto, agentJobs: AgentJobDto[]): AgentJobDto | null {
  const explicitJobId = commentAgentJobId(comment);
  if (explicitJobId !== null) {
    return agentJobs.find((job) => job.id === explicitJobId) ?? null;
  }
  if (comment.authorType !== "agent" || !comment.agentType) {
    return null;
  }

  const candidates = agentJobs.filter(
    (job) => job.agentType === comment.agentType && isCommentInsideJobWindow(comment, job)
  );
  if (!candidates.length) {
    return null;
  }

  const commentTimestamp = timestampMs(comment.createdAt);
  return candidates.sort((left, right) => {
    const leftReference = timestampMs(left.finishedAt ?? left.startedAt ?? left.createdAt);
    const rightReference = timestampMs(right.finishedAt ?? right.startedAt ?? right.createdAt);
    return Math.abs(commentTimestamp - leftReference) - Math.abs(commentTimestamp - rightReference);
  })[0];
}

function conversationActivityIsRelevant(activity: ActivityDto): boolean {
  if (activity.title === "Agent job queued" || activity.title.endsWith(" agent started")) return false;
  return activity.activityType === "system" || activity.title.toLowerCase().includes("committed");
}

function conversationEntries(comments: CommentDto[], agentJobs: AgentJobDto[], activities: ActivityDto[]): ConversationEntry[] {
  const relevantActivities = activities.filter(conversationActivityIsRelevant);
  const activityCommentIds = new Set<number>();
  for (const activity of relevantActivities) {
    if (!activity.body.trim()) continue;
    const duplicate = comments.find((comment) =>
      comment.authorType === "system" &&
      comment.body.trim() === activity.body.trim() &&
      Math.abs(timestampMs(comment.createdAt) - timestampMs(activity.createdAt)) < 30_000
    );
    if (duplicate) activityCommentIds.add(duplicate.id);
  }
  const timelineComments = comments.filter((comment) => !activityCommentIds.has(comment.id));
  const groups = new Map<number, { job: AgentJobDto; comments: CommentDto[] }>();
  for (const job of agentJobs) {
    groups.set(job.id, { job, comments: [] });
  }

  const groupedCommentIds = new Set<number>();
  for (const comment of timelineComments) {
    const job = findRelatedAgentJob(comment, agentJobs);
    if (!job) {
      continue;
    }
    groups.get(job.id)?.comments.push(comment);
    groupedCommentIds.add(comment.id);
  }

  const entries: ConversationEntry[] = [];
  for (const group of groups.values()) {
    const firstCommentTimestamp = Math.min(
      ...group.comments.map((comment) => timestampMs(comment.createdAt)),
      Number.POSITIVE_INFINITY
    );
    entries.push({
      kind: "agent_job",
      job: group.job,
      comments: group.comments.sort((left, right) => timestampMs(left.createdAt) - timestampMs(right.createdAt)),
      timestamp: Math.min(timestampMs(group.job.createdAt), firstCommentTimestamp)
    });
  }
  for (const comment of timelineComments) {
    if (!groupedCommentIds.has(comment.id)) {
      entries.push({ kind: "comment", comment, timestamp: timestampMs(comment.createdAt) });
    }
  }
  for (const activity of relevantActivities) {
    entries.push({ kind: "activity", activity, timestamp: timestampMs(activity.createdAt) });
  }

  return entries.sort((left, right) => left.timestamp - right.timestamp);
}

function ConversationPermalink(props: { anchor: string; createdAt: string }) {
  return (
    <a className="conversation-permalink" href={`#${props.anchor}`} aria-label={t("issues.permalink")}>
      <Link2 aria-hidden="true" size={12} />
      <span>{formatDateTime(props.createdAt)}</span>
    </a>
  );
}

function CollapsibleConversationMarkdown(props: { content: string; format?: CommentDto["bodyFormat"]; className?: string }) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = props.content.length > 3_500;
  return (
    <div className={collapsible && !expanded ? "conversation-report collapsed" : "conversation-report"}>
      <MarkdownContent className={props.className} content={props.content} format={props.format} />
      {collapsible ? (
        <button className="conversation-report-toggle" onClick={() => setExpanded((current) => !current)} type="button">
          {expanded ? t("issues.collapseComment") : t("issues.showFullComment")}
        </button>
      ) : null}
    </div>
  );
}

function ConversationActivityEvent(props: { activity: ActivityDto; onOpenAgentJob: (jobId: number) => void }) {
  const normalizedTitle = props.activity.title.toLowerCase();
  const Icon = normalizedTitle.includes("merge")
    ? GitMerge
    : normalizedTitle.includes("label")
      ? Tag
      : normalizedTitle.includes("commit")
        ? GitCommitHorizontal
        : normalizedTitle.includes("provider")
          ? Bot
          : Settings;
  return (
    <article className="conversation-activity" id={`activity-${props.activity.id}`}>
      <span className="conversation-activity-icon"><Icon aria-hidden="true" size={16} /></span>
      <div>
        <header>
          <strong>
            {props.activity.title}
            {props.activity.occurrenceCount > 1 ? (
              <span className="activity-occurrence-count">×{props.activity.occurrenceCount}</span>
            ) : null}
          </strong>
          <ConversationPermalink anchor={`activity-${props.activity.id}`} createdAt={props.activity.lastOccurredAt} />
        </header>
        {props.activity.body ? <CollapsibleConversationMarkdown content={props.activity.body} /> : null}
        {props.activity.agentJobId ? (
          <button className="secondary-button" onClick={() => props.onOpenAgentJob(props.activity.agentJobId!)} type="button">
            {t("issues.openGate")}
          </button>
        ) : null}
      </div>
    </article>
  );
}

function commentAuthorLabel(comment: CommentDto): string {
  if (comment.authorType === "agent" && comment.agentType) {
    return `${comment.agentType} agent`;
  }
  return comment.authorType;
}

function readableCommentBody(comment: CommentDto, relatedJob?: AgentJobDto): string {
  if (!isNoisyCodexText(comment.body)) {
    return comment.body;
  }
  return relatedJob ? agentJobMessage(relatedJob, []) ?? t("agents.noConciseComment") : t("agents.noConciseComment");
}

function commentSummaryAnchor(comment: CommentDto): "merge-summary" | "completion-summary" | null {
  const anchor = comment.metadata?.summaryAnchor;
  return anchor === "merge-summary" || anchor === "completion-summary" ? anchor : null;
}

function ConversationCommentCard(props: {
  comment: CommentDto;
  relatedJob?: AgentJobDto;
  onLoadRevisions?: (commentId: number) => Promise<CommentRevisionDto[]>;
  onUpdate?: (comment: CommentDto, body: string) => Promise<void>;
}) {
  const anchor = `comment-${props.comment.id}`;
  const summaryAnchor = commentSummaryAnchor(props.comment);
  const [isEditing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState(props.comment.body);
  const [isSaving, setSaving] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [revisions, setRevisions] = useState<CommentRevisionDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isEdited = props.comment.updatedAt !== props.comment.createdAt;

  async function saveEdit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!props.onUpdate || !editBody.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await props.onUpdate(props.comment, editBody);
      setEditing(false);
      setRevisions(null);
      setShowHistory(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("issues.commentUpdateFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function toggleHistory(): Promise<void> {
    const next = !showHistory;
    setShowHistory(next);
    if (!next || revisions || !props.onLoadRevisions) return;
    setError(null);
    try {
      setRevisions(await props.onLoadRevisions(props.comment.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("issues.commentHistoryFailed"));
    }
  }

  return (
    <article className="conversation-comment" id={anchor}>
      {summaryAnchor ? <span aria-hidden="true" className="conversation-semantic-anchor" id={summaryAnchor} /> : null}
      <header>
        <div className="conversation-comment-heading">
          <strong>{commentAuthorLabel(props.comment)}</strong>
          <ConversationPermalink anchor={anchor} createdAt={props.comment.createdAt} />
          {isEdited ? (
            <button className="conversation-text-button" onClick={() => void toggleHistory()} type="button">
              {t("issues.edited")} {formatDateTime(props.comment.updatedAt)}
            </button>
          ) : null}
        </div>
        {props.comment.authorType === "user" && props.onUpdate ? (
          <button
            className="conversation-text-button"
            onClick={() => {
              setEditBody(props.comment.body);
              setEditing((current) => !current);
              setError(null);
            }}
            type="button"
          >
            <Pencil aria-hidden="true" size={12} />
            {t("actions.edit")}
          </button>
        ) : null}
      </header>
      {isEditing ? (
        <form className="comment-edit-form" onSubmit={(event) => void saveEdit(event)}>
          <textarea
            aria-label={t("issues.editComment")}
            disabled={isSaving}
            onChange={(event) => setEditBody(event.target.value)}
            required
            rows={6}
            value={editBody}
          />
          <div className="action-row">
            <button className="primary-button" disabled={isSaving || !editBody.trim()} type="submit">
              <Save aria-hidden="true" size={14} />
              {t("actions.save")}
            </button>
            <button className="secondary-button" disabled={isSaving} onClick={() => setEditing(false)} type="button">
              {t("actions.cancel")}
            </button>
          </div>
        </form>
      ) : (
        <CollapsibleConversationMarkdown content={readableCommentBody(props.comment, props.relatedJob)} format={props.comment.bodyFormat} />
      )}
      {error ? <div className="inline-error">{error}</div> : null}
      {showHistory ? (
        <section className="comment-revision-history">
          <h4>{t("issues.editHistory")}</h4>
          {revisions === null ? <span className="muted-text">{t("status.loading")}</span> : null}
          {revisions?.map((revision, index) => (
            <article key={revision.id}>
              <header>
                <strong>{t("issues.previousVersion")} {revisions.length - index}</strong>
                <span>{formatDateTime(revision.createdAt)}</span>
              </header>
              <CollapsibleConversationMarkdown content={revision.body} format={revision.bodyFormat} />
            </article>
          ))}
        </section>
      ) : null}
    </article>
  );
}

function ConversationAgentJobCard(props: {
  job: AgentJobDto;
  comments: CommentDto[];
  onLoadCommentRevisions?: (commentId: number) => Promise<CommentRevisionDto[]>;
  onUpdateComment?: (comment: CommentDto, body: string) => Promise<void>;
  onOpenAgentJob: (jobId: number) => void;
}) {
  const message = props.comments.length ? null : agentJobMessage(props.job, []);

  return (
    <article className="conversation-agent-job" id={`agent-job-${props.job.id}`}>
      <header className="conversation-agent-job-header">
        <div>
          <strong>#{props.job.id} {props.job.agentType}</strong>
          <ConversationPermalink anchor={`agent-job-${props.job.id}`} createdAt={props.job.createdAt} />
        </div>
        <button className="secondary-button" onClick={() => props.onOpenAgentJob(props.job.id)} type="button">
          {t("agents.detail")}
        </button>
      </header>
      <div className="conversation-agent-job-meta">
        <span className={`status-pill status-${props.job.status}`}>{props.job.status}</span>
        <span>{props.job.triggerType}</span>
        {props.job.finishedAt ? <span>{formatDateTime(props.job.finishedAt)}</span> : null}
      </div>
      {message ? (
        <CollapsibleConversationMarkdown
          className={props.job.status === "failed" ? "job-error" : "agent-job-message"}
          content={message}
        />
      ) : null}
      {props.comments.length ? (
        <div className="conversation-agent-comments">
          {props.comments.map((comment) => (
            <ConversationCommentCard
              comment={comment}
              key={comment.id}
              onLoadRevisions={props.onLoadCommentRevisions}
              onUpdate={props.onUpdateComment}
              relatedJob={props.job}
            />
          ))}
        </div>
      ) : null}
    </article>
  );
}

function ConversationTimeline(props: {
  comments: CommentDto[];
  agentJobs: AgentJobDto[];
  activities: ActivityDto[];
  onLoadCommentRevisions: (commentId: number) => Promise<CommentRevisionDto[]>;
  onUpdateComment: (comment: CommentDto, body: string) => Promise<void>;
  onOpenAgentJob: (jobId: number) => void;
}) {
  const entries = conversationEntries(props.comments, props.agentJobs, props.activities);
  useEffect(() => {
    const anchor = window.location.hash.slice(1);
    if (!/^(?:(?:comment|activity|agent-job)-\d+|merge-summary|completion-summary)$/.test(anchor)) return;
    let animationFrame = 0;
    let attempts = 0;
    function reveal(): void {
      const target = document.getElementById(anchor);
      if (target) {
        target.scrollIntoView({ block: "center" });
        return;
      }
      attempts += 1;
      if (attempts < 4) animationFrame = window.requestAnimationFrame(reveal);
    }
    animationFrame = window.requestAnimationFrame(reveal);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [entries.length]);
  if (entries.length === 0) {
    return <div className="empty-state">{t("issues.noComments")}</div>;
  }

  return (
    <div className="conversation-timeline">
      {entries.map((entry) =>
        entry.kind === "comment" ? (
          <ConversationCommentCard
            comment={entry.comment}
            key={`comment-${entry.comment.id}`}
            onLoadRevisions={props.onLoadCommentRevisions}
            onUpdate={props.onUpdateComment}
          />
        ) : entry.kind === "activity" ? (
          <ConversationActivityEvent activity={entry.activity} key={`activity-${entry.activity.id}`} onOpenAgentJob={props.onOpenAgentJob} />
        ) : (
          <ConversationAgentJobCard
            comments={entry.comments}
            job={entry.job}
            key={`agent-job-${entry.job.id}`}
            onLoadCommentRevisions={props.onLoadCommentRevisions}
            onOpenAgentJob={props.onOpenAgentJob}
            onUpdateComment={props.onUpdateComment}
          />
        )
      )}
    </div>
  );
}

function LabelPicker(props: {
  labels: LabelDto[];
  selectedLabelIds: number[];
  disabled?: boolean;
  onSelectedLabelIdsChange: (labelIds: number[]) => void;
}) {
  const selected = new Set(props.selectedLabelIds);

  function toggleLabel(labelId: number) {
    const next = new Set(props.selectedLabelIds);
    if (next.has(labelId)) {
      next.delete(labelId);
    } else {
      next.add(labelId);
    }
    props.onSelectedLabelIdsChange(Array.from(next));
  }

  return (
    <section className="label-editor">
      <h3>{t("labels.title")}</h3>
      <div className="label-checklist">
        {props.labels.map((label) => (
          <label className="label-checkbox" key={label.id}>
            <input
              checked={selected.has(label.id)}
              disabled={props.disabled}
              onChange={() => toggleLabel(label.id)}
              type="checkbox"
            />
            <span className="label-swatch" style={{ background: label.color }} />
            <span>{label.name}</span>
          </label>
        ))}
      </div>
    </section>
  );
}

function CommentForm(props: { onSubmit: (body: string) => Promise<void> }) {
  const [body, setBody] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await props.onSubmit(body);
    setBody("");
  }

  return (
    <form className="comment-form" onSubmit={handleSubmit}>
      <textarea value={body} onChange={(event) => setBody(event.target.value)} rows={4} required />
      <button className="primary-button" type="submit">
        <Save size={16} />
        {t("issues.addComment")}
      </button>
    </form>
  );
}

type IssueScreen =
  | { name: "list" }
  | { name: "new" }
  | { name: "detail"; issueId: number }
  | { name: "edit"; issueId: number };

function IssuesListScreen(props: { project: ProjectDto; onNew: () => void; onOpen: (issueId: number) => void }) {
  const [issues, setIssues] = useState<IssueDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setLoading] = useState(true);

  async function load() {
    try {
      const issueResponse = await api.listIssues(props.project.id);
      setIssues(issueResponse.items);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : "Failed to load issues."));
  }, [props.project.id]);

  return (
    <section className="page-section">
      <div className="section-header">
        <h1>{t("issues.title")}</h1>
        <div className="header-actions">
          <button className="primary-button" onClick={props.onNew} type="button">
            <Plus size={16} />
            {t("issues.newIssue")}
          </button>
        </div>
      </div>
      {error ? <AsyncState kind="error" message={error} /> : null}
      <div className="work-item-list">
        {isLoading ? <AsyncState kind="loading" message={t("status.loading")} /> : null}
        {!isLoading && !error && issues.length === 0 ? <AsyncState kind="empty" message={t("issues.noIssues")} /> : null}
        {issues.map((issue) => (
          <button className="work-item-summary work-item-rich" key={issue.id} onClick={() => props.onOpen(issue.id)} type="button">
            <span className={`work-item-state-icon work-item-state-${issue.status}`}>
              <CircleDot aria-hidden="true" size={18} />
              <span className="sr-only">{issue.status === "open" ? t("issues.open") : t("issues.closed")}</span>
            </span>
            <span className="work-item-body">
              <span className="work-item-heading">
                <span className="work-item-title">{issue.title}</span>
                <WorkItemLabels labels={issue.labels} />
              </span>
              <span className="work-item-subtitle">
                <span>#{issue.id}</span>
                <WorkItemAuthor type={issue.createdByType} />
                <span>{t("issues.updated")} {formatDateTime(issue.updatedAt)}</span>
              </span>
              {issue.lastAgentStopReason ? <span className="work-item-stop-reason">{t("agents.stopReason")}: {issue.lastAgentStopReason}</span> : null}
            </span>
            <AgentCheckSummary status={issue.lastAgentStatus} />
            <span className="work-item-stat" title={`${issue.commentCount} ${t("issues.comments")}`}>
              <MessageCircle aria-hidden="true" size={16} />
              <span>{issue.commentCount}</span>
              <span className="sr-only">{t("issues.comments")}</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

function IssueNewScreen(props: { project: ProjectDto; onCancel: () => void; onCreated: (issueId: number) => void }) {
  const [labels, setLabels] = useState<LabelDto[]>([]);
  const [selectedLabelIds, setSelectedLabelIds] = useState<number[]>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);

  useEffect(() => {
    api
      .listLabels(props.project.id)
      .then((labelResponse) => {
        setLabels(labelResponse);
        const requirementsLabel = labelResponse.find((label) => label.name === workflowLabelNames.requirements);
        setSelectedLabelIds(requirementsLabel ? [requirementsLabel.id] : []);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load labels."));
  }, [props.project.id]);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const issue = await api.createIssue(props.project.id, {
        title,
        body,
        labelIds: selectedLabelIds
      });
      props.onCreated(issue.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create issue.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="editor-form" onSubmit={handleCreate}>
      <div className="page-toolbar">
        <button className="secondary-button" onClick={props.onCancel} type="button">
          <ArrowLeft size={16} />
          {t("actions.back")}
        </button>
        <h1>{t("issues.newIssue")}</h1>
      </div>
      {error ? <div className="error-banner">{error}</div> : null}
      <div className="editor-layout">
        <section className="page-section">
          <label>
            {t("issues.titleField")}
            <input value={title} onChange={(event) => setTitle(event.target.value)} required />
          </label>
          <label>
            {t("issues.bodyField")}
            <textarea value={body} onChange={(event) => setBody(event.target.value)} rows={12} />
          </label>
        </section>
        <aside className="side-panel">
          <LabelPicker
            disabled={isSaving}
            labels={labelsForTarget(labels, "issue")}
            onSelectedLabelIdsChange={setSelectedLabelIds}
            selectedLabelIds={selectedLabelIds}
          />
          <button className="primary-button full-width" disabled={isSaving} type="submit">
            <Save size={16} />
            {t("actions.create")}
          </button>
        </aside>
      </div>
    </form>
  );
}

function IssueRelatedLinks(props: {
  pullRequests: PullRequestDto[];
  onOpenPullRequest: (pullRequestId: number) => void;
}) {
  if (!props.pullRequests.length) {
    return null;
  }

  return (
    <section className="related-links" aria-label={t("issues.related")}>
      {props.pullRequests.length ? (
        <div className="related-link-group">
          <h3>{t("issues.relatedPullRequests")}</h3>
          <div className="related-link-list">
            {props.pullRequests.map((pullRequest) => (
              <button
                className="related-link-item"
                key={pullRequest.id}
                onClick={() => props.onOpenPullRequest(pullRequest.id)}
                type="button"
              >
                <span className="related-link-title">#{pullRequest.id} {pullRequest.title}</span>
                <span className="related-link-meta">
                  <span className={`status-pill status-${pullRequest.status}`}>
                    {formatPullRequestStatus(pullRequest.status)}
                  </span>
                  <span>{formatDateTime(pullRequest.closedAt ?? pullRequest.updatedAt)}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function objectiveEvidenceCount(objective: ObjectiveRunDto | null): number {
  const items = objective?.evidence?.items;
  return Array.isArray(items) ? items.length : 0;
}

const objectiveWorkflowStages: ObjectiveWorkflowStage[] = [
  "requirements",
  "implementation",
  "review",
  "fix",
  "qa",
  "verification",
  "ready_to_merge",
  "merged"
];

function objectiveWorkflowStageLabel(stage: ObjectiveWorkflowStage): string {
  if (stage === "requirements") return t("objectives.stageRequirements");
  if (stage === "implementation") return t("objectives.stageImplementation");
  if (stage === "review") return t("objectives.stageReview");
  if (stage === "fix") return t("objectives.stageFix");
  if (stage === "qa") return t("objectives.stageQa");
  if (stage === "verification") return t("objectives.stageVerification");
  if (stage === "ready_to_merge") return t("objectives.stageReadyToMerge");
  return t("objectives.stageMerged");
}

function ObjectivePanel(props: {
  objective: ObjectiveRunDto | null;
  onControl: (action: "pause" | "resume" | "cancel") => Promise<void>;
}) {
  const objective = props.objective;
  const [busyAction, setBusyAction] = useState<"pause" | "resume" | "cancel" | null>(null);
  const [controlError, setControlError] = useState<string | null>(null);
  if (!objective) {
    return <div className="empty-state">{t("objectives.noObjective")}</div>;
  }

  async function control(action: "pause" | "resume" | "cancel"): Promise<void> {
    if (action === "cancel" && !window.confirm(t("objectives.cancelConfirm"))) return;
    setBusyAction(action);
    setControlError(null);
    try {
      await props.onControl(action);
    } catch (error) {
      setControlError(error instanceof Error ? error.message : t("objectives.controlFailed"));
    } finally {
      setBusyAction(null);
    }
  }

  const canPause = ["open", "running", "waiting_provider", "waiting_human", "failed"].includes(objective.status);
  const canCancel = !["succeeded", "canceled"].includes(objective.status);
  const stageIndex = objectiveWorkflowStages.indexOf(objective.workflowStage);
  const stageProgress = ((stageIndex + 1) / objectiveWorkflowStages.length) * 100;

  return (
    <div className="objective-panel">
      <div className="objective-panel-header">
        <span className={`status-pill status-${objective.status}`}>{objective.status}</span>
        <span>{objective.roundCount}/{objective.maxRounds}</span>
      </div>
      <div className="objective-stage-summary">
        <div>
          <span>{t("objectives.workflowStage")}</span>
          <strong>{objectiveWorkflowStageLabel(objective.workflowStage)}</strong>
        </div>
        <span
          aria-label={`${t("objectives.workflowProgress")} ${stageIndex + 1}/${objectiveWorkflowStages.length}`}
          className="objective-stage-track"
          role="progressbar"
          aria-valuemax={objectiveWorkflowStages.length}
          aria-valuemin={1}
          aria-valuenow={stageIndex + 1}
        >
          <span style={{ width: `${stageProgress}%` }} />
        </span>
      </div>
      <dl className="compact-facts">
        <div>
          <dt>{t("objectives.stopReason")}</dt>
          <dd>{objective.stopReason ?? "-"}</dd>
        </div>
        <div>
          <dt>{t("objectives.evidence")}</dt>
          <dd>{objectiveEvidenceCount(objective)}</dd>
        </div>
        <div>
          <dt>{t("objectives.requiredEvidence")}</dt>
          <dd>
            {objective.evidenceRequirements.length
              ? `${objective.evidenceRequirements.filter((requirement) => requirement.required).length}/${objective.evidenceRequirements.length}`
              : "-"}
          </dd>
        </div>
        <div>
          <dt>{t("objectives.providerTokens")}</dt>
          <dd>
            {objective.providerUsage.totalTokens.toLocaleString()} / {objective.tokenBudget?.toLocaleString() ?? "∞"}
          </dd>
        </div>
        <div>
          <dt>{t("objectives.reportedCost")}</dt>
          <dd>
            ${objective.providerUsage.costUsd.toFixed(6)} / {objective.costBudgetUsd === null
              ? "∞"
              : `$${objective.costBudgetUsd.toFixed(6)}`}
          </dd>
        </div>
        <div>
          <dt>{t("objectives.generator")}</dt>
          <dd>{objective.generatorAiProvider ?? "-"}</dd>
        </div>
        <div>
          <dt>{t("objectives.judge")}</dt>
          <dd>{objective.judgeAiProvider ?? "-"}</dd>
        </div>
        <div>
          <dt>{t("objectives.updated")}</dt>
          <dd>{formatDateTime(objective.updatedAt)}</dd>
        </div>
      </dl>
      {objective.summary ? <p className="muted-text">{objective.summary}</p> : null}
      {controlError ? <div className="objective-control-error" role="alert">{controlError}</div> : null}
      <div className="objective-controls">
        {objective.status === "paused" ? (
          <button className="secondary-button" disabled={busyAction !== null} onClick={() => void control("resume")} type="button">
            <Play aria-hidden="true" size={14} />
            {busyAction === "resume" ? t("objectives.resuming") : t("objectives.resume")}
          </button>
        ) : canPause ? (
          <button className="secondary-button" disabled={busyAction !== null} onClick={() => void control("pause")} type="button">
            <Pause aria-hidden="true" size={14} />
            {busyAction === "pause" ? t("objectives.pausing") : t("objectives.pause")}
          </button>
        ) : null}
        {canCancel ? (
          <button className="danger-button" disabled={busyAction !== null} onClick={() => void control("cancel")} type="button">
            <XCircle aria-hidden="true" size={14} />
            {busyAction === "cancel" ? t("objectives.canceling") : t("objectives.cancel")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function IssueDetailScreen(props: {
  project: ProjectDto;
  issueId: number;
  onEdit: (issueId: number) => void;
  onOpenAgentJob: (jobId: number) => void;
  onOpenPullRequest: (pullRequestId: number) => void;
}) {
  const [issue, setIssue] = useState<IssueDto | null>(null);
  const [comments, setComments] = useState<CommentDto[]>([]);
  const [activities, setActivities] = useState<ActivityDto[]>([]);
  const [relatedPullRequests, setRelatedPullRequests] = useState<PullRequestDto[]>([]);
  const [relatedAgentJobs, setRelatedAgentJobs] = useState<AgentJobDto[]>([]);
  const [objective, setObjective] = useState<ObjectiveRunDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isUpdatingStatus, setUpdatingStatus] = useState(false);

  async function load() {
    const [issueResponse, commentsResponse, activityResponse, pullRequestResponse, agentJobResponse, objectiveResponse] = await Promise.all([
      api.getIssue(props.project.id, props.issueId),
      api.listIssueComments(props.project.id, props.issueId),
      api.listIssueActivities(props.project.id, props.issueId),
      api.listPullRequests(props.project.id, { issueId: props.issueId, status: null }),
      api.listAgentJobs(props.project.id, { targetType: "issue", targetId: props.issueId }),
      api.getIssueObjective(props.project.id, props.issueId)
    ]);
    setIssue(issueResponse);
    setComments(commentsResponse);
    setActivities(activityResponse);
    setRelatedPullRequests(pullRequestResponse.items);
    setRelatedAgentJobs(agentJobResponse);
    setObjective(objectiveResponse);
  }

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : "Failed to load issue."));
    const interval = window.setInterval(() => {
      void load().catch((err) => setError(err instanceof Error ? err.message : "Failed to load issue."));
    }, 4000);
    return () => window.clearInterval(interval);
  }, [props.project.id, props.issueId]);

  async function addComment(body: string) {
    await api.createIssueComment(props.project.id, props.issueId, body);
    await load();
  }

  async function updateComment(comment: CommentDto, body: string): Promise<void> {
    await api.updateComment(props.project.id, comment.id, { body, expectedUpdatedAt: comment.updatedAt });
    await load();
  }

  function loadCommentRevisions(commentId: number): Promise<CommentRevisionDto[]> {
    return api.listCommentRevisions(props.project.id, commentId);
  }

  async function queueAgent(agentType: "requirements" | "implementation") {
    await api.createAgentJob(props.project.id, {
      agentType,
      targetType: "issue",
      targetId: props.issueId,
      triggerType: "manual"
    });
    await load();
  }

  async function controlObjective(action: "pause" | "resume" | "cancel") {
    if (!objective) return;
    const result = await api.controlObjective(props.project.id, objective.id, action);
    setObjective(result.objective);
    await load();
  }

  async function updateIssueStatus(status: IssueDto["status"]) {
    if (!issue || issue.status === status) {
      return;
    }
    setUpdatingStatus(true);
    setError(null);
    try {
      const response = await api.updateIssue(props.project.id, issue.id, { status });
      setIssue(response.issue);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${status === "closed" ? "close" : "reopen"} issue.`);
    } finally {
      setUpdatingStatus(false);
    }
  }

  return (
    <div className="detail-page">
      <div className="page-toolbar">
        <div className="page-title-block">
          <h1>{issue ? `#${issue.id} ${issue.title}` : "Issue"}</h1>
          {issue ? <span className={`status-pill status-${issue.status}`}>{issue.status}</span> : null}
        </div>
        {issue ? (
          <div className="header-actions">
            {issue.status === "open" ? (
              <button
                className="secondary-button"
                disabled={isUpdatingStatus}
                onClick={() => void updateIssueStatus("closed")}
                type="button"
              >
                <CheckCircle2 size={16} />
                {t("issues.closeIssue")}
              </button>
            ) : (
              <button
                className="secondary-button"
                disabled={isUpdatingStatus}
                onClick={() => void updateIssueStatus("open")}
                type="button"
              >
                <RefreshCw size={16} />
                {t("issues.reopenIssue")}
              </button>
            )}
            <button className="secondary-button" onClick={() => props.onEdit(issue.id)} type="button">
              <Pencil size={16} />
              {t("actions.edit")}
            </button>
          </div>
        ) : null}
      </div>
      {error ? <AsyncState kind="error" message={error} /> : null}
      {issue ? <WorkItemDetailMeta item={issue} /> : null}
      <AutomationGateBanner jobs={relatedAgentJobs} objective={objective} onOpenAgentJob={props.onOpenAgentJob} />
      {!issue && !error ? <AsyncState kind="loading" message={t("status.loading")} /> : null}
      <div className={issue ? "detail-layout" : "detail-layout pending"}>
        <section className="page-section detail-main">
          {issue?.body ? <MarkdownContent content={issue.body} /> : <div className="empty-state">{t("issues.noDescription")}</div>}
          <h2>{t("issues.conversation")}</h2>
          <IssueRelatedLinks
            onOpenPullRequest={props.onOpenPullRequest}
            pullRequests={relatedPullRequests}
          />
          <ConversationTimeline
            activities={activities}
            agentJobs={relatedAgentJobs}
            comments={comments}
            onLoadCommentRevisions={loadCommentRevisions}
            onOpenAgentJob={props.onOpenAgentJob}
            onUpdateComment={updateComment}
          />
          <CommentForm onSubmit={addComment} />
        </section>
        <aside className="side-panel detail-sidebar">
          <h2>{t("issues.checks")}</h2>
          <AutomationChecksSummary jobs={relatedAgentJobs} objective={objective} onOpenAgentJob={props.onOpenAgentJob} />
          <h2>{t("objectives.title")}</h2>
          <ObjectivePanel objective={objective} onControl={controlObjective} />
          <h2>{t("labels.title")}</h2>
          <div className="label-row">
            {issue?.labels.length ? (
              issue.labels.map((label) => (
                <span className="label-pill" key={label.id} style={{ borderColor: label.color }}>
                  {label.name}
                </span>
              ))
            ) : (
              <span className="muted-text">{t("labels.none")}</span>
            )}
          </div>
          <h2>{t("agents.title")}</h2>
          <div className="action-row">
            <button className="secondary-button" disabled={Boolean(objective && ["paused", "canceled", "succeeded"].includes(objective.status))} onClick={() => void queueAgent("requirements")} type="button">
              <ListTodo size={16} />
              {t("agents.queueRequirements")}
            </button>
            <button className="secondary-button" disabled={Boolean(objective && ["paused", "canceled", "succeeded"].includes(objective.status))} onClick={() => void queueAgent("implementation")} type="button">
              <Terminal size={16} />
              {t("agents.queueImplementation")}
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}

function IssueEditScreen(props: {
  project: ProjectDto;
  issueId: number;
  onCancel: () => void;
  onDeleted: () => void;
  onSaved: (issueId: number) => void;
}) {
  const [issue, setIssue] = useState<IssueDto | null>(null);
  const [labels, setLabels] = useState<LabelDto[]>([]);
  const [selectedLabelIds, setSelectedLabelIds] = useState<number[]>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [status, setStatus] = useState<IssueDto["status"]>("open");
  const [goalChangeReason, setGoalChangeReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);
  const [isDeleting, setDeleting] = useState(false);

  async function load() {
    const [issueResponse, labelResponse] = await Promise.all([
      api.getIssue(props.project.id, props.issueId),
      api.listLabels(props.project.id)
    ]);
    setIssue(issueResponse);
    setTitle(issueResponse.title);
    setBody(issueResponse.body);
    setStatus(issueResponse.status);
    setSelectedLabelIds(issueResponse.labels.map((label) => label.id));
    setGoalChangeReason("");
    setLabels(labelResponse);
  }

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : "Failed to load issue."));
  }, [props.project.id, props.issueId]);

  async function saveIssue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!issue) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await api.updateIssue(props.project.id, issue.id, {
        title,
        body,
        status,
        labelIds: selectedLabelIds,
        goalChangeReason: goalChangeReason.trim() || undefined
      });
      props.onSaved(response.issue.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save issue.");
    } finally {
      setSaving(false);
    }
  }

  async function deleteIssue() {
    if (!issue || !window.confirm(t("issues.deleteConfirm"))) {
      return;
    }
    setDeleting(true);
    setError(null);
    try {
      await api.deleteIssue(props.project.id, issue.id);
      props.onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete issue.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <form className="editor-form" onSubmit={saveIssue}>
      <div className="page-toolbar">
        <button className="secondary-button" onClick={props.onCancel} type="button">
          <ArrowLeft size={16} />
          {t("actions.back")}
        </button>
        <h1>{issue ? `${t("actions.edit")} #${issue.id}` : t("actions.edit")}</h1>
      </div>
      {error ? <div className="error-banner">{error}</div> : null}
      <div className="editor-layout">
        <section className="page-section">
          <label>
            {t("issues.titleField")}
            <input value={title} onChange={(event) => setTitle(event.target.value)} required />
          </label>
          <label>
            {t("issues.bodyField")}
            <textarea value={body} onChange={(event) => setBody(event.target.value)} rows={12} />
          </label>
          {issue && body !== issue.body ? (
            <label>
              {t("issues.goalChangeReason")}
              <textarea
                onChange={(event) => setGoalChangeReason(event.target.value)}
                placeholder={t("issues.goalChangeReasonPlaceholder")}
                required
                rows={3}
                value={goalChangeReason}
              />
              <small>{t("issues.goalChangeReasonDescription")}</small>
            </label>
          ) : null}
        </section>
        <aside className="side-panel">
          <label>
            {t("issues.status")}
            <select value={status} onChange={(event) => setStatus(event.target.value as IssueDto["status"])}>
              <option value="open">{t("issues.open")}</option>
              <option value="closed">{t("issues.closed")}</option>
            </select>
          </label>
          <LabelPicker
            disabled={isSaving}
            labels={labelsForTarget(labels, "issue")}
            onSelectedLabelIdsChange={setSelectedLabelIds}
            selectedLabelIds={selectedLabelIds}
          />
          <button className="primary-button full-width" disabled={isSaving} type="submit">
            <Save size={16} />
            {t("actions.save")}
          </button>
          <button className="danger-button full-width" disabled={isDeleting} onClick={() => void deleteIssue()} type="button">
            {t("actions.delete")}
          </button>
        </aside>
      </div>
    </form>
  );
}

function IssuesView(props: {
  project: ProjectDto;
  routeIssueId: number | null;
  onOpenIssues: () => void;
  onOpenIssue: (issueId: number) => void;
  onOpenAgentJob: (jobId: number) => void;
  onOpenPullRequest: (pullRequestId: number) => void;
}) {
  const [screen, setScreen] = useState<IssueScreen>({ name: "list" });

  useEffect(() => {
    setScreen(props.routeIssueId === null ? { name: "list" } : { name: "detail", issueId: props.routeIssueId });
  }, [props.routeIssueId]);

  if (screen.name === "new") {
    return (
      <IssueNewScreen
        project={props.project}
        onCancel={() => {
          setScreen({ name: "list" });
          props.onOpenIssues();
        }}
        onCreated={(issueId) => {
          setScreen({ name: "detail", issueId });
          props.onOpenIssue(issueId);
        }}
      />
    );
  }

  if (screen.name === "detail") {
    return (
      <IssueDetailScreen
        project={props.project}
        issueId={screen.issueId}
        onEdit={(issueId) => setScreen({ name: "edit", issueId })}
        onOpenAgentJob={props.onOpenAgentJob}
        onOpenPullRequest={props.onOpenPullRequest}
      />
    );
  }

  if (screen.name === "edit") {
    return (
      <IssueEditScreen
        project={props.project}
        issueId={screen.issueId}
        onCancel={() => {
          setScreen({ name: "detail", issueId: screen.issueId });
          props.onOpenIssue(screen.issueId);
        }}
        onDeleted={() => {
          setScreen({ name: "list" });
          props.onOpenIssues();
        }}
        onSaved={(issueId) => {
          setScreen({ name: "detail", issueId });
          props.onOpenIssue(issueId);
        }}
      />
    );
  }

  return (
    <IssuesListScreen
      project={props.project}
      onNew={() => setScreen({ name: "new" })}
      onOpen={props.onOpenIssue}
    />
  );
}

function RepositoryView(props: { project: ProjectDto }) {
  const [commands, setCommands] = useState<ProjectCommandDto[]>([]);
  const [commits, setCommits] = useState<RepositoryCommitDto[]>([]);
  const [status, setStatus] = useState<RepositoryStatusDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setLoading] = useState(true);

  async function load() {
    try {
      const [commandResponse, statusResponse, commitResponse] = await Promise.all([
        api.listCommands(props.project.id),
        api.getRepositoryStatus(props.project.id),
        api.listRepositoryCommits(props.project.id)
      ]);
      setCommands(commandResponse);
      setStatus(statusResponse);
      setCommits(commitResponse);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : "Failed to load commands."));
  }, [props.project.id]);

  useEffect(() => {
    const anchor = window.location.hash.slice(1);
    if (!/^commit-[0-9a-f]{7,64}$/i.test(anchor) || commits.length === 0) return;
    const target = document.getElementById(anchor);
    target?.scrollIntoView({ block: "center" });
  }, [commits]);

  async function detectAgain() {
    await api.detectCommands(props.project.id);
    await load();
  }

  return (
    <section className="page-section">
      <div className="section-header">
        <h1>{t("repository.title")}</h1>
        <button className="secondary-button" onClick={() => void detectAgain()} type="button">
          <RefreshCw size={16} />
          {t("actions.detect")}
        </button>
      </div>
      {error ? <div className="error-banner">{error}</div> : null}
      <dl className="repository-facts">
        <div>
          <dt>{t("repository.path")}</dt>
          <dd>{props.project.repoPath}</dd>
        </div>
        <div>
          <dt>{t("repository.branch")}</dt>
          <dd>{props.project.defaultBranch}</dd>
        </div>
        <div>
          <dt>{t("repository.currentBranch")}</dt>
          <dd>{status?.branch ?? "-"}</dd>
        </div>
        <div>
          <dt>{t("repository.workingTree")}</dt>
          <dd>{status ? (status.clean ? t("repository.clean") : `${status.changedFiles.length} ${t("repository.dirty")}`) : "-"}</dd>
        </div>
      </dl>
      <h2>{t("repository.commands")}</h2>
      <table className="command-table">
        <thead>
          <tr>
            <th>{t("repository.command")}</th>
            <th>{t("repository.source")}</th>
            <th>{t("repository.available")}</th>
          </tr>
        </thead>
        <tbody>
          {commands.map((command) => (
            <tr key={command.id}>
              <td>
                <strong>{command.commandType}</strong>
                <span>{command.command ?? t("repository.missing")}</span>
              </td>
              <td>{command.detectionSource}</td>
              <td>
                {command.isAvailable ? <CheckCircle2 size={16} className="ok-icon" /> : <CircleAlert size={16} className="warn-icon" />}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>{t("repository.commits")}</h2>
      {isLoading ? <AsyncState kind="loading" message={t("status.loading")} /> : null}
      {!isLoading && commits.length === 0 ? <AsyncState kind="empty" message={t("repository.noCommits")} /> : null}
      <div className="repository-commit-list">
        {commits.map((commit) => {
          const anchor = repositoryCommitAnchor(commit.hash);
          return (
            <article className="repository-commit" id={anchor ?? undefined} key={commit.hash}>
              <div>
                <strong>{commit.subject}</strong>
                <span>{commit.authorName} · {formatDateTime(commit.date)}</span>
              </div>
              {anchor ? (
                <a className="repository-commit-hash" href={`#${anchor}`} title={commit.hash}>
                  <GitCommitHorizontal aria-hidden="true" size={14} />
                  <code>{commit.hash.slice(0, 12)}</code>
                </a>
              ) : <code>{commit.hash.slice(0, 12)}</code>}
            </article>
          );
        })}
      </div>
    </section>
  );
}

type PullRequestScreen =
  | { name: "list" }
  | { name: "new" }
  | { name: "detail"; pullRequestId: number }
  | { name: "conflicts"; pullRequestId: number }
  | { name: "edit"; pullRequestId: number };

function PullRequestsListScreen(props: {
  project: ProjectDto;
  onNew: () => void;
  onOpen: (pullRequestId: number) => void;
}) {
  const [pullRequests, setPullRequests] = useState<PullRequestDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setLoading] = useState(true);

  async function load() {
    try {
      const response = await api.listPullRequests(props.project.id);
      setPullRequests(response.items);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : "Failed to load pull requests."));
  }, [props.project.id]);

  return (
    <section className="page-section">
      <div className="section-header">
        <h1>{t("pullRequests.title")}</h1>
        <div className="header-actions">
          <button className="primary-button" onClick={props.onNew} type="button">
            <Plus size={16} />
            {t("pullRequests.newPullRequest")}
          </button>
        </div>
      </div>
      {error ? <AsyncState kind="error" message={error} /> : null}
      <div className="work-item-list">
        {isLoading ? <AsyncState kind="loading" message={t("status.loading")} /> : null}
        {!isLoading && !error && pullRequests.length === 0 ? <AsyncState kind="empty" message={t("pullRequests.noPullRequests")} /> : null}
        {pullRequests.map((pullRequest) => (
          <button
            className="work-item-summary work-item-rich"
            key={pullRequest.id}
            onClick={() => props.onOpen(pullRequest.id)}
            type="button"
          >
            <span className={`work-item-state-icon work-item-state-${pullRequest.status}`}>
              {pullRequest.status === "merged" ? <GitMerge aria-hidden="true" size={18} /> : <GitPullRequest aria-hidden="true" size={18} />}
              <span className="sr-only">{formatPullRequestStatus(pullRequest.status)}</span>
            </span>
            <span className="work-item-body">
              <span className="work-item-heading">
                <span className="work-item-title">{pullRequest.title}</span>
                <WorkItemLabels labels={pullRequest.labels} />
              </span>
              <span className="work-item-subtitle">
                <span>#{pullRequest.id}</span>
                <WorkItemAuthor type={pullRequest.createdByType} />
                <code>{pullRequest.sourceBranch}</code>
                <span aria-hidden="true">→</span>
                <code>{pullRequest.targetBranch}</code>
                {pullRequest.issueId ? <span>· {t("pullRequests.relatedIssue")} #{pullRequest.issueId}</span> : null}
                <span>· {t("issues.updated")} {formatDateTime(pullRequest.updatedAt)}</span>
              </span>
              {pullRequest.lastAgentStopReason ? <span className="work-item-stop-reason">{t("agents.stopReason")}: {pullRequest.lastAgentStopReason}</span> : null}
            </span>
            <AgentCheckSummary status={pullRequest.lastAgentStatus} />
            <span className="work-item-stats">
              <span className="work-item-stat" title={`${pullRequest.commentCount} ${t("issues.comments")}`}>
                <MessageCircle aria-hidden="true" size={16} />
                <span>{pullRequest.commentCount}</span>
                <span className="sr-only">{t("issues.comments")}</span>
              </span>
              <span className="work-item-stat" title={`${pullRequest.commitCount} ${t("pullRequests.commits")}`}>
                <GitCommitHorizontal aria-hidden="true" size={16} />
                <span>{pullRequest.commitCount}</span>
                <span className="sr-only">{t("pullRequests.commits")}</span>
              </span>
              <span className="work-item-stat" title={`${pullRequest.changedFileCount} ${t("pullRequests.files")}`}>
                <Files aria-hidden="true" size={16} />
                <span>{pullRequest.changedFileCount}</span>
                <span className="sr-only">{t("pullRequests.files")}</span>
              </span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

function PullRequestNewScreen(props: {
  project: ProjectDto;
  onCancel: () => void;
  onCreated: (pullRequestId: number) => void;
}) {
  const [labels, setLabels] = useState<LabelDto[]>([]);
  const [selectedLabelIds, setSelectedLabelIds] = useState<number[]>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [sourceBranch, setSourceBranch] = useState("");
  const [targetBranch, setTargetBranch] = useState(props.project.defaultBranch);
  const [issueId, setIssueId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);

  useEffect(() => {
    api
      .listLabels(props.project.id)
      .then((labelResponse) => {
        setLabels(labelResponse);
        const reviewLabel = labelResponse.find((label) => label.name === workflowLabelNames.reviewing);
        setSelectedLabelIds(reviewLabel ? [reviewLabel.id] : []);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load labels."));
  }, [props.project.id]);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const pullRequest = await api.createPullRequest(props.project.id, {
        issueId: issueId ? Number(issueId) : null,
        title,
        body,
        sourceBranch,
        targetBranch,
        labelIds: selectedLabelIds
      });
      props.onCreated(pullRequest.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create pull request.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="editor-form" onSubmit={handleCreate}>
      <div className="page-toolbar">
        <button className="secondary-button" onClick={props.onCancel} type="button">
          <ArrowLeft size={16} />
          {t("actions.back")}
        </button>
        <h1>{t("pullRequests.newPullRequest")}</h1>
      </div>
      {error ? <div className="error-banner">{error}</div> : null}
      <div className="editor-layout">
        <section className="page-section">
          <label>
            {t("issues.titleField")}
            <input value={title} onChange={(event) => setTitle(event.target.value)} required />
          </label>
          <label>
            {t("issues.bodyField")}
            <textarea value={body} onChange={(event) => setBody(event.target.value)} rows={10} />
          </label>
          <div className="form-grid two-columns">
            <label>
              {t("pullRequests.targetBranch")}
              <input value={targetBranch} onChange={(event) => setTargetBranch(event.target.value)} required />
            </label>
            <label>
              {t("pullRequests.sourceBranch")}
              <input value={sourceBranch} onChange={(event) => setSourceBranch(event.target.value)} required />
            </label>
          </div>
          <label>
            {t("pullRequests.linkedIssue")}
            <input value={issueId} onChange={(event) => setIssueId(event.target.value)} type="number" />
          </label>
        </section>
        <aside className="side-panel">
          <LabelPicker
            disabled={isSaving}
            labels={labelsForTarget(labels, "pull_request")}
            onSelectedLabelIdsChange={setSelectedLabelIds}
            selectedLabelIds={selectedLabelIds}
          />
          <button className="primary-button full-width" disabled={isSaving} type="submit">
            <Save size={16} />
            {t("actions.create")}
          </button>
        </aside>
      </div>
    </form>
  );
}

function PullRequestRelatedLinks(props: {
  issueId: number | null;
  linkedIssue: IssueDto | null;
  onOpenIssue: (issueId: number) => void;
}) {
  const issueId = props.issueId;

  if (!issueId) {
    return null;
  }

  return (
    <section className="related-links" aria-label={t("issues.related")}>
      {issueId ? (
        <div className="related-link-group">
          <h3>{t("pullRequests.relatedIssue")}</h3>
          <div className="related-link-list">
            <button className="related-link-item" onClick={() => props.onOpenIssue(issueId)} type="button">
              <span className="related-link-title">
                #{issueId} {props.linkedIssue?.title ?? ""}
              </span>
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function BranchCompare(props: { sourceBranch: string; targetBranch: string }) {
  return (
    <div className="branch-compare" aria-label={t("pullRequests.branchComparison")}>
      <div className="branch-card target-branch">
        <span>{t("pullRequests.targetBranch")}</span>
        <code>{props.targetBranch}</code>
      </div>
      <div className="branch-merge-arrow" aria-hidden="true">
        <ArrowLeft size={18} strokeWidth={2.5} />
      </div>
      <div className="branch-card source-branch">
        <span>{t("pullRequests.sourceBranch")}</span>
        <code>{props.sourceBranch}</code>
      </div>
    </div>
  );
}

function PullRequestDetailScreen(props: {
  project: ProjectDto;
  pullRequestId: number;
  onEdit: (pullRequestId: number) => void;
  onOpenConflicts: (pullRequestId: number) => void;
  onOpenAgentJob: (jobId: number) => void;
  onOpenIssue: (issueId: number) => void;
}) {
  const [pullRequest, setPullRequest] = useState<PullRequestDto | null>(null);
  const [linkedIssue, setLinkedIssue] = useState<IssueDto | null>(null);
  const [relatedAgentJobs, setRelatedAgentJobs] = useState<AgentJobDto[]>([]);
  const [comments, setComments] = useState<CommentDto[]>([]);
  const [activities, setActivities] = useState<ActivityDto[]>([]);
  const [objective, setObjective] = useState<ObjectiveRunDto | null>(null);
  const [files, setFiles] = useState<RepositoryFileChangeDto[]>([]);
  const [findings, setFindings] = useState<PullRequestFindingDto[]>([]);
  const [lineComments, setLineComments] = useState<PullRequestLineCommentDto[]>([]);
  const [diffRevision, setDiffRevision] = useState<{ sourceCommit: string; targetCommit: string } | null>(null);
  const [commits, setCommits] = useState<RepositoryCommitDto[]>([]);
  const [mergeConflicts, setMergeConflicts] = useState<MergeConflictDto | null>(null);
  const [tab, setTab] = useState<"conversation" | "files" | "commits">(() =>
    window.location.hash.startsWith("#diff-") ? "files" : "conversation"
  );
  const [error, setError] = useState<string | null>(null);
  const [mergeMessage, setMergeMessage] = useState<string | null>(null);
  const [isMerging, setMerging] = useState(false);
  const [isResolvingConflicts, setResolvingConflicts] = useState(false);

  async function load() {
    const [pullRequestResponse, commentsResponse, activityResponse, agentJobResponse, objectiveResponse] = await Promise.all([
      api.getPullRequest(props.project.id, props.pullRequestId),
      api.listPullRequestComments(props.project.id, props.pullRequestId),
      api.listPullRequestActivities(props.project.id, props.pullRequestId),
      api.listAgentJobs(props.project.id, { targetType: "pull_request", targetId: props.pullRequestId }),
      api.getPullRequestObjective(props.project.id, props.pullRequestId)
    ]);
    const linkedIssuePromise = pullRequestResponse.issueId
      ? api.getIssue(props.project.id, pullRequestResponse.issueId).catch(() => null)
      : Promise.resolve(null);
    const [filesResponse, findingsResponse, lineCommentsResponse, commitsResponse, conflictsResponse, linkedIssueResponse] = await Promise.all([
      api.listPullRequestFiles(props.project.id, props.pullRequestId),
      api.listPullRequestFindings(props.project.id, props.pullRequestId),
      api.listPullRequestLineComments(props.project.id, props.pullRequestId),
      api.listPullRequestCommits(props.project.id, props.pullRequestId),
      api.getPullRequestMergeConflicts(props.project.id, props.pullRequestId),
      linkedIssuePromise
    ]);
    setPullRequest(pullRequestResponse);
    setLinkedIssue(linkedIssueResponse);
    setRelatedAgentJobs(agentJobResponse);
    setComments(commentsResponse);
    setActivities(activityResponse);
    setObjective(objectiveResponse);
    setFiles(filesResponse.files);
    setFindings(findingsResponse);
    setLineComments(lineCommentsResponse);
    setDiffRevision({ sourceCommit: filesResponse.sourceCommit, targetCommit: filesResponse.targetCommit });
    setCommits(commitsResponse);
    setMergeConflicts(conflictsResponse);
  }

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : "Failed to load pull request."));
    const interval = window.setInterval(() => {
      void load().catch((err) => setError(err instanceof Error ? err.message : "Failed to load pull request."));
    }, 4000);
    return () => window.clearInterval(interval);
  }, [props.project.id, props.pullRequestId]);

  useEffect(() => {
    function openLinkedDiff(): void {
      if (window.location.hash.startsWith("#diff-")) {
        setTab("files");
      }
    }
    window.addEventListener("hashchange", openLinkedDiff);
    return () => window.removeEventListener("hashchange", openLinkedDiff);
  }, []);

  async function addComment(body: string) {
    await api.createPullRequestComment(props.project.id, props.pullRequestId, body);
    await load();
  }

  async function updateComment(comment: CommentDto, body: string): Promise<void> {
    await api.updateComment(props.project.id, comment.id, { body, expectedUpdatedAt: comment.updatedAt });
    await load();
  }

  function loadCommentRevisions(commentId: number): Promise<CommentRevisionDto[]> {
    return api.listCommentRevisions(props.project.id, commentId);
  }

  async function queueAgent(agentType: "review" | "fix" | "qa" | "verifier") {
    await api.createAgentJob(props.project.id, {
      agentType,
      targetType: "pull_request",
      targetId: props.pullRequestId,
      triggerType: "manual"
    });
    await load();
  }

  async function controlObjective(action: "pause" | "resume" | "cancel") {
    if (!objective) return;
    const result = await api.controlObjective(props.project.id, objective.id, action);
    setObjective(result.objective);
    await load();
  }

  async function resolveConflicts() {
    setResolvingConflicts(true);
    setError(null);
    try {
      const jobId = await api.resolvePullRequestConflicts(props.project.id, props.pullRequestId);
      if (jobId) {
        props.onOpenAgentJob(jobId);
        return;
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to queue conflict resolution.");
    } finally {
      setResolvingConflicts(false);
    }
  }

  async function mergePullRequest() {
    if (!pullRequest || !window.confirm(t("pullRequests.mergeConfirm"))) {
      return;
    }
    setMerging(true);
    setError(null);
    setMergeMessage(null);
    try {
      const response = await api.mergePullRequest(props.project.id, pullRequest.id);
      setPullRequest(response.pullRequest);
      setMergeMessage(`${t("pullRequests.mergeSucceeded")} ${response.mergeCommit.slice(0, 12)}`);
      setTab("conversation");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to merge pull request.");
    } finally {
      setMerging(false);
    }
  }

  const mergeDisabled = !pullRequest || pullRequest.status !== "open" || Boolean(mergeConflicts?.hasConflicts) || isMerging;
  const mergeDisabledReason = !pullRequest
    ? null
    : pullRequest.status !== "open"
      ? t("pullRequests.mergeUnavailableClosed")
      : mergeConflicts?.hasConflicts
        ? t("pullRequests.mergeUnavailableConflict")
        : null;

  return (
    <div className="detail-page">
      <div className="page-toolbar">
        <div className="page-title-block">
          <h1>{pullRequest ? `#${pullRequest.id} ${pullRequest.title}` : "Pull request"}</h1>
          {pullRequest ? (
            <span className={`status-pill status-${pullRequest.status}`}>{formatPullRequestStatus(pullRequest.status)}</span>
          ) : null}
        </div>
        {pullRequest ? (
          <button className="secondary-button" onClick={() => props.onEdit(pullRequest.id)} type="button">
            <Pencil size={16} />
            {t("actions.edit")}
          </button>
        ) : null}
      </div>
      {error ? <AsyncState kind="error" message={error} /> : null}
      {pullRequest ? <WorkItemDetailMeta item={pullRequest} /> : null}
      <AutomationGateBanner jobs={relatedAgentJobs} objective={objective} onOpenAgentJob={props.onOpenAgentJob} />
      {!pullRequest && !error ? <AsyncState kind="loading" message={t("status.loading")} /> : null}
      <div className={pullRequest ? "detail-layout" : "detail-layout pending"}>
        <section className="page-section detail-main">
          {pullRequest ? (
            <>
              <BranchCompare sourceBranch={pullRequest.sourceBranch} targetBranch={pullRequest.targetBranch} />
              <div className="detail-facts">
                <span>{pullRequest.changedFileCount} {t("pullRequests.files")}</span>
                <span>{pullRequest.commitCount} {t("pullRequests.commits")}</span>
              </div>
              {pullRequest.body ? (
                <MarkdownContent content={pullRequest.body} />
              ) : (
                <div className="empty-state">{t("issues.noDescription")}</div>
              )}
            </>
          ) : null}
          {mergeConflicts?.hasConflicts ? (
            <div className="warning-banner">
              <div>
                <strong>{t("pullRequests.conflictsDetected")}</strong>
                <p>{mergeConflicts.files.map((file) => file.path).join(", ")}</p>
              </div>
              <div className="action-row">
                <button className="secondary-button" onClick={() => props.onOpenConflicts(props.pullRequestId)} type="button">
                  <CircleAlert size={16} />
                  {t("pullRequests.viewConflicts")}
                </button>
                <button
                  className="secondary-button"
                  disabled={isResolvingConflicts}
                  onClick={() => void resolveConflicts()}
                  type="button"
                >
                  <Bot size={16} />
                  {t("pullRequests.resolveConflictsWithAi")}
                </button>
              </div>
            </div>
          ) : null}
          <div className="subtabs">
            <button className={tab === "conversation" ? "active" : ""} onClick={() => setTab("conversation")} type="button">
              {t("issues.conversation")}
            </button>
            <button className={tab === "files" ? "active" : ""} onClick={() => setTab("files")} type="button">
              {t("pullRequests.filesChanged")}
            </button>
            <button className={tab === "commits" ? "active" : ""} onClick={() => setTab("commits")} type="button">
              {t("pullRequests.commitsTab")}
            </button>
          </div>
          {tab === "conversation" ? (
            <>
              <PullRequestRelatedLinks
                issueId={pullRequest?.issueId ?? null}
                linkedIssue={linkedIssue}
                onOpenIssue={props.onOpenIssue}
              />
              <ConversationTimeline
                activities={activities}
                agentJobs={relatedAgentJobs}
                comments={comments}
                onLoadCommentRevisions={loadCommentRevisions}
                onOpenAgentJob={props.onOpenAgentJob}
                onUpdateComment={updateComment}
              />
              <CommentForm onSubmit={addComment} />
            </>
          ) : null}
          {tab === "files" ? (
            <DiffViewer
              files={files}
              findings={findings}
              lineComments={lineComments}
              projectId={props.project.id}
              pullRequestId={props.pullRequestId}
              sourceCommit={diffRevision?.sourceCommit ?? null}
              targetCommit={diffRevision?.targetCommit ?? null}
            />
          ) : null}
          {tab === "commits" ? (
            <div className="commit-list">
              {commits.length === 0 ? <div className="empty-state">{t("pullRequests.noCommits")}</div> : null}
              {commits.map((commit) => (
                <article className="file-row commit-row" key={commit.hash}>
                  <header>
                    <strong>{commit.subject}</strong>
                    <code>{commit.hash.slice(0, 8)}</code>
                  </header>
                  <p>
                    {commit.authorName} - {formatDateTime(commit.date)}
                  </p>
                </article>
              ))}
            </div>
          ) : null}
        </section>
        <aside className="side-panel detail-sidebar">
          <h2>{t("issues.checks")}</h2>
          <AutomationChecksSummary jobs={relatedAgentJobs} objective={objective} onOpenAgentJob={props.onOpenAgentJob} />
          <h2>{t("objectives.title")}</h2>
          <ObjectivePanel objective={objective} onControl={controlObjective} />
          <h2>{t("pullRequests.merge")}</h2>
          <div className="merge-panel">
            {mergeMessage ? <div className="success-banner">{mergeMessage}</div> : null}
            <button
              className="primary-button full-width"
              disabled={mergeDisabled}
              onClick={() => void mergePullRequest()}
              type="button"
            >
              <GitPullRequest size={16} />
              {isMerging ? t("status.running") : t("pullRequests.mergePullRequest")}
            </button>
            {mergeDisabledReason ? <p className="muted-text">{mergeDisabledReason}</p> : null}
          </div>
          <h2>{t("labels.title")}</h2>
          <div className="label-row">
            {pullRequest?.labels.length ? (
              pullRequest.labels.map((label) => (
                <span className="label-pill" key={label.id} style={{ borderColor: label.color }}>
                  {label.name}
                </span>
              ))
            ) : (
              <span className="muted-text">{t("labels.none")}</span>
            )}
          </div>
          <h2>{t("agents.title")}</h2>
          <div className="action-row">
            <button className="secondary-button" disabled={Boolean(objective && ["paused", "canceled", "succeeded"].includes(objective.status))} onClick={() => void queueAgent("review")} type="button">
              <GitPullRequest size={16} />
              {t("agents.queueReview")}
            </button>
            <button className="secondary-button" disabled={Boolean(objective && ["paused", "canceled", "succeeded"].includes(objective.status))} onClick={() => void queueAgent("fix")} type="button">
              <CircleAlert size={16} />
              {t("agents.queueFix")}
            </button>
            <button className="secondary-button" disabled={Boolean(objective && ["paused", "canceled", "succeeded"].includes(objective.status))} onClick={() => void queueAgent("qa")} type="button">
              <CheckCircle2 size={16} />
              {t("agents.queueQa")}
            </button>
            <button className="secondary-button" disabled={Boolean(objective && ["paused", "canceled", "succeeded"].includes(objective.status))} onClick={() => void queueAgent("verifier")} type="button">
              <CheckCircle2 size={16} />
              {t("agents.queueVerifier")}
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}

function ConflictContentBlock(props: { title: string; content?: string | null }) {
  return (
    <div className="conflict-version">
      <h3>{props.title}</h3>
      {props.content ? (
        <pre className="conflict-content">
          <code>{props.content}</code>
        </pre>
      ) : (
        <p className="muted-text">{t("pullRequests.noConflictContent")}</p>
      )}
    </div>
  );
}

function PullRequestConflictScreen(props: {
  project: ProjectDto;
  pullRequestId: number;
  onBack: () => void;
  onOpenAgentJob: (jobId: number) => void;
}) {
  const [pullRequest, setPullRequest] = useState<PullRequestDto | null>(null);
  const [conflicts, setConflicts] = useState<MergeConflictDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isResolvingConflicts, setResolvingConflicts] = useState(false);

  async function load() {
    const [pullRequestResponse, conflictsResponse] = await Promise.all([
      api.getPullRequest(props.project.id, props.pullRequestId),
      api.getPullRequestMergeConflicts(props.project.id, props.pullRequestId)
    ]);
    setPullRequest(pullRequestResponse);
    setConflicts(conflictsResponse);
  }

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : "Failed to load conflicts."));
  }, [props.project.id, props.pullRequestId]);

  async function resolveConflicts() {
    setResolvingConflicts(true);
    setError(null);
    setMessage(null);
    try {
      const jobId = await api.resolvePullRequestConflicts(props.project.id, props.pullRequestId);
      if (jobId) {
        props.onOpenAgentJob(jobId);
        return;
      }
      setMessage(t("pullRequests.resolveConflictsQueued"));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to queue conflict resolution.");
    } finally {
      setResolvingConflicts(false);
    }
  }

  return (
    <div className="detail-page">
      <div className="page-toolbar">
        <button className="secondary-button" onClick={props.onBack} type="button">
          <ArrowLeft size={16} />
          {t("actions.back")}
        </button>
        <div className="page-title-block">
          <h1>{t("pullRequests.conflictDetails")}</h1>
          {pullRequest ? <span className={`status-pill status-${pullRequest.status}`}>{formatPullRequestStatus(pullRequest.status)}</span> : null}
        </div>
        {conflicts?.hasConflicts ? (
          <button
            className="secondary-button"
            disabled={isResolvingConflicts}
            onClick={() => void resolveConflicts()}
            type="button"
          >
            <Bot size={16} />
            {t("pullRequests.resolveConflictsWithAi")}
          </button>
        ) : null}
      </div>
      {error ? <div className="error-banner">{error}</div> : null}
      {message ? <div className="success-banner">{message}</div> : null}
      <section className="page-section conflict-screen">
        {pullRequest ? <BranchCompare sourceBranch={pullRequest.sourceBranch} targetBranch={pullRequest.targetBranch} /> : null}
        {!conflicts ? <div className="empty-state">{t("status.running")}</div> : null}
        {conflicts && !conflicts.hasConflicts ? <div className="empty-state">{t("pullRequests.noConflicts")}</div> : null}
        {conflicts?.hasConflicts ? (
          <div className="conflict-list">
            {conflicts.files.map((file) => (
              <article className="conflict-file" key={file.path}>
                <header>
                  <strong>{file.path}</strong>
                  <span>{file.reason}</span>
                </header>
                <div className="conflict-version-grid">
                  <ConflictContentBlock title={t("pullRequests.conflictBase")} content={file.baseContent} />
                  <ConflictContentBlock
                    title={`${t("pullRequests.conflictTarget")} ${pullRequest?.targetBranch ?? ""}`}
                    content={file.targetContent}
                  />
                  <ConflictContentBlock
                    title={`${t("pullRequests.conflictSource")} ${pullRequest?.sourceBranch ?? ""}`}
                    content={file.sourceContent}
                  />
                </div>
              </article>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function PullRequestEditScreen(props: {
  project: ProjectDto;
  pullRequestId: number;
  onCancel: () => void;
  onDeleted: () => void;
  onSaved: (pullRequestId: number) => void;
}) {
  const [pullRequest, setPullRequest] = useState<PullRequestDto | null>(null);
  const [labels, setLabels] = useState<LabelDto[]>([]);
  const [selectedLabelIds, setSelectedLabelIds] = useState<number[]>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [status, setStatus] = useState<PullRequestDto["status"]>("open");
  const [sourceBranch, setSourceBranch] = useState("");
  const [targetBranch, setTargetBranch] = useState("");
  const [issueId, setIssueId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);
  const [isDeleting, setDeleting] = useState(false);

  async function load() {
    const [pullRequestResponse, labelsResponse] = await Promise.all([
      api.getPullRequest(props.project.id, props.pullRequestId),
      api.listLabels(props.project.id)
    ]);
    setPullRequest(pullRequestResponse);
    setTitle(pullRequestResponse.title);
    setBody(pullRequestResponse.body);
    setStatus(pullRequestResponse.status);
    setSourceBranch(pullRequestResponse.sourceBranch);
    setTargetBranch(pullRequestResponse.targetBranch);
    setIssueId(pullRequestResponse.issueId ? String(pullRequestResponse.issueId) : "");
    setSelectedLabelIds(pullRequestResponse.labels.map((label) => label.id));
    setLabels(labelsResponse);
  }

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : "Failed to load pull request."));
  }, [props.project.id, props.pullRequestId]);

  async function savePullRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pullRequest) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await api.updatePullRequest(props.project.id, pullRequest.id, {
        issueId: issueId ? Number(issueId) : null,
        title,
        body,
        status,
        sourceBranch,
        targetBranch,
        labelIds: selectedLabelIds
      });
      props.onSaved(response.pullRequest.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save pull request.");
    } finally {
      setSaving(false);
    }
  }

  async function deletePullRequest() {
    if (!pullRequest || !window.confirm(t("pullRequests.deleteConfirm"))) {
      return;
    }
    setDeleting(true);
    setError(null);
    try {
      await api.deletePullRequest(props.project.id, pullRequest.id);
      props.onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete pull request.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <form className="editor-form" onSubmit={savePullRequest}>
      <div className="page-toolbar">
        <button className="secondary-button" onClick={props.onCancel} type="button">
          <ArrowLeft size={16} />
          {t("actions.back")}
        </button>
        <h1>{pullRequest ? `${t("actions.edit")} #${pullRequest.id}` : t("actions.edit")}</h1>
      </div>
      {error ? <div className="error-banner">{error}</div> : null}
      <div className="editor-layout">
        <section className="page-section">
          <label>
            {t("issues.titleField")}
            <input value={title} onChange={(event) => setTitle(event.target.value)} required />
          </label>
          <label>
            {t("issues.bodyField")}
            <textarea value={body} onChange={(event) => setBody(event.target.value)} rows={10} />
          </label>
          <div className="form-grid two-columns">
            <label>
              {t("pullRequests.targetBranch")}
              <input value={targetBranch} onChange={(event) => setTargetBranch(event.target.value)} required />
            </label>
            <label>
              {t("pullRequests.sourceBranch")}
              <input value={sourceBranch} onChange={(event) => setSourceBranch(event.target.value)} required />
            </label>
          </div>
          <label>
            {t("pullRequests.linkedIssue")}
            <input value={issueId} onChange={(event) => setIssueId(event.target.value)} type="number" />
          </label>
        </section>
        <aside className="side-panel">
          <label>
            {t("issues.status")}
            <select value={status} onChange={(event) => setStatus(event.target.value as PullRequestDto["status"])}>
              <option value="open">{t("pullRequests.open")}</option>
              <option value="closed">{t("pullRequests.closed")}</option>
              <option value="merged">{t("pullRequests.merged")}</option>
            </select>
          </label>
          <LabelPicker
            disabled={isSaving}
            labels={labelsForTarget(labels, "pull_request")}
            onSelectedLabelIdsChange={setSelectedLabelIds}
            selectedLabelIds={selectedLabelIds}
          />
          <button className="primary-button full-width" disabled={isSaving} type="submit">
            <Save size={16} />
            {t("actions.save")}
          </button>
          <button className="danger-button full-width" disabled={isDeleting} onClick={() => void deletePullRequest()} type="button">
            {t("actions.delete")}
          </button>
        </aside>
      </div>
    </form>
  );
}

function PullRequestsView(props: {
  project: ProjectDto;
  routePullRequestId: number | null;
  routePullRequestScreen: "detail" | "conflicts" | null;
  onOpenPullRequests: () => void;
  onOpenPullRequest: (pullRequestId: number) => void;
  onOpenPullRequestConflicts: (pullRequestId: number) => void;
  onOpenAgentJob: (jobId: number) => void;
  onOpenIssue: (issueId: number) => void;
}) {
  const [screen, setScreen] = useState<PullRequestScreen>({ name: "list" });

  useEffect(() => {
    if (props.routePullRequestId === null) {
      setScreen({ name: "list" });
      return;
    }
    setScreen(
      props.routePullRequestScreen === "conflicts"
        ? { name: "conflicts", pullRequestId: props.routePullRequestId }
        : { name: "detail", pullRequestId: props.routePullRequestId }
    );
  }, [props.routePullRequestId, props.routePullRequestScreen]);

  if (screen.name === "new") {
    return (
      <PullRequestNewScreen
        project={props.project}
        onCancel={() => {
          setScreen({ name: "list" });
          props.onOpenPullRequests();
        }}
        onCreated={(pullRequestId) => {
          setScreen({ name: "detail", pullRequestId });
          props.onOpenPullRequest(pullRequestId);
        }}
      />
    );
  }

  if (screen.name === "detail") {
    return (
      <PullRequestDetailScreen
        project={props.project}
        pullRequestId={screen.pullRequestId}
        onEdit={(pullRequestId) => setScreen({ name: "edit", pullRequestId })}
        onOpenConflicts={(pullRequestId) => {
          setScreen({ name: "conflicts", pullRequestId });
          props.onOpenPullRequestConflicts(pullRequestId);
        }}
        onOpenAgentJob={props.onOpenAgentJob}
        onOpenIssue={props.onOpenIssue}
      />
    );
  }

  if (screen.name === "conflicts") {
    return (
      <PullRequestConflictScreen
        project={props.project}
        pullRequestId={screen.pullRequestId}
        onBack={() => {
          setScreen({ name: "detail", pullRequestId: screen.pullRequestId });
          props.onOpenPullRequest(screen.pullRequestId);
        }}
        onOpenAgentJob={props.onOpenAgentJob}
      />
    );
  }

  if (screen.name === "edit") {
    return (
      <PullRequestEditScreen
        project={props.project}
        pullRequestId={screen.pullRequestId}
        onCancel={() => {
          setScreen({ name: "detail", pullRequestId: screen.pullRequestId });
          props.onOpenPullRequest(screen.pullRequestId);
        }}
        onDeleted={() => {
          setScreen({ name: "list" });
          props.onOpenPullRequests();
        }}
        onSaved={(pullRequestId) => {
          setScreen({ name: "detail", pullRequestId });
          props.onOpenPullRequest(pullRequestId);
        }}
      />
    );
  }

  return (
    <PullRequestsListScreen
      project={props.project}
      onNew={() => setScreen({ name: "new" })}
      onOpen={props.onOpenPullRequest}
    />
  );
}

function roleAiAgentLabel(agentType: RoleAiAgentType): string {
  if (agentType === "implementation") return t("objectives.stageImplementation");
  if (agentType === "review") return t("objectives.stageReview");
  if (agentType === "qa") return t("objectives.stageQa");
  return t("objectives.stageVerification");
}

function SettingsView(props: { project: ProjectDto; onProjectLocaleChange: (locale: SupportedLocale) => void }) {
  const [settings, setSettings] = useState<ProjectSettingsDto | null>(null);
  const [locale, setLocale] = useState<SupportedLocale>(normalizeLocale(props.project.locale));
  const [aiProvider, setAiProvider] = useState<AiProvider>("codex");
  const [roleAiOverrides, setRoleAiOverrides] = useState<RoleAiOverrides>(defaultRoleAiOverrides());
  const [claudeCommand, setClaudeCommand] = useState("claude");
  const [claudeModel, setClaudeModel] = useState("");
  const [claudePermissionMode, setClaudePermissionMode] =
    useState<ProjectSettingsDto["ai"]["claudeCode"]["permissionMode"]>("bypassPermissions");
  const [claudeMaxTurns, setClaudeMaxTurns] = useState("");
  const [lmStudioBaseUrl, setLmStudioBaseUrl] = useState("http://127.0.0.1:1234/v1");
  const [lmStudioModel, setLmStudioModel] = useState("");
  const [lmStudioMaxToolRounds, setLmStudioMaxToolRounds] = useState("8");
  const [lmStudioTemperature, setLmStudioTemperature] = useState("");
  const [autoMergeEnabled, setAutoMergeEnabled] = useState(true);
  const [autoMergeTargetBranches, setAutoMergeTargetBranches] = useState("");
  const [autoMergeStrategy, setAutoMergeStrategy] = useState<ProjectSettingsDto["automation"]["autoMergeStrategy"]>("merge");
  const [autoMergeRiskThreshold, setAutoMergeRiskThreshold] =
    useState<ProjectSettingsDto["automation"]["autoMergeRiskThreshold"]>("medium");
  const [objectiveTokenBudget, setObjectiveTokenBudget] = useState("");
  const [objectiveCostBudgetUsd, setObjectiveCostBudgetUsd] = useState("");
  const [agentTimeBudgetMinutes, setAgentTimeBudgetMinutes] = useState("");
  const [verificationCommandTimeoutMinutes, setVerificationCommandTimeoutMinutes] = useState("5");
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);
  const [isLoading, setLoading] = useState(true);

  async function load() {
    const response = await api.getSettings(props.project.id);
    setSettings(response);
    setLocale(normalizeLocale(response.project.locale));
    setAiProvider(response.ai.provider);
    setRoleAiOverrides(response.ai.roleOverrides);
    setClaudeCommand(response.ai.claudeCode.command);
    setClaudeModel(response.ai.claudeCode.model ?? "");
    setClaudePermissionMode(response.ai.claudeCode.permissionMode);
    setClaudeMaxTurns(response.ai.claudeCode.maxTurns ? String(response.ai.claudeCode.maxTurns) : "");
    setLmStudioBaseUrl(response.ai.lmStudio.baseUrl);
    setLmStudioModel(response.ai.lmStudio.model ?? "");
    setLmStudioMaxToolRounds(String(response.ai.lmStudio.maxToolRounds));
    setLmStudioTemperature(response.ai.lmStudio.temperature === null ? "" : String(response.ai.lmStudio.temperature));
    setAutoMergeEnabled(response.automation.autoMergeEnabled);
    setAutoMergeTargetBranches(response.automation.autoMergeTargetBranches.join(", "));
    setAutoMergeStrategy(response.automation.autoMergeStrategy);
    setAutoMergeRiskThreshold(response.automation.autoMergeRiskThreshold);
    setObjectiveTokenBudget(response.automation.objectiveTokenBudget === null
      ? ""
      : String(response.automation.objectiveTokenBudget));
    setObjectiveCostBudgetUsd(response.automation.objectiveCostBudgetUsd === null
      ? ""
      : String(response.automation.objectiveCostBudgetUsd));
    setAgentTimeBudgetMinutes(response.automation.agentTimeBudgetMinutes === null
      ? ""
      : String(response.automation.agentTimeBudgetMinutes));
    setVerificationCommandTimeoutMinutes(String(response.automation.verificationCommandTimeoutMinutes));
  }

  useEffect(() => {
    setLoading(true);
    setError(null);
    void load()
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load settings."))
      .finally(() => setLoading(false));
  }, [props.project.id]);

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setSavedMessage(null);
    try {
      const response = await api.updateSettings(props.project.id, {
        locale,
        ai: {
          provider: aiProvider,
          roleOverrides: roleAiOverrides,
          claudeCode: {
            command: claudeCommand,
            model: claudeModel.trim() || null,
            permissionMode: claudePermissionMode,
            maxTurns: claudeMaxTurns.trim() ? Number(claudeMaxTurns) : null
          },
          lmStudio: {
            baseUrl: lmStudioBaseUrl,
            model: lmStudioModel.trim() || null,
            maxToolRounds: Number(lmStudioMaxToolRounds || "8"),
            temperature: lmStudioTemperature.trim() ? Number(lmStudioTemperature) : null
          }
        },
        automation: {
          autoMergeEnabled,
          autoMergeTargetBranches: autoMergeTargetBranches.split(",").map((branch) => branch.trim()).filter(Boolean),
          autoMergeStrategy,
          autoMergeRiskThreshold,
          objectiveTokenBudget: objectiveTokenBudget.trim() ? Number(objectiveTokenBudget) : null,
          objectiveCostBudgetUsd: objectiveCostBudgetUsd.trim() ? Number(objectiveCostBudgetUsd) : null,
          agentTimeBudgetMinutes: agentTimeBudgetMinutes.trim() ? Number(agentTimeBudgetMinutes) : null,
          verificationCommandTimeoutMinutes: Number(verificationCommandTimeoutMinutes || "5")
        }
      });
      setSettings(response);
      setAiProvider(response.ai.provider);
      setRoleAiOverrides(response.ai.roleOverrides);
      const savedLocale = setUiLocale(response.project.locale);
      setLocale(savedLocale);
      props.onProjectLocaleChange(savedLocale);
      setSavedMessage(t("settings.saved"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="page-section">
      <div className="section-header">
        <h1>{t("settings.title")}</h1>
      </div>
      {error ? <AsyncState kind="error" message={error} /> : null}
      {savedMessage ? <div className="success-banner">{savedMessage}</div> : null}
      {isLoading ? <AsyncState kind="loading" message={t("status.loading")} /> : null}
      {!isLoading && settings ? (
      <>
        <form className="settings-form" onSubmit={saveSettings}>
        <label>
          {t("settings.locale")}
          <select value={locale} onChange={(event) => setLocale(event.target.value as SupportedLocale)}>
            {supportedLocales.map((item) => (
              <option key={item} value={item}>
                {localeLabel(item)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("settings.provider")}
          <select value={aiProvider} onChange={(event) => setAiProvider(event.target.value as AiProvider)}>
            {aiProviders.map((provider) => (
              <option key={provider} value={provider}>
                {aiProviderLabel(provider)}
              </option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend>{t("settings.roleRouting")}</legend>
          <p className="muted-text">{t("settings.roleRoutingDescription")}</p>
          <div className="role-routing-grid">
            {roleAiAgentTypes.map((agentType) => {
              const roleLabel = roleAiAgentLabel(agentType);
              const override = roleAiOverrides[agentType];
              return (
                <div className="role-routing-row" key={agentType}>
                  <strong>{roleLabel}</strong>
                  <label>
                    <span>{t("settings.provider")}</span>
                    <select
                      aria-label={`${roleLabel} ${t("settings.provider")}`}
                      onChange={(event) => setRoleAiOverrides((current) => ({
                        ...current,
                        [agentType]: {
                          ...current[agentType],
                          provider: event.target.value ? event.target.value as AiProvider : null
                        }
                      }))}
                      value={override.provider ?? ""}
                    >
                      <option value="">{t("settings.inheritProvider")}</option>
                      {aiProviders.map((provider) => (
                        <option key={provider} value={provider}>{aiProviderLabel(provider)}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>{t("settings.model")}</span>
                    <input
                      aria-label={`${roleLabel} ${t("settings.model")}`}
                      onChange={(event) => setRoleAiOverrides((current) => ({
                        ...current,
                        [agentType]: {
                          ...current[agentType],
                          model: event.target.value || null
                        }
                      }))}
                      placeholder={t("settings.inheritModel")}
                      value={override.model ?? ""}
                    />
                  </label>
                </div>
              );
            })}
          </div>
        </fieldset>
        <fieldset>
          <legend>{t("settings.automation")}</legend>
          <label className="checkbox-row">
            <input
              checked={autoMergeEnabled}
              onChange={(event) => setAutoMergeEnabled(event.target.checked)}
              type="checkbox"
            />
            <span>
              {t("settings.autoMerge")}
              <small>{t("settings.autoMergeDescription")}</small>
            </span>
          </label>
          <label>
            {t("settings.autoMergeTargetBranches")}
            <input
              onChange={(event) => setAutoMergeTargetBranches(event.target.value)}
              placeholder={t("settings.autoMergeTargetBranchesPlaceholder")}
              value={autoMergeTargetBranches}
            />
            <small>{t("settings.autoMergeTargetBranchesDescription")}</small>
          </label>
          <label>
            {t("settings.autoMergeStrategy")}
            <select
              onChange={(event) =>
                setAutoMergeStrategy(event.target.value as ProjectSettingsDto["automation"]["autoMergeStrategy"])
              }
              value={autoMergeStrategy}
            >
              <option value="merge">{t("settings.autoMergeStrategyMerge")}</option>
              <option value="squash">{t("settings.autoMergeStrategySquash")}</option>
            </select>
          </label>
          <label>
            {t("settings.autoMergeRiskThreshold")}
            <select
              onChange={(event) =>
                setAutoMergeRiskThreshold(
                  event.target.value as ProjectSettingsDto["automation"]["autoMergeRiskThreshold"]
                )
              }
              value={autoMergeRiskThreshold}
            >
              <option value="medium">{t("settings.riskThresholdMedium")}</option>
              <option value="high">{t("settings.riskThresholdHigh")}</option>
              <option value="none">{t("settings.riskThresholdNone")}</option>
            </select>
            <small>{t("settings.autoMergeRiskThresholdDescription")}</small>
          </label>
          <label>
            {t("settings.objectiveTokenBudget")}
            <input
              min="1"
              onChange={(event) => setObjectiveTokenBudget(event.target.value)}
              placeholder={t("settings.unlimitedBudget")}
              step="1"
              type="number"
              value={objectiveTokenBudget}
            />
            <small>{t("settings.objectiveTokenBudgetDescription")}</small>
          </label>
          <label>
            {t("settings.objectiveCostBudget")}
            <input
              min="0.000001"
              onChange={(event) => setObjectiveCostBudgetUsd(event.target.value)}
              placeholder={t("settings.unlimitedBudget")}
              step="0.01"
              type="number"
              value={objectiveCostBudgetUsd}
            />
            <small>{t("settings.objectiveCostBudgetDescription")}</small>
          </label>
          <label>
            {t("settings.agentTimeBudget")}
            <input
              min="0.01"
              onChange={(event) => setAgentTimeBudgetMinutes(event.target.value)}
              placeholder={t("settings.unlimitedBudget")}
              step="0.5"
              type="number"
              value={agentTimeBudgetMinutes}
            />
            <small>{t("settings.agentTimeBudgetDescription")}</small>
          </label>
          <label>
            {t("settings.verificationCommandTimeout")}
            <input
              min="0.01"
              onChange={(event) => setVerificationCommandTimeoutMinutes(event.target.value)}
              required
              step="0.5"
              type="number"
              value={verificationCommandTimeoutMinutes}
            />
            <small>{t("settings.verificationCommandTimeoutDescription")}</small>
          </label>
        </fieldset>
        <fieldset>
          <legend>{t("settings.claudeCode")}</legend>
          <label>
            {t("settings.command")}
            <input value={claudeCommand} onChange={(event) => setClaudeCommand(event.target.value)} required />
          </label>
          <label>
            {t("settings.model")}
            <input value={claudeModel} onChange={(event) => setClaudeModel(event.target.value)} />
          </label>
          <label>
            {t("settings.permissionMode")}
            <select
              value={claudePermissionMode}
              onChange={(event) =>
                setClaudePermissionMode(event.target.value as ProjectSettingsDto["ai"]["claudeCode"]["permissionMode"])
              }
            >
              <option value="bypassPermissions">bypassPermissions</option>
              <option value="auto">auto</option>
              <option value="dontAsk">dontAsk</option>
              <option value="default">default</option>
            </select>
          </label>
          <label>
            {t("settings.maxTurns")}
            <input
              min="1"
              onChange={(event) => setClaudeMaxTurns(event.target.value)}
              type="number"
              value={claudeMaxTurns}
            />
          </label>
        </fieldset>
        <fieldset>
          <legend>{t("settings.lmStudio")}</legend>
          <label>
            {t("settings.baseUrl")}
            <input value={lmStudioBaseUrl} onChange={(event) => setLmStudioBaseUrl(event.target.value)} required />
          </label>
          <label>
            {t("settings.model")}
            <input value={lmStudioModel} onChange={(event) => setLmStudioModel(event.target.value)} />
          </label>
          <label>
            {t("settings.maxToolRounds")}
            <input
              min="1"
              onChange={(event) => setLmStudioMaxToolRounds(event.target.value)}
              required
              type="number"
              value={lmStudioMaxToolRounds}
            />
          </label>
          <label>
            {t("settings.temperature")}
            <input
              onChange={(event) => setLmStudioTemperature(event.target.value)}
              step="0.1"
              type="number"
              value={lmStudioTemperature}
            />
          </label>
        </fieldset>
        <button className="primary-button" disabled={isSaving} type="submit">
          <Save size={16} />
          {t("actions.save")}
        </button>
        </form>
        <dl className="repository-facts">
        <div>
          <dt>{t("settings.server")}</dt>
          <dd>
            {settings ? `${settings.runtime.server.host}:${settings.runtime.server.port}` : "-"}
          </dd>
        </div>
        <div>
          <dt>{t("settings.database")}</dt>
          <dd>{settings?.runtime.database.url ?? "-"}</dd>
        </div>
        <div>
          <dt>{t("settings.provider")}</dt>
          <dd>{settings ? aiProviderLabel(settings.ai.provider) : "-"}</dd>
        </div>
        <div>
          <dt>{t("settings.codexCommand")}</dt>
          <dd>{settings?.ai.codex.command ?? "-"}</dd>
        </div>
        <div>
          <dt>{t("settings.model")}</dt>
          <dd>{settings?.ai.codex.model ?? "-"}</dd>
        </div>
        <div>
          <dt>{t("settings.fullAccess")}</dt>
          <dd>{settings?.ai.codex.fullAccess ? t("status.ready") : "-"}</dd>
        </div>
        </dl>
      </>
      ) : null}
    </section>
  );
}

function ProjectSelector(props: {
  repositories: KnownRepositoryDto[];
  onAddProject: () => void;
  onSelect: (repository: KnownRepositoryDto) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [openingRepoPath, setOpeningRepoPath] = useState<string | null>(null);

  async function openRepository(repository: KnownRepositoryDto) {
    setError(null);
    setOpeningRepoPath(repository.repoPath);
    try {
      await props.onSelect(repository);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open repository.");
    } finally {
      setOpeningRepoPath(null);
    }
  }

  return (
    <main className="setup-screen">
      <section className="setup-panel project-selector">
        <h1>{t("projects.title")}</h1>
        <p className="muted-text">{t("projects.subtitle")}</p>
        {error ? <div className="error-banner">{error}</div> : null}
        <div className="work-item-list">
          {props.repositories.length === 0 ? <div className="empty-state">{t("projects.noProjects")}</div> : null}
          {props.repositories.map((repository) => (
            <button
              className="work-item-summary project-summary"
              disabled={openingRepoPath !== null}
              key={repository.repoPath}
              onClick={() => void openRepository(repository)}
              type="button"
            >
              <span className="work-item-title">{repository.name}</span>
              <span className="project-repo-path">{repository.repoPath}</span>
              <span className="project-opened-at">{formatDateTime(repository.lastOpenedAt)}</span>
              <span className="project-open-action">
                {openingRepoPath === repository.repoPath ? t("status.running") : t("projects.openProject")}
              </span>
            </button>
          ))}
        </div>
        <button className="primary-button" disabled={openingRepoPath !== null} onClick={props.onAddProject} type="button">
          <FolderOpen size={16} />
          {t("projects.addProject")}
        </button>
      </section>
    </main>
  );
}

export function App() {
  const [repositories, setRepositories] = useState<KnownRepositoryDto[]>([]);
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [screen, setScreen] = useState<"select" | "setup" | "app">("select");
  const [isLoading, setLoading] = useState(true);
  const [agentJobs, setAgentJobs] = useState<AgentJobDto[]>([]);
  const [route, setRoute] = useState<AppRoute>(() => parseRoute());
  const project = useMemo(() => projects[0] ?? null, [projects]);
  const view = viewForRoute(route);
  const routeIssueId = route.name === "issue" ? route.issueId : null;
  const routeAgentJobId = route.name === "agentJob" ? route.jobId : null;
  const routePullRequestId = route.name === "pullRequest" || route.name === "pullRequestConflicts" ? route.pullRequestId : null;
  const routePullRequestScreen =
    route.name === "pullRequestConflicts" ? "conflicts" : route.name === "pullRequest" ? "detail" : null;

  const navigate = useCallback((nextRoute: AppRoute, mode: "push" | "replace" = "push") => {
    const path = routeToPath(nextRoute);
    setRoute(nextRoute);
    if (window.location.pathname === path) {
      return;
    }
    if (mode === "replace") {
      window.history.replaceState(null, "", path);
      return;
    }
    window.history.pushState(null, "", path);
  }, []);
  const handleViewChange = useCallback((nextView: View) => navigate(listRouteForView(nextView)), [navigate]);
  const handleOpenIssues = useCallback(() => navigate({ name: "issues" }), [navigate]);
  const handleOpenIssue = useCallback((issueId: number) => navigate({ name: "issue", issueId }), [navigate]);
  const handleOpenAgentJob = useCallback((jobId: number) => navigate({ name: "agentJob", jobId }), [navigate]);
  const handleOpenPullRequests = useCallback(() => navigate({ name: "pullRequests" }), [navigate]);
  const handleOpenPullRequest = useCallback(
    (pullRequestId: number) => navigate({ name: "pullRequest", pullRequestId }),
    [navigate]
  );
  const handleOpenPullRequestConflicts = useCallback(
    (pullRequestId: number) => navigate({ name: "pullRequestConflicts", pullRequestId }),
    [navigate]
  );
  const refreshRepositories = useCallback(async () => {
    setRepositories(await api.listRepositories());
  }, []);
  const handleSelectRepository = useCallback(
    async (repository: KnownRepositoryDto) => {
      const response = await api.switchRepository({ repoPath: repository.repoPath, name: repository.name });
      setProjects(response.projects);
      setAgentJobs([]);
      setScreen(response.projects.length ? "app" : "setup");
      navigate({ name: "issues" }, "replace");
      await refreshRepositories();
    },
    [navigate, refreshRepositories]
  );
  const handleProjectCreated = useCallback(
    async (created: ProjectDto) => {
      setProjects([created]);
      setAgentJobs([]);
      setScreen("app");
      navigate({ name: "issues" }, "replace");
      await refreshRepositories();
    },
    [navigate, refreshRepositories]
  );
  const handleSwitchProject = useCallback(() => {
    setProjects([]);
    setAgentJobs([]);
    setScreen("select");
    navigate({ name: "issues" }, "replace");
    void refreshRepositories();
  }, [navigate, refreshRepositories]);
  const handleProjectLocaleChange = useCallback((locale: SupportedLocale) => {
    setProjects((current) => current.map((item, index) => (index === 0 ? { ...item, locale } : item)));
  }, []);

  if (project) {
    setUiLocale(project.locale);
  }

  useEffect(() => {
    refreshRepositories().finally(() => setLoading(false));
  }, [refreshRepositories]);

  useEffect(() => {
    function handlePopState() {
      setRoute(parseRoute());
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    if (screen === "app" && project && window.location.pathname === "/") {
      navigate({ name: "issues" }, "replace");
    }
  }, [project, navigate, screen]);

  useEffect(() => {
    if (!project || screen !== "app") {
      setAgentJobs([]);
      return;
    }

    let disposed = false;
    async function loadAgentJobs() {
      const jobs = await api.listAgentJobs(project.id);
      if (!disposed) {
        setAgentJobs(jobs);
      }
    }

    void loadAgentJobs().catch(() => {
      if (!disposed) {
        setAgentJobs([]);
      }
    });
    const interval = window.setInterval(() => {
      void loadAgentJobs().catch(() => {
        if (!disposed) {
          setAgentJobs([]);
        }
      });
    }, 3000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [project, screen]);

  if (isLoading) {
    return <div className="loading-screen"><AsyncState kind="loading" message={t("status.loading")} /></div>;
  }

  if (screen === "select") {
    return (
      <ProjectSelector
        onAddProject={() => setScreen("setup")}
        onSelect={handleSelectRepository}
        repositories={repositories}
      />
    );
  }

  if (screen === "setup" || !project) {
    return (
      <SetupWizard
        onCancel={repositories.length ? () => setScreen("select") : undefined}
        onCreated={(created) => {
          void handleProjectCreated(created);
        }}
      />
    );
  }

  return (
    <AppShell
      agentState={summarizeAgentJobs(agentJobs)}
      onSwitchProject={handleSwitchProject}
      onViewChange={handleViewChange}
      projectName={project.name}
      repositoryPath={project.repoPath}
      view={view}
    >
      {view === "issues" ? (
        <IssuesView
          project={project}
          routeIssueId={routeIssueId}
          onOpenIssues={handleOpenIssues}
          onOpenIssue={handleOpenIssue}
          onOpenAgentJob={handleOpenAgentJob}
          onOpenPullRequest={handleOpenPullRequest}
        />
      ) : null}
      {view === "pullRequests" ? (
        <PullRequestsView
          project={project}
          routePullRequestId={routePullRequestId}
          routePullRequestScreen={routePullRequestScreen}
          onOpenPullRequests={handleOpenPullRequests}
          onOpenPullRequest={handleOpenPullRequest}
          onOpenPullRequestConflicts={handleOpenPullRequestConflicts}
          onOpenAgentJob={handleOpenAgentJob}
          onOpenIssue={handleOpenIssue}
        />
      ) : null}
      {view === "agentJobs" ? (
        <AgentJobsView
          project={project}
          routeJobId={routeAgentJobId}
          onOpenAgentJob={handleOpenAgentJob}
        />
      ) : null}
      {view === "repository" ? <RepositoryView project={project} /> : null}
      {view === "settings" ? (
        <SettingsView project={project} onProjectLocaleChange={handleProjectLocaleChange} />
      ) : null}
    </AppShell>
  );
}
