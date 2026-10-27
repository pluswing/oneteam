import type { DevelopmentPhase, DevelopmentStatus } from "./development-loop";
import type { VulnerabilityRemediationPlan } from "./vulnerability-plan";

export type VulnerabilitySeverity = "critical" | "high" | "medium" | "low" | "unknown";
export type VulnerabilityScope = "application" | "container" | "deployment";
export type ScanFailureDiagnosis = {
  category: "network" | "database" | "cache" | "tool" | "authentication" | "configuration" | "target" | "timeout" | "unknown";
  summary: string;
  details: string;
  retryable: boolean;
  recoveryStatus: "recovered" | "failed" | "requires_action";
  attemptedActions: string[];
  fingerprint: string;
};
export type VulnerabilityLifecycleCheck = {
  targetId: string;
  product: string;
  cycle: string;
  status: "supported" | "end_of_life";
  componentKind?: "os" | "runtime" | "middleware";
  installedVersion?: string;
  latestSupportedVersion?: string;
  newerSupportedCycles?: number;
  supportEndsAt?: string | null;
  manifestPath?: string;
  sourceUrl?: string;
  scope?: VulnerabilityScope;
  targetLabel?: string;
  remediationMode?: "repository" | "external";
};
export type VulnerabilityScanTarget = {
  id: string;
  scope: VulnerabilityScope;
  kind: string;
  label: string;
  sourcePath: string;
  ref: string;
  status: "pending" | "scanned" | "failed" | "unavailable" | "unsupported";
  scanner: string;
  coverage: "complete" | "partial" | "unsupported";
  dependenciesScanned: number;
  error: string | null;
  checkedAt: string | null;
  diagnosis?: ScanFailureDiagnosis;
  coverageWarnings?: string[];
};
export type VulnerabilityFinding = {
  remediationTarget?: {
    kind: "image" | "environment";
    name: string;
    reference: string;
  };
  kind?: "vulnerability" | "support_end" | "platform_update" | "scan_failure" | "coverage_gap";
  coverageGap?: {
    category: "inventory" | "build" | "configuration" | "deployment" | "access" | "scanner" | "limit" | "lifecycle" | "other";
    warnings: string[];
    action: string;
    sourcePaths: string[];
    evidence: "target" | "project";
    targetKind: string;
    reference: string;
  };
  lifecycle?: {
    componentKind: "os" | "runtime" | "middleware";
    product: string;
    cycle: string;
    supportEndedAt: string | null;
    sourceUrl: string;
  };
  scanFailure?: ScanFailureDiagnosis;
  translations?: {
    ja?: { summary: string; details: string; sourceHash: string; status: "translated" | "pending" | "failed" };
  };
  scope?: VulnerabilityScope;
  targetId?: string;
  targetLabel?: string;
  scanner?: string;
  remediationMode?: "repository" | "external";
  id: string;
  advisoryId: string;
  aliases: string[];
  packageName: string;
  ecosystem: string;
  installedVersion: string;
  manifestPath: string;
  summary: string;
  details: string;
  severity: VulnerabilitySeverity;
  references: string[];
  fixedVersions: string[];
  publishedAt: string | null;
  modifiedAt: string | null;
};
export type VulnerabilityScanResult = {
  inspectionSources?: string[];
  targets?: VulnerabilityScanTarget[];
  lifecycleChecks?: VulnerabilityLifecycleCheck[];
  recoveries?: ScanFailureDiagnosis[];
  inventoryHash: string;
  dependenciesScanned: number;
  manifests: string[];
  warnings: string[];
  coverage: "complete" | "partial" | "unsupported";
  findings: VulnerabilityFinding[];
};
export type VulnerabilityRecord = VulnerabilityFinding & {
  status: "open" | "resolved";
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  remediationId: string | null;
};
export type VulnerabilitySettings = {
  autoRefresh: boolean;
  autoRemediate: boolean;
  intervalHours: number;
};
export type VulnerabilityScanState = {
  inspectionSources?: string[];
  lifecycleChecks?: VulnerabilityLifecycleCheck[];
  recoveries?: ScanFailureDiagnosis[];
  targets?: VulnerabilityScanTarget[];
  status: "never" | "scanning" | "succeeded" | "failed";
  startedAt: string | null;
  completedAt: string | null;
  nextScanAt: string | null;
  error: string | null;
  inventoryHash: string | null;
  dependenciesScanned: number;
  manifests: string[];
  warnings: string[];
  coverage: "complete" | "partial" | "unsupported";
};
export type VulnerabilityRemediation = {
  stage?: VulnerabilityRemediationPlan["stage"];
  policyVersion?: number;
  verifiedAt?: string;
  verification?: { status: "passed" | "failed"; checkedAt: string; summary: string };
  id: string;
  findingIds: string[];
  issueId: number;
  loopId: number;
  status: DevelopmentStatus;
  phase: DevelopmentPhase;
  pullRequestId: number | null;
  summary: string;
  createdAt: string;
  updatedAt: string;
};
export type VulnerabilityDashboard = {
  projectId: string;
  settings: VulnerabilitySettings;
  scan: VulnerabilityScanState;
  findings: VulnerabilityRecord[];
  remediations: VulnerabilityRemediation[];
  remediationPlan?: VulnerabilityRemediationPlan;
};

/** A failed environment must not invalidate evidence for an independently verified application. */
export function hasCompleteVulnerabilityTarget(
  scan: Pick<VulnerabilityScanResult, "coverage" | "targets" | "manifests">,
  finding: Pick<VulnerabilityFinding, "targetId" | "scope" | "manifestPath">
): boolean {
  if (!scan.targets) return scan.coverage === "complete";
  // Losing an inventory file is not proof that its dependencies were repaired.
  if ((finding.scope ?? "application") === "application" && !scan.manifests.includes(finding.manifestPath)) return false;
  return scan.targets.some((target) => target.id === (finding.targetId ?? "application") && target.scope === (finding.scope ?? "application") && target.status === "scanned" && target.coverage === "complete");
}

/** Lifecycle updates and restoring an unavailable scanner must be possible before CVE coverage is complete. */
export function canRemediateVulnerabilityFinding(
  scan: Pick<VulnerabilityScanState, "status" | "coverage" | "targets" | "manifests">,
  finding: VulnerabilityFinding
): boolean {
  if (finding.remediationMode === "external" || scan.status === "scanning" || scan.status === "never") return false;
  if (finding.kind === "coverage_gap") return scan.status === "succeeded" && Boolean(finding.coverageGap);
  if (finding.kind === "scan_failure") {
    return !scan.targets ? scan.status === "failed" : scan.targets.some((target) => target.id === (finding.targetId ?? "application")
      && target.scope === (finding.scope ?? "application") && (["failed", "unavailable"].includes(target.status) || Boolean(target.diagnosis && target.diagnosis.recoveryStatus !== "recovered")));
  }
  if (finding.kind === "support_end" || finding.kind === "platform_update") {
    return scan.status === "succeeded" && Boolean(finding.lifecycle)
      && (!scan.targets || scan.targets.some((target) => target.id === (finding.targetId ?? "application")
        && target.scope === (finding.scope ?? "application") && ["scanned", "unsupported"].includes(target.status)));
  }
  return scan.status === "succeeded" && finding.fixedVersions.length > 0 && hasCompleteVulnerabilityTarget(scan, finding);
}

/** Missing lifecycle data or an absent failed target cannot prove that a repair worked. */
export function hasVulnerabilityResolutionEvidence(
  scan: Pick<VulnerabilityScanResult, "coverage" | "targets" | "manifests" | "lifecycleChecks" | "warnings" | "inspectionSources">,
  finding: VulnerabilityFinding
): boolean {
  if (finding.kind === "coverage_gap") {
    const gap = finding.coverageGap;
    if (!gap || gap.warnings.some((warning) => scan.warnings.includes(warning))) return false;
    const sources = new Set(scan.inspectionSources ?? scan.manifests);
    if (!gap.sourcePaths.every((source) => sources.has(source))) return false;
    if (gap.evidence === "project") return scan.coverage === "complete" && scan.warnings.length === 0;
    const targets = scan.targets?.filter((target) => target.id === finding.targetId) ?? [];
    if (!targets.length && gap.targetKind === "unresolved") {
      // Parsing a previously invalid definition can replace its unresolved target IDs.
      targets.push(...(scan.targets ?? []).filter((target) => gap.sourcePaths.includes(target.sourcePath)));
    }
    return targets.length > 0 && targets.every((target) => target.status === "scanned" && target.coverage === "complete" && !target.coverageWarnings?.length);
  }
  if (finding.kind === "support_end" || finding.kind === "platform_update") {
    const checks = scan.lifecycleChecks?.filter((check) => check.targetId === (finding.targetId ?? "application")
      && (check.product === finding.lifecycle?.product || (finding.lifecycle?.componentKind === "os" && check.componentKind === "os"))) ?? [];
    const supported = checks.filter((check) => check.status === "supported");
    if (!finding.lifecycle || !supported.length || checks.some((check) => check.status === "end_of_life")) return false;
    // A supported cycle alone cannot prove that a proposed version update happened.
    return finding.kind !== "platform_update" || supported.every((check) => Boolean(check.installedVersion && check.latestSupportedVersion)
      && platformVersionAtLeast(check.installedVersion!, check.latestSupportedVersion!, false, check.componentKind === "os" ? check.cycle : undefined)
      && (check.product !== finding.lifecycle!.product || platformVersionAtLeast(check.installedVersion!, finding.installedVersion, true)));
  }
  if (finding.kind === "scan_failure") {
    return scan.targets?.some((target) => target.id === (finding.targetId ?? "application")
      && target.scope === (finding.scope ?? "application") && target.status === "scanned" && (!finding.scanner || target.scanner === finding.scanner)
      && (!target.diagnosis || target.diagnosis.recoveryStatus === "recovered")) ?? scan.coverage === "complete";
  }
  return hasCompleteVulnerabilityTarget(scan, finding);
}

/** Distro revisions do not make a current upstream version look outdated. Unknown formats are never proof. */
function platformVersionAtLeast(actual: string, required: string, strictly = false, osCycle?: string): boolean {
  const parse = (value: string) => value.replace(/^\d+:/, "").replace(/^(?:v|go)(?=\d)/, "")
    .match(/^(\d+(?:\.\d+)*)(?:$|-(?=\d|r\d)|[+~_]|\.(?=[a-z]))/i)?.[1].split(".").map(Number);
  const left = parse(actual);
  let right = parse(required);
  if (!left || !right) return false;
  const cycle = osCycle ? parse(osCycle) : undefined;
  // Trivy may identify only an OS cycle, while the catalog latest names installation media.
  if (cycle && cycle.length === left.length && cycle.every((part, index) => part === left[index])) right = right.slice(0, left.length);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference > 0;
  }
  return !strictly;
}
