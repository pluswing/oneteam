import { expect, test } from "@playwright/test";
import type { ProjectDto, PullRequestDto } from "../src/shared/types";

test("merge failures stay visible across refresh and a retry updates the PR", async ({ page }) => {
  await page.clock.install();
  const timestamp = "2026-10-27T00:00:00.000Z";
  const project: ProjectDto = { id: "merge-button", name: "Merge button", repoPath: "/workspace/merge-button", defaultBranch: "main", locale: "en", createdAt: timestamp, updatedAt: timestamp };
  const base = `/api/projects/${project.id}`;
  const pr: PullRequestDto = { id: 1, title: "Verified change", body: "Ready for merge", status: "open", createdByType: "agent", labels: [], commentCount: 0,
    lastAgentStatus: null, lastAgentStopReason: null, createdAt: timestamp, updatedAt: timestamp, closedAt: null,
    issueId: null, sourceBranch: "feature", targetBranch: "main", changedFileCount: 1, commitCount: 1 };
  let mergeAttempts = 0;
  let detailReads = 0;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let response: unknown = { items: [], page: { total: 0, limit: 50, offset: 0 } };
    if (path === "/api/projects") response = { items: [project] };
    else if (path === "/api/codex/status") response = { status: "connected" };
    else if (path === `${base}/pull-requests/1`) { detailReads++; response = { pullRequest: pr }; }
    else if (path === `${base}/pull-requests/1/merge`) {
      mergeAttempts++;
      if (mergeAttempts === 1) {
        await route.fulfill({ status: 409, json: { error: { message: "Working tree must be clean before merge." } } });
        return;
      }
      pr.status = "merged"; pr.closedAt = timestamp;
      response = { pullRequest: pr, mergeCommit: "a".repeat(40), output: "Merged" };
    }
    else if (path.endsWith("/objective")) response = { objective: null };
    else if (path.endsWith("/files")) response = { files: [], sourceCommit: "source", targetCommit: "target" };
    else if (path.endsWith("/conflicts")) response = { hasConflicts: false, files: [] };
    await route.fulfill({ json: response });
  });
  page.on("dialog", (dialog) => { void dialog.accept(); });
  await page.goto("/pulls/1");
  const button = page.getByRole("button", { name: "Merge pull request", exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  const error = page.locator(".merge-panel").getByRole("alert");
  await expect(error).toContainText("Working tree must be clean before merge.");
  const readsBeforeRefresh = detailReads;
  await page.clock.runFor(5000);
  await expect.poll(() => detailReads).toBeGreaterThan(readsBeforeRefresh);
  await expect(error).toBeVisible();
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.locator(".merge-panel .success-banner")).toContainText("Merged");
  await expect(error).toHaveCount(0);
  await expect(button).toBeDisabled();
  expect(mergeAttempts).toBe(2);
});
