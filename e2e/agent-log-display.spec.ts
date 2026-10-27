import { expect, test, type Page } from "@playwright/test";
import type { ActivityDto, AgentJobDto, CommentDto, IssueDto, ProjectDto, PullRequestDto } from "../src/shared/types";
import type { DevelopmentLoopDto } from "../src/shared/development-loop";
import { expectScreenContrast } from "./accessibility";

const timestamp = "2026-10-27T00:00:00.000Z";
const project: ProjectDto = { id: "agent-display", name: "Agent display", repoPath: "/workspace/agent-display", defaultBranch: "main", locale: "en", createdAt: timestamp, updatedAt: timestamp };
const base = `/api/projects/${project.id}`;

async function mockActivityApi(page: Page) {
  const statuses: AgentJobDto["status"][] = ["queued", "running", "waiting_human", "waiting_provider", "succeeded", "failed", "canceled", "paused"];
  const jobs: AgentJobDto[] = statuses.map((status, index) => ({
    id: index + 1, projectId: project.id, aiProvider: "codex", aiModel: "fixture-model", agentType: "implementation",
    targetType: "issue", targetId: 1, status, triggerType: "fixture", parentJobId: null, input: {},
    output: status === "succeeded" ? { message: "Completed task result" } : null, error: null, attempt: 1, lockKey: null,
    waitReason: null, waitMetadata: null, nextRetryAt: null, createdAt: timestamp, startedAt: timestamp,
    finishedAt: ["succeeded", "failed", "canceled"].includes(status) ? timestamp : null
  }));
  const loops: DevelopmentLoopDto[] = jobs.map((job) => ({
    id: job.id, projectId: project.id, issueId: 1, pullRequestId: 1, objectiveId: null, phase: "implementing",
    status: job.status === "waiting_human" ? "waiting_input" : job.status === "waiting_provider" ? "waiting_capacity" : job.status,
    currentJobId: job.id, mergeCommit: null, sourceCommit: null, targetCommit: null, nextAgent: "implementation", failures: 0,
    summary: "", rounds: 1, createdAt: timestamp, updatedAt: timestamp, finishedAt: job.finishedAt
  }));
  const activities: ActivityDto[] = [
    { id: 1, agentJobId: 2, title: "Model selected", body: "Model selection diagnostics", activityType: "system" },
    { id: 2, agentJobId: 2, title: "Codex thread started", body: "Thread diagnostics", activityType: "system" },
    { id: 3, agentJobId: 2, title: "Checking acceptance criteria", body: "Current task progress", activityType: "progress" },
    { id: 4, agentJobId: null, title: "Labels changed", body: "Visible workflow event", activityType: "system" },
    { id: 5, agentJobId: 5, title: "Codex thread started", body: "Completed task diagnostics", activityType: "system" }
  ].map((activity) => ({ ...activity, targetType: "issue", targetId: 1, payload: null, occurrenceCount: 1, lastOccurredAt: timestamp, createdAt: timestamp })) as ActivityDto[];
  const comments: CommentDto[] = [
    { id: 1, targetType: "issue", targetId: 1, authorType: "user", agentType: null, body: "Keep this conversation comment", bodyFormat: "markdown", metadata: null, createdAt: timestamp, updatedAt: timestamp },
    { id: 2, targetType: "issue", targetId: 1, authorType: "agent", agentType: "implementation", body: "Completed task report", bodyFormat: "markdown", metadata: { agentJobId: 5 }, createdAt: timestamp, updatedAt: timestamp }
  ];
  const issue: IssueDto = { id: 1, title: "Activity display", body: "Issue description", status: "open", createdByType: "user", labels: [], commentCount: 2, lastAgentStatus: null, lastAgentStopReason: null, createdAt: timestamp, updatedAt: timestamp, closedAt: null };
  const pullRequest: PullRequestDto = { ...issue, issueId: 1, sourceBranch: "feature", targetBranch: "main", changedFileCount: 0, commitCount: 0 };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let response: unknown = { items: [], page: { limit: 50, offset: 0, total: 0 } };
    if (path === "/api/projects") response = { items: [project] };
    else if (path === "/api/codex/status") response = { status: "connected" };
    else if (path === `${base}/issues/1`) response = { issue };
    else if (path === `${base}/pull-requests/1`) response = { pullRequest };
    else if (path.endsWith("/objective")) response = { objective: null };
    else if (path.endsWith("/comments")) response = { items: comments };
    else if (path.endsWith("/files")) response = { files: [], sourceCommit: "source", targetCommit: "target" };
    else if (path.endsWith("/conflicts")) response = { hasConflicts: false, files: [] };
    else if (path === `${base}/development-loops`) response = { items: loops };
    else if (/\/development-loops\/\d+$/.test(path)) response = { loop: loops[0], jobs, revisions: [], retrospective: null };
    else if (path === `${base}/agent-jobs`) response = { items: jobs };
    else if (/\/agent-jobs\/\d+$/.test(path)) response = { job: jobs.find((job) => job.id === Number(path.split("/").at(-1))) };
    else if (path.endsWith("/executions")) response = { items: [{ id: 1, projectId: project.id, jobId: 2, selectedModel: "fixture-model", resolvedModel: "fixture-model", effort: "medium", selectionReason: "Execution selection reason", policyVersion: "fixture", threadId: "thread", turnId: "turn", status: "running", usage: null, startedAt: timestamp, finishedAt: null }] };
    else if (path.endsWith("/activities")) {
      const match = /\/agent-jobs\/(\d+)\//.exec(path);
      response = { items: match ? activities.filter((activity) => activity.agentJobId === Number(match[1])) : activities };
    }
    await route.fulfill({ json: response });
  });
  return { jobs, loops };
}

for (const path of ["/issues/1", "/pulls/1"]) {
  test(`${path} defaults to active tasks and lets users reveal all diagnostic logs and history`, async ({ page }) => {
    await mockActivityApi(page);
    await page.goto(path);
    const toggle = page.getByLabel("Show detailed logs and history");
    await expect(toggle).not.toBeChecked();
    await expect(page.locator(".conversation-agent-job")).toHaveCount(4);
    await expect(page.locator(".development-loop-card")).toHaveCount(4);
    for (const id of [1, 2, 3, 4]) await expect(page.locator(`#agent-job-${id}`)).toBeVisible();
    await expect(page.locator(".conversation-timeline")).not.toContainText("Model selected");
    await expect(page.locator(".conversation-timeline")).not.toContainText("Codex thread started");
    await expect(page.locator(".conversation-timeline")).toContainText("Keep this conversation comment");
    await expect(page.locator(".conversation-timeline")).toContainText("Completed task report");
    await expect(page.locator(".conversation-timeline")).toContainText("Labels changed");

    await toggle.focus();
    await toggle.press("Space");
    await expect(toggle).toBeChecked();
    await expect(page.locator(".conversation-agent-job")).toHaveCount(8);
    await expect(page.locator(".development-loop-card")).toHaveCount(8);
    await expect(page.locator(".conversation-timeline")).toContainText("Model selected");
    await expect(page.locator(".conversation-timeline")).toContainText("Codex thread started");
    await expect(page.locator(".conversation-timeline")).toContainText("Completed task diagnostics");
    await toggle.uncheck();
    await expect(page.locator(".conversation-agent-job")).toHaveCount(4);
    await expect(page.locator(".conversation-timeline")).not.toContainText("Model selected");
  });
}

test("Agent list and details share the toggle, include waiting tasks, and drop completed tasks on refresh", async ({ page }) => {
  const fixture = await mockActivityApi(page);
  await page.goto("/jobs");
  const toggle = page.getByLabel("Show detailed logs and history");
  await expect(toggle).not.toBeChecked();
  await expect(page.locator(".agent-job-summary")).toHaveCount(4);
  await expect(page.locator(".development-loop-card")).toHaveCount(4);
  await toggle.check();
  await expect(page.locator(".agent-job-summary")).toHaveCount(8);
  await page.locator(".agent-job-summary").filter({ hasText: "#2 implementation" }).click();
  await expect(toggle).toBeChecked();
  await expect(page.locator(".activity-list .activity-item")).toHaveCount(1);
  await page.getByRole("button", { name: /Show history/ }).click();
  await expect(page.locator(".agent-activities")).toContainText("Model selected");
  await expect(page.locator(".agent-activities")).toContainText("Codex thread started");
  await expect(page.locator(".execution-history")).toBeVisible();
  await toggle.uncheck();
  await expect(page.locator(".execution-history")).toHaveCount(0);
  await page.getByRole("button", { name: /Hide history/ }).click();
  await expect(page.locator(".agent-activities")).toContainText("Current task progress");
  await expect(page.locator(".agent-activities")).not.toContainText("Model selected");
  await expectScreenContrast(page, "Active task with hidden diagnostics");
  await page.getByRole("button", { name: "Agent runs", exact: true }).click();
  await expect(toggle).not.toBeChecked();
  fixture.jobs[1].status = "succeeded";
  fixture.loops[1].status = "succeeded";
  await expect(page.locator(".agent-job-summary")).toHaveCount(3);
  await expect(page.locator(".development-loop-card")).toHaveCount(3);
  await toggle.check();
  await expect(page.locator(".agent-job-summary")).toHaveCount(8);
  await page.reload();
  await expect(toggle).not.toBeChecked();
  await expect(page.locator(".agent-job-summary")).toHaveCount(3);
});
