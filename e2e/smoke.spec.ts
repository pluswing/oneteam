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
  await expect(page.getByText("No issues")).toBeVisible();

  await page.getByRole("button", { name: "New issue" }).click();
  await expect(page.getByRole("heading", { name: "New issue" })).toBeVisible();
  await page.getByLabel("Title").fill("Add smoke workflow");
  await page.getByLabel("Body").fill("Exercise setup, label automation, and job controls.");
  await page.getByRole("button", { name: "Create" }).click();

  await expect(page.getByRole("heading", { name: /#1 Add smoke workflow/ })).toBeVisible();
  await expect(page.locator(".label-pill", { hasText: "requirements" })).toBeVisible();

  await page.getByRole("button", { name: "Agent Jobs" }).click();
  await expect(page.getByRole("heading", { name: "Agent Jobs" })).toBeVisible();
  const requirementsJob = page.locator(".agent-job-summary").filter({ hasText: "requirements" }).first();
  await expect(requirementsJob).toContainText("queued");
  await requirementsJob.click();
  await expect(page.getByRole("heading", { name: /#\d+ requirements/ })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator(".page-title-block")).toContainText("canceled");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.locator(".page-title-block")).toContainText("queued");

  await page.getByRole("button", { name: "Repository and settings" }).click();
  await page.getByRole("menuitem", { name: "Repository" }).click();
  await expect(page.getByRole("heading", { name: "Repository" })).toBeVisible();
  await expect(page.getByText("npm run build")).toBeVisible();
  await expect(page.getByText("npm run test")).toBeVisible();
  await expect(page.getByText("npm run lint")).toBeVisible();

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
  await page.getByRole("button", { name: /Review a large generated diff/ }).click();
  await page.getByRole("button", { name: "Files changed" }).click();
  await expect(page.locator(".diff-render-footer")).toContainText("1,000");
  await expect(page.locator(".diff-line")).toHaveCount(1_000);
  await page.getByRole("button", { name: "Render 1,000 more lines" }).click();
  await expect(page.locator(".diff-line")).toHaveCount(2_000);
});
