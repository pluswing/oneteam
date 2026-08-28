import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const repoPath = resolve(".tmp/e2e/repo");

test("setup, label automation, and agent job controls", async ({ page }) => {
  test.setTimeout(90_000);
  await expect
    .poll(async () => {
      const response = await page.request.get("/api/health");
      return response.ok();
    })
    .toBe(true);

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Choose project" })).toBeVisible();
  await page.getByRole("button", { name: "Add repository" }).click();
  await expect(page.getByRole("heading", { name: "Setup" })).toBeVisible();
  await page.getByLabel("Name").fill("E2E Project");
  await page.getByLabel("Path").fill(repoPath);
  await page.getByRole("button", { name: "Create project" }).click();

  await expect(page.getByRole("heading", { name: "Issues" })).toBeVisible();
  await expect(page.locator(".repository-identity")).toContainText("E2E Project");
  await expect(page.locator(".repository-identity")).toContainText("Local");
  await expect(page.getByRole("navigation", { name: "Repository navigation" })).toBeVisible();
  await expect(page.getByText("No issues")).toBeVisible();

  await page.getByRole("button", { name: "New issue" }).click();
  await expect(page.getByRole("heading", { name: "New issue" })).toBeVisible();
  await page.getByLabel("Title").fill("Add smoke workflow");
  await page.getByLabel("Body").fill("Exercise setup, label automation, and job controls.");
  await page.getByRole("button", { name: "Create" }).click();

  await expect(page.getByRole("heading", { name: /#1 Add smoke workflow/ })).toBeVisible();
  await expect(page.locator(".label-pill", { hasText: "requirements" })).toBeVisible();
  await expect(page.locator(".work-item-detail-meta")).toContainText("user");
  await expect(page.locator(".automation-checks")).toContainText("requirements");
  await expect(page.locator(".automation-checks")).toContainText("queued");
  await expect(page.locator(".objective-stage-summary")).toContainText("Requirements");
  await page.getByRole("button", { name: "Pause automation" }).click();
  await expect(page.locator(".objective-panel .status-pill")).toHaveText("paused");
  await expect(page.locator(".objective-stage-summary")).toContainText("Requirements");
  await page.getByRole("button", { name: "Resume automation" }).click();
  await expect(page.locator(".objective-panel .status-pill")).toHaveText("running");
  await page.getByRole("button", { name: "Close issue" }).click();
  await expect(page.locator(".page-title-block .status-pill")).toHaveText("closed");
  await page.getByRole("button", { name: "Reopen issue" }).click();
  await expect(page.locator(".page-title-block .status-pill")).toHaveText("open");
  await expect(page.getByText("Existing Objective selected after reopen").first()).toBeVisible();
  await page.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByLabel("Body")).toHaveValue("Exercise setup, label automation, and job controls.");
  await page.getByLabel("Body").fill("Exercise setup, label automation, job controls, and Goal Contract auditing.");
  await page.getByLabel("Goal Contract change reason").fill("Include the newly required contract audit flow.");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Goal Contract changed").first()).toBeVisible();

  await page.getByRole("button", { name: "Issues", exact: true }).click();
  const issueSummary = page.locator(".work-item-rich").filter({ hasText: "Add smoke workflow" });
  await expect(issueSummary).toContainText("requirements");
  await expect(issueSummary.locator(".work-item-author")).toHaveText("user");
  await expect(issueSummary.locator(".work-item-check")).toContainText("queued");

  await page.getByRole("button", { name: "Agent runs" }).click();
  await expect(page.getByRole("heading", { name: "Agent Jobs" })).toBeVisible();
  const requirementsJob = page.locator(".agent-job-summary").filter({ hasText: "requirements" }).first();
  await expect(requirementsJob).toContainText("queued");
  await requirementsJob.click();
  await expect(page.getByRole("heading", { name: /#\d+ requirements/ })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator(".page-title-block")).toContainText("canceled");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.locator(".page-title-block")).toContainText("queued");

  await page.getByRole("button", { name: "Repository", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Repository" })).toBeVisible();
  await expect(page.getByText("npm run build")).toBeVisible();
  await expect(page.getByText("npm run test")).toBeVisible();
  await expect(page.getByText("npm run lint")).toBeVisible();

  await page.getByRole("button", { name: "Project and settings" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await page.getByLabel("Automatic merge target branches").fill("main, release");
  await page.getByLabel("Merge strategy").selectOption("squash");
  await page.getByLabel("Diff risk threshold").selectOption("high");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Settings saved")).toBeVisible();
  await page.getByRole("button", { name: "Repository", exact: true }).click();
  await page.getByRole("button", { name: "Project and settings" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page.getByLabel("Automatic merge target branches")).toHaveValue("main, release");
  await expect(page.getByLabel("Merge strategy")).toHaveValue("squash");
  await expect(page.getByLabel("Diff risk threshold")).toHaveValue("high");

  execFileSync("git", ["checkout", "-b", "feature/large-diff"], { cwd: repoPath });
  writeFileSync(
    resolve(repoPath, "large.ts"),
    Array.from({ length: 6_000 }, (_, index) => `export const value${index + 1} = ${index + 1};`).join("\n") + "\n"
  );
  execFileSync("git", ["add", "large.ts"], { cwd: repoPath });
  execFileSync("git", ["commit", "-m", "add large diff fixture"], { cwd: repoPath });

  const projectsResponse = await page.request.get("/api/projects");
  const projects = (await projectsResponse.json()) as { items: Array<{ id: string }> };
  const pullRequestResponse = await page.request.post(`/api/projects/${projects.items[0].id}/pull-requests`, {
    data: {
      title: "Review a large generated diff",
      body: "Exercises bounded progressive diff rendering.",
      sourceBranch: "feature/large-diff",
      targetBranch: "main"
    }
  });
  expect(pullRequestResponse.ok()).toBe(true);

  await page.getByRole("button", { name: "Pull Requests" }).click();
  const pullRequestSummary = page.locator(".work-item-rich").filter({ hasText: "Review a large generated diff" });
  await expect(pullRequestSummary).toContainText("feature/large-diff");
  await expect(pullRequestSummary.locator(".work-item-author")).toHaveText("user");
  await expect(pullRequestSummary.locator(".work-item-stats")).toContainText("1");
  await page.getByRole("button", { name: /Review a large generated diff/ }).click();
  await expect(page.locator(".work-item-detail-meta")).toContainText("user");
  await expect(page.locator(".automation-checks")).toContainText("review");
  await page.getByRole("button", { name: "Files changed" }).click();
  await expect(page.locator(".diff-render-footer")).toContainText("1,000");
  await expect(page.locator(".diff-virtual-status")).toContainText("Visible diff rows");
  await expect.poll(() => page.locator(".diff-line").count()).toBeLessThanOrEqual(200);
  await expect.poll(() => page.locator(".diff-line").count()).toBeGreaterThan(0);
  await page.getByRole("button", { name: /Collapse hunk/ }).click();
  await expect(page.locator(".diff-line")).toHaveCount(0);
  await page.getByRole("button", { name: /Expand hunk/ }).click();
  await expect.poll(() => page.locator(".diff-line").count()).toBeLessThanOrEqual(200);
  await page.getByRole("button", { exact: true, name: "Comment on line New line 1" }).click();
  await page.getByPlaceholder("Leave a review comment…").fill("**Review note:** keep this generated value stable.");
  await page.getByRole("button", { name: "Add comment" }).click();
  await expect(page.locator(".diff-line-comment")).toContainText("Review note: keep this generated value stable.");
  await page.getByRole("button", { name: "Render 1,000 more lines" }).click();
  await expect(page.locator(".diff-render-footer")).toContainText("2,000");
  await page.locator(".diff-table-scroll").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(() => page.locator(".diff-line").count()).toBeLessThanOrEqual(200);
  await expect(page.locator(".diff-virtual-status")).toContainText("2,001");
  await page.getByRole("button", { name: "Pull Requests" }).click();
  await page.getByRole("button", { name: /Review a large generated diff/ }).click();
  await page.getByRole("button", { name: "Files changed" }).click();
  await expect(page.locator(".diff-line-comment")).toContainText("Review note: keep this generated value stable.");
});
