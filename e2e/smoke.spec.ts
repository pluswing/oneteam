import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

const repoPath = resolve(".tmp/e2e/repo");
const fakeCodexPath = resolve(".tmp/e2e/fake-codex.mjs");

test("setup, label automation, and agent job controls", async ({ page }) => {
  await expect
    .poll(async () => {
      const response = await page.request.get("/api/health");
      return response.ok();
    })
    .toBe(true);

  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Setup" })).toBeVisible();
  await page.getByLabel("Name").fill("E2E Project");
  await page.getByLabel("Path").fill(repoPath);
  await page.getByLabel("Command").fill(fakeCodexPath);
  await page.getByRole("button", { name: "Create project" }).click();

  await expect(page.getByRole("heading", { name: "Issues" })).toBeVisible();
  await expect(page.getByText("No issues")).toBeVisible();

  const newIssuePanel = page.locator(".side-panel").filter({ hasText: "New issue" });
  await newIssuePanel.getByLabel("Title").fill("Add smoke workflow");
  await newIssuePanel.getByLabel("Body").fill("Exercise setup, label automation, and job controls.");
  await newIssuePanel.getByRole("button", { name: "Create" }).click();

  await expect(page.getByRole("heading", { name: /#1 Add smoke workflow/ })).toBeVisible();
  await expect(page.locator(".label-pill", { hasText: "requirements" })).toBeVisible();

  const agentPanel = page.locator(".side-panel").filter({ hasText: "Agent Jobs" });
  await agentPanel.getByTitle("Refresh").click();
  const requirementsJob = page.locator(".job-row").filter({ hasText: "requirements" }).first();
  await expect(requirementsJob).toContainText("queued");
  await requirementsJob.getByRole("button", { name: "Cancel" }).click();
  await expect(requirementsJob).toContainText("canceled");
  await requirementsJob.getByRole("button", { name: "Retry" }).click();

  const retriedJob = page.locator(".job-row").filter({ hasText: "requirements" }).first();
  await expect(retriedJob).toContainText("queued");

  await page.getByRole("button", { name: "Repository" }).click();
  await expect(page.getByRole("heading", { name: "Repository" })).toBeVisible();
  await expect(page.getByText("npm run build")).toBeVisible();
  await expect(page.getByText("npm run test")).toBeVisible();
  await expect(page.getByText("npm run lint")).toBeVisible();
});
