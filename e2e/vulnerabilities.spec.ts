import { expect, test, type Page } from "@playwright/test";
import type { VulnerabilityDashboard, VulnerabilityRecord, VulnerabilityRemediation, VulnerabilityScanTarget } from "../src/shared/vulnerabilities";
import { expectScreenContrast } from "./accessibility";
import { coverageGapFindings } from "../src/server/services/vulnerability-coverage-gaps";
import { buildVulnerabilityRemediationPlan } from "../src/shared/vulnerability-plan";

const timestamp = "2026-10-23T05:00:00.000Z";
const projectId = "security-fixture";
const projectPath = `/api/projects/${projectId}`;

function finding(input: Partial<VulnerabilityRecord>): VulnerabilityRecord {
  return {
    id: "finding-critical", advisoryId: "GHSA-fixture-0001", aliases: ["CVE-2026-0001"],
    packageName: "fixture-library", ecosystem: "npm", installedVersion: "1.0.0", manifestPath: "packages/web/package-lock.json",
    summary: "A critical dependency vulnerability", details: "Upgrade to a supported version.", severity: "critical",
    references: ["https://example.com/security/advisory"], fixedVersions: ["1.0.1"], publishedAt: timestamp, modifiedAt: timestamp,
    status: "open", firstSeenAt: timestamp, lastSeenAt: timestamp, resolvedAt: null, remediationId: null,
    ...input
  };
}

function dashboard(): VulnerabilityDashboard {
  return {
    projectId, settings: { autoRefresh: true, autoRemediate: false, intervalHours: 24 },
    scan: { status: "succeeded", startedAt: timestamp, completedAt: timestamp, nextScanAt: "2026-10-24T05:00:00.000Z", error: null,
      inventoryHash: "fixture-inventory", dependenciesScanned: 81, manifests: ["packages/web/package-lock.json"], warnings: [], coverage: "complete",
      lifecycleChecks: [{ targetId: "application", product: "nodejs", cycle: "24", installedVersion: "24.0.0", componentKind: "runtime", status: "supported", newerSupportedCycles: 0, latestSupportedVersion: "24.10.0", sourceUrl: "https://endoflife.date/nodejs" }] },
    findings: [finding({}), finding({ id: "finding-medium", advisoryId: "GHSA-fixture-0002", packageName: "second-library", summary: "A medium dependency vulnerability", severity: "medium" }),
      finding({ id: "finding-resolved", advisoryId: "GHSA-fixture-0003", packageName: "resolved-library", summary: "A previously resolved vulnerability", status: "resolved", resolvedAt: timestamp })],
    remediations: []
  };
}

async function mockSecurityApi(page: Page, initial = dashboard(), locale = "en") {
  const fixture = { dashboard: initial, requests: [] as Array<{ method: string; path: string; body: Record<string, unknown> | null }> };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body = request.postDataJSON() as Record<string, unknown> | null;
    fixture.requests.push({ method, path, body });
    let response: unknown = { items: [], page: { limit: 100, offset: 0, total: 0 } };
    if (path === "/api/projects") response = { items: [{ id: projectId, name: "Security fixture", repoPath: "/workspace/security-fixture", defaultBranch: "main", locale, createdAt: timestamp, updatedAt: timestamp }] };
    else if (path === "/api/codex/status") response = { status: "connected" };
    else if (path === `${projectPath}/vulnerabilities/settings`) {
      fixture.dashboard.settings = { ...fixture.dashboard.settings, ...body };
      response = fixture.dashboard;
    } else if (path === `${projectPath}/vulnerabilities/refresh`) {
      fixture.dashboard.scan = { ...fixture.dashboard.scan, status: "scanning", error: null };
      response = fixture.dashboard;
    } else if (path === `${projectPath}/vulnerabilities/remediate`) {
      const plan = buildVulnerabilityRemediationPlan(fixture.dashboard);
      const remediation: VulnerabilityRemediation = {
        id: "remediation-1", findingIds: plan.findingIds, issueId: 8, loopId: 9, stage: plan.stage, policyVersion: plan.policyVersion,
        status: "queued", phase: "planning", pullRequestId: 17, summary: "Preparing a dependency update.", createdAt: timestamp, updatedAt: timestamp
      };
      fixture.dashboard.remediations = [remediation];
      response = fixture.dashboard;
    } else if (path === `${projectPath}/vulnerabilities`) response = fixture.dashboard;
    else if (/\/development-loops\/9\/(pause|resume|cancel)$/.test(path)) {
      const action = path.split("/").at(-1);
      fixture.dashboard.remediations[0].status = action === "pause" ? "paused" : action === "resume" ? "running" : "canceled";
      response = {};
    } else if (path === `${projectPath}/development-loops/9`) {
      response = { loop: {}, retrospective: null, revisions: [], jobs: [{ id: 12, agentType: "implement", status: "queued" }] };
    }
    if (response === fixture.dashboard) response = { ...fixture.dashboard, remediationPlan: buildVulnerabilityRemediationPlan(fixture.dashboard) };
    await route.fulfill({ json: response, status: method === "POST" && path.includes("/vulnerabilities/") ? 202 : 200 });
  });
  return fixture;
}

function updateGroup(page: Page, name: string) {
  return page.locator(".vulnerability-group").filter({ has: page.locator(".vulnerability-group-subject code").getByText(name, { exact: true }) });
}

async function openUpdateDetails(page: Page, name: string) {
  const toggle = updateGroup(page, name).locator(".vulnerability-group-children > summary");
  if (!await toggle.locator("..").evaluate((element) => element.hasAttribute("open"))) await toggle.click();
}

function repairRequests(fixture: Awaited<ReturnType<typeof mockSecurityApi>>) {
  return fixture.requests.filter((request) => request.path.endsWith("/vulnerabilities/remediate"));
}

async function approvePlan(page: Page, japanese = true) {
  await page.getByRole("button", { name: japanese ? "課題を作成して修正を開始" : "Create Issue and start repairs", exact: true }).click();
  await expect(page.locator(".vulnerability-remediation")).toBeVisible();
}

test("assesses maintained platforms before proposing nearest safe updates across severities and explicit Issue creation", async ({ page }) => {
  const initial = dashboard();
  initial.findings.push(
    finding({ id: "finding-high", advisoryId: "GHSA-fixture-high", packageName: "high-library", severity: "high", fixedVersions: ["1.0.2"] }),
    finding({ id: "critical-without-fix", advisoryId: "GHSA-fixture-blocked", packageName: "blocked-library", fixedVersions: [] }),
    finding({ id: "external-high", advisoryId: "GHSA-fixture-external", packageName: "external-library", scope: "deployment", severity: "high", remediationMode: "external" })
  );
  const expectedPlan = buildVulnerabilityRemediationPlan(initial);
  const fixture = await mockSecurityApi(page, initial, "ja");
  await page.goto("/vulnerabilities");
  const plan = page.getByTestId("vulnerability-plan");
  const included = page.getByTestId("vulnerability-plan-included");
  const excluded = page.getByTestId("vulnerability-plan-excluded");
  await expect(plan).toBeVisible();
  await expect(plan).toContainText("緊急");
  await expect(plan).toContainText("高");
  await expect(page.getByTestId("vulnerability-assessment")).toContainText("メンテナンス継続中");
  await expect(plan).toHaveAttribute("data-stage", "minimal_dependencies");
  await expect(plan).toContainText("第1段階の修正・再検査が完了してから");
  await expect(plan).toContainText("推奨する更新先: 1.0.1");
  await expect(included).toContainText("fixture-library");
  await expect(included).toContainText("high-library");
  await expect(included).toContainText("second-library");
  await expect(excluded).toContainText("blocked-library");
  await expect(excluded).toContainText("external-library");
  await expect(page.getByLabel("自動で修正", { exact: true })).toHaveCount(0);
  await expect(page.locator(".vulnerability-group").getByRole("button")).toHaveCount(0);
  expect(repairRequests(fixture)).toEqual([]);
  await expectScreenContrast(page, "Overall vulnerability proposal before approval");
  await page.screenshot({ path: ".tmp/vulnerability-plan-ja-desktop.png", fullPage: true });

  // Detail filters must not silently reduce the agreed project-wide scope.
  await page.getByLabel("深刻度で絞り込み", { exact: true }).selectOption("high");
  await approvePlan(page);
  expect(repairRequests(fixture)).toEqual([{ method: "POST", path: `${projectPath}/vulnerabilities/remediate`, body: { planId: expectedPlan.id } }]);
  await expect(page.locator(".vulnerability-remediation")).toContainText("実行待ち");
});

test("declining an overall proposal starts no repair", async ({ page }) => {
  const fixture = await mockSecurityApi(page, dashboard(), "ja");
  await page.goto("/vulnerabilities");
  await expect(page.getByTestId("vulnerability-plan")).toBeVisible();
  await page.getByRole("button", { name: "今回は実行しない", exact: true }).click();
  expect(repairRequests(fixture)).toEqual([]);
  await expect(page.locator(".vulnerability-remediation")).toHaveCount(0);
  await expect(page.getByTestId("vulnerability-plan-included")).toContainText("fixture-library");
  await expect(page.getByTestId("vulnerability-plan-included")).toContainText("second-library");
});

test("includes warning-only inventory and build gaps in the proposal and retains diagnostic details", async ({ page }) => {
  const initial = dashboard();
  const missingLock = "Dependency declaration package.json has no scanned resolved inventory (package-lock.json); some dependencies remain unchecked.";
  const unbuilt = "The Compose service builds a local image. Provide the current built image, root filesystem, or SBOM; the source and base image alone do not describe the resulting OS and middleware packages.";
  initial.scan.coverage = "partial";
  initial.scan.warnings = [missingLock, unbuilt];
  initial.scan.targets = [
    { id: "application", scope: "application", kind: "filesystem", label: "Application dependencies", sourcePath: ".", ref: ".", status: "scanned", scanner: "trivy", coverage: "partial", dependenciesScanned: 1, coverageWarnings: [missingLock], error: null, checkedAt: timestamp },
    { id: "compose:web:build", scope: "container", kind: "unresolved", label: "compose.yaml: web: built environment", sourcePath: "compose.yaml", ref: "compose.yaml#services.web:build", status: "unsupported", scanner: "trivy", coverage: "unsupported", dependenciesScanned: 0, error: unbuilt, checkedAt: timestamp }
  ];
  initial.findings = coverageGapFindings({ ...initial.scan, findings: [] }).map((gap) => finding(gap));
  const expectedPlan = buildVulnerabilityRemediationPlan(initial);
  const fixture = await mockSecurityApi(page, initial, "ja");
  await page.goto("/vulnerabilities");
  await expect(page.getByTestId("vulnerability-plan")).toHaveAttribute("data-stage", "assessment");
  await expect(page.getByTestId("vulnerability-assessment")).toContainText("脆弱性が未検出でも安全と判断しません");
  await expect(page.locator('.vulnerability-group[data-remediation-kind="coverage_gap"]')).toHaveCount(2);
  await expect(page.getByRole("button", { name: "確認範囲を改善", exact: true })).toHaveCount(0);
  await openUpdateDetails(page, ".");
  const row = page.locator('tr[data-finding-kind="coverage_gap"]').filter({ hasText: "依存関係一覧" });
  await expect(row.getByText("依存関係一覧を整えて検査する必要があります", { exact: true })).toBeVisible();
  await expect(row.locator(".severity-unknown")).toHaveCount(0);
  await row.getByText("詳細と情報源", { exact: true }).click();
  await expect(row).toContainText("ロックファイル・解決済み依存関係一覧・SBOMを作成または更新");
  expect(repairRequests(fixture)).toEqual([]);
  await approvePlan(page);
  expect(repairRequests(fixture)[0].body).toEqual({ planId: expectedPlan.id });
  expect(fixture.dashboard.remediations[0].findingIds).toEqual(expect.arrayContaining(initial.findings.map((finding) => finding.id)));
});

test("summarizes image updates together and includes their bundled findings in one approved plan", async ({ page }) => {
  const initial = dashboard();
  const mysql: VulnerabilityScanTarget = { id: "compose:mysql_tfg", kind: "image", scope: "container", label: "docker-compose.yaml: mysql_tfg", ref: "mysql:5.7", sourcePath: "docker-compose.yaml", status: "scanned", scanner: "trivy", coverage: "complete", dependenciesScanned: 150, error: null, checkedAt: timestamp };
  initial.scan.targets = [mysql, { ...mysql, id: "compose:redis", label: "docker-compose.yaml: redis", ref: "redis:6" }];
  initial.scan.lifecycleChecks!.push({ targetId: mysql.id, product: "mysql", cycle: "5.7", installedVersion: "5.7", componentKind: "middleware", status: "end_of_life", latestSupportedVersion: "8.4" });
  initial.scan.manifests = ["docker-compose.yaml"];
  initial.findings = [
    finding({ id: "go-critical", packageName: "stdlib", ecosystem: "Go", installedVersion: "v1.13.10", manifestPath: mysql.sourcePath, scope: "container", targetId: mysql.id, targetLabel: mysql.label }),
    finding({ id: "openssl-high", packageName: "openssl", severity: "high", manifestPath: mysql.sourcePath, scope: "container", targetId: mysql.id, targetLabel: mysql.label }),
    finding({ id: "no-published-fix", packageName: "bundled-package", severity: "medium", fixedVersions: [], manifestPath: mysql.sourcePath, scope: "container", targetId: mysql.id, targetLabel: mysql.label }),
    finding({ id: "redis-high", packageName: "stdlib", severity: "high", manifestPath: mysql.sourcePath, scope: "container", targetId: "compose:redis", targetLabel: "docker-compose.yaml: redis" })
  ];
  const expectedPlan = buildVulnerabilityRemediationPlan(initial);
  const fixture = await mockSecurityApi(page, initial, "ja");
  await page.goto("/vulnerabilities");
  const plan = page.getByTestId("vulnerability-plan");
  await expect(plan).toContainText("mysql:5.7");
  await expect(plan).toContainText("redis:6");
  await expect(plan).toContainText("docker-compose.yaml");
  await expect(plan).toHaveAttribute("data-stage", "modernization");
  await expect(plan).toContainText("環境の更新を優先するため短期修正は見送り");
  const group = updateGroup(page, "mysql:5.7");
  await expect(page.locator(".vulnerability-group")).toHaveCount(2);
  await expect(group.getByRole("heading", { name: "mysql のコンテナイメージを更新", exact: true })).toBeVisible();
  await expect(group.locator(".vulnerability-group-risk")).toHaveText("最大の深刻度: 緊急");
  await expect(group.locator(".vulnerability-group-counts")).toContainText("検出項目 3 件");
  await expect(group.getByText("stdlib", { exact: true })).not.toBeVisible();
  const toggle = group.locator(".vulnerability-group-children > summary");
  await toggle.focus(); await page.keyboard.press("Space");
  await expect(group.getByText("stdlib", { exact: true })).toBeVisible();
  await expect(group.getByText("v1.13.10", { exact: true })).toBeVisible();
  await toggle.click();
  await page.getByLabel("深刻度で絞り込み", { exact: true }).selectOption("high");
  await expect(group.locator(".vulnerability-group-risk")).toHaveText("最大の深刻度: 緊急");
  await expect(group).toContainText("3 件中 1 件が絞り込み条件に一致しています");
  await openUpdateDetails(page, "mysql:5.7");
  await expect(group.getByText("openssl", { exact: true })).toBeVisible();
  await expect(group.getByText("stdlib", { exact: true })).toHaveCount(0);
  await expectScreenContrast(page, "Grouped vulnerability details");
  await page.setViewportSize({ width: 390, height: 844 });
  const width = await page.evaluate(() => ({ visible: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
  expect(width.content).toBe(width.visible);
  await page.screenshot({ path: ".tmp/vulnerability-plan-mobile.png", fullPage: true });
  await approvePlan(page);
  expect(repairRequests(fixture)[0].body).toEqual({ planId: expectedPlan.id });
  expect(fixture.dashboard.remediations[0].findingIds).toEqual(expect.arrayContaining(["go-critical", "openssl-high", "no-published-fix", "redis-high"]));
});

test("Japanese vulnerability tab preserves result filters and manual refresh with approval-only repairs", async ({ page }) => {
  const fixture = await mockSecurityApi(page, dashboard(), "ja");
  await page.goto("/issues");
  await page.getByRole("button", { name: "脆弱性対応", exact: true }).click();
  await expect(page).toHaveURL(/\/vulnerabilities$/);
  await expect(page.getByRole("button", { name: "脆弱性対応", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "脆弱性対応", exact: true })).toBeVisible();
  await expect(updateGroup(page, "fixture-library")).toBeVisible();
  await expect(page.getByLabel("情報を自動更新", { exact: true })).toBeChecked();
  await expect(page.getByLabel("自動で修正", { exact: true })).toHaveCount(0);
  await page.getByLabel("深刻度で絞り込み").selectOption("critical");
  await expect(updateGroup(page, "second-library")).toHaveCount(0);
  await page.getByLabel("深刻度で絞り込み").selectOption("all");
  await page.getByRole("button", { name: "解決済み (1)", exact: true }).click();
  await expect(updateGroup(page, "resolved-library")).toBeVisible();
  await expect(page.locator(".vulnerability-group").getByRole("button")).toHaveCount(0);
  await page.getByRole("button", { name: "未解決 (2)", exact: true }).click();
  await page.getByLabel("情報を自動更新", { exact: true }).uncheck();
  expect(fixture.requests).toContainEqual({ method: "PATCH", path: `${projectPath}/vulnerabilities/settings`, body: { autoRefresh: false } });
  await page.getByRole("button", { name: "今すぐ更新", exact: true }).click();
  await expect(page.getByRole("button", { name: "脆弱性を確認中…", exact: true })).toBeDisabled();
  await expect(updateGroup(page, "fixture-library")).toBeVisible();
  expect(fixture.requests).toContainEqual({ method: "POST", path: `${projectPath}/vulnerabilities/refresh`, body: null });
  expect(repairRequests(fixture)).toEqual([]);
});

test("prioritizes an end-of-support platform even without major CVEs and retains scanner recovery", async ({ page }) => {
  const initial = dashboard();
  initial.scan.coverage = "partial";
  initial.scan.manifests = ["compose.yaml"];
  initial.scan.targets = [
    { id: "compose:app", scope: "container", kind: "image", label: "Compose app", sourcePath: "compose.yaml", ref: "debian:10", status: "unsupported", scanner: "trivy", coverage: "partial", dependenciesScanned: 3, error: null, checkedAt: timestamp },
    { id: "compose:database", scope: "container", kind: "image", label: "Compose database", sourcePath: "compose.yaml", ref: "postgres:12", status: "failed", scanner: "trivy", coverage: "unsupported", dependenciesScanned: 0, error: "registry download failed", checkedAt: timestamp }
  ];
  initial.findings = [
    finding({ id: "eol-os", kind: "support_end", advisoryId: "ONETEAM-EOL-debian-10", aliases: [], packageName: "Debian", installedVersion: "10", manifestPath: "compose.yaml", severity: "unknown", fixedVersions: [], scope: "container", targetId: "compose:app", scanner: "lifecycle", summary: "Debian 10 reached end of support", details: "The scanner reported end of support.", lifecycle: { componentKind: "os", product: "Debian", cycle: "10", supportEndedAt: "2024-06-30", sourceUrl: "https://endoflife.date/debian" } }),
    finding({ id: "scanner-failure", kind: "scan_failure", advisoryId: "ONETEAM-SCAN-database", aliases: [], packageName: "Trivy", manifestPath: "compose.yaml", severity: "unknown", fixedVersions: [], scope: "container", targetId: "compose:database", scanner: "trivy", summary: "Registry database request failed", details: "HTTP 503 from the registry", scanFailure: { category: "database", summary: "Registry database request failed", details: "HTTP 503 from the registry", retryable: true, recoveryStatus: "failed", attemptedActions: ["公開脆弱性データベースを認証情報なしで再取得しました。"], fingerprint: "db-failure" } })
  ];
  const fixture = await mockSecurityApi(page, initial, "ja");
  await page.goto("/vulnerabilities");
  await expect(page.getByTestId("vulnerability-plan")).toHaveAttribute("data-stage", "modernization");
  await expect(page.getByTestId("vulnerability-assessment")).toContainText("保守終了または重大な脆弱性のある環境");
  await expect(page.getByTestId("vulnerability-plan")).toContainText("広範なコード修正と全体の検証");
  await expect(page.getByTestId("vulnerability-plan-included")).toContainText("debian:10");
  await expect(page.getByTestId("vulnerability-plan-included")).toContainText("postgres:12");
  await openUpdateDetails(page, "debian:10");
  await openUpdateDetails(page, "postgres:12");
  const eolRow = page.locator('tr[data-finding-kind="support_end"]');
  await expect(eolRow.getByText("OS アップデート", { exact: true })).toBeVisible();
  await expect(eolRow.getByText("Debian 10 のサポートが終了しています", { exact: true })).toBeVisible();
  await expect(eolRow.locator(".severity-unknown")).toHaveCount(0);
  const failureRow = page.locator('tr[data-finding-kind="scan_failure"]');
  await failureRow.getByText("詳細と情報源", { exact: true }).click();
  await expect(failureRow.getByText("公開脆弱性データベースを認証情報なしで再取得しました。", { exact: true })).toBeVisible();
  await expect(failureRow.getByText("HTTP 503 from the registry", { exact: true })).not.toBeVisible();
  await failureRow.getByText("検出時の原文を表示", { exact: true }).click();
  await expect(failureRow.getByText("HTTP 503 from the registry", { exact: true })).toBeVisible();
  expect(repairRequests(fixture)).toEqual([]);
  await approvePlan(page);
  expect(fixture.dashboard.remediations[0].findingIds).toEqual(expect.arrayContaining(["scanner-failure", "eol-os"]));
});

test("a scan-recovery proposal excludes stale CVEs while keeping failure diagnostics available", async ({ page }) => {
  const initial = dashboard();
  initial.scan.status = "failed";
  initial.scan.coverage = "unsupported";
  initial.scan.error = "Vulnerability inspection failed (exit 1): network unavailable";
  initial.findings = [initial.findings[0], finding({ id: "scan-failure", kind: "scan_failure", packageName: "Trivy", severity: "unknown", fixedVersions: [], summary: "Connection failed", details: "network unavailable", scanFailure: { category: "network", summary: "Connection failed", details: "network unavailable", retryable: true, recoveryStatus: "failed", attemptedActions: ["一時的な接続障害に対して再試行しました。"], fingerprint: "network-failure" } })];
  const expectedPlan = buildVulnerabilityRemediationPlan(initial);
  const fixture = await mockSecurityApi(page, initial, "ja");
  await page.goto("/vulnerabilities");
  await expect(page.getByTestId("vulnerability-plan-included")).toContainText("Trivy");
  await expect(page.getByTestId("vulnerability-plan-excluded")).toContainText("fixture-library");
  await openUpdateDetails(page, "Trivy");
  const failureRow = page.locator('tr[data-finding-kind="scan_failure"]');
  await expect(failureRow.getByText("通信エラーにより検査に失敗しました", { exact: true })).toBeVisible();
  await failureRow.getByText("詳細と情報源", { exact: true }).click();
  await expect(failureRow.getByText("一時的な接続障害に対して再試行しました。", { exact: true })).toBeVisible();
  await approvePlan(page);
  expect(repairRequests(fixture)[0].body).toEqual({ planId: expectedPlan.id });
  expect(fixture.dashboard.remediations[0].findingIds).toEqual(["scan-failure"]);
});

test("keeps Japanese advisory detail, original sources and inspection notices available in both lists", async ({ page }) => {
  const initial = dashboard();
  const translatedSummary = "依存パッケージで認証を回避できる脆弱性";
  const translatedDetails = "特定のリクエストにより認証を回避できる可能性があります。fixture-library を 1.0.1 に更新してください。";
  const originalSummary = initial.findings[0].summary;
  const originalDetails = initial.findings[0].details;
  initial.findings[0].translations = { ja: { summary: translatedSummary, details: translatedDetails, sourceHash: "fixture-japanese-advisory", status: "translated" } };
  initial.scan.coverage = "partial";
  const knownWarning = "Dependency declaration requirements.txt has no scanned resolved inventory; some dependencies remain unchecked.";
  const unknownWarning = "Custom scanner diagnostic: remote registry access denied.";
  initial.scan.warnings = [knownWarning, unknownWarning];
  await mockSecurityApi(page, initial, "ja");
  await page.goto("/vulnerabilities");
  const notices = page.locator(".vulnerability-coverage");
  await expect(notices).toContainText("依存関係の宣言 requirements.txt に対応する解決済み一覧を検査できていません。一部の依存関係は未確認です。");
  await expect(notices.getByText(unknownWarning, { exact: true })).not.toBeVisible();
  await notices.getByText("原文を表示", { exact: true }).last().click();
  await expect(notices.getByText(unknownWarning, { exact: true })).toBeVisible();
  await openUpdateDetails(page, "fixture-library");
  const row = page.getByRole("row").filter({ hasText: "fixture-library" });
  await expect(row.getByText(translatedSummary, { exact: true })).toBeVisible();
  await expect(row.getByText(originalSummary, { exact: true })).not.toBeVisible();
  await row.getByText("詳細と情報源", { exact: true }).click();
  await expect(row.getByText(translatedDetails, { exact: true })).toBeVisible();
  await row.getByText("原文を表示", { exact: true }).click();
  await expect(row.getByText(originalSummary, { exact: true })).toBeVisible();
  await expect(row.getByText(originalDetails, { exact: true })).toBeVisible();
  await page.getByLabel("深刻度で絞り込み", { exact: true }).selectOption("medium");
  await expect(page.getByText(translatedSummary, { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("vulnerability-plan-excluded")).toContainText("second-library");
  await openUpdateDetails(page, "second-library");
  await expect(updateGroup(page, "second-library").getByText("GHSA-fixture-0002", { exact: true })).toBeVisible();
  await expectScreenContrast(page, "Japanese advisory details and excluded findings");
});

test("approved repairs retain PR, activity and pause/resume/cancel controls", async ({ page }) => {
  const fixture = await mockSecurityApi(page);
  const expectedPlan = buildVulnerabilityRemediationPlan(fixture.dashboard);
  await page.goto("/vulnerabilities");
  expect(repairRequests(fixture)).toEqual([]);
  await page.screenshot({ path: ".tmp/vulnerability-plan-en-desktop.png", fullPage: true });
  await approvePlan(page, false);
  expect(repairRequests(fixture)[0].body).toEqual({ planId: expectedPlan.id });
  const response = page.locator(".vulnerability-remediation");
  await expect(response).toContainText("Queued");
  await expect(page.getByTestId("vulnerability-plan-included")).toContainText("fixture-library");
  await expect(response.getByRole("link", { name: "View pull request #17" })).toHaveAttribute("href", "/pulls/17");
  await expect(page.getByRole("button", { name: "Create Issue and start repairs", exact: true })).toBeDisabled();
  await response.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(response).toContainText("Paused");
  await response.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(response).toContainText("Running");
  await response.getByText("View activity", { exact: true }).click();
  await expect(response.getByRole("link", { name: "#12 implement" })).toHaveAttribute("href", "/jobs/12");
  await response.getByRole("button", { name: "Cancel fix", exact: true }).click();
  await expect(response).toContainText("Canceled");
  await expectScreenContrast(page, "Vulnerability repair controls");
});

test("unverified targets and deployment-side findings remain excluded with their coverage visible", async ({ page }) => {
  const initial = dashboard();
  const application: VulnerabilityScanTarget = {
    id: "application", scope: "application", kind: "filesystem", label: "Project dependencies", sourcePath: ".", ref: ".",
    status: "scanned", scanner: "trivy", coverage: "complete", dependenciesScanned: 28, error: null, checkedAt: timestamp
  };
  const container: VulnerabilityScanTarget = {
    ...application, id: "compose:database", scope: "container", kind: "image", label: "Compose database",
    sourcePath: "compose.yaml", ref: "postgres:16", dependenciesScanned: 150
  };
  const deployment: VulnerabilityScanTarget = {
    ...application, id: "deployment:production", scope: "deployment", kind: "image", label: "Production image",
    sourcePath: ".oneteam/vulnerability-targets.json", ref: "registry.example.com/app:latest", status: "unavailable", coverage: "unsupported",
    dependenciesScanned: 0, checkedAt: null, error: "Registry authentication required."
  };
  const liveDeployment: VulnerabilityScanTarget = {
    ...application, id: "deployment:live", scope: "deployment", kind: "rootfs", label: "Production host",
    sourcePath: ".oneteam/vulnerability-targets.json", ref: "ssh://production", dependenciesScanned: 90
  };
  initial.scan.coverage = "partial";
  initial.scan.targets = [application, container, deployment, liveDeployment];
  initial.scan.lifecycleChecks!.push({ targetId: container.id, product: "debian", cycle: "10", installedVersion: "10", componentKind: "os", status: "end_of_life", latestSupportedVersion: "13" });
  initial.scan.warnings = [deployment.error!];
  initial.scan.manifests = ["uv.lock", "compose.yaml", ".oneteam/vulnerability-targets.json"];
  initial.findings = [
    finding({ id: "python-finding", packageName: "python-library", ecosystem: "PyPI", manifestPath: "uv.lock", scanner: "trivy", targetId: application.id, targetLabel: application.label, scope: "application" }),
    finding({ id: "container-finding", packageName: "libssl3", ecosystem: "debian", manifestPath: "compose.yaml", scanner: "trivy", targetId: container.id, targetLabel: container.label, scope: "container", summary: "Container OS package vulnerability" }),
    finding({ id: "stale-deployment-finding", packageName: "deployment-library", scanner: "trivy", targetId: deployment.id, targetLabel: deployment.label, scope: "deployment", summary: "Previously detected deployment vulnerability" }),
    finding({ id: "external-finding", packageName: "kernel-package", scanner: "trivy", targetId: liveDeployment.id, targetLabel: liveDeployment.label, scope: "deployment", remediationMode: "external", summary: "Deployment host vulnerability" })
  ];
  const expectedPlan = buildVulnerabilityRemediationPlan(initial);
  const fixture = await mockSecurityApi(page, initial);
  await page.goto("/vulnerabilities");
  await expect(page.getByTestId("vulnerability-plan-included")).toContainText("python-library");
  await expect(page.getByTestId("vulnerability-plan-included")).toContainText("postgres:16");
  await expect(page.getByTestId("vulnerability-plan-excluded")).toContainText("registry.example.com/app:latest");
  await expect(page.getByTestId("vulnerability-plan-excluded")).toContainText("ssh://production");
  const targets = page.locator(".vulnerability-targets");
  await expect(targets).not.toHaveAttribute("open", "");
  await targets.locator(":scope > summary").click();
  await expect(targets.getByText("Compose database", { exact: true })).toBeVisible();
  await expect(targets.getByText("Registry authentication required.", { exact: false })).toBeVisible();
  await page.getByLabel("Filter by target", { exact: true }).selectOption("container");
  await expect(updateGroup(page, "python-library")).toHaveCount(0);
  await expect(updateGroup(page, "postgres:16")).toBeVisible();
  await approvePlan(page, false);
  expect(repairRequests(fixture)[0].body).toEqual({ planId: expectedPlan.id });
  expect(fixture.dashboard.remediations[0].findingIds).toEqual(expect.arrayContaining(["python-finding", "container-finding"]));
  expect(fixture.dashboard.remediations[0].findingIds).not.toContain("stale-deployment-finding");
  expect(fixture.dashboard.remediations[0].findingIds).not.toContain("external-finding");
});
