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

  await page.getByRole("button", { name: "New issue" }).click();
  await expect(page.getByRole("heading", { name: "New issue" })).toBeVisible();
  await page.getByLabel("Title").fill("Add smoke workflow");
  await page.getByLabel("Body").fill("Exercise setup, label automation, and job controls.");
  await page.getByRole("button", { name: "Create" }).click();

  await expect(page.getByRole("heading", { name: /#1 Add smoke workflow/ })).toBeVisible();
  await expect(page.locator(".label-pill", { hasText: "requirements" })).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();

  await page.getByRole("button", { name: "Agent Jobs" }).click();
  await expect(page.getByRole("heading", { name: "Agent Jobs" })).toBeVisible();
  await page.getByRole("button", { name: "Refresh" }).click();
  const requirementsJob = page.locator(".agent-job-summary").filter({ hasText: "requirements" }).first();
  await expect(requirementsJob).toContainText("queued");
  await requirementsJob.click();
  await expect(page.getByRole("heading", { name: /#\d+ requirements/ })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator(".page-title-block")).toContainText("canceled");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.locator(".page-title-block")).toContainText("queued");
  await page.getByRole("button", { name: "Back" }).click();

  await page.getByRole("button", { name: "Repository and settings" }).click();
  await page.getByRole("menuitem", { name: "Repository" }).click();
  await expect(page.getByRole("heading", { name: "Repository" })).toBeVisible();
  await expect(page.getByText("npm run build")).toBeVisible();
  await expect(page.getByText("npm run test")).toBeVisible();
  await expect(page.getByText("npm run lint")).toBeVisible();
});
