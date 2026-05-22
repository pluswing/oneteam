import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDatabaseContext } from "../server/db/client";
import { runMigrations } from "../server/db/migrations";
import { createRepositories } from "../server/db/repositories";
import { defaultCodexCommand } from "../shared/codex";
import { workflowLabelNames } from "../shared/workflow-labels";

describe("database migrations", () => {
  it("can run repeatedly and seed labels for a project", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneteam-db-"));
    const context = createDatabaseContext(`file:${join(dir, "test.db")}`);

    await runMigrations(context.client);
    await runMigrations(context.client);

    const repos = createRepositories(context.db);
    await repos.settings.set("ai", {
      provider: "codex-cli",
      codexCommand: defaultCodexCommand,
      fullAccess: true
    });
    const aiSettings = await repos.settings.get("ai");
    const project = await repos.projects.create({
      name: "Example",
      repoPath: join(dir, "repo"),
      defaultBranch: "main",
      locale: "en"
    });
    const labels = await repos.labels.list(project.id);
    const reviewLabel = labels.find((label) => label.name === workflowLabelNames.reviewing);
    const pullRequest = await repos.pullRequests.create({
      projectId: project.id,
      title: "Example PR",
      body: "Local pull request",
      sourceBranch: "feature/example",
      targetBranch: "main",
      labelIds: reviewLabel ? [reviewLabel.id] : []
    });
    const job = await repos.agentJobs.create({
      projectId: project.id,
      agentType: "review",
      targetType: "pull_request",
      targetId: pullRequest.id
    });
    const activity = await repos.activities.create({
      projectId: project.id,
      agentJobId: job.id,
      targetType: "pull_request",
      targetId: pullRequest.id,
      activityType: "progress",
      title: "Review queued"
    });

    expect(aiSettings?.codexCommand).toBe(defaultCodexCommand);
    expect(project.id).toMatch(/^project_/);
    expect(labels.map((label) => label.name)).toContain(workflowLabelNames.requirements);
    expect(labels.map((label) => label.name)).toContain(workflowLabelNames.done);
    expect(pullRequest.labels.map((label) => label.name)).toContain(workflowLabelNames.reviewing);
    expect(job.status).toBe("queued");
    expect(activity.title).toBe("Review queued");

    context.client.close();
  });

  it("renames legacy Japanese workflow labels and preserves references", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneteam-db-label-migration-"));
    const context = createDatabaseContext(`file:${join(dir, "test.db")}`);

    await runMigrations(context.client);

    const repos = createRepositories(context.db);
    const project = await repos.projects.create({
      name: "Example",
      repoPath: join(dir, "repo"),
      defaultBranch: "main",
      locale: "en"
    });
    const timestamp = new Date().toISOString();
    await context.client.execute({
      sql: `insert into labels (project_id, name, color, kind, description, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?, ?)`,
      args: [project.id, "レビュー中", "#0969da", "system", "Legacy review label", timestamp, timestamp]
    });
    const legacyLabelRows = await context.client.execute({
      sql: "select id from labels where project_id = ? and name = ?",
      args: [project.id, "レビュー中"]
    });
    const legacyLabelId = Number(legacyLabelRows.rows[0]?.id);
    const pullRequest = await repos.pullRequests.create({
      projectId: project.id,
      title: "Example PR",
      body: "Local pull request",
      sourceBranch: "feature/example",
      targetBranch: "main",
      labelIds: [legacyLabelId]
    });

    await context.client.execute({
      sql: "delete from schema_migrations where id = ?",
      args: ["0003_english_system_labels"]
    });
    await runMigrations(context.client);

    const labels = await repos.labels.list(project.id);
    const updatedPullRequest = await repos.pullRequests.get(project.id, pullRequest.id);
    const legacyRows = await context.client.execute({
      sql: "select deleted_at from labels where project_id = ? and name = ?",
      args: [project.id, "レビュー中"]
    });

    expect(labels.map((label) => label.name)).toContain(workflowLabelNames.reviewing);
    expect(labels.map((label) => label.name)).not.toContain("レビュー中");
    expect(updatedPullRequest?.labels.map((label) => label.name)).toContain(workflowLabelNames.reviewing);
    expect(legacyRows.rows[0]?.deleted_at).toBeTruthy();

    context.client.close();
  });
});
