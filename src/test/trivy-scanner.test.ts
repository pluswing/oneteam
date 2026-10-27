import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasTrivyCoverageWarnings, parseTrivyReport, scanFilesystemWithTrivy as scanFilesystem } from "../server/services/trivy-scanner";
import { emptyLifecycleCatalog } from "./lifecycle-fixture";
import type { TrivyRun } from "../server/services/trivy-runtime";

const temporaryDirectories: string[] = [];
const scanFilesystemWithTrivy: typeof scanFilesystem = (root, options) => scanFilesystem(root, { lifecycleFetch: emptyLifecycleCatalog, ...options });
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
const context = { scope: "application" as const, targetId: "application", targetLabel: "Application dependencies" };
const report = (Results: unknown[], extra: Record<string, unknown> = {}): string => JSON.stringify({ SchemaVersion: 2, ArtifactType: "filesystem", Results, ...extra });
const vulnerability = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  VulnerabilityID: "CVE-2026-12345", PkgName: "framework", InstalledVersion: "1.0.0", Severity: "HIGH",
  FixedVersion: "1.0.1, 2.0.0", Title: "Dependency vulnerability", ...overrides
});
const target = (Type: string, Target: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  Class: "lang-pkgs", Type, Target, Packages: [{ Name: "framework", Version: "1.0.0" }], Vulnerabilities: [vulnerability()], ...overrides
});

describe("universal Trivy vulnerability scanner", () => {
  it("accepts every reported ecosystem, including new analyzer types without application changes", () => {
    const result = parseTrivyReport(report([
      target("composer", "php/composer.lock"), target("bundler", "ruby/Gemfile.lock"), target("uv", "python/uv.lock"),
      target("gomod", "go/go.mod"), target("cargo", "rust/Cargo.lock"), target("conan", "cpp/conan.lock"),
      target("future-language-analyzer", "other/new.lock"), target("constructor", "other/another.lock")
    ]), context);
    expect(result.coverage).toBe("complete");
    expect(result.dependenciesScanned).toBe(8);
    expect(result.findings.map((finding) => finding.ecosystem).sort()).toEqual(["Conan", "Go", "Packagist", "PyPI", "RubyGems", "crates.io", "future-language-analyzer", "constructor"].sort());
    expect(result.findings.every((finding) => finding.scope === "application" && finding.scanner === "trivy")).toBe(true);
    expect(result.findings.every((finding) => finding.fixedVersions.join(",") === "1.0.1,2.0.0")).toBe(true);
  });

  it("retains OS packages and ties findings to an image or deployment target", () => {
    const result = parseTrivyReport(report([target("alpine", "alpine:3.20", {
      Class: "os-pkgs", Packages: [{ Name: "openssl", Version: "3.1.0", Release: "r0", SrcName: "openssl", SrcVersion: "3.1.0" }],
      Vulnerabilities: [vulnerability({ PkgName: "openssl", InstalledVersion: "3.1.0-r0", FixedVersion: "3.1.1-r2", Severity: "CRITICAL" })]
    })]), { scope: "deployment", targetId: "production-api", targetLabel: "Production API", manifestPath: "deploy/production.yaml" });
    expect(result.coverage).toBe("complete");
    expect(result.findings[0]).toMatchObject({ ecosystem: "alpine", scope: "deployment", targetId: "production-api", targetLabel: "Production API", manifestPath: "deploy/production.yaml", remediationMode: "external", fixedVersions: ["3.1.1-r2"] });
    expect(result.manifests).toEqual(["deploy/production.yaml"]);
  });

  it("extracts aliases, safe references, dates and CVSS severity without requiring semver versions", () => {
    const result = parseTrivyReport(report([target("composer", "composer.lock", {
      Vulnerabilities: [vulnerability({ Severity: "UNKNOWN", CVSS: { nvd: { V3Score: 9.8 } },
        VendorIDs: ["GHSA-aaaa-bbbb-cccc", "invalid/id"], References: ["https://github.com/advisories/GHSA-aaaa-bbbb-cccc", "javascript:alert(1)"],
        PrimaryURL: "https://example.org/CVE-2026-12345", PublishedDate: "2026-01-01T00:00:00Z", LastModifiedDate: "2026-10-23T00:00:00Z",
        FixedVersion: ">= 1.0.1, 2026.10-r2"
      })]
    })]), context);
    expect(result.findings[0]).toMatchObject({ severity: "critical", aliases: ["GHSA-aaaa-bbbb-cccc"],
      references: ["https://example.org/CVE-2026-12345", "https://github.com/advisories/GHSA-aaaa-bbbb-cccc"],
      fixedVersions: ["2026.10-r2", ">= 1.0.1"], publishedAt: "2026-01-01T00:00:00Z", modifiedAt: "2026-10-23T00:00:00Z" });
    const vendor = parseTrivyReport(report([target("bundler", "Gemfile.lock", { Vulnerabilities: [vulnerability({ Severity: undefined, SeveritySource: "ruby-advisory-db", VendorSeverity: { "ruby-advisory-db": 2 } })] })]), context);
    expect(vendor.findings[0].severity).toBe("medium");
  });

  it("distinguishes a scanned clean package inventory from no recognized inventory", () => {
    expect(parseTrivyReport(report([target("pub", "pubspec.lock", { Vulnerabilities: [] })]), context)).toMatchObject({ coverage: "complete", dependenciesScanned: 1, findings: [], warnings: [] });
    for (const value of [report([]), JSON.stringify({ SchemaVersion: 2 }), report([target("pub", "pubspec.lock", { Packages: [], Vulnerabilities: [] })])]) {
      expect(parseTrivyReport(value, context)).toMatchObject({ coverage: "unsupported", dependenciesScanned: 0, findings: [] });
    }
    expect(parseTrivyReport(report([target("pub", "pubspec.lock", { Packages: undefined })]), context).coverage).toBe("partial");
    expect(parseTrivyReport(report([target("alpine", "alpine", { Class: "os-pkgs", Vulnerabilities: [] })], { Metadata: { OS: { EOSL: true } } }), context).coverage).toBe("partial");
  });

  it.each([
    "not json", JSON.stringify({ SchemaVersion: 3, Results: [] }), JSON.stringify({ Results: [] }), report([{}]),
    report([target("npm", "package-lock.json", { Class: "new-unknown-schema" })]),
    report([target("npm", "package-lock.json", { Packages: {} })]),
    report([target("npm", "package-lock.json", { Packages: [{ Name: "framework" }] })]),
    report([target("npm", "package-lock.json", { Vulnerabilities: [{ PkgName: "framework", InstalledVersion: "1.0.0" }] })]),
    report([target("npm", "package-lock.json", { Vulnerabilities: [vulnerability({ FixedVersion: [] })] })])
  ])("rejects malformed or unsupported output instead of reporting zero findings (%#)", (value) => {
    expect(() => parseTrivyReport(value, context)).toThrow(/Trivy/);
  });

  it("keeps inventory hashes stable across report/advisory/order changes and finding IDs distinct across targets", () => {
    const first = target("composer", "composer.lock", { Packages: [{ Name: "framework", Version: "1.0.0" }, { Name: "safe", Version: "2.0.0" }] });
    const second = target("uv", "nested/uv.lock", { Vulnerabilities: [] });
    const scan = parseTrivyReport(report([first, second]), context);
    const reordered = parseTrivyReport(report([second, { ...first, Packages: [...first.Packages as unknown[]].reverse(), Vulnerabilities: [vulnerability({ Description: "New advisory content" })] }], { CreatedAt: "2026-10-23T00:00:00Z" }), context);
    expect(scan.inventoryHash).toBe(reordered.inventoryHash);
    expect(scan.findings[0].id).toBe(reordered.findings[0].id);
    const updated = parseTrivyReport(report([{ ...first, Packages: [{ Name: "framework", Version: "1.0.1" }] }, second]), context);
    expect(updated.inventoryHash).not.toBe(scan.inventoryHash);
    const anotherTarget = parseTrivyReport(report([first, second]), { ...context, targetId: "container-api", scope: "container" });
    expect(anotherTarget.findings[0].id).not.toBe(scan.findings[0].id);
  });

  it("runs vulnerability-only filesystem discovery through the shared runtime and propagates cancellation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oneteam-trivy-scanner-"));
    temporaryDirectories.push(root);
    const run = vi.fn<TrivyRun>(async (_args, options) => ({ stdout: report([target("composer", path.join(options.cwd, "composer.lock"))]), stderr: "INFO Vulnerability scanning is enabled" }));
    const controller = new AbortController();
    const scan = await scanFilesystemWithTrivy(root, { run, signal: controller.signal });
    expect(run).toHaveBeenCalledWith(["filesystem", "--format", "json", "--scanners", "vuln", "--list-all-pkgs", "--include-dev-deps", "--skip-dirs", expect.stringMatching(/\.oneteam$/), "--skip-dirs", expect.stringMatching(/\.git$/), "--", expect.any(String)], { cwd: expect.any(String), signal: controller.signal });
    expect(scan.manifests).toEqual(["composer.lock"]);
    expect(scan.targets?.[0]).toMatchObject({ id: "application", scanner: "trivy", status: "scanned", coverage: "complete" });
    controller.abort();
    await expect(scanFilesystemWithTrivy(root, { run, signal: controller.signal })).rejects.toThrow(/cancelled/);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not turn scanner warnings or execution failures into a clean result", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oneteam-trivy-scanner-"));
    temporaryDirectories.push(root);
    const run = vi.fn<TrivyRun>(async () => ({ stdout: report([target("pip", "requirements.txt", { Vulnerabilities: [] })]), stderr: "WARN unable to analyze https://user:password@example.org/package" }));
    const scan = await scanFilesystemWithTrivy(root, { run });
    expect(scan.coverage).toBe("partial");
    expect(scan.warnings.join(" ")).toContain("warning");
    expect(JSON.stringify(scan)).not.toContain("password");
    run.mockRejectedValueOnce(new Error("Trivy database unavailable"));
    await expect(scanFilesystemWithTrivy(root, { run })).rejects.toThrow("Trivy database unavailable");
  });

  it("distinguishes harmless live Trivy license/severity diagnostics from incomplete vulnerability scans", () => {
    const benign = "2026-10-23T11:07:39+09:00\tWARN\t[pip] Unable to find python `site-packages` directory. License detection is skipped.\n2026-10-23T11:07:39+09:00\tWARN\tUsing severities from other vendors for some vulnerabilities. Read https://trivy.dev/docs/v0.76/guide/scanner/vulnerability#severity-selection for details.";
    expect(hasTrivyCoverageWarnings(benign)).toBe(false);
    expect(hasTrivyCoverageWarnings(`${benign}\nWARN unresolved dependency version`)).toBe(true);
    expect(hasTrivyCoverageWarnings("ERROR License detection is skipped.")).toBe(true);
  });
});
