import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { VulnerabilityFinding, VulnerabilityScanResult, VulnerabilityScope, VulnerabilitySeverity } from "../../shared/vulnerabilities";
import { runTrivy, type TrivyRun } from "./trivy-runtime";
import { inspectVulnerabilityInventoryCoverage } from "./vulnerability-inventory-coverage";
import { enrichLifecycleFindings, trivyOsLifecycleFindings, type LifecycleScanOptions } from "./lifecycle-vulnerability-scanner";

type JsonObject = Record<string, unknown>;
export type TrivyReportContext = {
  scope: VulnerabilityScope;
  targetId: string;
  targetLabel: string;
  manifestPath?: string;
  remediationMode?: "repository" | "external";
  repoPath?: string;
};

const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const MAX_PACKAGES = 100_000;
const MAX_FINDINGS = 10_000;
const object = (value: unknown): JsonObject | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
const unique = (values: string[]): string[] => [...new Set(values)].sort();
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const text = (value: unknown, limit: number): string => typeof value === "string" ? value.slice(0, limit) : "";

// Display aliases only. This is not an analyzer whitelist: unfamiliar Trivy types
// are preserved and scanned in exactly the same way as the familiar ecosystems.
const ECOSYSTEM_NAMES: Record<string, string> = {
  npm: "npm", yarn: "npm", pnpm: "npm", bun: "npm", "node-pkg": "npm",
  bundler: "RubyGems", gemspec: "RubyGems", composer: "Packagist", "composer-vendor": "Packagist",
  pip: "PyPI", pipenv: "PyPI", poetry: "PyPI", uv: "PyPI", pylock: "PyPI", "python-pkg": "PyPI",
  cargo: "crates.io", rustbinary: "crates.io", gomod: "Go", gobinary: "Go",
  jar: "Maven", pom: "Maven", gradle: "Maven", sbt: "Maven",
  nuget: "NuGet", "dotnet-core": "NuGet", "packages-props": "NuGet",
  conan: "Conan", hex: "Hex", pub: "Pub", cocoapods: "CocoaPods", swift: "SwiftURL", julia: "Julia"
};

function requiredString(value: unknown, label: string, maximum = 4_000): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum || [...value].some((character) => character.charCodeAt(0) < 32)) {
    throw new Error(`Trivy returned an invalid ${label}; scan incomplete.`);
  }
  return value;
}

function optionalArray(value: unknown, label: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Trivy returned an invalid ${label}; scan incomplete.`);
  return value;
}

function severityOf(vulnerability: JsonObject): VulnerabilitySeverity {
  const severity = text(vulnerability.Severity, 30).toLowerCase();
  if (["critical", "high", "medium", "low"].includes(severity)) return severity as VulnerabilitySeverity;
  const vendorSeverity = object(vulnerability.VendorSeverity);
  const source = text(vulnerability.SeveritySource, 200);
  const sourceSeverity = source ? vendorSeverity?.[source] : undefined;
  if (typeof sourceSeverity === "number" && sourceSeverity >= 1 && sourceSeverity <= 4) {
    return (["unknown", "low", "medium", "high", "critical"] as const)[sourceSeverity] ?? "unknown";
  }
  const cvss = object(vulnerability.CVSS);
  const scores = Object.values(cvss ?? {}).flatMap((entry) => {
    const metrics = object(entry);
    return [metrics?.V40Score, metrics?.V3Score, metrics?.V2Score]
      .filter((score): score is number => typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 10);
  });
  const score = scores.length > 0 ? Math.max(...scores) : 0;
  return score >= 9 ? "critical" : score >= 7 ? "high" : score >= 4 ? "medium" : score > 0 ? "low" : "unknown";
}

function targetName(value: string, context: TrivyReportContext): string {
  if (!context.repoPath || !path.isAbsolute(value)) return value.replaceAll("\\", "/");
  const relative = path.relative(context.repoPath, value);
  if (relative.startsWith(`..${path.sep}`) || relative === "..") throw new Error("Trivy returned a target outside the project; scan incomplete.");
  return relative.replaceAll(path.sep, "/") || ".";
}

function advisoryAliases(vulnerability: JsonObject, advisoryId: string, references: string[]): string[] {
  const referencedIds = references.flatMap((reference) => reference.match(/\b(?:CVE-\d{4}-\d{4,}|GHSA-[a-z\d]{4}-[a-z\d]{4}-[a-z\d]{4})\b/gi) ?? []);
  return unique([...strings(vulnerability.VendorIDs), ...strings(vulnerability.Aliases), ...referencedIds])
    .filter((alias) => alias !== advisoryId && /^[a-zA-Z\d:_.-]{1,200}$/.test(alias)).slice(0, 100);
}

/** Trivy also emits WARN for successful severity fallback and skipped license
 * metadata. Those diagnostics do not reduce a vulnerability-only scan's coverage. */
export function hasTrivyCoverageWarnings(stderr: string): boolean {
  return stderr.split("\n").some((line) => {
    if (/\bERROR\b/i.test(line)) return true;
    if (!/\bWARN\b/i.test(line)) return false;
    return !line.includes("License detection is skipped.") && !line.includes("Using severities from other vendors for some vulnerabilities.");
  });
}

/** Parse the vulnerability JSON contract rather than assuming an empty result is a clean project. */
export function parseTrivyReport(stdout: string, context: TrivyReportContext): VulnerabilityScanResult {
  if (Buffer.byteLength(stdout, "utf8") > MAX_REPORT_BYTES) throw new Error("Trivy report exceeds the size limit; scan incomplete.");
  let report: JsonObject | null;
  try { report = object(JSON.parse(stdout)); }
  catch { throw new Error("Trivy returned invalid JSON; scan incomplete."); }
  if (!report || report.SchemaVersion !== 2) throw new Error("Trivy returned an unsupported report schema; scan incomplete.");

  const results = optionalArray(report.Results, "result list");
  const findings = new Map<string, VulnerabilityFinding>();
  const packages = new Set<string>();
  const manifests = new Set<string>();
  const warnings = new Set<string>();
  let analyzers = 0;
  let packageEntries = 0;
  for (const value of results) {
    const result = object(value);
    if (!result || !["lang-pkgs", "os-pkgs"].includes(String(result.Class))) throw new Error("Trivy returned an unsupported vulnerability result; scan incomplete.");
    const type = requiredString(result.Type, "analyzer type", 200);
    const target = targetName(requiredString(result.Target, "scan target"), context);
    const manifestPath = context.manifestPath ?? target;
    manifests.add(manifestPath);
    const inventory = optionalArray(result.Packages, "package inventory");
    const vulnerabilities = optionalArray(result.Vulnerabilities, "vulnerability list");
    // Empty typed results establish that an analyzer ran, but without any package
    // inventory they cannot establish vulnerability coverage.
    if (inventory.length > 0 || vulnerabilities.length > 0) analyzers++;
    if (inventory.length === 0 && vulnerabilities.length > 0) warnings.add("Trivy did not return the full package inventory for a target; dependency coverage is incomplete.");
    for (const value of inventory) {
      if (++packageEntries > MAX_PACKAGES) throw new Error("Trivy package inventory exceeds the limit; scan incomplete.");
      const pkg = object(value);
      if (!pkg) throw new Error("Trivy returned an invalid package inventory entry; scan incomplete.");
      const name = requiredString(pkg.Name, "package name", 1_000);
      const version = requiredString(pkg.Version, "package version", 1_000);
      packages.add(JSON.stringify([context.targetId, target, result.Class, type, name, version,
        text(pkg.SrcName, 1_000), text(pkg.SrcVersion, 1_000), text(pkg.SrcRelease, 1_000), text(pkg.Release, 1_000),
        text(pkg.Epoch, 100) || (typeof pkg.Epoch === "number" ? pkg.Epoch : ""), text(object(pkg.Identifier)?.PURL, 4_000)]));
    }
    for (const value of vulnerabilities) {
      const vulnerability = object(value);
      if (!vulnerability) throw new Error("Trivy returned an invalid vulnerability; scan incomplete.");
      const advisoryId = requiredString(vulnerability.VulnerabilityID, "advisory identifier", 200);
      const packageName = requiredString(vulnerability.PkgName, "vulnerable package name", 1_000);
      const installedVersion = requiredString(vulnerability.InstalledVersion, "installed package version", 1_000);
      if (vulnerability.FixedVersion !== undefined && typeof vulnerability.FixedVersion !== "string") throw new Error("Trivy returned invalid fixed versions; scan incomplete.");
      const references = unique([text(vulnerability.PrimaryURL, 2_000), ...strings(vulnerability.References)])
        .filter((url) => url.length <= 2_000 && /^https?:\/\//i.test(url)).slice(0, 40);
      const id = hash(JSON.stringify([context.scope, context.targetId, target, type, advisoryId, packageName, installedVersion, text(vulnerability.PkgPath, 4_000)])).slice(0, 32);
      findings.set(id, {
        id, advisoryId, aliases: advisoryAliases(vulnerability, advisoryId, references), packageName,
        ecosystem: Object.hasOwn(ECOSYSTEM_NAMES, type) ? ECOSYSTEM_NAMES[type] : type, installedVersion, manifestPath,
        summary: text(vulnerability.Title, 4_000) || advisoryId, details: text(vulnerability.Description, 30_000),
        severity: severityOf(vulnerability), references,
        fixedVersions: unique(text(vulnerability.FixedVersion, 16_000).split(",").map((version) => version.trim()).filter(Boolean)).slice(0, 100),
        publishedAt: text(vulnerability.PublishedDate, 100) || null, modifiedAt: text(vulnerability.LastModifiedDate, 100) || null,
        scope: context.scope, targetId: context.targetId, targetLabel: context.targetLabel,
        scanner: "trivy", remediationMode: context.remediationMode ?? (context.scope === "deployment" ? "external" : "repository")
      });
      if (findings.size > MAX_FINDINGS) throw new Error("Trivy vulnerability findings exceed the limit; scan incomplete.");
    }
  }
  const os = object(object(report.Metadata)?.OS);
  if (os?.EOSL === true) warnings.add("The scanned operating system is end of life; its vulnerability coverage may be incomplete.");
  const lifecycle = trivyOsLifecycleFindings(report, context);
  for (const finding of lifecycle.findings) findings.set(finding.id, finding);
  if (analyzers === 0) warnings.add("Trivy found no supported dependency inventory. Provide lockfiles, an SBOM, or built artifacts; zero findings do not establish vulnerability coverage.");
  const osIdentity = typeof os?.Family === "string" && typeof os.Name === "string" ? [JSON.stringify(["operating-system", context.targetId, os.Family, os.Name])] : [];
  return {
    inventoryHash: hash(JSON.stringify([...packages, ...osIdentity].sort())), dependenciesScanned: packages.size,
    manifests: [...manifests].sort(), warnings: [...warnings].sort(),
    coverage: analyzers === 0 ? "unsupported" : warnings.size > 0 ? "partial" : "complete",
    findings: [...findings.values()].sort((a, b) => a.id.localeCompare(b.id)), lifecycleChecks: lifecycle.checks
  };
}

/** Retain the synchronous report contract for imports and enrich actual inspections with lifecycle metadata. */
export async function parseTrivyReportWithLifecycle(stdout: string, context: TrivyReportContext, options: LifecycleScanOptions = {}): Promise<VulnerabilityScanResult> {
  return enrichLifecycleFindings(stdout, context, parseTrivyReport(stdout, context), options);
}

/** Delegate analyzer discovery to Trivy so new ecosystems do not need application changes. */
export async function scanFilesystemWithTrivy(
  repoPath: string,
  options: { signal?: AbortSignal; run?: TrivyRun; lifecycleFetch?: typeof globalThis.fetch } = {}
): Promise<VulnerabilityScanResult> {
  if (options.signal?.aborted) throw new Error("Vulnerability scan cancelled.");
  const root = await realpath(repoPath);
  if (!(await lstat(root)).isDirectory()) throw new Error("Project repository is not a directory.");
  const result = await (options.run ?? runTrivy)([
    "filesystem", "--format", "json", "--scanners", "vuln", "--list-all-pkgs", "--include-dev-deps",
    "--skip-dirs", path.join(root, ".oneteam"), "--skip-dirs", path.join(root, ".git"), "--", root
  ], { cwd: root, signal: options.signal });
  if (options.signal?.aborted) throw new Error("Vulnerability scan cancelled.");
  const scan = await parseTrivyReportWithLifecycle(result.stdout, { scope: "application", targetId: "application", targetLabel: "Application dependencies", repoPath: root }, { signal: options.signal, fetch: options.lifecycleFetch });
  if (result.recovery) scan.recoveries = [result.recovery];
  const inventory = await inspectVulnerabilityInventoryCoverage(root, scan.manifests, { signal: options.signal });
  scan.inspectionSources = [...new Set([".", ...inventory.sources, ...scan.manifests])];
  const inventoryWarnings = inventory.warnings;
  if (inventoryWarnings.length) {
    scan.warnings.push(...inventoryWarnings);
    if (scan.coverage === "complete") scan.coverage = "partial";
  }
  if (hasTrivyCoverageWarnings(result.stderr)) {
    // Keep scanner logs out of persisted data: URLs and local configuration can
    // contain credentials. A warning must still prevent a clean-coverage claim.
    scan.warnings.push("Trivy reported a scanner warning; some dependency inventories may have incomplete coverage.");
    if (scan.coverage === "complete") scan.coverage = "partial";
  }
  scan.targets = [{
    id: "application", scope: "application", kind: "filesystem", label: "Application dependencies", sourcePath: ".", ref: ".",
    status: scan.coverage === "unsupported" ? "unsupported" : "scanned", scanner: "trivy", coverage: scan.coverage,
    dependenciesScanned: scan.dependenciesScanned, error: scan.coverage === "unsupported" ? scan.warnings.join(" ") : null, coverageWarnings: [...scan.warnings], checkedAt: new Date().toISOString()
  }];
  return scan;
}
