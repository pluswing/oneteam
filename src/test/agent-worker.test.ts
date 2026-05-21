import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentWorker } from "../server/agents/worker";
import type { AgentAdapter } from "../server/agents/types";
import { createDatabaseContext } from "../server/db/client";
import { runMigrations } from "../server/db/migrations";
import { createRepositories } from "../server/db/repositories";

describe("agent worker", () => {
  it("runs a queued job and persists comments, activities, and label transitions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneteam-worker-"));
    const context = createDatabaseContext(`file:${join(dir, "test.db")}`);
    await runMigrations(context.client);

    const repos = createRepositories(context.db);
    const project = await repos.projects.create({
      name: "Example",
      repoPath: dir,
      defaultBranch: "main",
      locale: "en"
    });
    const issue = await repos.issues.create({
      projectId: project.id,
      title: "Add setup",
      body: "Create a setup wizard."
    });
    await repos.commands.upsertMany(project.id, [
      {
        commandType: "test",
        command: "npm test",
        detectionSource: "manual",
        isRequired: true,
        isAvailable: true
      }
    ]);
    const job = await repos.agentJobs.create({
      projectId: project.id,
      agentType: "requirements",
      targetType: "issue",
      targetId: issue.id
    });

    const fakeAdapter: AgentAdapter = {
      async run(input) {
        await input.onActivity?.({
          type: "thinking",
          title: "Reviewed issue",
          body: "The request is clear enough for implementation."
        });
        return {
          status: "succeeded",
          message: "Requirements are ready.",
          comment: {
            targetType: "issue",
            targetId: issue.id,
            body: "## Requirements\n\nBuild the setup wizard."
          },
          activities: [
            {
              type: "progress",
              title: "Requirements completed"
            }
          ],
          metadata: {
            nextLabel: "実装待ち"
          }
        };
      }
    };

    const worker = new AgentWorker(repos, fakeAdapter, { pollIntervalMs: 1000 });
    await worker.tick();

    const updatedJob = await repos.agentJobs.get(project.id, job.id);
    const comments = await repos.comments.list(project.id, "issue", issue.id);
    const activities = await repos.activities.list(project.id, "issue", issue.id);
    const updatedIssue = await repos.issues.get(project.id, issue.id);

    expect(updatedJob?.status).toBe("succeeded");
    expect(comments[0].body).toContain("Build the setup wizard");
    expect(activities.map((activity) => activity.title)).toContain("Reviewed issue");
    expect(updatedIssue?.labels.map((label) => label.name)).toContain("実装待ち");

    context.client.close();
  });

  it("does not apply an agent result after the job has been canceled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneteam-worker-cancel-"));
    const context = createDatabaseContext(`file:${join(dir, "test.db")}`);
    await runMigrations(context.client);

    const repos = createRepositories(context.db);
    const project = await repos.projects.create({
      name: "Example",
      repoPath: dir,
      defaultBranch: "main",
      locale: "en"
    });
    const issue = await repos.issues.create({
      projectId: project.id,
      title: "Add setup",
      body: "Create a setup wizard."
    });
    const job = await repos.agentJobs.create({
      projectId: project.id,
      agentType: "requirements",
      targetType: "issue",
      targetId: issue.id
    });

    const fakeAdapter: AgentAdapter = {
      async run(input) {
        expect(await input.isCanceled?.()).toBe(false);
        await repos.agentJobs.updateStatus(project.id, job.id, "canceled", { error: "Cancellation requested." });
        expect(await input.isCanceled?.()).toBe(true);
        return {
          status: "succeeded",
          message: "This result should not be applied.",
          comment: {
            targetType: "issue",
            targetId: issue.id,
            body: "Do not save this."
          }
        };
      }
    };

    const worker = new AgentWorker(repos, fakeAdapter, { pollIntervalMs: 1000 });
    await worker.tick();

    const updatedJob = await repos.agentJobs.get(project.id, job.id);
    const comments = await repos.comments.list(project.id, "issue", issue.id);
    const activities = await repos.activities.list(project.id, "issue", issue.id);

    expect(updatedJob?.status).toBe("canceled");
    expect(comments).toHaveLength(0);
    expect(activities.map((activity) => activity.title)).toContain("Agent job canceled");

    context.client.close();
  });
});
