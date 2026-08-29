import { expect, test } from "@playwright/test";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { diffLineAnchor } from "../src/shared/diff-anchors";
import { expectScreenContrast } from "./accessibility";

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
  await expectScreenContrast(page, "project picker");
  await page.getByRole("button", { name: "Add repository" }).click();
  await expect(page.getByRole("heading", { name: "Setup" })).toBeVisible();
  await expectScreenContrast(page, "repository setup");
  await page.getByLabel("Name").fill("E2E Project");
  await page.getByLabel("Path").fill(repoPath);
  await page.getByRole("button", { name: "Create project" }).click();

  await expect(page.getByRole("heading", { name: "Issues" })).toBeVisible();
  await expectScreenContrast(page, "issues list");
  await expect(page.locator(".repository-identity")).toContainText("E2E Project");
  await expect(page.locator(".repository-identity")).toContainText("Local");
  await expect(page.getByRole("navigation", { name: "Repository navigation" })).toBeVisible();
  await expect(page.getByText("No issues")).toBeVisible();
  const skipLink = page.getByRole("link", { name: "Skip to content" });
  await skipLink.focus();
  await expect(skipLink).toBeVisible();
  await skipLink.click();
  await expect(page.locator("main#main-content")).toBeFocused();
  const toolsButton = page.getByRole("button", { name: "Project and settings" });
  await toolsButton.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Projects" })).toBeFocused();
  await page.keyboard.press("End");
  await expect(page.getByRole("menuitem", { name: "Settings" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(toolsButton).toBeFocused();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.getByRole("button", { name: "Agent runs" }).click();
  await expect(page.locator("main#main-content")).toBeFocused();
  await page.getByRole("button", { name: "Issues", exact: true }).click();
  await expect(page.locator("main#main-content")).toBeFocused();

  await page.getByRole("button", { name: "New issue" }).click();
  await expect(page.getByRole("heading", { name: "New issue" })).toBeVisible();
  await page.getByLabel("Title").fill("Add smoke workflow");
  await page.getByLabel("Body").fill("Exercise setup, label automation, and job controls.");
  await page.getByRole("button", { name: "Create" }).click();

  await expect(page.getByRole("heading", { name: /#1 Add smoke workflow/ })).toBeVisible();
  await expectScreenContrast(page, "issue detail");
  await expect(page.locator(".label-pill", { hasText: "requirements" })).toBeVisible();
  await expect(page.locator(".conversation-activity").filter({ hasText: "Labels applied" })).toBeVisible();
  await expect(page.locator(".conversation-activity").filter({ hasText: "Labels applied" }).locator(".conversation-permalink")).toHaveAttribute("href", /^#activity-\d+$/);
  await expect(page.locator(".work-item-detail-meta")).toContainText("user");
  await expect(page.locator(".automation-checks")).toContainText("requirements");
  await expect(page.locator(".automation-checks")).toContainText("queued");
  await expect(page.locator(".automation-check-links")).toContainText("Activities");
  await expect(page.locator(".objective-stage-summary")).toContainText("Requirements");

  const projectsResponse = await page.request.get("/api/projects");
  const projects = (await projectsResponse.json()) as { items: Array<{ id: string }> };
  const projectId = projects.items[0].id;
  const database = createClient({ url: `file:${resolve(".tmp/e2e/oneteam.db")}` });
  const timestamp = new Date().toISOString();
  await database.execute({
    sql: `INSERT INTO comments (
      project_id, target_type, target_id, author_type, agent_type, body, body_format, metadata_json, created_at, updated_at
    ) VALUES (?, 'issue', 1, 'system', NULL, ?, 'html', NULL, ?, ?)`,
    args: [
      projectId,
      `<section class="app-shell" data-private="secret" style="color: #0969da; display: grid; position: fixed; background-image: url(https://example.com/a)">
        <h2>Sanitizer security report</h2>
        <a href="javascript:alert(1)" onclick="alert(1)">Unsafe link</a>
        <a href="/issues/1">Safe local link</a>
        <img alt="Remote tracker" src="https://example.com/tracker.png" onerror="alert(1)" />
        <img alt="Local artifact" src="/api/health" width="640" height="9999" />
        <script>window.__unsafeHtmlExecuted = true</script>
        <iframe src="https://example.com"></iframe>
      </section>`,
      timestamp,
      timestamp
    ]
  });
  database.close();
  await page.getByRole("button", { name: "Issues", exact: true }).click();
  const smokeIssue = page.getByRole("button", { name: /Add smoke workflow/ });
  await smokeIssue.focus();
  await smokeIssue.press("Enter");
  const sanitizedReport = page.locator(".html-body section").filter({ hasText: "Sanitizer security report" });
  await expect(sanitizedReport).toBeVisible();
  await expect(sanitizedReport).not.toHaveAttribute("class");
  await expect(sanitizedReport).not.toHaveAttribute("data-private");
  await expect(sanitizedReport).toHaveAttribute("style", /color: #0969da; display: grid/);
  await expect(sanitizedReport).not.toHaveAttribute("style", /position|background-image|url/i);
  await expect(sanitizedReport.getByText("Unsafe link")).not.toHaveAttribute("href");
  await expect(sanitizedReport.getByText("Unsafe link")).not.toHaveAttribute("onclick");
  await expect(sanitizedReport.getByRole("link", { name: "Safe local link" })).toHaveAttribute("href", "/issues/1");
  await expect(sanitizedReport.getByRole("link", { name: "Safe local link" })).toHaveAttribute("rel", "noreferrer noopener");
  await expect(sanitizedReport.getByAltText("Remote tracker")).not.toHaveAttribute("src");
  await expect(sanitizedReport.getByAltText("Local artifact")).toHaveAttribute("src", "/api/health");
  await expect(sanitizedReport.getByAltText("Local artifact")).toHaveAttribute("loading", "lazy");
  await expect(sanitizedReport.getByAltText("Local artifact")).toHaveAttribute("referrerpolicy", "no-referrer");
  await expect(sanitizedReport.getByAltText("Local artifact")).toHaveAttribute("width", "640");
  await expect(sanitizedReport.getByAltText("Local artifact")).not.toHaveAttribute("height");
  await expect(sanitizedReport.locator("script, iframe")).toHaveCount(0);
  expect(await page.evaluate(() => "__unsafeHtmlExecuted" in window)).toBe(false);
  const systemCommentCard = page.locator(".conversation-comment").filter({ hasText: "Sanitizer security report" });
  await expect(systemCommentCard.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);

  await page.locator(".comment-form textarea").fill("Initial **implementation note**.");
  await page.getByRole("button", { name: "Add comment" }).click();
  const initialUserComment = page.locator(".conversation-comment").filter({
    has: page.locator("header strong", { hasText: /^user$/ })
  }).last();
  await expect(initialUserComment).toBeVisible();
  await expect(initialUserComment).toContainText("Initial implementation note");
  await initialUserComment.getByRole("button", { name: "Edit", exact: true }).click();
  await initialUserComment.getByLabel("Edit comment").fill("Clarified **implementation note** with audit context.");
  await initialUserComment.getByRole("button", { name: "Save", exact: true }).click();
  const editedUserComment = page.locator(".conversation-comment").filter({ hasText: "Clarified implementation note" });
  await expect(editedUserComment).toBeVisible();
  await expect(editedUserComment.getByRole("button", { name: /^Edited/ })).toBeVisible();
  await editedUserComment.getByRole("button", { name: /^Edited/ }).click();
  await expect(editedUserComment.locator(".comment-revision-history")).toContainText("Initial implementation note");

  await page.getByRole("button", { name: "Pause automation" }).click();
  await expect(page.locator(".objective-panel .status-pill")).toHaveText("paused");
  await expect(page.locator(".objective-stage-summary")).toContainText("Requirements");
  await page.getByRole("button", { name: "Resume automation" }).click();
  await expect(page.locator(".objective-panel .status-pill")).toHaveText("running");
  await page.getByRole("button", { name: "Close issue" }).click();
  await expect(page.locator(".page-title-block .status-pill")).toHaveText("closed");
  await page.getByRole("button", { name: "Reopen issue" }).click();
  await expect(page.locator(".page-title-block .status-pill")).toHaveText("open");
  await expect(page.locator(".conversation-activity").filter({ hasText: "Issue closed" })).toBeVisible();
  await expect(page.locator(".conversation-activity").filter({ hasText: "Existing Objective selected after reopen" })).toBeVisible();
  await expect(page.getByText("Existing Objective selected after reopen").first()).toBeVisible();
  await page.locator(".page-toolbar").getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByLabel("Body")).toHaveValue("Exercise setup, label automation, and job controls.");
  await page.getByLabel("Body").fill("Exercise setup, label automation, job controls, and Goal Contract auditing.");
  await page.getByLabel("Goal Contract change reason").fill("Include the newly required contract audit flow.");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Goal Contract changed").first()).toBeVisible();
  await expect(page.locator(".conversation-activity").filter({ hasText: "Goal Contract changed" })).toBeVisible();

  await page.getByRole("button", { name: "Issues", exact: true }).click();
  const issueSummary = page.locator(".work-item-rich").filter({ hasText: "Add smoke workflow" });
  await expect(issueSummary).toContainText("requirements");
  await expect(issueSummary.locator(".work-item-author")).toHaveText("user");
  await expect(issueSummary.locator(".work-item-check")).toContainText("queued");

  const triageResponses = await Promise.all([
    page.request.post(`/api/projects/${projectId}/triage-items`, {
      data: {
        sourceType: "scheduler",
        title: "Investigate flaky smoke check",
        body: "## Evidence\n\n- `npm test` failed once\n- Review before implementation",
        priority: "high",
        metadata: { discovery: "verification_failure", schedulerKey: "e2e:verification" }
      }
    }),
    page.request.post(`/api/projects/${projectId}/triage-items`, {
      data: {
        sourceType: "scheduler",
        title: "Ignore intentional TODO",
        body: "This marker is intentionally long-lived.",
        priority: "normal",
        metadata: { discovery: "todo_fixme", schedulerKey: "e2e:todo" }
      }
    })
  ]);
  expect(triageResponses.every((response) => response.ok())).toBe(true);
  await page.getByRole("button", { name: "Agent runs" }).click();
  await expect(page.getByRole("heading", { name: "Agent Jobs" })).toBeVisible();
  await expectScreenContrast(page, "agent runs list");
  await page.getByRole("button", { name: "Issues", exact: true }).click();
  const triageInbox = page.getByRole("region", { name: "Triage notifications" });
  await expect(triageInbox).toBeVisible();
  await expect(triageInbox.locator(".counter-badge")).toHaveText("2");
  const ignoredTriage = triageInbox.locator(".issue-triage-item").filter({ hasText: "Ignore intentional TODO" });
  await ignoredTriage.getByRole("button", { name: "Ignore", exact: true }).click();
  await expect(ignoredTriage).toHaveCount(0);
  const convertedTriage = triageInbox.locator(".issue-triage-item").filter({ hasText: "Investigate flaky smoke check" });
  await expect(convertedTriage).toContainText("npm test");
  await convertedTriage.getByRole("button", { name: "Convert to issue", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Investigate flaky smoke check/ })).toBeVisible();

  await page.getByRole("button", { name: "Agent runs" }).click();
  await expect(page.getByRole("heading", { name: "Agent Jobs" })).toBeVisible();
  const requirementsJob = page.locator(".agent-job-summary").filter({ hasText: "requirements" }).first();
  await expect(requirementsJob).toContainText("queued");
  await requirementsJob.focus();
  await requirementsJob.press("Enter");
  await expect(page.getByRole("heading", { name: /#\d+ requirements/ })).toBeVisible();
  await expectScreenContrast(page, "agent run detail");
  await expect(page.locator("#job-activities")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator(".page-title-block")).toContainText("canceled");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.locator(".page-title-block")).toContainText("queued");

  const artifactJobResponse = await page.request.post(`/api/projects/${projectId}/agent-jobs`, {
    data: { agentType: "qa", targetType: "project", targetId: 0, triggerType: "e2e_artifact" }
  });
  expect(artifactJobResponse.ok()).toBe(true);
  const artifactJob = (await artifactJobResponse.json()) as { job: { id: number } };
  const artifactName = "01-qa-dashboard.png";
  const artifactDirectory = resolve(repoPath, ".oneteam", "data", "artifacts", `job-${artifactJob.job.id}`);
  mkdirSync(artifactDirectory, { recursive: true });
  writeFileSync(
    resolve(artifactDirectory, artifactName),
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")
  );
  const artifactDatabase = createClient({ url: `file:${resolve(".tmp/e2e/oneteam.db")}` });
  await artifactDatabase.execute({
    sql: "UPDATE agent_jobs SET status = 'succeeded', output_json = ?, started_at = ?, finished_at = ? WHERE id = ?",
    args: [
      JSON.stringify({
        status: "succeeded",
        message: "Visual QA passed.",
        stopReason: "passed",
        evidence: [
          {
            type: "screenshot",
            title: "Dashboard visual check",
            summary: "The dashboard remained readable.",
            payload: {
              artifact: {
                kind: "image",
                status: "available",
                name: artifactName,
                caption: "QA dashboard",
                mediaType: "image/png",
                byteSize: 68,
                url: `/api/projects/${projectId}/agent-jobs/${artifactJob.job.id}/artifacts/${artifactName}`
              }
            }
          }
        ]
      }),
      timestamp,
      timestamp,
      artifactJob.job.id
    ]
  });
  artifactDatabase.close();
  await page.getByRole("button", { name: "Agent runs" }).click();
  const qaArtifactJob = page.locator(".agent-job-summary").filter({ hasText: `#${artifactJob.job.id} qa` });
  await expect(qaArtifactJob).toContainText("succeeded");
  await qaArtifactJob.click();
  const artifactPreview = page.getByAltText("QA dashboard");
  await expect(artifactPreview).toBeVisible();
  await expect(artifactPreview).toHaveAttribute(
    "src",
    `/api/projects/${projectId}/agent-jobs/${artifactJob.job.id}/artifacts/${artifactName}`
  );
  await expect(page.locator(".evidence-image-artifact figcaption")).toContainText("image/png");

  await page.getByRole("button", { name: "Repository", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Repository" })).toBeVisible();
  await expectScreenContrast(page, "repository overview");
  await expect(page.getByText("npm run build")).toBeVisible();
  await expect(page.getByText("npm run test")).toBeVisible();
  await expect(page.getByText("npm run lint")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Commit history" })).toBeVisible();
  const repositoryCommit = page.locator(".repository-commit").first();
  await expect(repositoryCommit).toBeVisible();
  await expect(repositoryCommit).toHaveAttribute("id", /^commit-[0-9a-f]{40}$/);
  await repositoryCommit.locator(".repository-commit-hash").focus();
  await repositoryCommit.locator(".repository-commit-hash").press("Enter");
  await expect(page).toHaveURL(/\/repository#commit-[0-9a-f]{40}$/);

  await page.getByRole("button", { name: "Project and settings" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expectScreenContrast(page, "settings");
  await page.getByLabel("Automatic merge target branches").fill("main, release");
  await page.getByLabel("Merge strategy").selectOption("squash");
  await page.getByLabel("Diff risk threshold").selectOption("high");
  await page.getByLabel("Default max rounds for new Objectives").fill("24");
  await page.getByLabel("Implementation AI provider").selectOption("claude_code");
  await page.getByLabel("Implementation Model").fill("claude-implementation");
  await page.getByLabel("Verification AI provider").selectOption("codex");
  await page.getByLabel("Verification Model").fill("gpt-verifier");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Settings saved")).toBeVisible();
  await page.getByRole("button", { name: "Repository", exact: true }).click();
  await page.getByRole("button", { name: "Project and settings" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await expect(page.getByLabel("Automatic merge target branches")).toHaveValue("main, release");
  await expect(page.getByLabel("Merge strategy")).toHaveValue("squash");
  await expect(page.getByLabel("Diff risk threshold")).toHaveValue("high");
  await expect(page.getByLabel("Default max rounds for new Objectives")).toHaveValue("24");
  await expect(page.getByLabel("Implementation AI provider")).toHaveValue("claude_code");
  await expect(page.getByLabel("Implementation Model")).toHaveValue("claude-implementation");
  await expect(page.getByLabel("Verification AI provider")).toHaveValue("codex");
  await expect(page.getByLabel("Verification Model")).toHaveValue("gpt-verifier");
  await page.getByRole("button", { name: "Project and settings" }).press("ArrowDown");
  await page.getByRole("menuitem", { name: "Projects" }).press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Loops" })).toBeFocused();
  await page.getByRole("menuitem", { name: "Loops" }).press("Enter");
  await expect(page.getByRole("heading", { name: "Loops", exact: true })).toBeVisible();
  await expectScreenContrast(page, "loops and memory");

  execFileSync("git", ["checkout", "-b", "feature/large-diff"], { cwd: repoPath });
  const longDiffPath = [
    "src",
    "features",
    "automation",
    "orchestration",
    "provider-usage-recovery",
    "review-evidence",
    "components",
    "provider-usage-recovery-status-panel-with-verification-evidence.tsx"
  ].join("/");
  writeFileSync(
    resolve(repoPath, "large.ts"),
    Array.from({ length: 6_000 }, (_, index) => `export const value${index + 1} = ${index + 1};`).join("\n") + "\n"
  );
  mkdirSync(resolve(repoPath, longDiffPath, ".."), { recursive: true });
  writeFileSync(resolve(repoPath, longDiffPath), "export const recoveryStatus = \"waiting-for-usage-reset\";\n");
  execFileSync("git", ["add", "large.ts", longDiffPath], { cwd: repoPath });
  execFileSync("git", ["commit", "-m", "add large diff fixture"], { cwd: repoPath });

  const pullRequestResponse = await page.request.post(`/api/projects/${projectId}/pull-requests`, {
    data: {
      title: "Review a large generated diff",
      body: "Exercises bounded progressive diff rendering.",
      sourceBranch: "feature/large-diff",
      targetBranch: "main"
    }
  });
  expect(pullRequestResponse.ok()).toBe(true);
  const createdPullRequest = (await pullRequestResponse.json()) as { pullRequest: { id: number } };
  const findingJobResponse = await page.request.post(`/api/projects/${projectId}/agent-jobs`, {
    data: {
      agentType: "review",
      targetType: "pull_request",
      targetId: createdPullRequest.pullRequest.id,
      triggerType: "e2e_finding"
    }
  });
  expect(findingJobResponse.ok()).toBe(true);
  const findingJob = (await findingJobResponse.json()) as { job: { id: number } };
  const bilingualReportDatabase = createClient({ url: `file:${resolve(".tmp/e2e/oneteam.db")}` });
  const bilingualReportTimestamp = new Date().toISOString();
  await bilingualReportDatabase.execute({
    sql: "UPDATE agent_jobs SET status = 'succeeded', output_json = ?, started_at = ?, finished_at = ? WHERE id = ?",
    args: [
      JSON.stringify({
        status: "succeeded",
        message: "Review found an important line.",
        metadata: {
          review: {
            verdict: "changes_requested",
            findings: [{
              severity: "high",
              path: "large.ts",
              line: 1_500,
              side: "R",
              title: "Keep generated value stable",
              body: "The generated value is part of the compatibility fixture."
            }],
            checked: ["large diff stability"]
          }
        }
      }),
      bilingualReportTimestamp,
      bilingualReportTimestamp,
      findingJob.job.id
    ]
  });
  await bilingualReportDatabase.execute({
    sql: `INSERT INTO comments (
      project_id, target_type, target_id, author_type, agent_type, body, body_format, metadata_json, created_at, updated_at
    ) VALUES (?, 'pull_request', ?, 'system', NULL, ?, 'html', NULL, ?, ?)`,
    args: [
      projectId,
      createdPullRequest.pullRequest.id,
      `<section>
        <h2>Bilingual verification report / 日英表示検証レポート</h2>
        <p>Checks, evidence, and implementation decisions remain scannable after switching locale.</p>
        <table>
          <thead><tr><th>Gate / 判定</th><th>Evidence / 証拠</th><th>Next action / 次の処理</th></tr></thead>
          <tbody><tr>
            <td><strong>Verifier passed</strong></td>
            <td><div style="width: 1600px"><code>${longDiffPath}</code> was reviewed against the required checks and retained as stable audit evidence.</div></td>
            <td>Continue automatic review and merge processing.</td>
          </tr></tbody>
        </table>
      </section>`,
      bilingualReportTimestamp,
      bilingualReportTimestamp
    ]
  });
  bilingualReportDatabase.close();

  await page.getByRole("button", { name: "Pull Requests" }).click();
  await expectScreenContrast(page, "pull requests list");
  const pullRequestSummary = page.locator(".work-item-rich").filter({ hasText: "Review a large generated diff" });
  await expect(pullRequestSummary).toContainText("feature/large-diff");
  await expect(pullRequestSummary.locator(".work-item-author")).toHaveText("user");
  await expect(pullRequestSummary.locator(".work-item-stats")).toContainText("2");
  const pullRequestListButton = page.getByRole("button", { name: /Review a large generated diff/ });
  await pullRequestListButton.focus();
  await pullRequestListButton.press("Enter");
  await expect(page.locator(".work-item-detail-meta")).toContainText("user");
  await expectScreenContrast(page, "pull request conversation");
  const pullRequestTabs = page.getByRole("tablist", { name: "Pull request sections" });
  const conversationTab = pullRequestTabs.getByRole("tab", { name: "Conversation" });
  const filesTab = pullRequestTabs.getByRole("tab", { name: "Files changed" });
  const commitsTab = pullRequestTabs.getByRole("tab", { name: "Commits" });
  await expect(conversationTab).toHaveAttribute("aria-selected", "true");
  await conversationTab.focus();
  await conversationTab.press("ArrowRight");
  await expect(filesTab).toBeFocused();
  await expect(filesTab).toHaveAttribute("aria-selected", "true");
  await filesTab.press("End");
  await expect(commitsTab).toBeFocused();
  await expect(commitsTab).toHaveAttribute("aria-selected", "true");
  await commitsTab.press("Home");
  await expect(conversationTab).toBeFocused();
  await expect(conversationTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".automation-checks")).toContainText("review");
  const findingLineLink = page.getByRole("link", { name: "HIGH large.ts:1500" });
  await expect(findingLineLink).toHaveAttribute("href", new RegExp(`#${diffLineAnchor("large.ts", "R", 1_500)}$`));
  await findingLineLink.click();
  await expect(page).toHaveURL(new RegExp(`#${diffLineAnchor("large.ts", "R", 1_500)}$`));
  await expect(page.locator(`#${diffLineAnchor("large.ts", "R", 1_500)}`)).toBeVisible();
  await expect(page.locator("a.diff-finding-card")).toHaveAttribute("href", `#${diffLineAnchor("large.ts", "R", 1_500)}`);
  await expectScreenContrast(page, "pull request diff");
  await expect.poll(async () => page.evaluate(() => {
    const load = performance.getEntriesByName("oneteam:diff-load").at(-1);
    const render = performance.getEntriesByName("oneteam:diff-render").at(-1);
    return load && render ? { load: load.duration, render: render.duration } : null;
  })).not.toBeNull();
  const measuredDiffPerformance = await page.evaluate(() => ({
    load: performance.getEntriesByName("oneteam:diff-load").at(-1)?.duration ?? Number.POSITIVE_INFINITY,
    render: performance.getEntriesByName("oneteam:diff-render").at(-1)?.duration ?? Number.POSITIVE_INFINITY
  }));
  expect(measuredDiffPerformance.load).toBeLessThan(8_000);
  expect(measuredDiffPerformance.render).toBeLessThan(3_000);
  const diffFileNavigation = page.getByRole("navigation", { name: "Files changed" });
  const diffFileButtons = diffFileNavigation.getByRole("button");
  await expect(diffFileButtons).toHaveCount(2);
  await expect(diffFileButtons.nth(0)).toHaveAttribute("aria-current", "true");
  await expect(diffFileButtons.nth(0)).toHaveAttribute("tabindex", "0");
  await expect(diffFileButtons.nth(1)).toHaveAttribute("tabindex", "-1");
  await page.getByPlaceholder("Search changed files").focus();
  await page.keyboard.press("Tab");
  await expect(diffFileButtons.nth(0)).toBeFocused();
  await expect.poll(() => diffFileButtons.nth(0).evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
  await diffFileButtons.nth(0).press("ArrowDown");
  await expect(diffFileButtons.nth(1)).toBeFocused();
  await expect(diffFileButtons.nth(1)).toHaveAttribute("aria-current", "true");
  await diffFileButtons.nth(1).press("Home");
  await expect(diffFileButtons.nth(0)).toBeFocused();
  await expect(page.getByRole("button", { name: "Unified" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Split" })).toHaveAttribute("aria-pressed", "false");
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
  await page.getByRole("tab", { name: "Files changed" }).click();
  await expect(page.locator(".diff-line-comment")).toContainText("Review note: keep this generated value stable.");
  const linkedLineAnchor = diffLineAnchor("large.ts", "R", 1_500);
  await page.goto(`/pulls/${createdPullRequest.pullRequest.id}#${linkedLineAnchor}`);
  await expect(page.getByRole("heading", { name: /Review a large generated diff/ })).toBeVisible();
  await expect(page.locator(`#${linkedLineAnchor}`)).toBeVisible();
  await expect.poll(() => page.locator(".diff-table-scroll").evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Project and settings" }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.getByLabel("Locale").selectOption("ja");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("heading", { name: "設定" })).toBeVisible();
  await expect(page.getByText("設定を保存しました")).toBeVisible();
  await expectScreenContrast(page, "Japanese settings");

  await page.getByRole("button", { name: "Pull Request", exact: true }).click();
  await page.getByRole("button", { name: /Review a large generated diff/ }).click();
  await expect(page.getByRole("tab", { name: "変更ファイル", exact: true })).toBeVisible();
  await expect(page.locator(".automation-checks")).toContainText("review");
  const bilingualReport = page.locator(".html-body section").filter({ hasText: "日英表示検証レポート" });
  await expect(bilingualReport).toBeVisible();
  await expectScreenContrast(page, "Japanese pull request conversation");
  const bilingualTable = bilingualReport.locator("table");
  await expect(bilingualTable).toBeVisible();
  await expect(bilingualTable).toContainText("Gate / 判定");
  const tableMetrics = await bilingualTable.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    right: element.getBoundingClientRect().right,
    viewportWidth: document.documentElement.clientWidth
  }));
  expect(tableMetrics.scrollWidth).toBeGreaterThan(tableMetrics.clientWidth);
  expect(tableMetrics.right).toBeLessThanOrEqual(tableMetrics.viewportWidth + 1);
  const conversationPageMetrics = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));
  expect(conversationPageMetrics.scrollWidth).toBeLessThanOrEqual(conversationPageMetrics.clientWidth + 1);

  await page.getByRole("tab", { name: "変更ファイル", exact: true }).click();
  await expect(page.locator(".diff-viewer")).toContainText("2 ファイル");
  await expect(page.getByPlaceholder("変更ファイルを検索")).toBeVisible();
  const longPathEntry = page.locator(".diff-file-list > button").filter({ hasText: longDiffPath });
  await expect(longPathEntry).toBeVisible();
  await expect(page.locator(".diff-virtual-status")).toContainText("表示中のdiff行:");
  const diffPageMetrics = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));
  expect(diffPageMetrics.scrollWidth).toBeLessThanOrEqual(diffPageMetrics.clientWidth + 1);
  await expectScreenContrast(page, "Japanese pull request diff");
});
