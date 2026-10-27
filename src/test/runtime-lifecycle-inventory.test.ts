import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { inspectDeclaredRuntimes } from "../server/services/runtime-lifecycle-inventory";
import { parseTrivyReportWithLifecycle } from "../server/services/trivy-scanner";
import { includeCoverageGapFindings } from "../server/services/vulnerability-coverage-gaps";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function repository(files: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "runtime-inventory-"));
  roots.push(root);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return root;
}
const now = () => Date.parse("2026-10-23T00:00:00Z");
const catalog = () => vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ result: [
  { name: "nodejs", label: "Node.js", aliases: ["node"], category: "lang", identifiers: [{ type: "purl", id: "pkg:generic/nodejs" }], releases: [
    { name: "22", isEol: false, eolFrom: "2027-04-30", releaseDate: "2024-04-24", latest: { name: "22.20.0", date: "2026-10-01" } }
  ] }
] })));
const report = JSON.stringify({ SchemaVersion: 2, Results: [{ Class: "lang-pkgs", Type: "npm", Target: "package-lock.json", Packages: [{ Name: "example-library", Version: "1.2.3" }], Vulnerabilities: [] }] });

it("reads concrete runtime versions from version managers without running the host interpreter", async () => {
  const root = await repository({ ".nvmrc": "v22.10.0\n", ".python-version": "3.13.0\n", ".tool-versions": "ruby 3.4.1\nnodejs 22.10.0 # pinned\n" });
  const result = await inspectDeclaredRuntimes(root, ["package-lock.json", "requirements.txt"]);
  expect(result.candidates).toEqual(expect.arrayContaining([
    { name: "nodejs", version: "22.10.0", manifestPath: ".nvmrc" },
    { name: "python", version: "3.13.0", manifestPath: ".python-version" },
    { name: "ruby", version: "3.4.1", manifestPath: ".tool-versions" },
    { name: "nodejs", version: "22.10.0", manifestPath: ".tool-versions" }
  ]));
  expect(result.warnings).toEqual([]);
});

it("finds workspace pins and exact Volta settings, while engines alone prove no version", async () => {
  const root = await repository({ "package.json": '{"engines":{"node":">=22"}}', "packages/api/.node-version": "22.12.0", "packages/web/package.json": '{"volta":{"node":"22.13.0"}}' });
  const result = await inspectDeclaredRuntimes(root, ["packages/api/package-lock.json", "packages/web/package-lock.json"]);
  expect(result.candidates).toEqual([
    { name: "nodejs", version: "22.12.0", manifestPath: "packages/api/.node-version" },
    { name: "nodejs", version: "22.13.0", manifestPath: "packages/web/package.json" }
  ]);
  expect(result.required).toContainEqual(expect.objectContaining({ name: "nodejs", manifestPath: "package.json" }));
});

it.each(["22", "22.10", "lts/*", "node", "system", ">=22.0.0", "22.0.0-rc.1", "https://credential@example.invalid/runtime"])("leaves moving or uncertain pin %s unverified without disclosing its content", async (version) => {
  const root = await repository({ ".nvmrc": version });
  const result = await inspectDeclaredRuntimes(root, ["package-lock.json"]);
  expect(result.candidates).toEqual([]);
  expect(result.warnings.join()).toContain("固定パッチ版");
  expect(result.warnings.join()).not.toContain(` ${version} `);
});

it("refuses symlinked runtime files and repository-external manifest traversal", async () => {
  const outside = await repository({ ".nvmrc": "22.19.0" });
  const root = await repository({});
  await symlink(path.join(outside, ".nvmrc"), path.join(root, ".nvmrc"));
  const result = await inspectDeclaredRuntimes(root, ["../package-lock.json", path.join(outside, "package-lock.json")]);
  expect(result.candidates).toEqual([]);
  expect(result.warnings.join()).toContain("安全に読み取れませんでした");
  expect(JSON.stringify(result)).not.toContain(outside);
});

it("adds supported runtime evidence to an npm-only Trivy inventory using the project pin", async () => {
  const root = await repository({ ".nvmrc": "22.10.0" });
  const fetcher = catalog();
  const context = { scope: "application" as const, targetId: "application", targetLabel: "Application", repoPath: root };
  const scan = await parseTrivyReportWithLifecycle(report, context, { fetch: fetcher, now });
  expect(scan.lifecycleChecks).toEqual([expect.objectContaining({ product: "nodejs", installedVersion: "22.10.0", status: "supported", manifestPath: ".nvmrc", componentKind: "runtime" })]);
  expect(scan.findings).toContainEqual(expect.objectContaining({ kind: "platform_update", installedVersion: "22.10.0", manifestPath: ".nvmrc" }));
  expect(scan.inspectionSources).toContain(".nvmrc");
  expect(scan.warnings).toEqual([]);
  await writeFile(path.join(root, ".nvmrc"), "22.20.0");
  const updated = await parseTrivyReportWithLifecycle(report, context, { fetch: fetcher, now });
  expect(updated.inventoryHash).not.toBe(scan.inventoryHash);
  expect(updated.findings).toEqual([]);
  expect(JSON.stringify(fetcher.mock.calls)).not.toContain("22.10.0");
  expect(JSON.stringify(fetcher.mock.calls)).not.toContain(root);
});

it("turns missing runtime evidence into an actionable lifecycle inspection gap", async () => {
  const root = await repository({ "package.json": '{"engines":{"node":">=22"}}' });
  const scan = includeCoverageGapFindings(await parseTrivyReportWithLifecycle(report, { scope: "application", targetId: "application", targetLabel: "Application", repoPath: root }, { fetch: catalog(), now }));
  expect(scan.lifecycleChecks ?? []).toEqual([]);
  expect(scan.findings).toContainEqual(expect.objectContaining({ kind: "coverage_gap", remediationMode: "repository", coverageGap: expect.objectContaining({ category: "lifecycle" }) }));
  expect(scan.warnings.join()).toContain("nodejs の実バージョンを確認できませんでした");
});

const workspaceReport = (paths: string[], runtimePath?: string) => JSON.stringify({ SchemaVersion: 2, Results: paths.map((target) => ({
  Class: "lang-pkgs", Type: "npm", Target: target, Vulnerabilities: [], Packages: [
    { Name: "example-library", Version: "1.2.3" },
    ...(runtimePath === target ? [{ Name: "node", Version: "22.20.0", Identifier: { PURL: "pkg:generic/nodejs@22.20.0" } }] : [])
  ]
})) });

it("does not use a sibling workspace's runtime to verify a manifest without a pin", async () => {
  const root = await repository({ "packages/current/.nvmrc": "22.20.0" });
  const scan = includeCoverageGapFindings(await parseTrivyReportWithLifecycle(workspaceReport(["packages/current/package-lock.json", "packages/legacy/package-lock.json"]),
    { scope: "application", targetId: "application", targetLabel: "Application", repoPath: root }, { fetch: catalog(), now }));
  expect(scan.lifecycleChecks).toContainEqual(expect.objectContaining({ product: "nodejs", manifestPath: "packages/current/.nvmrc", status: "supported" }));
  expect(scan.warnings).toContainEqual(expect.stringContaining("対象: packages/legacy/package-lock.json"));
  expect(scan.warnings).not.toContainEqual(expect.stringContaining("対象: packages/current/package-lock.json"));
  expect(scan.findings).toContainEqual(expect.objectContaining({ kind: "coverage_gap", coverageGap: expect.objectContaining({ category: "lifecycle" }) }));
});

it("inherits the closest parent pin separately for each workspace", async () => {
  const root = await repository({ ".nvmrc": "22.20.0", "packages/current/.node-version": "22.10.0" });
  const inventory = await inspectDeclaredRuntimes(root, ["packages/current/package-lock.json", "packages/legacy/package-lock.json"]);
  expect(inventory.required).toContainEqual(expect.objectContaining({ manifestPath: "packages/current/package-lock.json", declarationPaths: ["packages/current/.node-version"], declaredVersion: "22.10.0", conflict: false }));
  expect(inventory.required).toContainEqual(expect.objectContaining({ manifestPath: "packages/legacy/package-lock.json", declarationPaths: [".nvmrc"], declaredVersion: "22.20.0", conflict: false }));
  const scan = await parseTrivyReportWithLifecycle(workspaceReport(["packages/current/package-lock.json", "packages/legacy/package-lock.json"]),
    { scope: "application", targetId: "application", targetLabel: "Application", repoPath: root }, { fetch: catalog(), now });
  expect(scan.warnings).toEqual([]);
});

it.each(["22.10.0", "lts/*"])("keeps conflicting or uncertain nearest runtime files unknown (%s), without falling back to a parent", async (other) => {
  const root = await repository({ ".nvmrc": "22.20.0", "packages/app/.nvmrc": "22.20.0", "packages/app/.node-version": other });
  const inventory = await inspectDeclaredRuntimes(root, ["packages/app/package-lock.json"]);
  expect(inventory.required).toContainEqual(expect.objectContaining({ manifestPath: "packages/app/package-lock.json", conflict: true }));
  expect(inventory.candidates).not.toContainEqual(expect.objectContaining({ manifestPath: "packages/app/.nvmrc" }));
  const scan = await parseTrivyReportWithLifecycle(workspaceReport(["packages/app/package-lock.json"]),
    { scope: "application", targetId: "application", targetLabel: "Application", repoPath: root }, { fetch: catalog(), now });
  expect(scan.warnings).toContainEqual(expect.stringContaining("対象: packages/app/package-lock.json"));
});

it("accepts runtime inventory only for the manifest that supplied that evidence", async () => {
  const root = await repository({});
  const paths = ["packages/current/package-lock.json", "packages/legacy/package-lock.json"];
  const scan = await parseTrivyReportWithLifecycle(workspaceReport(paths, paths[0]),
    { scope: "application", targetId: "application", targetLabel: "Application", repoPath: root }, { fetch: catalog(), now });
  expect(scan.warnings).not.toContainEqual(expect.stringContaining(`対象: ${paths[0]}`));
  expect(scan.warnings).toContainEqual(expect.stringContaining(`対象: ${paths[1]}`));
});

it.each([false, true])("accepts explicit Bun workspaces while retaining explicit Node requirements (%s)", async (nodeRequired) => {
  const root = await repository({ ".bun-version": "1.3.0", "package.json": JSON.stringify(nodeRequired ? { engines: { node: ">=22" } } : {}), "bun.lock": "" });
  const bunCatalog: typeof fetch = async () => new Response(JSON.stringify({ result: [{ name: "bun", category: "runtime", releases: [
    { name: "1", isEol: false, eolFrom: "2030-01-01", releaseDate: "2023-01-01", latest: { name: "1.3.0" } }
  ] }] }));
  const scan = await parseTrivyReportWithLifecycle(workspaceReport(["bun.lock"]),
    { scope: "application", targetId: "application", targetLabel: "Application", repoPath: root }, { fetch: bunCatalog, now });
  expect(scan.lifecycleChecks).toContainEqual(expect.objectContaining({ product: "bun", manifestPath: ".bun-version", status: "supported" }));
  if (nodeRequired) expect(scan.warnings).toContainEqual(expect.stringContaining("nodejs の実バージョン"));
  else expect(scan.warnings).toEqual([]);
});
