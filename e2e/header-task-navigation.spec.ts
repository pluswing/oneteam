import { expect, test } from "@playwright/test";
import type { AgentJobDto, IssueDto, ProjectDto, PullRequestDto } from "../src/shared/types";
import type { DevelopmentLoopDto } from "../src/shared/development-loop";

test("header status opens the current Agent, Issue or PR and follows changing tasks", async ({ page }) => {
  const timestamp = "2026-10-27T00:00:00.000Z";
  const project: ProjectDto = { id: "header-task", name: "Header task", repoPath: "/workspace/header-task", defaultBranch: "main", locale: "en", createdAt: timestamp, updatedAt: timestamp };
  const base = `/api/projects/${project.id}`;
  const job: AgentJobDto = {
    id: 37, projectId: project.id, aiProvider: "codex", aiModel: null, agentType: "implementation", targetType: "issue", targetId: 42,
    status: "running", triggerType: "fixture", parentJobId: null, input: {}, output: null, error: null, attempt: 1, lockKey: null,
    waitReason: null, waitMetadata: null, nextRetryAt: null, createdAt: timestamp, startedAt: timestamp, finishedAt: null
  };
  const loop: DevelopmentLoopDto = {
    id: 8, projectId: project.id, issueId: 42, pullRequestId: 24, objectiveId: null, phase: "implementing", status: "running", currentJobId: job.id,
    mergeCommit: null, sourceCommit: null, targetCommit: null, nextAgent: "implementation", failures: 0, summary: "", rounds: 1,
    createdAt: timestamp, updatedAt: timestamp, finishedAt: null
  };
  let jobs: AgentJobDto[] = [];
  let loops: DevelopmentLoopDto[] = [];
  const issue: IssueDto = { id: 42, title: "Current Issue", body: "Current work", status: "open", createdByType: "user", labels: [], commentCount: 0, lastAgentStatus: null, lastAgentStopReason: null, createdAt: timestamp, updatedAt: timestamp, closedAt: null };
  const pullRequest: PullRequestDto = { ...issue, id: 24, title: "Current pull request", issueId: issue.id, sourceBranch: "feature", targetBranch: "main", changedFileCount: 0, commitCount: 0 };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let response: unknown = { items: [], page: { total: 0, limit: 50, offset: 0 } };
    if (path === "/api/projects") response = { items: [project] };
    else if (path === "/api/codex/status") response = { status: "connected" };
    else if (path === `${base}/agent-jobs`) response = { items: jobs };
    else if (path === `${base}/development-loops`) response = { items: loops };
    else if (/\/agent-jobs\/\d+$/.test(path)) response = { job: jobs.find((item) => item.id === Number(path.split("/").at(-1))) };
    else if (path === `${base}/issues/42`) response = { issue };
    else if (path === `${base}/pull-requests/24`) response = { pullRequest };
    else if (path.endsWith("/objective")) response = { objective: null };
    else if (path.endsWith("/files")) response = { files: [], sourceCommit: "source", targetCommit: "target" };
    else if (path.endsWith("/conflicts")) response = { hasConflicts: false, files: [] };
    await route.fulfill({ json: response });
  });
  const status = page.locator(".agent-state");
  await page.goto("/issues");
  await expect(status).toHaveText("Ready");
  await expect(page.locator("a.agent-state")).toHaveCount(0);

  jobs = [job]; loops = [loop];
  await expect(status).toHaveAttribute("href", "/jobs/37");
  await expect(status).toContainText("Running");
  await status.focus();
  await status.press("Enter");
  await expect(page).toHaveURL(/\/jobs\/37$/);
  await expect(page.getByRole("heading", { name: "#37 implementation", exact: true })).toBeVisible();
  await expect(page.locator("#main-content")).toBeFocused();
  await page.goBack();
  await expect(page).toHaveURL(/\/issues$/);

  // The same header link must follow the current job as polling advances the Loop.
  jobs = [{ ...job, id: 38 }]; loops = [{ ...loop, currentJobId: 38 }];
  await expect(status).toHaveAttribute("href", "/jobs/38");
  await status.click();
  await expect(page).toHaveURL(/\/jobs\/38$/);
  await expect(page.getByRole("heading", { name: "#38 implementation", exact: true })).toBeVisible();

  jobs = []; loops = [{ ...loop, currentJobId: null }];
  await page.goto("/issues");
  await expect(status).toHaveAttribute("href", "/issues/42");
  await status.click();
  await expect(page).toHaveURL(/\/issues\/42$/);
  await expect(page.getByRole("heading", { name: "#42 Current Issue", exact: true })).toBeVisible();
  await expect(page.locator(".development-loop-card")).toContainText("Loop #8");

  loops = [{ ...loop, currentJobId: null, phase: "merging" }];
  await page.goto("/issues");
  await expect(status).toHaveAttribute("href", "/pulls/24");
  await status.click();
  await expect(page).toHaveURL(/\/pulls\/24$/);
  await expect(page.getByRole("heading", { name: "#24 Current pull request", exact: true })).toBeVisible();

  jobs = [{ ...job, status: "waiting_human" }]; loops = [{ ...loop, status: "waiting_input" }];
  await page.goto("/issues");
  await expect(status).toHaveAttribute("href", "/jobs/37");
  await expect(status).toContainText("Input needed");
  await status.click();
  await expect(page).toHaveURL(/\/jobs\/37$/);

  jobs = [job]; loops = [];
  await page.goto("/issues");
  await expect(status).toHaveAttribute("href", "/jobs/37");
  await expect(status).toContainText("Running");
});
