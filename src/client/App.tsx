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
  RotateCcw,
  Save,
  Settings,
  Square,
  Terminal
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import type {
  ActivityDto,
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
import logoMarkUrl from "./assets/logo.svg";
import oneTeamLogoUrl from "./assets/oneteam.svg";
import { t } from "./i18n";

type View = "issues" | "pullRequests" | "agentJobs" | "repository" | "settings";
const activeAgentStatuses = new Set<AgentJobDto["status"]>(["queued", "running", "waiting_human"]);
const retryableAgentStatuses = new Set<AgentJobDto["status"]>(["failed", "canceled"]);
const issueWorkflowLabelNames = new Set<string>(issueWorkflowLabels);
const pullRequestWorkflowLabelNames = new Set<string>(pullRequestWorkflowLabels);
type AgentHeaderStatus = "ready" | "queued" | "running" | "waiting" | "failed";
type AgentHeaderState = {
  status: AgentHeaderStatus;
  label: string;
  count: number;
  title: string;
};

function isActiveAgentJob(job: AgentJobDto): boolean {
  return activeAgentStatuses.has(job.status);
}

function canRetryAgentJob(job: AgentJobDto): boolean {
  return retryableAgentStatuses.has(job.status);
}

function formatJobTarget(job: AgentJobDto): string {
  return job.targetType === "project" ? "project" : `${job.targetType} #${job.targetId}`;
}

function summarizeAgentJobs(jobs: AgentJobDto[]): AgentHeaderState {
  const runningJobs = jobs.filter((job) => job.status === "running");
  if (runningJobs.length) {
    return agentHeaderState("running", t("status.running"), runningJobs);
  }

  const waitingJobs = jobs.filter((job) => job.status === "waiting_human");
  if (waitingJobs.length) {
    return agentHeaderState("waiting", t("status.waiting"), waitingJobs);
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

function formatDateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "-";
}

function formatPullRequestStatus(status: PullRequestDto["status"]): string {
  if (status === "open") {
    return t("pullRequests.open");
  }
  if (status === "merged") {
    return t("pullRequests.merged");
  }
  return t("pullRequests.closed");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function recordArrayValue(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function labelsForTarget(labels: LabelDto[], targetType: "issue" | "pull_request"): LabelDto[] {
  const workflowLabels = targetType === "issue" ? issueWorkflowLabelNames : pullRequestWorkflowLabelNames;
  return labels.filter((label) => label.kind === "custom" || workflowLabels.has(label.name));
}

function MarkdownContent(props: { content: string; className?: string }) {
  return (
    <div className={["markdown-body", props.className].filter(Boolean).join(" ")}>
      <ReactMarkdown>{props.content}</ReactMarkdown>
    </div>
  );
}

function AppShell(props: {
  project: ProjectDto;
  view: View;
  onViewChange: (view: View) => void;
  agentState: AgentHeaderState;
  children: React.ReactNode;
}) {
  const [isSettingsMenuOpen, setSettingsMenuOpen] = useState(false);
  const settingsMenuRef = useRef<HTMLDivElement | null>(null);
  const nav = [
    { view: "issues" as const, label: t("nav.issues"), icon: ListTodo },
    { view: "pullRequests" as const, label: t("nav.pullRequests"), icon: GitPullRequest },
    { view: "agentJobs" as const, label: t("nav.agentJobs"), icon: Bot }
  ];
  const settingsNav = [
    { view: "repository" as const, label: t("nav.repository"), icon: Terminal },
    { view: "settings" as const, label: t("nav.settings"), icon: Settings }
  ];

  useEffect(() => {
    if (!isSettingsMenuOpen) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && settingsMenuRef.current?.contains(target)) {
        return;
      }
      setSettingsMenuOpen(false);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [isSettingsMenuOpen]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="header-logo" aria-hidden="true">
          <img src={logoMarkUrl} alt="" />
        </div>
        <nav className="nav-tabs" aria-label="Primary">
          {nav.map((item) => {
            const Icon = item.icon;
            return (
              <button
                className={props.view === item.view ? "nav-tab active" : "nav-tab"}
                key={item.view}
                onClick={() => props.onViewChange(item.view)}
                type="button"
              >
                <Icon size={16} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className={`agent-state agent-state-${props.agentState.status}`} title={props.agentState.title}>
          {props.agentState.status === "ready" ? <CheckCircle2 size={16} /> : null}
          {props.agentState.status === "running" ? <RotateCcw size={16} /> : null}
          {props.agentState.status === "queued" ? <Bot size={16} /> : null}
          {props.agentState.status === "waiting" || props.agentState.status === "failed" ? <CircleAlert size={16} /> : null}
          {props.agentState.label}
        </div>
        <div className="settings-menu" ref={settingsMenuRef}>
          <button
            aria-expanded={isSettingsMenuOpen}
            aria-haspopup="menu"
            aria-label={t("nav.tools")}
            className={props.view === "repository" || props.view === "settings" ? "settings-menu-button active" : "settings-menu-button"}
            onClick={() => setSettingsMenuOpen((current) => !current)}
            type="button"
          >
            <Settings size={18} />
          </button>
          {isSettingsMenuOpen ? (
            <div className="settings-menu-popover" role="menu">
              {settingsNav.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    className={props.view === item.view ? "settings-menu-item active" : "settings-menu-item"}
                    key={item.view}
                    onClick={() => {
                      props.onViewChange(item.view);
                      setSettingsMenuOpen(false);
                    }}
                    role="menuitem"
                    type="button"
                  >
                    <Icon size={16} />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      </header>
      <main className="main">{props.children}</main>
    </div>
  );
}

function SetupWizard(props: { onCreated: (project: ProjectDto) => void }) {
  const [mode, setMode] = useState<"import" | "create">("import");
  const [name, setName] = useState("one team");
  const [repoPath, setRepoPath] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [codexCommand, setCodexCommand] = useState(defaultCodexCommand);
  const [codexModel, setCodexModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const project = await api.createProject({
        mode,
        name,
        repoPath,
        defaultBranch,
        locale: "en",
        codex: {
          command: codexCommand,
          model: codexModel || undefined,
          fullAccess: true
        }
      });
      props.onCreated(project);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Setup failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="setup-screen">
      <form className="setup-panel" onSubmit={handleSubmit}>
        <div className="setup-logo">
          <img src={oneTeamLogoUrl} alt={t("app.name")} />
        </div>
        <h1>{t("setup.title")}</h1>
        <section className="form-section">
          <h2>{t("setup.repository")}</h2>
          <label>
            {t("setup.mode")}
            <select value={mode} onChange={(event) => setMode(event.target.value as "import" | "create")}>
              <option value="import">{t("setup.importMode")}</option>
              <option value="create">{t("setup.createMode")}</option>
            </select>
          </label>
          <label>
            {t("setup.name")}
            <input value={name} onChange={(event) => setName(event.target.value)} required />
          </label>
          <label>
            {t("setup.path")}
            <input value={repoPath} onChange={(event) => setRepoPath(event.target.value)} required />
          </label>
          <label>
            {t("setup.defaultBranch")}
            <input value={defaultBranch} onChange={(event) => setDefaultBranch(event.target.value)} required />
          </label>
        </section>

        <section className="form-section">
          <h2>{t("setup.codex")}</h2>
          <label>
            {t("setup.command")}
            <input value={codexCommand} onChange={(event) => setCodexCommand(event.target.value)} required />
          </label>
          <label>
            {t("setup.model")}
            <input value={codexModel} onChange={(event) => setCodexModel(event.target.value)} />
          </label>
          <label className="checkbox-label">
            <input checked readOnly type="checkbox" />
            {t("setup.fullAccess")}
          </label>
        </section>

        {error ? <div className="error-banner">{error}</div> : null}
        <button className="primary-button" disabled={isSubmitting} type="submit">
          <Save size={16} />
          {t("setup.createProject")}
        </button>
      </form>
    </main>
  );
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

function ActivityLog(props: { activities: ActivityDto[] }) {
  if (props.activities.length === 0) {
    return <div className="empty-state">{t("issues.noActivity")}</div>;
  }

  return (
    <div className="timeline">
      {props.activities.map((activity) => (
        <article className="timeline-item activity-item" key={activity.id}>
          <header>
            <strong>{activity.activityType}</strong>
            <span>{new Date(activity.createdAt).toLocaleString()}</span>
          </header>
          <h3>{activity.title}</h3>
          {activity.body ? <MarkdownContent content={activity.body} /> : null}
        </article>
      ))}
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
  openIssueId: number | null;
  onOpenIssueHandled: () => void;
  onOpenAgentJob: (jobId: number) => void;
  onOpenPullRequest: (pullRequestId: number) => void;
}) {
  const [screen, setScreen] = useState<IssueScreen>({ name: "list" });

  useEffect(() => {
    if (props.openIssueId === null) {
      return;
    }
    setScreen({ name: "detail", issueId: props.openIssueId });
    props.onOpenIssueHandled();
  }, [props.openIssueId, props.onOpenIssueHandled]);

  if (screen.name === "new") {
    return (
      <IssueNewScreen
        project={props.project}
        onCancel={() => setScreen({ name: "list" })}
        onCreated={(issueId) => setScreen({ name: "detail", issueId })}
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
        onCancel={() => setScreen({ name: "detail", issueId: screen.issueId })}
        onDeleted={() => setScreen({ name: "list" })}
        onSaved={(issueId) => setScreen({ name: "detail", issueId })}
      />
    );
  }

  return (
    <IssuesListScreen
      project={props.project}
      onNew={() => setScreen({ name: "new" })}
      onOpen={(issueId) => setScreen({ name: "detail", issueId })}
    />
  );
}

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

function isNoisyCodexText(text: string): boolean {
  return (
    text.length > 1000 &&
    (text.includes("<html>") || text.includes("codex_core_plugins") || text.includes("codex_core_skills"))
  );
}

function agentJobFailureMessage(activities: ActivityDto[]): string | null {
  const meaningfulError = [...activities]
    .reverse()
    .find((activity) => ["Codex turn failed", "Codex error", "Agent job failed"].includes(activity.title) && activity.body);
  return meaningfulError?.body ?? null;
}

function agentJobMessage(job: AgentJobDto, activities: ActivityDto[]): string | null {
  const output = job.output ?? {};
  if (job.status === "failed") {
    const activityMessage = agentJobFailureMessage(activities);
    if (activityMessage) {
      return activityMessage;
    }
  }

  const outputMessage = stringValue(output.message);
  if (outputMessage && !isNoisyCodexText(outputMessage)) {
    return outputMessage;
  }

  if (job.error && !isNoisyCodexText(job.error)) {
    return job.error;
  }

  return job.status === "failed" ? "Agent job failed. No concise error message was captured." : null;
}

function isRelevantAgentActivity(job: AgentJobDto, activity: ActivityDto): boolean {
  if (activity.title === `${job.agentType} agent started`) {
    return false;
  }

  if (noisyAgentActivityTitles.has(activity.title)) {
    return false;
  }

  return true;
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

function AgentJobsView(props: { project: ProjectDto; openJobId: number | null; onOpenJobHandled: () => void }) {
  const [screen, setScreen] = useState<AgentJobScreen>({ name: "list" });

  useEffect(() => {
    if (props.openJobId === null) {
      return;
    }
    setScreen({ name: "detail", jobId: props.openJobId });
    props.onOpenJobHandled();
  }, [props.openJobId, props.onOpenJobHandled]);

  if (screen.name === "detail") {
    return (
      <AgentJobDetailScreen
        project={props.project}
        jobId={screen.jobId}
        onOpen={(jobId) => setScreen({ name: "detail", jobId })}
      />
    );
  }

  return <AgentJobsListScreen project={props.project} onOpen={(jobId) => setScreen({ name: "detail", jobId })} />;
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
  openPullRequestId: number | null;
  onOpenPullRequestHandled: () => void;
  onOpenAgentJob: (jobId: number) => void;
  onOpenIssue: (issueId: number) => void;
}) {
  const [screen, setScreen] = useState<PullRequestScreen>({ name: "list" });

  useEffect(() => {
    if (props.openPullRequestId === null) {
      return;
    }
    setScreen({ name: "detail", pullRequestId: props.openPullRequestId });
    props.onOpenPullRequestHandled();
  }, [props.openPullRequestId, props.onOpenPullRequestHandled]);

  if (screen.name === "new") {
    return (
      <PullRequestNewScreen
        project={props.project}
        onCancel={() => setScreen({ name: "list" })}
        onCreated={(pullRequestId) => setScreen({ name: "detail", pullRequestId })}
      />
    );
  }

  if (screen.name === "detail") {
    return (
      <PullRequestDetailScreen
        project={props.project}
        pullRequestId={screen.pullRequestId}
        onEdit={(pullRequestId) => setScreen({ name: "edit", pullRequestId })}
        onOpenConflicts={(pullRequestId) => setScreen({ name: "conflicts", pullRequestId })}
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
        onBack={() => setScreen({ name: "detail", pullRequestId: screen.pullRequestId })}
        onOpenAgentJob={props.onOpenAgentJob}
      />
    );
  }

  if (screen.name === "edit") {
    return (
      <PullRequestEditScreen
        project={props.project}
        pullRequestId={screen.pullRequestId}
        onCancel={() => setScreen({ name: "detail", pullRequestId: screen.pullRequestId })}
        onDeleted={() => setScreen({ name: "list" })}
        onSaved={(pullRequestId) => setScreen({ name: "detail", pullRequestId })}
      />
    );
  }

  return (
    <PullRequestsListScreen
      project={props.project}
      onNew={() => setScreen({ name: "new" })}
      onOpen={(pullRequestId) => setScreen({ name: "detail", pullRequestId })}
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
  const [view, setView] = useState<View>("issues");
  const [openIssueId, setOpenIssueId] = useState<number | null>(null);
  const [openAgentJobId, setOpenAgentJobId] = useState<number | null>(null);
  const [openPullRequestId, setOpenPullRequestId] = useState<number | null>(null);
  const project = useMemo(() => projects[0] ?? null, [projects]);
  const handleOpenIssue = useCallback((issueId: number) => {
    setOpenIssueId(issueId);
    setView("issues");
  }, []);
  const handleOpenAgentJob = useCallback((jobId: number) => {
    setOpenAgentJobId(jobId);
    setView("agentJobs");
  }, []);
  const handleOpenPullRequest = useCallback((pullRequestId: number) => {
    setOpenPullRequestId(pullRequestId);
    setView("pullRequests");
  }, []);
  const handleOpenAgentJobHandled = useCallback(() => setOpenAgentJobId(null), []);
  const handleOpenIssueHandled = useCallback(() => setOpenIssueId(null), []);
  const handleOpenPullRequestHandled = useCallback(() => setOpenPullRequestId(null), []);

  useEffect(() => {
    api
      .listProjects()
      .then(setProjects)
      .finally(() => setLoading(false));
  }, []);

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
    <AppShell project={project} view={view} onViewChange={setView} agentState={summarizeAgentJobs(agentJobs)}>
      {view === "issues" ? (
        <IssuesView
          project={project}
          openIssueId={openIssueId}
          onOpenIssueHandled={handleOpenIssueHandled}
          onOpenAgentJob={handleOpenAgentJob}
          onOpenPullRequest={handleOpenPullRequest}
        />
      ) : null}
      {view === "pullRequests" ? (
        <PullRequestsView
          project={project}
          openPullRequestId={openPullRequestId}
          onOpenPullRequestHandled={handleOpenPullRequestHandled}
          onOpenAgentJob={handleOpenAgentJob}
          onOpenIssue={handleOpenIssue}
        />
      ) : null}
      {view === "agentJobs" ? (
        <AgentJobsView
          project={project}
          openJobId={openAgentJobId}
          onOpenJobHandled={handleOpenAgentJobHandled}
        />
      ) : null}
      {view === "repository" ? <RepositoryView project={project} /> : null}
      {view === "settings" ? <SettingsView project={project} /> : null}
    </AppShell>
  );
}
