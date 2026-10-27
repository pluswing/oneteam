import { expect, test, type Page } from "@playwright/test";
import type { ActivityDto, AgentJobDto, ProjectDto } from "../src/shared/types";
import { expectScreenContrast } from "./accessibility";

async function mockActivities(page: Page) {
  const timestamp = "2026-10-27T00:00:00.000Z";
  const project: ProjectDto = { id: "activity-cards", name: "OneTeam", repoPath: "/workspace/oneteam", defaultBranch: "main", locale: "ja", createdAt: timestamp, updatedAt: timestamp };
  const jobs: AgentJobDto[] = [1, 2].map((id) => ({ id, projectId: project.id, aiProvider: "codex", aiModel: "gpt-6.1-sol", agentType: "implementation", targetType: "issue", targetId: id,
    status: "running", triggerType: "manual", parentJobId: null, input: {}, output: null, error: null, attempt: 1, lockKey: null, waitReason: null, waitMetadata: null,
    nextRetryAt: null, createdAt: timestamp, startedAt: timestamp, finishedAt: null }));
  const result = { status: "succeeded", message: "検索条件の保存に対応しました。再起動後も、選択した条件を引き継ぎます。", changedFiles: ["src/client/views/IssueFilters.tsx", "src/server/services/project-preferences.ts", "src/test/project-preferences.test.ts"],
    testResults: [{ command: "npm test", status: "passed", exitCode: 0, output: "24 tests passed" }, { command: "npm run typecheck", status: "passed", exitCode: 0 }],
    evidence: [{ title: "再起動後の保存を確認", summary: "アプリを再起動して検索条件が保持されることを確認しました。" }],
    metadata: { model: "gpt-6.1-sol", verifier: { stopConditionMet: true } } };
  const activities: ActivityDto[] = [
    { id: 80, title: "以前の進捗", activityType: "progress", body: "以前の受付内容を確認しました。", payload: null, lastOccurredAt: timestamp },
    { id: 3, title: "実装と検証が完了", activityType: "progress", body: JSON.stringify(result), payload: null, lastOccurredAt: "2026-10-27T02:00:00.000Z" },
    { id: 70, title: "Codex command completed", activityType: "error", body: "npm test\nConfiguration file missing", payload: { status: "failed", command: "npm test", exitCode: 1, durationMs: 1200, cwd: "/workspace/oneteam" }, lastOccurredAt: "2026-10-27T01:00:00.000Z" }
  ].map((activity) => ({ ...activity, agentJobId: 1, targetType: "issue", targetId: 1, occurrenceCount: 1, createdAt: activity.lastOccurredAt })) as ActivityDto[];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let response: unknown = { items: [], page: { total: 0, limit: 50, offset: 0 } };
    if (path === "/api/projects") response = { items: [project] };
    else if (path === "/api/codex/status") response = { status: "connected" };
    else if (path.endsWith("/agent-jobs")) response = { items: jobs };
    else if (/\/agent-jobs\/\d+$/.test(path)) response = { job: jobs.find((job) => job.id === Number(path.split("/").at(-1))) };
    else if (/\/agent-jobs\/\d+\/activities$/.test(path)) response = { items: activities.filter((activity) => activity.agentJobId === Number(path.split("/").at(-2))) };
    await route.fulfill({ json: response });
  });
  return { activities, jobs };
}

test("structured activities show the newest record and disclose earlier records independently of diagnostic logs", async ({ page }) => {
  const fixture = await mockActivities(page);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/jobs/1");
  const section = page.locator(".agent-activities");
  await expect(section.locator(".activity-item")).toHaveCount(1);
  await expect(section.locator(".activity-item")).toHaveAttribute("data-activity-id", "3");
  await expect(section).toContainText("検索条件の保存に対応しました。");
  await expect(section.locator(".activity-files li")).toHaveCount(3);
  await expect(section.locator(".activity-records li")).toHaveCount(3);
  await expect(section.locator(".activity-status.status-succeeded")).toHaveCount(3);
  await expect(section).not.toContainText('"changedFiles"');
  await expect(section).not.toContainText("Configuration file missing");
  await expect(section.locator(".activity-more")).not.toHaveAttribute("open");
  await section.scrollIntoViewIfNeeded();
  await expectScreenContrast(page, "Japanese structured activity card");
  await section.screenshot({ path: ".tmp/agent-activities-desktop.png" });

  const history = section.getByRole("button", { name: /履歴を表示/ });
  await expect(history).toHaveAttribute("aria-expanded", "false");
  await page.getByLabel("詳細ログと履歴を表示").check();
  await expect(section.locator(".activity-item")).toHaveCount(1);
  await history.focus(); await history.press("Space");
  await expect(section.getByRole("button", { name: /履歴を隠す/ })).toHaveAttribute("aria-expanded", "true");
  await expect(section.locator(".activity-item")).toHaveCount(3);
  await expect(section).toContainText("Configuration file missing");
  await expect(section.locator(".activity-item").nth(1)).toHaveAttribute("data-activity-id", "70");
  await expect(section.locator(".activity-status.status-failed")).toHaveCount(1);

  fixture.activities.push({ ...fixture.activities[0], id: 90, title: "最終確認が完了", body: '{"status":"succeeded","message":"最新の検証記録です。","changedFiles":["src/final-check.ts"]}',
    createdAt: "2026-10-27T03:00:00.000Z", lastOccurredAt: "2026-10-27T03:00:00.000Z" });
  await expect(section.locator(".activity-latest")).toHaveAttribute("data-activity-id", "90");
  await expect(section.locator(".activity-item")).toHaveCount(4);
  await section.getByRole("button", { name: /履歴を隠す/ }).click();
  await expect(section.locator(".activity-item")).toHaveCount(1);
  await expect(section).not.toContainText("検索条件の保存に対応しました。");
  await expect(section).toContainText("最新の検証記録です。");
  await section.getByRole("button", { name: /履歴を表示/ }).click();
  await page.reload();
  await expect(section.locator(".activity-item")).toHaveCount(1);

  await page.setViewportSize({ width: 390, height: 844 });
  await section.scrollIntoViewIfNeeded();
  await expect(section.getByRole("button", { name: /履歴を表示/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  await section.screenshot({ path: ".tmp/agent-activities-mobile.png" });
  await page.getByRole("button", { name: "ジョブ", exact: true }).click();
  await page.locator(".agent-job-summary").filter({ hasText: "#2 実装" }).click();
  await expect(section).toContainText("アクティビティはまだありません。");
  await expect(section.getByRole("button", { name: /履歴/ })).toHaveCount(0);

  fixture.jobs[0].status = "succeeded";
  await page.goto("/jobs/1");
  await expect(section.locator(".activity-item")).toHaveCount(1);
  await expect(section).toContainText("最新の検証記録です。");
});
