import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDatabaseContext } from "../server/db/client";
import { runMigrations } from "../server/db/migrations";
import { createRepositories } from "../server/db/repositories";

describe("database migrations", () => {
  it("can run repeatedly and seed labels for a project", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneteam-db-"));
    const context = createDatabaseContext(`file:${join(dir, "test.db")}`);

    await runMigrations(context.client);
    await runMigrations(context.client);

    const repos = createRepositories(context.db);
    const project = await repos.projects.create({
      name: "Example",
      repoPath: join(dir, "repo"),
      defaultBranch: "main",
      locale: "en"
    });
    const labels = await repos.labels.list(project.id);
    const reviewLabel = labels.find((label) => label.name === "レビュー中");
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

    expect(project.id).toMatch(/^project_/);
    expect(labels.map((label) => label.name)).toContain("要件定義中");
    expect(labels.map((label) => label.name)).toContain("完了");
    expect(pullRequest.labels.map((label) => label.name)).toContain("レビュー中");
    expect(job.status).toBe("queued");
    expect(activity.title).toBe("Review queued");

    context.client.close();
  });
});
