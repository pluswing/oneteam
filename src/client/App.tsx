import { CheckCircle2, CircleAlert, GitPullRequest, ListTodo, RefreshCw, Save, Settings, Terminal } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import type {
  ActivityDto,
  AgentJobDto,
  CommentDto,
  IssueDto,
  LabelDto,
  ProjectCommandDto,
  ProjectDto,
  PullRequestDto,
  RepositoryFileChangeDto,
  RepositoryStatusDto
} from "../shared/types";
import { defaultCodexCommand } from "../shared/codex";
import { api } from "./api";
import { t } from "./i18n";

type View = "issues" | "pullRequests" | "repository" | "settings";

function AppShell(props: {
  project: ProjectDto;
  view: View;
  onViewChange: (view: View) => void;
  children: React.ReactNode;
}) {
  const nav = [
    { view: "issues" as const, label: t("nav.issues"), icon: ListTodo },
    { view: "pullRequests" as const, label: t("nav.pullRequests"), icon: GitPullRequest },
    { view: "repository" as const, label: t("nav.repository"), icon: Terminal },
    { view: "settings" as const, label: t("nav.settings"), icon: Settings }
  ];

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">{t("app.name")}</div>
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
        <div className="agent-state">
          <CheckCircle2 size={16} />
          {t("status.ready")}
        </div>
      </header>
      <div className="projectbar">
        <span>{props.project.name}</span>
        <span>{props.project.defaultBranch}</span>
        <span>{props.project.repoPath}</span>
      </div>
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

function Timeline(props: { comments: CommentDto[] }) {
  if (props.comments.length === 0) {
    return <div className="empty-state">{t("issues.noComments")}</div>;
  }

  return (
    <div className="timeline">
      {props.comments.map((comment) => (
        <article className="timeline-item" key={comment.id}>
          <header>
            <strong>{comment.authorType}</strong>
            <span>{new Date(comment.createdAt).toLocaleString()}</span>
          </header>
          <p>{comment.body}</p>
        </article>
      ))}
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
          {activity.body ? <p>{activity.body}</p> : null}
        </article>
      ))}
    </div>
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

function IssueDetailPanel(props: { project: ProjectDto; issueId: number; onClose: () => void }) {
  const [issue, setIssue] = useState<IssueDto | null>(null);
  const [comments, setComments] = useState<CommentDto[]>([]);
  const [activities, setActivities] = useState<ActivityDto[]>([]);
  const [tab, setTab] = useState<"conversation" | "activity">("conversation");
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const [issueResponse, commentsResponse, activitiesResponse] = await Promise.all([
      api.getIssue(props.project.id, props.issueId),
      api.listIssueComments(props.project.id, props.issueId),
      api.listIssueActivities(props.project.id, props.issueId)
    ]);
    setIssue(issueResponse);
    setComments(commentsResponse);
    setActivities(activitiesResponse);
  }

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : "Failed to load issue."));
  }, [props.project.id, props.issueId]);

  async function addComment(body: string) {
    const comment = await api.createIssueComment(props.project.id, props.issueId, body);
    setComments((current) => [...current, comment]);
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

  return (
    <aside className="detail-panel">
      <div className="section-header">
        <h2>{issue ? `#${issue.id} ${issue.title}` : "Issue"}</h2>
        <button className="secondary-button" onClick={props.onClose} type="button">
          {t("actions.close")}
        </button>
      </div>
      {error ? <div className="error-banner">{error}</div> : null}
      {issue ? <p className="detail-body">{issue.body}</p> : null}
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
      <div className="subtabs">
        <button className={tab === "conversation" ? "active" : ""} onClick={() => setTab("conversation")} type="button">
          {t("issues.conversation")}
        </button>
        <button className={tab === "activity" ? "active" : ""} onClick={() => setTab("activity")} type="button">
          {t("issues.activity")}
        </button>
      </div>
      {tab === "conversation" ? (
        <>
          <Timeline comments={comments} />
          <CommentForm onSubmit={addComment} />
        </>
      ) : (
        <ActivityLog activities={activities} />
      )}
    </aside>
  );
}

function IssuesView(props: { project: ProjectDto }) {
  const [issues, setIssues] = useState<IssueDto[]>([]);
  const [labels, setLabels] = useState<LabelDto[]>([]);
  const [selectedIssueId, setSelectedIssueId] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const [issueResponse, labelResponse] = await Promise.all([
      api.listIssues(props.project.id),
      api.listLabels(props.project.id)
    ]);
    setIssues(issueResponse.items);
    setLabels(labelResponse);
  }

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : "Failed to load issues."));
  }, [props.project.id]);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const requirementsLabel = labels.find((label) => label.name === "要件定義中");
    const issue = await api.createIssue(props.project.id, {
      title,
      body,
      labelIds: requirementsLabel ? [requirementsLabel.id] : []
    });
    setIssues((current) => [issue, ...current]);
    setTitle("");
    setBody("");
  }

  return (
    <div className="page-grid">
      <section className="page-section">
        <div className="section-header">
          <h1>{t("issues.title")}</h1>
          <button className="icon-button" onClick={() => void load()} type="button" title={t("actions.refresh")}>
            <RefreshCw size={16} />
          </button>
        </div>
        {error ? <div className="error-banner">{error}</div> : null}
        <div className="issue-list">
          {issues.length === 0 ? <div className="empty-state">{t("issues.noIssues")}</div> : null}
          {issues.map((issue) => (
            <article className="issue-row clickable" key={issue.id} onClick={() => setSelectedIssueId(issue.id)}>
              <div>
                <h2>#{issue.id} {issue.title}</h2>
                <p>{issue.body || "\u00a0"}</p>
                <div className="label-row">
                  {issue.labels.map((label) => (
                    <span className="label-pill" key={label.id} style={{ borderColor: label.color }}>
                      {label.name}
                    </span>
                  ))}
                </div>
              </div>
              <div className="row-meta">
                <span>{issue.status === "open" ? t("issues.open") : t("issues.closed")}</span>
                <span>{issue.commentCount} {t("issues.comments")}</span>
              </div>
            </article>
          ))}
        </div>
      </section>

      <aside className="side-panel">
        <h2>{t("issues.newIssue")}</h2>
        <form onSubmit={handleCreate}>
          <label>
            {t("issues.titleField")}
            <input value={title} onChange={(event) => setTitle(event.target.value)} required />
          </label>
          <label>
            {t("issues.bodyField")}
            <textarea value={body} onChange={(event) => setBody(event.target.value)} rows={8} />
          </label>
          <button className="primary-button" type="submit">
            <Save size={16} />
            {t("actions.create")}
          </button>
        </form>
      </aside>
      {selectedIssueId ? (
        <IssueDetailPanel project={props.project} issueId={selectedIssueId} onClose={() => setSelectedIssueId(null)} />
      ) : null}
    </div>
  );
}

function AgentJobsPanel(props: { project: ProjectDto }) {
  const [jobs, setJobs] = useState<AgentJobDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setJobs(await api.listAgentJobs(props.project.id));
  }

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : "Failed to load agent jobs."));
  }, [props.project.id]);

  async function queueRequirementsJob() {
    await api.createAgentJob(props.project.id, {
      agentType: "requirements",
      targetType: "project",
      targetId: 0,
      triggerType: "manual"
    });
    await load();
  }

  return (
    <aside className="side-panel">
      <div className="section-header compact">
        <h2>{t("agents.title")}</h2>
        <button className="icon-button" onClick={() => void load()} title={t("actions.refresh")} type="button">
          <RefreshCw size={16} />
        </button>
      </div>
      {error ? <div className="error-banner">{error}</div> : null}
      <button className="secondary-button full-width" onClick={() => void queueRequirementsJob()} type="button">
        <ListTodo size={16} />
        {t("agents.queueRequirements")}
      </button>
      <div className="job-list">
        {jobs.length === 0 ? <div className="empty-state">{t("agents.noJobs")}</div> : null}
        {jobs.map((job) => (
          <article className="job-row" key={job.id}>
            <strong>#{job.id} {job.agentType}</strong>
            <span>{job.status}</span>
            <span>{job.targetType} #{job.targetId}</span>
          </article>
        ))}
      </div>
    </aside>
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

function PullRequestDetailPanel(props: { project: ProjectDto; pullRequestId: number; onClose: () => void }) {
  const [pullRequest, setPullRequest] = useState<PullRequestDto | null>(null);
  const [comments, setComments] = useState<CommentDto[]>([]);
  const [activities, setActivities] = useState<ActivityDto[]>([]);
  const [files, setFiles] = useState<RepositoryFileChangeDto[]>([]);
  const [tab, setTab] = useState<"conversation" | "activity" | "files">("conversation");
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const [pullRequestResponse, commentsResponse, activitiesResponse, filesResponse] = await Promise.all([
      api.getPullRequest(props.project.id, props.pullRequestId),
      api.listPullRequestComments(props.project.id, props.pullRequestId),
      api.listPullRequestActivities(props.project.id, props.pullRequestId),
      api.listPullRequestFiles(props.project.id, props.pullRequestId)
    ]);
    setPullRequest(pullRequestResponse);
    setComments(commentsResponse);
    setActivities(activitiesResponse);
    setFiles(filesResponse);
  }

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : "Failed to load pull request."));
  }, [props.project.id, props.pullRequestId]);

  async function addComment(body: string) {
    const comment = await api.createPullRequestComment(props.project.id, props.pullRequestId, body);
    setComments((current) => [...current, comment]);
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

  return (
    <aside className="detail-panel">
      <div className="section-header">
        <h2>{pullRequest ? `#${pullRequest.id} ${pullRequest.title}` : "Pull request"}</h2>
        <button className="secondary-button" onClick={props.onClose} type="button">
          {t("actions.close")}
        </button>
      </div>
      {error ? <div className="error-banner">{error}</div> : null}
      {pullRequest ? (
        <p className="detail-body">
          {pullRequest.sourceBranch} -&gt; {pullRequest.targetBranch}
        </p>
      ) : null}
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
      <div className="subtabs">
        <button className={tab === "conversation" ? "active" : ""} onClick={() => setTab("conversation")} type="button">
          {t("issues.conversation")}
        </button>
        <button className={tab === "activity" ? "active" : ""} onClick={() => setTab("activity")} type="button">
          {t("issues.activity")}
        </button>
        <button className={tab === "files" ? "active" : ""} onClick={() => setTab("files")} type="button">
          {t("pullRequests.filesChanged")}
        </button>
      </div>
      {tab === "conversation" ? (
        <>
          <Timeline comments={comments} />
          <CommentForm onSubmit={addComment} />
        </>
      ) : null}
      {tab === "activity" ? <ActivityLog activities={activities} /> : null}
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
              {file.patch ? <pre>{file.patch}</pre> : null}
            </article>
          ))}
        </div>
      ) : null}
    </aside>
  );
}

function PullRequestsView(props: { project: ProjectDto }) {
  const [pullRequests, setPullRequests] = useState<PullRequestDto[]>([]);
  const [selectedPullRequestId, setSelectedPullRequestId] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [sourceBranch, setSourceBranch] = useState("");
  const [targetBranch, setTargetBranch] = useState(props.project.defaultBranch);
  const [issueId, setIssueId] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const response = await api.listPullRequests(props.project.id);
    setPullRequests(response.items);
  }

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : "Failed to load pull requests."));
  }, [props.project.id]);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const pullRequest = await api.createPullRequest(props.project.id, {
      issueId: issueId ? Number(issueId) : null,
      title,
      body,
      sourceBranch,
      targetBranch
    });
    setPullRequests((current) => [pullRequest, ...current]);
    setTitle("");
    setBody("");
    setSourceBranch("");
    setIssueId("");
  }

  return (
    <div className="page-grid">
      <section className="page-section">
        <div className="section-header">
          <h1>{t("pullRequests.title")}</h1>
          <button className="icon-button" onClick={() => void load()} type="button" title={t("actions.refresh")}>
            <RefreshCw size={16} />
          </button>
        </div>
        {error ? <div className="error-banner">{error}</div> : null}
        <div className="issue-list">
          {pullRequests.length === 0 ? <div className="empty-state">{t("pullRequests.noPullRequests")}</div> : null}
          {pullRequests.map((pullRequest) => (
            <article
              className="issue-row clickable"
              key={pullRequest.id}
              onClick={() => setSelectedPullRequestId(pullRequest.id)}
            >
              <div>
                <h2>#{pullRequest.id} {pullRequest.title}</h2>
                <p>{pullRequest.sourceBranch} -&gt; {pullRequest.targetBranch}</p>
                <div className="label-row">
                  {pullRequest.labels.map((label) => (
                    <span className="label-pill" key={label.id} style={{ borderColor: label.color }}>
                      {label.name}
                    </span>
                  ))}
                </div>
              </div>
              <div className="row-meta">
                <span>{pullRequest.status}</span>
                <span>{pullRequest.commentCount} {t("issues.comments")}</span>
              </div>
            </article>
          ))}
        </div>
      </section>

      <aside className="side-panel">
        <h2>{t("pullRequests.newPullRequest")}</h2>
        <form onSubmit={handleCreate}>
          <label>
            {t("issues.titleField")}
            <input value={title} onChange={(event) => setTitle(event.target.value)} required />
          </label>
          <label>
            {t("issues.bodyField")}
            <textarea value={body} onChange={(event) => setBody(event.target.value)} rows={6} />
          </label>
          <label>
            {t("pullRequests.sourceBranch")}
            <input value={sourceBranch} onChange={(event) => setSourceBranch(event.target.value)} required />
          </label>
          <label>
            {t("pullRequests.targetBranch")}
            <input value={targetBranch} onChange={(event) => setTargetBranch(event.target.value)} required />
          </label>
          <label>
            {t("pullRequests.linkedIssue")}
            <input value={issueId} onChange={(event) => setIssueId(event.target.value)} type="number" />
          </label>
          <button className="primary-button" type="submit">
            <Save size={16} />
            {t("actions.create")}
          </button>
        </form>
      </aside>
      {selectedPullRequestId ? (
        <PullRequestDetailPanel
          project={props.project}
          pullRequestId={selectedPullRequestId}
          onClose={() => setSelectedPullRequestId(null)}
        />
      ) : null}
    </div>
  );
}

function SettingsView(props: { project: ProjectDto }) {
  return (
    <section className="page-section">
      <h1>{t("settings.title")}</h1>
      <dl className="repository-facts">
        <div>
          <dt>{t("settings.locale")}</dt>
          <dd>{props.project.locale}</dd>
        </div>
        <div>
          <dt>{t("settings.database")}</dt>
          <dd>file:./data/oneteam.db</dd>
        </div>
      </dl>
    </section>
  );
}

export function App() {
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [isLoading, setLoading] = useState(true);
  const [view, setView] = useState<View>("issues");
  const project = useMemo(() => projects[0] ?? null, [projects]);

  useEffect(() => {
    api
      .listProjects()
      .then(setProjects)
      .finally(() => setLoading(false));
  }, []);

  if (isLoading) {
    return <div className="loading-screen">{t("status.running")}</div>;
  }

  if (!project) {
    return <SetupWizard onCreated={(created) => setProjects([created])} />;
  }

  return (
    <AppShell project={project} view={view} onViewChange={setView}>
      {view === "issues" ? <IssuesView project={project} /> : null}
      {view === "pullRequests" ? <PullRequestsView project={project} /> : null}
      {view === "repository" ? <RepositoryView project={project} /> : null}
      {view === "settings" ? <SettingsView project={project} /> : null}
      {view === "issues" ? <AgentJobsPanel project={project} /> : null}
    </AppShell>
  );
}
