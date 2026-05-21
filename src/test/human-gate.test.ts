import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import { createDatabaseContext } from "../server/db/client";
import { runMigrations } from "../server/db/migrations";
import { createRepositories } from "../server/db/repositories";

describe("human gate", () => {
  it("restores labels and requeues the waiting issue job when a user comments", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneteam-human-gate-"));
    const context = createDatabaseContext(`file:${join(dir, "test.db")}`);
    await runMigrations(context.client);

    const repos = createRepositories(context.db);
    const app = createApp({ repos });
    const project = await repos.projects.create({
      name: "Example",
      repoPath: dir,
      defaultBranch: "main",
      locale: "en"
    });
    const requirementsLabel = await repos.labels.findByName(project.id, "要件定義中");
    const confirmationLabel = await repos.labels.findByName(project.id, "確認待ち");
    expect(requirementsLabel).toBeDefined();
    expect(confirmationLabel).toBeDefined();

    const issue = await repos.issues.create({
      projectId: project.id,
      title: "Add setup",
      body: "Create a setup wizard.",
      labelIds: [confirmationLabel!.id]
    });
    const job = await repos.agentJobs.create({
      projectId: project.id,
      agentType: "requirements",
      targetType: "issue",
      targetId: issue.id
    });
    await repos.agentJobs.updateStatus(project.id, job.id, "waiting_human", {
      output: {
        status: "waiting_human",
        message: "Need more detail.",
        metadata: {
          humanGate: {
            previousLabelIds: [requirementsLabel!.id],
            previousLabelNames: [requirementsLabel!.name]
          }
        }
      }
    });

    const response = await app.request(`/api/projects/${project.id}/issues/${issue.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        body: "Show it to project maintainers."
      })
    });
    const body = (await response.json()) as { autoResumedJobId: number | null };
    const resumedJob = await repos.agentJobs.get(project.id, job.id);
    const updatedIssue = await repos.issues.get(project.id, issue.id);
    const activities = await repos.activities.list(project.id, "issue", issue.id);

    expect(response.status).toBe(201);
    expect(body.autoResumedJobId).toBe(job.id);
    expect(resumedJob?.status).toBe("queued");
    expect(resumedJob?.attempt).toBe(2);
    expect(updatedIssue?.labels.map((label) => label.name)).toEqual(["要件定義中"]);
    expect(activities.map((activity) => activity.title)).toContain("Human answer received");

    context.client.close();
  });
});
