import { expect, test } from "@playwright/test";
import type { IssueDto, ProjectDto } from "../src/shared/types";

test("keeps the repository header and navigation fixed while scrolling and resizing", async ({ page }) => {
  const timestamp = "2026-10-27T00:00:00.000Z";
  const project: ProjectDto = {
    id: "header-fixture", name: "example-project", repoPath: "/workspace/example-project", defaultBranch: "main",
    locale: "en", createdAt: timestamp, updatedAt: timestamp
  };
  const issues: IssueDto[] = Array.from({ length: 35 }, (_, index) => ({
    id: index + 1, title: `Issue ${index + 1}`, body: "", status: "open", createdByType: "system", labels: [],
    commentCount: 0, lastAgentStatus: null, lastAgentStopReason: null, createdAt: timestamp, updatedAt: timestamp, closedAt: null
  }));
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let response: unknown = { items: [], page: { total: 0, limit: 50, offset: 0 } };
    if (path === "/api/projects") response = { items: [project] };
    else if (path === "/api/codex/status") response = { status: "connected" };
    else if (path === `/api/projects/${project.id}/issues`) response = { items: issues, page: { total: issues.length, limit: 50, offset: 0 } };
    await route.fulfill({ json: response });
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/issues");
  await expect(page.locator(".work-item-summary")).toHaveCount(issues.length);

  let desktopHeight = 0;
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 720 });
    await page.evaluate(() => window.scrollTo(0, 0));
    const header = page.locator(".app-header");
    const initial = await header.boundingBox();
    expect(initial).not.toBeNull();
    if (width === 1280) desktopHeight = initial!.height;
    else expect(initial!.height).toBeGreaterThan(desktopHeight);
    await expect.poll(() => page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop))).toBe(initial!.height);

    await page.evaluate(() => window.scrollTo(0, 600));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    expect(await header.boundingBox()).toEqual(initial);
    for (const selector of [".topbar", ".repository-identity", ".nav-tabs"]) {
      const bounds = await page.locator(selector).boundingBox();
      expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(initial!.height);
    }
    // A real hash link must land below the fixed header, including after wrapping on mobile.
    const skipLink = page.getByRole("link", { name: "Skip to content" });
    await skipLink.focus();
    await skipLink.click();
    await expect(page.locator("#main-content")).toBeFocused();
    const main = await page.locator("#main-content").boundingBox();
    expect(main!.y).toBeGreaterThanOrEqual(initial!.height);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBe(0);
  }

  await page.getByRole("button", { name: "Pull Requests", exact: true }).click();
  await expect(page).toHaveURL(/\/pulls$/);
  await expect(page.locator("#main-content")).toBeFocused();
  expect((await page.locator(".app-header").boundingBox())!.y).toBe(0);
});

test("shows Japanese navigation, work item states and job roles", async ({ page }) => {
  const timestamp = "2026-10-27T00:00:00.000Z";
  const project: ProjectDto = { id: "ja-fixture", name: "日本語確認", repoPath: "/workspace/ja", defaultBranch: "main", locale: "ja", createdAt: timestamp, updatedAt: timestamp };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let response: unknown = { items: [], page: { total: 0, limit: 50, offset: 0 } };
    if (path === "/api/projects") response = { items: [project] };
    else if (path === "/api/codex/status") response = { status: "connected" };
    else if (path.endsWith("/agent-jobs")) response = { items: [{ id: 1, projectId: project.id, agentType: "implementation", status: "running", targetType: "issue", targetId: 42, aiProvider: "codex", aiModel: "gpt-6.1-sol", input: {}, output: null, createdAt: timestamp, startedAt: timestamp, finishedAt: null }] };
    await route.fulfill({ json: response });
  });
  await page.goto("/issues");
  await expect(page.getByRole("button", { name: "課題", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "プルリクエスト", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "ジョブ", exact: true }).click();
  await expect(page.locator(".agent-job-title")).toHaveText("#1 実装");
  await expect(page.locator("#main-content")).toContainText("課題 #42");
  await expect(page.locator("#main-content")).toContainText("実行中");
  await expect(page.locator("#main-content")).toContainText("gpt-6.1-sol");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
});
