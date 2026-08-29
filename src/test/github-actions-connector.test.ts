import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDatabaseContext } from "../server/db/client";
import { runMigrations } from "../server/db/migrations";
import { createRepositories } from "../server/db/repositories";
import {
  GitHubActionsConnector,
  parseGitHubRepository,
  type GitHubActionsConnectorOptions
} from "../server/services/github-actions-connector";

describe("GitHub Actions Connector", () => {
  it("parses configured, HTTPS, SSH URL, and SCP-style repository references", () => {
    expect(parseGitHubRepository("pluswing/oneteam")).toEqual({ owner: "pluswing", repo: "oneteam" });
    expect(parseGitHubRepository("https://github.com/pluswing/oneteam.git")).toEqual({
      owner: "pluswing",
      repo: "oneteam"
    });
    expect(parseGitHubRepository("ssh://git@github.example.com/pluswing/oneteam.git")).toEqual({
      owner: "pluswing",
      repo: "oneteam"
    });
    expect(parseGitHubRepository("git@github-alias:pluswing/oneteam.git")).toEqual({
      owner: "pluswing",
      repo: "oneteam"
    });
    expect(parseGitHubRepository("not-a-repository")).toBeNull();
  });

  it("upserts workflow status Evidence and creates a deduplicated failure Triage and PR Activity", async () => {
    const fixture = await createFixture();
    let state = workflowRun("failure", "2026-08-29T01:00:00.000Z");
    const requests: Array<{ url: string; headers: Headers }> = [];
    const connector = new GitHubActionsConnector(fixture.repos, connectorOptions({
      fetch: async (input, init) => {
        requests.push({ url: String(input), headers: new Headers(init?.headers) });
        return Response.json({ total_count: 1, workflow_runs: [state] });
      }
    }));

    await connector.tick();
    const firstObjective = await fixture.repos.objectives.findByPullRequest(fixture.project.id, fixture.pullRequest.id);
    const firstEvidence = evidenceItems(firstObjective?.evidence ?? null);
    expect(firstEvidence).toHaveLength(1);
    expect(firstEvidence[0]).toMatchObject({
      type: "ci_status",
      payload: {
        status: "failure",
        conclusion: "failure",
        sourceCommit: "source-commit",
        targetCommit: "target-commit"
      }
    });
    expect(requests[0]?.url).toContain("head_sha=source-commit");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer test-token");
    expect(requests[0]?.headers.get("x-github-api-version")).toBe("2026-03-10");
    expect((await fixture.repos.triage.list(fixture.project.id)).map((item) => item.metadata?.discovery)).toEqual([
      "github_actions_failure"
    ]);
    await expect(fixture.repos.activities.list(
      fixture.project.id,
      "pull_request",
      fixture.pullRequest.id
    )).resolves.toHaveLength(1);
    await expect(fixture.repos.agentJobs.list({ projectId: fixture.project.id })).resolves.toHaveLength(0);

    await connector.tick();
    expect(evidenceItems((await fixture.repos.objectives.findByPullRequest(
      fixture.project.id,
      fixture.pullRequest.id
    ))?.evidence ?? null)).toHaveLength(1);
    await expect(fixture.repos.triage.list(fixture.project.id)).resolves.toHaveLength(1);
    await expect(fixture.repos.activities.list(
      fixture.project.id,
      "pull_request",
      fixture.pullRequest.id
    )).resolves.toHaveLength(1);

    state = workflowRun("success", "2026-08-29T01:05:00.000Z");
    await connector.tick();
    const recoveredEvidence = evidenceItems((await fixture.repos.objectives.findByPullRequest(
      fixture.project.id,
      fixture.pullRequest.id
    ))?.evidence ?? null);
    expect(recoveredEvidence).toHaveLength(1);
    expect(recoveredEvidence[0]?.payload).toMatchObject({ status: "success", conclusion: "success" });
    await expect(fixture.repos.activities.list(
      fixture.project.id,
      "pull_request",
      fixture.pullRequest.id
    )).resolves.toHaveLength(2);
    await expect(fixture.repos.triage.list(fixture.project.id)).resolves.toHaveLength(1);
    fixture.context.client.close();
  });

  it("isolates Connector errors from Agent Jobs and deduplicates retry diagnostics", async () => {
    const fixture = await createFixture();
    const connector = new GitHubActionsConnector(fixture.repos, connectorOptions({
      fetch: async () => {
        throw new Error("network unavailable");
      }
    }));

    await connector.tick();
    await connector.tick();

    const triage = await fixture.repos.triage.list(fixture.project.id);
    expect(triage).toHaveLength(1);
    expect(triage[0]).toMatchObject({
      sourceType: "connector",
      metadata: {
        discovery: "connector_failure",
        connector: "github_actions",
        pullRequestId: fixture.pullRequest.id
      }
    });
    expect(triage[0]?.body).toContain("without changing any Agent Job state");
    await expect(fixture.repos.activities.list(
      fixture.project.id,
      "pull_request",
      fixture.pullRequest.id
    )).resolves.toHaveLength(1);
    await expect(fixture.repos.agentJobs.list({ projectId: fixture.project.id })).resolves.toHaveLength(0);
    fixture.context.client.close();
  });
});

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "oneteam-github-actions-"));
  const context = createDatabaseContext(`file:${join(directory, "test.db")}`);
  await runMigrations(context.client);
  const repos = createRepositories(context.db);
  const project = await repos.projects.create({
    name: "Connector test",
    repoPath: directory,
    defaultBranch: "main"
  });
  const issue = await repos.issues.create({ projectId: project.id, title: "Sync CI" });
  const pullRequest = await repos.pullRequests.create({
    projectId: project.id,
    issueId: issue.id,
    title: "Sync CI status",
    sourceBranch: "feature/ci",
    targetBranch: "main"
  });
  return { context, repos, project, issue, pullRequest };
}

function connectorOptions(overrides: Partial<GitHubActionsConnectorOptions>): GitHubActionsConnectorOptions {
  return {
    enabled: true,
    intervalMs: 60_000,
    token: "test-token",
    apiBaseUrl: "https://api.github.test",
    apiVersion: "2026-03-10",
    repository: "pluswing/oneteam",
    resolveRevision: async (_repoPath, revision) => revision === "main" ? "target-commit" : "source-commit",
    ...overrides
  };
}

function workflowRun(conclusion: "failure" | "success", updatedAt: string) {
  return {
    id: 98765,
    name: "CI",
    display_title: "Run project checks",
    run_number: 42,
    run_attempt: 1,
    status: "completed",
    conclusion,
    head_branch: "feature/ci",
    head_sha: "source-commit",
    html_url: "https://github.test/pluswing/oneteam/actions/runs/98765",
    event: "pull_request",
    created_at: "2026-08-29T00:55:00.000Z",
    updated_at: updatedAt
  };
}

function evidenceItems(evidence: Record<string, unknown> | null): Array<Record<string, unknown>> {
  return Array.isArray(evidence?.items)
    ? evidence.items.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    : [];
}
