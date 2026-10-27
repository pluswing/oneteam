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
  kind?: "vulnerability" | "support_end" | "scan_failure" | "coverage_gap";
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
  if (finding.kind === "support_end") {
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
  if (finding.kind === "support_end") {
    const checks = scan.lifecycleChecks?.filter((check) => check.targetId === (finding.targetId ?? "application")
      && (check.product === finding.lifecycle?.product || (finding.lifecycle?.componentKind === "os" && check.componentKind === "os"))) ?? [];
    return Boolean(finding.lifecycle && checks.some((check) => check.status === "supported") && !checks.some((check) => check.status === "end_of_life"));
  }
  if (finding.kind === "scan_failure") {
    return scan.targets?.some((target) => target.id === (finding.targetId ?? "application")
      && target.scope === (finding.scope ?? "application") && target.status === "scanned" && (!finding.scanner || target.scanner === finding.scanner)
      && (!target.diagnosis || target.diagnosis.recoveryStatus === "recovered")) ?? scan.coverage === "complete";
  }
  return hasCompleteVulnerabilityTarget(scan, finding);
}
