import {
  ArrowLeft,
  Bot,
  CheckCircle2,
  CircleAlert,
  GitPullRequest,
  ListTodo,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Terminal
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type {
  AgentJobDto,
  CommentDto,
  IssueDto,
  LabelDto,
  MergeConflictDto,
  ProjectCommandDto,
  ProjectDto,
  ProjectSettingsDto,
  PullRequestDto,
  RepositoryCommitDto,
  RepositoryFileChangeDto,
  RepositoryStatusDto
} from "../shared/types";
import { defaultCodexCommand } from "../shared/codex";
import {
  issueWorkflowLabelNames as issueWorkflowLabels,
  pullRequestWorkflowLabelNames as pullRequestWorkflowLabels,
  workflowLabelNames
} from "../shared/workflow-labels";
import { api } from "./api";
import { agentJobMessage, isNoisyCodexText } from "./agent-job-message";
import { summarizeAgentJobs } from "./agent-status";
import { AppShell } from "./components/AppShell";
import { MarkdownContent } from "./components/MarkdownContent";
import { SetupWizard } from "./components/SetupWizard";
import { formatDateTime, formatPullRequestStatus } from "./formatters";
import { t } from "./i18n";
import { type AppRoute, type View, listRouteForView, parseRoute, routeToPath, viewForRoute } from "./routes";
import { numberValue, recordValue } from "./value-parsers";
import { AgentJobsView } from "./views/AgentJobsView";

const issueWorkflowLabelNames = new Set<string>(issueWorkflowLabels);
const pullRequestWorkflowLabelNames = new Set<string>(pullRequestWorkflowLabels);

function labelsForTarget(labels: LabelDto[], targetType: "issue" | "pull_request"): LabelDto[] {
  const workflowLabels = targetType === "issue" ? issueWorkflowLabelNames : pullRequestWorkflowLabelNames;
  return labels.filter((label) => label.kind === "custom" || workflowLabels.has(label.name));
}

type ConversationEntry =
  | { kind: "comment"; comment: CommentDto; timestamp: number }
  | { kind: "agent_job"; job: AgentJobDto; comments: CommentDto[]; timestamp: number };

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
  if (!endTimestamp || ["queued", "running", "waiting_human"].includes(job.status)) {
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

function conversationEntries(comments: CommentDto[], agentJobs: AgentJobDto[]): ConversationEntry[] {
  const groups = new Map<number, { job: AgentJobDto; comments: CommentDto[] }>();
  for (const job of agentJobs) {
    groups.set(job.id, { job, comments: [] });
  }

  const groupedCommentIds = new Set<number>();
  for (const comment of comments) {
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
  for (const comment of comments) {
    if (!groupedCommentIds.has(comment.id)) {
      entries.push({ kind: "comment", comment, timestamp: timestampMs(comment.createdAt) });
    }
  }

  return entries.sort((left, right) => left.timestamp - right.timestamp);
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

function ConversationCommentCard(props: { comment: CommentDto; relatedJob?: AgentJobDto }) {
  return (
    <article className="conversation-comment">
      <header>
        <strong>{commentAuthorLabel(props.comment)}</strong>
        <span>{formatDateTime(props.comment.createdAt)}</span>
      </header>
      <MarkdownContent content={readableCommentBody(props.comment, props.relatedJob)} />
    </article>
  );
}

function ConversationAgentJobCard(props: {
  job: AgentJobDto;
  comments: CommentDto[];
  onOpenAgentJob: (jobId: number) => void;
}) {
  const message = props.comments.length ? null : agentJobMessage(props.job, []);

  return (
    <article className="conversation-agent-job">
      <header className="conversation-agent-job-header">
        <div>
          <strong>#{props.job.id} {props.job.agentType}</strong>
          <span>{formatDateTime(props.job.createdAt)}</span>
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
        <MarkdownContent
          className={props.job.status === "failed" ? "job-error" : "agent-job-message"}
          content={message}
        />
      ) : null}
      {props.comments.length ? (
        <div className="conversation-agent-comments">
          {props.comments.map((comment) => (
            <ConversationCommentCard comment={comment} key={comment.id} relatedJob={props.job} />
          ))}
        </div>
      ) : null}
    </article>
  );
}

function ConversationTimeline(props: {
  comments: CommentDto[];
  agentJobs: AgentJobDto[];
  onOpenAgentJob: (jobId: number) => void;
}) {
  const entries = conversationEntries(props.comments, props.agentJobs);
  if (entries.length === 0) {
    return <div className="empty-state">{t("issues.noComments")}</div>;
  }

  return (
    <div className="conversation-timeline">
      {entries.map((entry) =>
        entry.kind === "comment" ? (
          <ConversationCommentCard comment={entry.comment} key={`comment-${entry.comment.id}`} />
        ) : (
          <ConversationAgentJobCard
            comments={entry.comments}
            job={entry.job}
            key={`agent-job-${entry.job.id}`}
            onOpenAgentJob={props.onOpenAgentJob}
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

function DiffPreview(props: { patch: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = props.patch.split("\n");
  const isLarge = lines.length > 120;
  const visiblePatch = isLarge && !expanded ? lines.slice(0, 120).join("\n") : props.patch;

  return (
    <>
      <pre>{visiblePatch}</pre>
      {isLarge ? (
        <div className="diff-actions">
          <span>{lines.length} {t("pullRequests.diffLines")}</span>
          <button className="secondary-button" onClick={() => setExpanded((current) => !current)} type="button">
            {expanded ? t("pullRequests.collapseDiff") : t("pullRequests.showFullDiff")}
          </button>
        </div>
      ) : null}
    </>
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

  async function load() {
    const issueResponse = await api.listIssues(props.project.id);
    setIssues(issueResponse.items);
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
      {error ? <div className="error-banner">{error}</div> : null}
      <div className="work-item-list">
        {issues.length === 0 ? <div className="empty-state">{t("issues.noIssues")}</div> : null}
        {issues.map((issue) => (
          <button className="work-item-summary" key={issue.id} onClick={() => props.onOpen(issue.id)} type="button">
            <span className="work-item-title">#{issue.id} {issue.title}</span>
            <span className={`status-pill status-${issue.status}`}>{issue.status === "open" ? t("issues.open") : t("issues.closed")}</span>
            <span>{issue.commentCount} {t("issues.comments")}</span>
            <span>{formatDateTime(issue.updatedAt)}</span>
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

function IssueDetailScreen(props: {
  project: ProjectDto;
  issueId: number;
  onEdit: (issueId: number) => void;
  onOpenAgentJob: (jobId: number) => void;
  onOpenPullRequest: (pullRequestId: number) => void;
}) {
  const [issue, setIssue] = useState<IssueDto | null>(null);
  const [comments, setComments] = useState<CommentDto[]>([]);
  const [relatedPullRequests, setRelatedPullRequests] = useState<PullRequestDto[]>([]);
  const [relatedAgentJobs, setRelatedAgentJobs] = useState<AgentJobDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isClosing, setClosing] = useState(false);

  async function load() {
    const [issueResponse, commentsResponse, pullRequestResponse, agentJobResponse] = await Promise.all([
      api.getIssue(props.project.id, props.issueId),
      api.listIssueComments(props.project.id, props.issueId),
      api.listPullRequests(props.project.id, { issueId: props.issueId, status: null }),
      api.listAgentJobs(props.project.id, { targetType: "issue", targetId: props.issueId })
    ]);
    setIssue(issueResponse);
    setComments(commentsResponse);
    setRelatedPullRequests(pullRequestResponse.items);
    setRelatedAgentJobs(agentJobResponse);
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

  async function queueAgent(agentType: "requirements" | "implementation") {
    await api.createAgentJob(props.project.id, {
      agentType,
      targetType: "issue",
      targetId: props.issueId,
      triggerType: "manual"
    });
    await load();
  }

  async function closeIssue() {
    if (!issue || issue.status === "closed") {
      return;
    }
    setClosing(true);
    setError(null);
    try {
      const response = await api.updateIssue(props.project.id, issue.id, { status: "closed" });
      setIssue(response.issue);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to close issue.");
    } finally {
      setClosing(false);
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
              <button className="secondary-button" disabled={isClosing} onClick={() => void closeIssue()} type="button">
                <CheckCircle2 size={16} />
                {t("issues.closeIssue")}
              </button>
            ) : null}
            <button className="secondary-button" onClick={() => props.onEdit(issue.id)} type="button">
              <Pencil size={16} />
              {t("actions.edit")}
            </button>
          </div>
        ) : null}
      </div>
      {error ? <div className="error-banner">{error}</div> : null}
      <div className="detail-layout">
        <section className="page-section detail-main">
          {issue?.body ? <MarkdownContent content={issue.body} /> : <div className="empty-state">{t("issues.noDescription")}</div>}
          <h2>{t("issues.conversation")}</h2>
          <IssueRelatedLinks
            onOpenPullRequest={props.onOpenPullRequest}
            pullRequests={relatedPullRequests}
          />
          <ConversationTimeline
            agentJobs={relatedAgentJobs}
            comments={comments}
            onOpenAgentJob={props.onOpenAgentJob}
          />
          <CommentForm onSubmit={addComment} />
        </section>
        <aside className="side-panel detail-sidebar">
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
            <button className="secondary-button" onClick={() => void queueAgent("requirements")} type="button">
              <ListTodo size={16} />
              {t("agents.queueRequirements")}
            </button>
            <button className="secondary-button" onClick={() => void queueAgent("implementation")} type="button">
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
        labelIds: selectedLabelIds
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
  const [status, setStatus] = useState<RepositoryStatusDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const [commandResponse, statusResponse] = await Promise.all([
      api.listCommands(props.project.id),
      api.getRepositoryStatus(props.project.id)
    ]);
    setCommands(commandResponse);
    setStatus(statusResponse);
  }

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : "Failed to load commands."));
  }, [props.project.id]);

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

  async function load() {
    const response = await api.listPullRequests(props.project.id);
    setPullRequests(response.items);
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
      {error ? <div className="error-banner">{error}</div> : null}
      <div className="work-item-list">
        {pullRequests.length === 0 ? <div className="empty-state">{t("pullRequests.noPullRequests")}</div> : null}
        {pullRequests.map((pullRequest) => (
          <button
            className="work-item-summary"
            key={pullRequest.id}
            onClick={() => props.onOpen(pullRequest.id)}
            type="button"
          >
            <span className="work-item-title">#{pullRequest.id} {pullRequest.title}</span>
            <span className={`status-pill status-${pullRequest.status}`}>{formatPullRequestStatus(pullRequest.status)}</span>
            <span>{pullRequest.commentCount} {t("issues.comments")}</span>
            <span>{formatDateTime(pullRequest.updatedAt)}</span>
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
  const [files, setFiles] = useState<RepositoryFileChangeDto[]>([]);
  const [commits, setCommits] = useState<RepositoryCommitDto[]>([]);
  const [mergeConflicts, setMergeConflicts] = useState<MergeConflictDto | null>(null);
  const [tab, setTab] = useState<"conversation" | "files" | "commits">("conversation");
  const [error, setError] = useState<string | null>(null);
  const [mergeMessage, setMergeMessage] = useState<string | null>(null);
  const [isMerging, setMerging] = useState(false);
  const [isResolvingConflicts, setResolvingConflicts] = useState(false);

  async function load() {
    const [pullRequestResponse, commentsResponse, agentJobResponse] = await Promise.all([
      api.getPullRequest(props.project.id, props.pullRequestId),
      api.listPullRequestComments(props.project.id, props.pullRequestId),
      api.listAgentJobs(props.project.id, { targetType: "pull_request", targetId: props.pullRequestId })
    ]);
    const linkedIssuePromise = pullRequestResponse.issueId
      ? api.getIssue(props.project.id, pullRequestResponse.issueId).catch(() => null)
      : Promise.resolve(null);
    const [filesResponse, commitsResponse, conflictsResponse, linkedIssueResponse] = await Promise.all([
      api.listPullRequestFiles(props.project.id, props.pullRequestId),
      api.listPullRequestCommits(props.project.id, props.pullRequestId),
      api.getPullRequestMergeConflicts(props.project.id, props.pullRequestId),
      linkedIssuePromise
    ]);
    setPullRequest(pullRequestResponse);
    setLinkedIssue(linkedIssueResponse);
    setRelatedAgentJobs(agentJobResponse);
    setComments(commentsResponse);
    setFiles(filesResponse);
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

  async function addComment(body: string) {
    await api.createPullRequestComment(props.project.id, props.pullRequestId, body);
    await load();
  }

  async function queueAgent(agentType: "review" | "fix" | "qa") {
    await api.createAgentJob(props.project.id, {
      agentType,
      targetType: "pull_request",
      targetId: props.pullRequestId,
      triggerType: "manual"
    });
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
      {error ? <div className="error-banner">{error}</div> : null}
      <div className="detail-layout">
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
                agentJobs={relatedAgentJobs}
                comments={comments}
                onOpenAgentJob={props.onOpenAgentJob}
              />
              <CommentForm onSubmit={addComment} />
            </>
          ) : null}
          {tab === "files" ? (
            <div className="file-list">
              {files.length === 0 ? <div className="empty-state">{t("pullRequests.noFiles")}</div> : null}
              {files.map((file) => (
                <article className="file-row" key={file.path}>
                  <header>
                    <strong>{file.path}</strong>
                    <span>
                      +{file.additions} -{file.deletions}
                    </span>
                  </header>
                  {file.patch ? <DiffPreview patch={file.patch} /> : null}
                </article>
              ))}
            </div>
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
                    {commit.authorName} - {new Date(commit.date).toLocaleString()}
                  </p>
                </article>
              ))}
            </div>
          ) : null}
        </section>
        <aside className="side-panel detail-sidebar">
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
            <button className="secondary-button" onClick={() => void queueAgent("review")} type="button">
              <GitPullRequest size={16} />
              {t("agents.queueReview")}
            </button>
            <button className="secondary-button" onClick={() => void queueAgent("fix")} type="button">
              <CircleAlert size={16} />
              {t("agents.queueFix")}
            </button>
            <button className="secondary-button" onClick={() => void queueAgent("qa")} type="button">
              <CheckCircle2 size={16} />
              {t("agents.queueQa")}
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

function SettingsView(props: { project: ProjectDto }) {
  const [settings, setSettings] = useState<ProjectSettingsDto | null>(null);
  const [locale, setLocale] = useState(props.project.locale);
  const [codexCommand, setCodexCommand] = useState(defaultCodexCommand);
  const [codexModel, setCodexModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [isSaving, setSaving] = useState(false);

  async function load() {
    const response = await api.getSettings(props.project.id);
    setSettings(response);
    setLocale(response.project.locale);
    setCodexCommand(response.ai.codexCommand);
    setCodexModel(response.ai.model ?? "");
  }

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : "Failed to load settings."));
  }, [props.project.id]);

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setSavedMessage(null);
    try {
      const response = await api.updateSettings(props.project.id, {
        locale,
        codexCommand,
        model: codexModel || undefined
      });
      setSettings(response);
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
      {error ? <div className="error-banner">{error}</div> : null}
      {savedMessage ? <div className="success-banner">{savedMessage}</div> : null}
      <form className="settings-form" onSubmit={saveSettings}>
        <label>
          {t("settings.codexCommand")}
          <input value={codexCommand} onChange={(event) => setCodexCommand(event.target.value)} required />
        </label>
        <label>
          {t("settings.model")}
          <input value={codexModel} onChange={(event) => setCodexModel(event.target.value)} />
        </label>
        <label>
          {t("settings.locale")}
          <input value={locale} onChange={(event) => setLocale(event.target.value)} required />
        </label>
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
          <dt>{t("settings.fullAccess")}</dt>
          <dd>{settings?.ai.fullAccess ? t("status.ready") : "-"}</dd>
        </div>
      </dl>
    </section>
  );
}

export function App() {
  const [projects, setProjects] = useState<ProjectDto[]>([]);
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

  useEffect(() => {
    api
      .listProjects()
      .then(setProjects)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    function handlePopState() {
      setRoute(parseRoute());
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    if (project && window.location.pathname === "/") {
      navigate({ name: "issues" }, "replace");
    }
  }, [project, navigate]);

  useEffect(() => {
    if (!project) {
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
  }, [project]);

  if (isLoading) {
    return <div className="loading-screen">{t("status.running")}</div>;
  }

  if (!project) {
    return <SetupWizard onCreated={(created) => setProjects([created])} />;
  }

  return (
    <AppShell view={view} onViewChange={handleViewChange} agentState={summarizeAgentJobs(agentJobs)}>
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
      {view === "settings" ? <SettingsView project={project} /> : null}
    </AppShell>
  );
}
