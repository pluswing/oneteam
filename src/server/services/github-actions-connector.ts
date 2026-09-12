import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ObjectiveRunDto, ProjectDto, PullRequestDto, TriageItemDto } from "../../shared/types";
import type { AgentEvidenceResult } from "../agents/types";
import type { Repositories } from "../db/repositories";

const execFileAsync = promisify(execFile);
const failedConclusions = new Set([
  "action_required",
  "cancelled",
  "failure",
  "stale",
  "startup_failure",
  "timed_out"
]);

export type GitHubActionsConnectorOptions = {
  enabled: boolean;
  intervalMs: number;
  token: string | null;
  apiBaseUrl: string;
  apiVersion: string;
  repository: string | null;
  requestTimeoutMs?: number;
  fetch?: typeof fetch;
  resolveRepository?: (repoPath: string) => Promise<GitHubRepository>;
  resolveRevision?: (repoPath: string, revision: string) => Promise<string>;
};

export type GitHubRepository = {
  owner: string;
  repo: string;
};

type GitHubWorkflowRun = {
  id: number;
  name: string;
  displayTitle: string;
  runNumber: number;
  runAttempt: number;
  status: string;
  conclusion: string | null;
  headBranch: string;
  headSha: string;
  htmlUrl: string;
  event: string;
  createdAt: string;
  updatedAt: string;
};

type ConnectorSyncResult = {
  evidence: AgentEvidenceResult;
  connectorKey: string;
  connectorRevision: string;
  failure: boolean;
};

export class GitHubActionsConnector {
  private timer: NodeJS.Timeout | null = null;
  private isTicking = false;

  constructor(
    private readonly repos: Repositories,
    private readonly options: GitHubActionsConnectorOptions
  ) {}

  start(): void {
    if (!this.options.enabled || this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.intervalMs);
    void this.tick();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (!this.options.enabled || this.isTicking) return;
    this.isTicking = true;
    try {
      let projects: ProjectDto[];
      try {
        projects = await this.repos.projects.list();
      } catch (error) {
        this.reportUnpersistedFailure("Could not list projects", error);
        return;
      }

      for (const project of projects) {
        try {
          await this.syncProject(project);
        } catch (error) {
          await this.recordConnectorFailure(project, null, error);
        }
      }
    } finally {
      this.isTicking = false;
    }
  }

  private async syncProject(project: ProjectDto): Promise<void> {
    const repository = this.options.repository
      ? parseGitHubRepository(this.options.repository)
      : await (this.options.resolveRepository ?? resolveGitHubRepository)(project.repoPath);
    if (!repository) {
      throw new Error("GitHub repository must use the owner/repository format");
    }

    const pullRequests = await this.repos.pullRequests.list({
      projectId: project.id,
      status: "open",
      limit: 100,
      offset: 0
    });
    for (const pullRequest of pullRequests.items) {
      try {
        await this.syncPullRequest(project, pullRequest, repository);
      } catch (error) {
        await this.recordConnectorFailure(project, pullRequest, error);
      }
    }
  }

  private async syncPullRequest(
    project: ProjectDto,
    pullRequest: PullRequestDto,
    repository: GitHubRepository
  ): Promise<void> {
    const resolveRevision = this.options.resolveRevision ?? resolveGitRevision;
    const [sourceCommit, targetCommit] = await Promise.all([
      resolveRevision(project.repoPath, pullRequest.sourceBranch),
      resolveRevision(project.repoPath, pullRequest.targetBranch)
    ]);
    const runs = await this.listWorkflowRuns(repository, sourceCommit);
    if (!runs.length) return;

    let objective = await this.repos.objectives.findByPullRequest(project.id, pullRequest.id);
    objective ??= await this.repos.objectives.ensureForPullRequest({
      projectId: project.id,
      pullRequestId: pullRequest.id,
      issueId: pullRequest.issueId,
      title: pullRequest.title,
      goal: pullRequest.body
    });

    for (const run of runs) {
      const result = workflowRunEvidence(repository, run, sourceCommit, targetCommit);
      const updated = await this.upsertEvidence(objective, result);
      if (!updated.changed) continue;
      objective = updated.objective;
      await this.recordStatusActivity(project, pullRequest, run, result);
      if (result.failure) {
        await this.recordCiFailure(project, pullRequest, objective, run, result);
      }
    }
  }

  private async listWorkflowRuns(repository: GitHubRepository, headSha: string): Promise<GitHubWorkflowRun[]> {
    const baseUrl = this.options.apiBaseUrl.replace(/\/$/, "");
    const endpoint = new URL(
      `${baseUrl}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/actions/runs`
    );
    endpoint.searchParams.set("head_sha", headSha);
    endpoint.searchParams.set("per_page", "100");
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": this.options.apiVersion,
      "User-Agent": "OneTeam-GitHub-Actions-Connector"
    };
    if (this.options.token) headers.Authorization = `Bearer ${this.options.token}`;

    const response = await (this.options.fetch ?? fetch)(endpoint, {
      headers,
      signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 15_000)
    });
    if (!response.ok) {
      const remaining = response.headers.get("x-ratelimit-remaining");
      const reset = response.headers.get("x-ratelimit-reset");
      const rateLimit = remaining === "0" && reset
        ? `; rate limit resets at ${new Date(Number(reset) * 1000).toISOString()}`
        : "";
      throw new Error(`GitHub Actions API returned ${response.status} ${response.statusText}${rateLimit}`);
    }
    const payload = await response.json() as { workflow_runs?: unknown };
    if (!Array.isArray(payload.workflow_runs)) {
      throw new Error("GitHub Actions API response did not include workflow_runs");
    }
    return payload.workflow_runs.map(parseWorkflowRun).filter((run): run is GitHubWorkflowRun => run !== null);
  }

  private async upsertEvidence(
    objective: ObjectiveRunDto,
    result: ConnectorSyncResult
  ): Promise<{ changed: boolean; objective: ObjectiveRunDto }> {
    const items = evidenceItems(objective.evidence);
    const index = items.findIndex((item) => connectorKey(item) === result.connectorKey);
    if (index >= 0 && connectorRevision(items[index]) === result.connectorRevision) {
      return { changed: false, objective };
    }
    const nextItems = [...items];
    if (index >= 0) nextItems[index] = result.evidence;
    else nextItems.push(result.evidence);
    const updated = await this.repos.objectives.update(objective.projectId, objective.id, {
      evidence: { items: nextItems.slice(-80) }
    });
    if (!updated) throw new Error(`Objective #${objective.id} disappeared while saving CI Evidence`);
    return { changed: true, objective: updated };
  }

  private async recordStatusActivity(
    project: ProjectDto,
    pullRequest: PullRequestDto,
    run: GitHubWorkflowRun,
    result: ConnectorSyncResult
  ): Promise<void> {
    const outcome = normalizedRunStatus(run);
    await this.repos.activities.create({
      projectId: project.id,
      targetType: "pull_request",
      targetId: pullRequest.id,
      activityType: result.failure ? "error" : "test",
      title: `GitHub Actions: ${run.name} — ${outcome}`,
      body: [
        `[Open workflow run #${run.runNumber}](${run.htmlUrl})`,
        "",
        `- Status: \`${run.status}\``,
        `- Conclusion: \`${run.conclusion ?? "pending"}\``,
        `- Source: \`${run.headBranch || pullRequest.sourceBranch}\` at \`${shortCommit(run.headSha)}\``,
        `- Updated: ${run.updatedAt}`
      ].join("\n"),
      payload: {
        connector: "github_actions",
        connectorKey: result.connectorKey,
        connectorRevision: result.connectorRevision,
        workflowRunId: run.id,
        status: outcome,
        url: run.htmlUrl
      }
    });
  }

  private async recordCiFailure(
    project: ProjectDto,
    pullRequest: PullRequestDto,
    objective: ObjectiveRunDto,
    run: GitHubWorkflowRun,
    result: ConnectorSyncResult
  ): Promise<void> {
    const schedulerKey = `${result.connectorKey}:failure:${run.conclusion}`;
    if (await hasTriageKey(this.repos, project.id, schedulerKey)) return;
    await this.repos.triage.create({
      projectId: project.id,
      sourceType: "connector",
      sourceId: objective.id,
      title: `Investigate failed GitHub Actions run: ${run.name}`,
      body: [
        `GitHub Actions reported \`${run.conclusion}\` for local Pull Request [#${pullRequest.id}](/pulls/${pullRequest.id}).`,
        "",
        `- Workflow: [${run.name} #${run.runNumber}](${run.htmlUrl})`,
        `- Attempt: \`${run.runAttempt}\``,
        `- Commit: \`${run.headSha}\``,
        `- Updated: ${run.updatedAt}`,
        "",
        "Inspect the workflow logs and decide whether to retry the run or create a corrective Issue. The Agent Job queue remains unaffected."
      ].join("\n"),
      priority: "high",
      metadata: {
        schedulerKey,
        discovery: "github_actions_failure",
        connector: "github_actions",
        connectorKey: result.connectorKey,
        objectiveRunId: objective.id,
        pullRequestId: pullRequest.id,
        workflowRunId: run.id,
        runAttempt: run.runAttempt,
        conclusion: run.conclusion,
        headSha: run.headSha,
        url: run.htmlUrl
      }
    });
  }

  private async recordConnectorFailure(
    project: ProjectDto,
    pullRequest: PullRequestDto | null,
    error: unknown
  ): Promise<void> {
    const message = errorMessage(error);
    const scope = pullRequest ? `pull-request:${pullRequest.id}` : "project";
    const fingerprint = createHash("sha256").update(`${scope}\n${message}`).digest("hex").slice(0, 16);
    const schedulerKey = `connector:github-actions:error:${scope}:${fingerprint}`;
    try {
      if (await hasTriageKey(this.repos, project.id, schedulerKey)) return;
      await this.repos.triage.create({
        projectId: project.id,
        sourceType: "connector",
        sourceId: pullRequest?.id ?? null,
        title: `GitHub Actions Connector could not sync${pullRequest ? ` PR #${pullRequest.id}` : " the project"}`,
        body: [
          "The optional GitHub Actions Connector failed without changing any Agent Job state.",
          "",
          `- Scope: \`${scope}\``,
          `- Error: ${markdownCode(message)}`,
          "",
          "Check the repository remote, token permissions, API endpoint, and network availability. The next scheduled poll will retry automatically."
        ].join("\n"),
        priority: "normal",
        metadata: {
          schedulerKey,
          discovery: "connector_failure",
          connector: "github_actions",
          scope,
          fingerprint,
          pullRequestId: pullRequest?.id ?? null
        }
      });
      if (pullRequest) {
        await this.repos.activities.create({
          projectId: project.id,
          targetType: "pull_request",
          targetId: pullRequest.id,
          activityType: "error",
          title: "GitHub Actions sync failed",
          body: `The Connector isolated this failure from Agent Jobs and will retry automatically.\n\nError: ${markdownCode(message)}`,
          payload: {
            connector: "github_actions",
            connectorFailureKey: schedulerKey,
            fingerprint
          }
        });
      }
    } catch (persistenceError) {
      this.reportUnpersistedFailure("Could not persist Connector failure", persistenceError);
    }
  }

  private reportUnpersistedFailure(context: string, error: unknown): void {
    console.error(`[github-actions-connector] ${context}: ${errorMessage(error)}`);
  }
}

export function parseGitHubRepository(value: string): GitHubRepository | null {
  const trimmed = value.trim().replace(/\/$/, "").replace(/\.git$/, "");
  const scpMatch = trimmed.match(/^[^@\s]+@[^:\s]+:(.+)$/);
  let path = scpMatch?.[1] ?? trimmed;
  if (!scpMatch && /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) {
    try {
      path = new URL(trimmed).pathname;
    } catch {
      return null;
    }
  }
  const parts = path.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  return owner && repo ? { owner, repo } : null;
}

async function resolveGitHubRepository(repoPath: string): Promise<GitHubRepository> {
  const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd: repoPath });
  const repository = parseGitHubRepository(stdout);
  if (!repository) throw new Error("Could not infer GitHub owner/repository from the origin remote");
  return repository;
}

async function resolveGitRevision(repoPath: string, revision: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`], {
    cwd: repoPath
  });
  const commit = stdout.trim();
  if (!/^[0-9a-f]{40,64}$/i.test(commit)) throw new Error(`Could not resolve Git revision ${revision}`);
  return commit;
}

function parseWorkflowRun(value: unknown): GitHubWorkflowRun | null {
  if (!isRecord(value) || typeof value.id !== "number" || typeof value.status !== "string") return null;
  if (typeof value.head_sha !== "string" || typeof value.html_url !== "string") return null;
  return {
    id: value.id,
    name: stringValue(value.name) ?? "Workflow",
    displayTitle: stringValue(value.display_title) ?? stringValue(value.name) ?? "Workflow run",
    runNumber: numberValue(value.run_number) ?? value.id,
    runAttempt: numberValue(value.run_attempt) ?? 1,
    status: value.status,
    conclusion: stringValue(value.conclusion),
    headBranch: stringValue(value.head_branch) ?? "",
    headSha: value.head_sha,
    htmlUrl: value.html_url,
    event: stringValue(value.event) ?? "unknown",
    createdAt: stringValue(value.created_at) ?? new Date(0).toISOString(),
    updatedAt: stringValue(value.updated_at) ?? stringValue(value.created_at) ?? new Date(0).toISOString()
  };
}

function workflowRunEvidence(
  repository: GitHubRepository,
  run: GitHubWorkflowRun,
  sourceCommit: string,
  targetCommit: string
): ConnectorSyncResult {
  const connectorKey = `github-actions:${repository.owner}/${repository.repo}:${run.id}:${run.runAttempt}`;
  const connectorRevision = `${run.status}:${run.conclusion ?? "pending"}:${run.updatedAt}`;
  const status = normalizedRunStatus(run);
  return {
    connectorKey,
    connectorRevision,
    failure: Boolean(run.conclusion && failedConclusions.has(run.conclusion.toLowerCase())),
    evidence: {
      type: "ci_status",
      title: `GitHub Actions: ${run.name}`,
      summary: `${run.displayTitle} — run #${run.runNumber} is ${status}.`,
      payload: {
        connector: "github_actions",
        connectorKey,
        connectorRevision,
        repository: `${repository.owner}/${repository.repo}`,
        workflowRunId: run.id,
        name: run.name,
        displayTitle: run.displayTitle,
        runNumber: run.runNumber,
        runAttempt: run.runAttempt,
        status,
        workflowStatus: run.status,
        conclusion: run.conclusion,
        event: run.event,
        headBranch: run.headBranch,
        headSha: run.headSha,
        sourceCommit,
        targetCommit,
        url: run.htmlUrl,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        capturedAt: run.updatedAt
      }
    }
  };
}

function normalizedRunStatus(run: GitHubWorkflowRun): string {
  if (run.conclusion) return run.conclusion.toLowerCase();
  return run.status === "completed" ? "unknown" : run.status.toLowerCase();
}

function evidenceItems(value: Record<string, unknown> | null): AgentEvidenceResult[] {
  return Array.isArray(value?.items)
    ? value.items.filter((item): item is AgentEvidenceResult => isRecord(item) && typeof item.type === "string" && typeof item.title === "string")
    : [];
}

function connectorKey(item: AgentEvidenceResult): string | null {
  return isRecord(item.payload) ? stringValue(item.payload.connectorKey) : null;
}

function connectorRevision(item: AgentEvidenceResult): string | null {
  return isRecord(item.payload) ? stringValue(item.payload.connectorRevision) : null;
}

async function hasTriageKey(repos: Repositories, projectId: string, schedulerKey: string): Promise<boolean> {
  const items: TriageItemDto[] = await repos.triage.list(projectId);
  return items.some((item) => item.metadata?.schedulerKey === schedulerKey);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 500) || "Unknown Connector error";
}

function markdownCode(value: string): string {
  return `\`${value.replaceAll("`", "'")}\``;
}

function shortCommit(value: string): string {
  return value.slice(0, 12);
}
