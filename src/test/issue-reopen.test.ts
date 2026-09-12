import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import { createDatabaseContext } from "../server/db/client";
import { runMigrations } from "../server/db/migrations";
import { createRepositories } from "../server/db/repositories";
import { ensureObjectiveForTarget } from "../server/services/objective-runs";
import { workflowLabelNames } from "../shared/workflow-labels";

describe("Issue reopen lifecycle", () => {
  it("creates a follow-up Objective without modifying the completed delivery", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneteam-issue-reopen-"));
    const context = createDatabaseContext(`file:${join(dir, "test.db")}`);
    await runMigrations(context.client);
    const repos = createRepositories(context.db);
    const project = await repos.projects.create({
      name: "Example",
      repoPath: dir,
      defaultBranch: "main",
      locale: "en"
    });
    const doneLabel = await repos.labels.findByName(project.id, workflowLabelNames.done);
    const issue = await repos.issues.create({
      projectId: project.id,
      title: "Delivered behavior",
      body: "Original Goal Contract."
    });
    const originalObjective = await ensureObjectiveForTarget(repos, {
      projectId: project.id,
      targetType: "issue",
      targetId: issue.id
    });
    const pullRequest = await repos.pullRequests.create({
      projectId: project.id,
      issueId: issue.id,
      title: "Delivered behavior",
      sourceBranch: "feature/delivered",
      targetBranch: "main"
    });
    await ensureObjectiveForTarget(repos, {
      projectId: project.id,
      targetType: "pull_request",
      targetId: pullRequest.id
    });
    if (!originalObjective) throw new Error("Original Objective was not created.");
    await repos.objectives.update(project.id, originalObjective.id, {
      status: "succeeded",
      workflowStage: "merged",
      stopReason: "merged",
      summary: "Original delivery completed.",
      finishedAt: new Date().toISOString()
    });
    await repos.issues.update(project.id, issue.id, {
      status: "closed",
      labelIds: doneLabel ? [doneLabel.id] : []
    });

    const app = createApp({ repos });
    const response = await app.request(`/api/projects/${project.id}/issues/${issue.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "open", body: "Follow-up Goal Contract." })
    });
    const payload = (await response.json()) as { issue: { labels: Array<{ name: string }> }; automationJobIds: number[] };
    const [objectives, originalAfter, linkedPullRequestObjective, comments, memory, jobs] = await Promise.all([
      repos.objectives.list({ projectId: project.id, issueId: issue.id }),
      repos.objectives.get(project.id, originalObjective.id),
      repos.objectives.findByPullRequest(project.id, pullRequest.id),
      repos.comments.list(project.id, "issue", issue.id),
      repos.loopMemory.list(project.id),
      repos.agentJobs.list({ projectId: project.id, targetType: "issue", targetId: issue.id })
    ]);
    const followUp = objectives.find((objective) => objective.id !== originalObjective.id);

    expect(response.status).toBe(200);
    expect(payload.issue.labels.map((label) => label.name)).toContain(workflowLabelNames.requirements);
    expect(payload.issue.labels.map((label) => label.name)).not.toContain(workflowLabelNames.done);
    expect(payload.automationJobIds).toHaveLength(0);
    expect(objectives).toHaveLength(2);
    expect(followUp).toMatchObject({
      status: "open",
      workflowStage: "requirements",
      goal: "Follow-up Goal Contract.",
      pullRequestId: null
    });
    expect(followUp?.evidence).toMatchObject({
      items: [expect.objectContaining({ payload: expect.objectContaining({ previousObjectiveRunId: originalObjective.id }) })]
    });
    expect(originalAfter).toMatchObject({ status: "succeeded", workflowStage: "merged", pullRequestId: pullRequest.id });
    expect(linkedPullRequestObjective?.id).toBe(originalObjective.id);
    expect(jobs).toHaveLength(0);
    expect(await repos.development.forIssue(project.id, issue.id)).toMatchObject({ status: "queued", objectiveId: followUp?.id });
    expect(comments.some((comment) => comment.body.includes("## Follow-up Objective created"))).toBe(true);
    expect(comments.some((comment) => comment.metadata?.previousObjectiveRunId === originalObjective.id)).toBe(true);
    expect(memory.some((entry) => entry.tags.includes("reopened") && entry.tags.includes("follow_up"))).toBe(true);

    const secondResponse = await app.request(`/api/projects/${project.id}/issues/${issue.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "open" })
    });
    expect(secondResponse.status).toBe(200);
    expect(await repos.objectives.list({ projectId: project.id, issueId: issue.id })).toHaveLength(2);

    context.client.close();
  });
});
