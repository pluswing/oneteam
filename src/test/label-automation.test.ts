import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import { createDatabaseContext } from "../server/db/client";
import { runMigrations } from "../server/db/migrations";
import { createRepositories } from "../server/db/repositories";
import { runLabelAutomation } from "../server/services/label-automation";

describe("label automation", () => {
  it("queues the next issue agent from newly applied labels and avoids duplicate active jobs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneteam-label-automation-"));
    const context = createDatabaseContext(`file:${join(dir, "test.db")}`);
    await runMigrations(context.client);

    const repos = createRepositories(context.db);
    const project = await repos.projects.create({
      name: "Example",
      repoPath: dir,
      defaultBranch: "main",
      locale: "en"
    });
    const labels = await repos.labels.list(project.id);
    const requirementsLabel = labels.find((label) => label.name === "要件定義中");
    const implementationLabel = labels.find((label) => label.name === "実装待ち");
    expect(requirementsLabel).toBeDefined();
    expect(implementationLabel).toBeDefined();

    const issue = await repos.issues.create({
      projectId: project.id,
      title: "Add setup",
      body: "Create a setup wizard.",
      labelIds: [requirementsLabel!.id]
    });

    const requirementsJobs = await runLabelAutomation(repos, {
      projectId: project.id,
      targetType: "issue",
      targetId: issue.id,
      labels: issue.labels
    });
    const duplicateJobs = await runLabelAutomation(repos, {
      projectId: project.id,
      targetType: "issue",
      targetId: issue.id,
      labels: issue.labels
    });
    await repos.agentJobs.updateStatus(project.id, requirementsJobs[0].id, "succeeded");
    const updatedIssue = await repos.issues.update(project.id, issue.id, {
      labelIds: [implementationLabel!.id]
    });
    const implementationJobs = await runLabelAutomation(repos, {
      projectId: project.id,
      targetType: "issue",
      targetId: issue.id,
      labels: updatedIssue!.labels,
      previousLabels: issue.labels,
      triggerType: "label_transition"
    });
    const activities = await repos.activities.list(project.id, "issue", issue.id);

    expect(requirementsJobs).toHaveLength(1);
    expect(requirementsJobs[0].agentType).toBe("requirements");
    expect(duplicateJobs).toHaveLength(0);
    expect(implementationJobs).toHaveLength(1);
    expect(implementationJobs[0].agentType).toBe("implementation");
    expect(activities.map((activity) => activity.title)).toContain("Agent job queued");

    context.client.close();
  });

  it("hooks issue and pull request API writes into label automation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneteam-label-api-"));
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
    const labels = await repos.labels.list(project.id);
    const requirementsLabel = labels.find((label) => label.name === "要件定義中");
    expect(requirementsLabel).toBeDefined();

    const issueResponse = await app.request(`/api/projects/${project.id}/issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Add setup",
        body: "Create a setup wizard.",
        labelIds: [requirementsLabel!.id]
      })
    });
    const issueBody = (await issueResponse.json()) as { automationJobIds: number[] };
    const pullRequestResponse = await app.request(`/api/projects/${project.id}/pull-requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Review setup",
        body: "Local PR",
        sourceBranch: "feature/setup",
        targetBranch: "main"
      })
    });
    const pullRequestBody = (await pullRequestResponse.json()) as { automationJobIds: number[] };
    const jobs = await repos.agentJobs.list({ projectId: project.id });

    expect(issueResponse.status).toBe(201);
    expect(issueBody.automationJobIds).toHaveLength(1);
    expect(pullRequestResponse.status).toBe(201);
    expect(pullRequestBody.automationJobIds).toHaveLength(1);
    expect(jobs.map((job) => job.agentType)).toEqual(expect.arrayContaining(["requirements", "review"]));

    context.client.close();
  });
});
