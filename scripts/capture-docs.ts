/** Capture real Electron screens with isolated, illustrative data. No LLM calls. */
import { _electron as electron, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createDatabaseContext } from "../src/server/db/client";
import { runMigrations } from "../src/server/db/migrations";
import { createRepositories } from "../src/server/db/repositories";
import { ensureDevelopmentLoop, phaseForAgent, queueDevelopmentJob } from "../src/server/services/development-loop";
import { ensureKnowledgeFiles, knowledgeHash, readKnowledgeBody, replaceKnowledgeBody } from "../src/server/services/knowledge-files";
import { finalizeRetrospective } from "../src/server/services/retrospective";
import type { AgentType } from "../src/shared/types";

const exec = promisify(execFile);
const output = resolve("docs/assets/screenshots");
await mkdir(output, { recursive: true });

const initialSearch = `export function searchNotes(notes, query = "") {
  const term = query.trim().toLocaleLowerCase();
  return notes.filter(note =>
    note.title.toLocaleLowerCase().includes(term)
  );
}

export function emptySearchMessage() {
  return "No notes found.";
}
`;
const improvedSearch = initialSearch.replace('return "No notes found.";', 'return "No matching notes. Try another search or clear your filters.";');
const taggedSearch = `export function searchNotes(notes, query = "", tag = null) {
  const term = query.trim().toLocaleLowerCase();
  return notes.filter(note => {
    const matchesText = note.title.toLocaleLowerCase().includes(term);
    const matchesTag = !tag || note.tags.includes(tag);
    return matchesText && matchesTag;
  });
}

export function emptySearchMessage() {
  return "No matching notes. Try another search or clear your filters.";
}
`;
const initialTests = `import { test } from "node:test";
import { strict as assert } from "node:assert";
import { searchNotes, emptySearchMessage } from "./search.js";

const notes = [
  { title: "Release checklist", tags: ["work"] },
  { title: "Weekend ideas", tags: ["personal"] },
  { title: "Release notes", tags: ["work", "writing"] }
];

test("search matches a title", () => {
  assert.equal(searchNotes(notes, "release").length, 2);
});
test("search ignores case", () => {
  assert.equal(searchNotes(notes, "WEEKEND").length, 1);
});
test("an empty search returns every note", () => {
  assert.equal(searchNotes(notes, "").length, 3);
});
test("unmatched text returns no notes", () => {
  assert.deepEqual(searchNotes(notes, "missing"), []);
});
test("the empty state explains what happened", () => {
  assert.ok(emptySearchMessage().length > 0);
});
`;
const improvedTests = initialTests + `test("the empty state explains how to recover", () => {
  assert.match(emptySearchMessage(), /clear your filters/);
});
`;
const taggedTests = improvedTests + `test("a tag narrows down the results", () => {
  assert.equal(searchNotes(notes, "", "work").length, 2);
});
test("text and tag filters work together", () => {
  assert.equal(searchNotes(notes, "release", "writing").length, 1);
});
test("an unmatched tag has an empty state", () => {
  assert.deepEqual(searchNotes(notes, "", "missing"), []);
});
test("clearing the tag restores the text results", () => {
  assert.equal(searchNotes(notes, "release", null).length, 2);
});
`;

async function capture(locale: "en" | "ja") {
  const root = await mkdtemp("/tmp/oneteam-docs-");
  const repoPath = join(root, "field-notes");
  const appHome = join(root, "app-data");
  const databaseUrl = `file:${join(repoPath, ".oneteam/data/oneteam.db")}`;
  const git = async (...args: string[]) => (await exec("git", args, { cwd: repoPath })).stdout.trim();
  const t = (en: string, ja: string) => locale === "ja" ? ja : en;
  let desktop: Awaited<ReturnType<typeof electron.launch>> | undefined;
  let context: ReturnType<typeof createDatabaseContext> | undefined;
  try {
    await mkdir(join(repoPath, "src"), { recursive: true });
    await mkdir(appHome, { recursive: true });
    await writeFile(join(repoPath, "package.json"), JSON.stringify({ name: "field-notes-demo", private: true, type: "module", scripts: { test: "node --test src/search.test.js" } }, null, 2));
    await writeFile(join(repoPath, "README.md"), "# Field Notes\n\nA sample notebook for OneTeam documentation.\n");
    await writeFile(join(repoPath, "src/search.js"), initialSearch);
    await writeFile(join(repoPath, "src/search.test.js"), initialTests);
    await git("init", "-b", "main");
    await git("config", "user.name", "OneTeam Demo");
    await git("config", "user.email", "demo@example.com");
    await git("add", ".");
    await git("commit", "-m", "Create Field Notes search");
    await git("switch", "-c", "improve-empty-search");
    await writeFile(join(repoPath, "src/search.js"), improvedSearch);
    await writeFile(join(repoPath, "src/search.test.js"), improvedTests);
    await exec(process.execPath, ["--test", "src/search.test.js"], { cwd: repoPath });
    await git("add", ".");
    await git("commit", "-m", "Explain how to recover from an empty search");
    await git("switch", "main");
    await git("merge", "--no-ff", "improve-empty-search", "-m", "Merge PR #1: Improve empty search");
    const mergeCommit = await git("rev-parse", "HEAD");
    await git("switch", "-c", "filter-notes-by-tag");
    await writeFile(join(repoPath, "src/search.js"), taggedSearch);
    await writeFile(join(repoPath, "src/search.test.js"), taggedTests);
    const testOutput = (await exec(process.execPath, ["--test", "src/search.test.js"], { cwd: repoPath })).stdout;
    await git("add", ".");
    await git("commit", "-m", "Combine text search with tag filters");
    await git("switch", "main");

    context = createDatabaseContext(databaseUrl);
    await runMigrations(context.client);
    const repos = createRepositories(context.db);
    const project = await repos.projects.create({ name: t("Field Notes · Demo", "Field Notes · サンプル"), repoPath, defaultBranch: "main", locale });
    await ensureKnowledgeFiles(repoPath);
    await replaceKnowledgeBody(repoPath, "AGENTS.md", t("# Field Notes\n\nRun `npm test` after changes to search.\n", "# Field Notes\n\n検索を変更したら `npm test` を実行する。\n"));
    const issue1 = await repos.issues.create({ projectId: project.id, title: t("Make empty search results helpful", "検索結果がないときの案内を改善する"), body: t("Explain why the search is empty and how to clear it. Add a regression test.", "検索結果が0件のときに、状況と検索条件をリセットできることを伝える。回帰テストも追加する。") });
    const loop1 = await ensureDevelopmentLoop(repos, project.id, issue1.id);
    const pr1 = await repos.pullRequests.create({ projectId: project.id, issueId: issue1.id, title: issue1.title, sourceBranch: "improve-empty-search", targetBranch: "main", createdByType: "agent" });
    await repos.development.update(project.id, loop1.id, { pullRequestId: pr1.id, mergeCommit });
    await repos.objectives.update(project.id, loop1.objectiveId!, { pullRequestId: pr1.id, workflowStage: "merged", status: "succeeded", stopReason: "merged", finishedAt: new Date().toISOString() });
    await repos.issues.update(project.id, issue1.id, { status: "closed" });
    await repos.pullRequests.update(project.id, pr1.id, { status: "merged" });

    async function job(loopId: number, role: AgentType, message: string, running = false, extra: Record<string, unknown> = {}) {
      const loop = await repos.development.update(project.id, loopId, { nextAgent: role, phase: phaseForAgent(role), summary: message, currentJobId: null });
      const created = await queueDevelopmentJob(repos, loop);
      const model = role === "requirements" ? "gpt-5.4-mini" : "gpt-5.5";
      await repos.development.setJobModel(project.id, created.id, model);
      await repos.agentJobs.updateStatus(project.id, created.id, "running", { output: { message, ...extra } });
      const execution = await repos.development.executions.create({ projectId: project.id, jobId: created.id, selectedModel: model, effort: role === "review" ? "high" : "medium", selectionReason: t("Example selection: cross-check combined filters and regression coverage against the previous loop’s testing guidance.", "選択理由の例：複合フィルターの条件と回帰テストを、前のLoopで得た検証方針に照らしてレビューする。"), policyVersion: "documentation-sample" });
      await repos.development.executions.update(project.id, execution.id, { resolvedModel: model, status: running ? "running" : "succeeded", threadId: `demo-thread-${created.id}`, turnId: `demo-turn-${created.id}`, finishedAt: running ? null : new Date().toISOString() });
      if (!running) await repos.agentJobs.updateStatus(project.id, created.id, "succeeded");
      return (await repos.agentJobs.get(project.id, created.id))!;
    }

    for (const role of ["requirements", "implementation", "review", "qa", "verifier"] as const) {
      await job(loop1.id, role, t("Empty-state guidance and its regression tests are ready.", "空状態の案内と回帰テストを確認しました。"));
    }
    const knowledgeBefore = await readKnowledgeBody(repoPath, "AGENTS.md");
    const knowledgeAfter = t("# Field Notes\n\nRun `npm test` after changes to search.\nTest normal results, empty results, and clearing filters.\nSee knowledge/search-testing.md for the checklist.\n", "# Field Notes\n\n検索を変更したら `npm test` を実行する。\n通常の結果・空の状態・条件のリセットを検証する。\n詳細は knowledge/search-testing.md を参照。\n");
    const retro = await job(loop1.id, "retrospective", t("Save a reusable checklist for search changes", "検索改善で得たテスト方針を、次のタスクへ"), false, { metadata: { retrospective: {
      body: t("### What we learned\nAn empty search needs an explanation and a way back.\n\n### For the next task\nTest normal results, empty results, and clearing filters together. Apply the same checklist when adding tag search.", "### 今回わかったこと\n検索結果が0件のときは、状況の説明と元に戻す導線をセットで用意する。\n\n### 次のタスクで使うこと\n通常の結果・空の状態・条件のリセットをまとめて検証する。タグ検索の追加にも同じ観点を使う。"),
      changes: [
        { path: "AGENTS.md", beforeHash: knowledgeHash(knowledgeBefore), body: knowledgeAfter, reason: t("Keep the tested recovery behavior in the guidance read by the next task.", "検証した復帰操作の観点を、次のタスクが読む共通指針に残す。") },
        { path: "knowledge/search-testing.md", beforeHash: null, body: t("# Search checklist\n\n- Normal matches and unmatched text\n- Empty results with a recovery hint\n- Clearing filters restores results\n- Combine text and tag filters\n", "# 検索の検証チェックリスト\n\n- 通常の一致と、該当しない検索語\n- 空の結果と復帰方法の案内\n- 条件解除で結果が戻ること\n- テキストとタグの組み合わせ\n"), reason: t("Reuse this checklist for tag filtering.", "タグ絞り込みでも使える検証項目を整理する。") }
      ]
    } } });
    await finalizeRetrospective(repos, project, (await repos.development.get(project.id, loop1.id))!, retro);

    const issue2 = await repos.issues.create({ projectId: project.id, title: t("Filter saved notes by tag", "保存したノートをタグで絞り込む"), body: t("## What to build\nFind saved notes by combining a search term with a tag.\n\n## Acceptance criteria\n- Combine text search and a selected tag.\n- Explain an empty result and offer a way to reset.\n- Clearing the tag restores the matching notes.\n\nUse the search checklist saved by Loop #1.", "## つくりたいこと\n検索語とタグを組み合わせて、保存したノートを探せるようにする。\n\n## できあがりの条件\n- テキスト検索と選択したタグを組み合わせられる。\n- 結果が0件なら、案内とリセット方法を表示する。\n- タグを解除すると、検索結果が元に戻る。\n\nLoop #1で保存した検索チェックリストを使ってください。") });
    const loop2 = await ensureDevelopmentLoop(repos, project.id, issue2.id);
    const pr2 = await repos.pullRequests.create({ projectId: project.id, issueId: issue2.id, title: t("Add tag filters to note search", "ノート検索にタグの絞り込みを追加"), body: t("## Changes\nCombine tags with text search and preserve the empty-state recovery hint.\n\n## Verification\n`npm test`: 10 tests passed.\n\nCloses #2. Uses the knowledge from Loop #1.", "## 変更内容\nテキスト検索とタグを組み合わせ、空状態から復帰する案内を維持します。\n\n## 検証\n`npm test`：10件のテストに成功。\n\nIssue #2 に対応。Loop #1の知識を引き継いでいます。"), sourceBranch: "filter-notes-by-tag", targetBranch: "main", createdByType: "agent" });
    await repos.development.update(project.id, loop2.id, { pullRequestId: pr2.id });
    await repos.objectives.update(project.id, loop2.objectiveId!, { pullRequestId: pr2.id, workflowStage: "review", status: "running" });
    await job(loop2.id, "requirements", t("Acceptance criteria ready; loaded the search checklist from Loop #1.", "完了条件を整理。Loop #1の検索チェックリストを読み込みました。"));
    await job(loop2.id, "implementation", t("PR #2 is ready for review. Text and tag filters are implemented; 10 tests passed.", "PR #2を作成。テキストとタグの絞り込みを実装し、10件のテストに成功しました。"), false, { changedFiles: ["src/search.js", "src/search.test.js"], testResults: [{ command: "npm test", status: "passed", exitCode: 0, output: testOutput }] });
    const review = await job(loop2.id, "review", t("Reviewing the combined filters and empty-state recovery.", "タグと検索語の組み合わせ、空状態からの復帰操作をレビュー中です。"), true);
    await repos.objectives.update(project.id, loop2.objectiveId!, { lastAgentJobId: review.id, evidence: { items: [
      { type: "command_result", title: "npm test", summary: "10 tests passed", payload: { command: "npm test", exitCode: 0, output: testOutput } },
      { type: "file_change", title: "Search implementation and regression tests", summary: "src/search.js, src/search.test.js", payload: { sourceCommit: await git("rev-parse", "filter-notes-by-tag") } }
    ] } });
    for (const [title, body] of [
      [t("Knowledge loaded from Loop #1", "Loop #1の知識を読み込み"), t("Loaded `AGENTS.md` and `knowledge/search-testing.md`: test matches, empty results, and clearing filters.", "`AGENTS.md` と `knowledge/search-testing.md` を参照。通常の結果・空状態・条件解除の観点を引き継ぎます。")],
      [t("Reviewing the pull request", "PRの差分を確認中"), t("Inspecting `src/search.js` and `src/search.test.js`. Checking that text and tag filters are combined with AND.", "`src/search.js` と `src/search.test.js` を確認。検索語とタグがAND条件になっているかを調べています。")],
      [t("Regression checks", "回帰テストの確認"), t("Implementation checks: **10 tests passed**. Now reviewing the reset behavior and coverage for an unknown tag.", "実装時の検証：**10件のテストに成功**。条件のリセットと、存在しないタグのテストを確認しています。")]
    ]) await repos.activities.create({ projectId: project.id, agentJobId: review.id, targetType: "pull_request", targetId: pr2.id, activityType: "system", title, body });
    await repos.comments.create({ projectId: project.id, targetType: "issue", targetId: issue2.id, authorType: "agent", agentType: "implementation", body: t("### Implementation ready\nCreated PR #2 with the tag filter and four regression checks.\n\n- Reused the empty-state guidance from Loop #1.\n- `npm test`: **10 passed**.\n- Review is now checking combined filters and reset behavior.", "### 実装できました\nタグの絞り込みと4件の回帰テストを追加し、PR #2を作成しました。\n\n- Loop #1の空状態に関する指針を再利用。\n- `npm test`：**10件成功**。\n- 現在、レビューが組み合わせ条件とリセット操作を確認中です。") });
    for (const title of [t("Focus search with the keyboard", "キーボードから検索欄へ移動する"), t("Explain how to organize notes with tags", "タグでノートを整理する使い方を追加")]) {
      const issue = await repos.issues.create({ projectId: project.id, title, body: t("Follow up after tag search is complete.", "タグ検索が完成したら、続けて改善する。") });
      await ensureDevelopmentLoop(repos, project.id, issue.id);
    }
    context.client.close();
    context = undefined;

    const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && key !== "ELECTRON_RUN_AS_NODE")) as Record<string, string>;
    desktop = await electron.launch({ args: [resolve(".")], env: { ...env, ONETEAM_HOME: appHome, ONETEAM_DATABASE_URL: databaseUrl, ONETEAM_AGENT_WORKER: "false", ONETEAM_CODEX_AUTO_LOGIN: "false" } });
    const page = await desktop.firstWindow();
    await desktop.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setContentSize(1440, 1040); });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(page.locator(".work-item-list")).toBeVisible();
    const origin = new URL(page.url()).origin;
    const shot = async (name: string, fullPage = false) => {
      await expect(page.locator(".error-banner, .async-state-error")).toHaveCount(0);
      await page.locator(".header-brand").click();
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: join(output, `${name}-${locale}.png`), animations: "disabled", fullPage });
      console.log(`Captured ${name}-${locale}.png`);
    };
    await page.goto(`${origin}/issues/${issue2.id}`);
    await expect(page.locator(".development-loop-card")).toContainText(t("Review", "レビュー"));
    await expect(page.locator(".conversation-comment")).toBeVisible();
    await shot("issue");
    await page.goto(`${origin}/pulls/${pr2.id}`);
    await page.locator("#pull-request-tab-files").click();
    await expect(page.locator(".diff-table")).toBeVisible();
    await shot("pull-request", true);
    await page.goto(`${origin}/jobs/${review.id}`);
    await expect(page.locator(".execution-record")).toContainText("gpt-5.5");
    await expect(page.locator(".activity-item")).toHaveCount(3);
    await page.locator(".agent-job-main-content").screenshot({ path: join(output, `agent-${locale}.png`), animations: "disabled" });
    console.log(`Captured agent-${locale}.png`);
    await page.goto(`${origin}/jobs`);
    const loopCard = page.locator(".development-loop-card").filter({ has: page.locator('header a[href="/issues/1"]') });
    await loopCard.locator(":scope > details > summary").click();
    await expect(loopCard.locator(".knowledge-revision")).toHaveCount(3);
    const revision = loopCard.locator(".knowledge-revision").filter({ has: page.locator("summary", { hasText: /^AGENTS\.md/ }) });
    await revision.locator("summary").click();
    await expect(revision.locator("pre")).toHaveCount(2);
    await loopCard.screenshot({ path: join(output, `retrospective-${locale}.png`), animations: "disabled" });
    console.log(`Captured retrospective-${locale}.png`);
    // Confirm the screenshots display the same knowledge actually persisted on disk.
    expect(await readFile(join(repoPath, ".oneteam/AGENTS.md"), "utf8")).toBe(knowledgeAfter);
  } finally {
    await desktop?.close();
    context?.client.close();
    await rm(root, { recursive: true, force: true });
  }
}

await capture("ja");
await capture("en");
