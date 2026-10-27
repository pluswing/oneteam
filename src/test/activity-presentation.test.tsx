import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import { activityStatusTone, newestActivities, parseActivityBody } from "../client/activity-presentation";
import { ActivityContent, ActivityStatusBadge } from "../client/components/ActivityContent";
import { setLocale } from "../client/i18n";
import type { ActivityDto } from "../shared/types";

afterEach(() => setLocale("en"));
const render = (body: string, payload: ActivityDto["payload"] = null) => renderToStaticMarkup(<ActivityContent activity={{ body, payload, activityType: "progress" }} pullRequestId={12} />);

it("recognizes only complete object or array results, including fenced JSON", () => {
  expect(parseActivityBody('```json\n{"status":"succeeded","message":"Done"}\n```')).toEqual({ status: "succeeded", message: "Done" });
  expect(parseActivityBody('[{"path":"a.ts"}]')).toEqual([{ path: "a.ts" }]);
  for (const body of ['{"status":', 'A message with {"status":"failed"} inside it', '[a link](/issues/1)', '"message"', '42']) expect(parseActivityBody(body)).toBeNull();
});

it("selects the latest occurrence deterministically without changing the API array", () => {
  const activities = [
    { id: 1, createdAt: "2026-10-27T00:00:00Z", lastOccurredAt: "2026-10-27T02:00:00Z" },
    { id: 3, createdAt: "2026-10-27T01:00:00Z", lastOccurredAt: "2026-10-27T01:00:00Z" },
    { id: 4, createdAt: "2026-10-27T02:00:00Z", lastOccurredAt: "2026-10-27T02:00:00Z" }
  ] as ActivityDto[];
  expect(newestActivities(activities).map((activity) => activity.id)).toEqual([4, 1, 3]);
  expect(activities.map((activity) => activity.id)).toEqual([1, 3, 4]);
});

it("renders a result as badges, a message, file links and readable lists rather than JSON", () => {
  setLocale("ja");
  const html = render(JSON.stringify({ status: "succeeded", message: "検索条件を追加しました。", changedFiles: ["src/filter.ts", "docs/filter.md"],
    questions: ["対象環境を確認してください"], testResults: [{ command: "npm test", status: "passed", exitCode: 0, output: "12 tests passed" }],
    evidence: [{ title: "動作確認", summary: "一覧に条件が反映されることを確認" }], metadata: { verifier: { stopConditionMet: true } } }));
  expect(html).toContain('class="status-pill activity-status status-succeeded"');
  for (const text of ["検索条件を追加しました。", "変更ファイル", "テスト", "終了コード", "動作確認", "npm test", "12 tests passed", "追加情報"]) expect(html).toContain(text);
  expect(html).toContain('href="/pulls/12#');
  expect(html).toContain("<ul");
  expect(html).not.toContain("&quot;changedFiles&quot;");
  expect(html).not.toContain("&quot;status&quot;");
});

it("preserves unknown fields as readable values and escapes untrusted content", () => {
  const html = render(JSON.stringify({ status: "future_state", message: "<script>alert(1)</script>", customMetric: 0, enabled: false, nested: { value: "<img onerror=attack()>" } }));
  expect(html).toContain("custom Metric");
  expect(html).toContain("future_state");
  expect(html).toContain("No");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img onerror=");
  expect(html).toContain("&lt;img");
});

it("formats command payloads and file-change arrays", () => {
  const command = render("npm test\nEverything passed", { command: "npm test", status: "completed", exitCode: 0, durationMs: 1250, cwd: "/project" });
  expect(command).toContain("Everything passed");
  expect(command).toContain("activity-output");
  expect(command).toContain("status-succeeded");
  expect(command).toContain("1.25");
  const files = render('[{"path":"src/a.ts","kind":{"type":"update"}},{"path":"src/b.ts","kind":"add"}]');
  expect(files).toContain("activity-files");
  expect(files).toContain("src/a.ts");
  expect(files).not.toContain("&quot;kind&quot;");
});

it("keeps plain messages readable and puts incomplete JSON behind an explicit disclosure", () => {
  expect(render("Checking **acceptance criteria**.")).toContain("<strong>acceptance criteria</strong>");
  const incomplete = render('{"status":"running","changedFiles":[');
  expect(incomplete).toContain("Show original record");
  expect(incomplete).toContain("incomplete");
  expect(incomplete).toContain("<details");
  expect(incomplete).not.toContain("<details open");
  const fallback = render('{"status":', { status: "failed", message: "Useful error from payload" });
  expect(fallback).toContain("Useful error from payload");
  expect(fallback).toContain("status-failed");
});

it("keeps status semantics independent of the display language", () => {
  setLocale("ja");
  for (const status of ["passed", "completed", "success"]) {
    expect(activityStatusTone(status)).toBe("succeeded");
    expect(renderToStaticMarkup(<ActivityStatusBadge status={status} />)).toContain("status-succeeded");
  }
  expect(activityStatusTone("timed_out")).toBe("failed");
  expect(activityStatusTone("waiting_human")).toBe("waiting");
  expect(activityStatusTone("unknown status <tag>")).toBe("neutral");
});
