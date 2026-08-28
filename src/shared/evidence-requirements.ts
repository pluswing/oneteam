export const objectiveEvidenceTypes = [
  "test",
  "lint",
  "build",
  "command",
  "screenshot",
  "ui_snapshot",
  "file_change",
  "diff_summary",
  "performance",
  "ci_status",
  "review",
  "qa",
  "verifier"
] as const;

export type ObjectiveEvidenceType = (typeof objectiveEvidenceTypes)[number];
export type EvidenceCommitScope = "source" | "target" | "both" | "none";

export type ObjectiveEvidenceRequirement = {
  type: ObjectiveEvidenceType;
  required: boolean;
  commitScope: EvidenceCommitScope;
  maxAgeHours: number | null;
};

export type EvidenceRequirementCheckStatus =
  | "passed"
  | "optional_missing"
  | "missing"
  | "stale"
  | "commit_mismatch"
  | "unavailable";

export type EvidenceRequirementCheck = {
  requirement: ObjectiveEvidenceRequirement;
  status: EvidenceRequirementCheckStatus;
  evidenceTitle: string | null;
  capturedAt: string | null;
};

export type EvidenceGateEvaluation = {
  passed: boolean;
  checks: EvidenceRequirementCheck[];
};

const evidenceTypeSet = new Set<string>(objectiveEvidenceTypes);
const commitScopes = new Set<EvidenceCommitScope>(["source", "target", "both", "none"]);
const maximumRequirements = 20;
const maximumFreshnessHours = 24 * 30;

export function normalizeEvidenceRequirements(value: unknown): ObjectiveEvidenceRequirement[] {
  if (!Array.isArray(value)) return [];
  const normalized: ObjectiveEvidenceRequirement[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const record = objectValue(item);
    const type = typeof record?.type === "string" && evidenceTypeSet.has(record.type)
      ? record.type as ObjectiveEvidenceType
      : null;
    const commitScope = typeof record?.commitScope === "string" && commitScopes.has(record.commitScope as EvidenceCommitScope)
      ? record.commitScope as EvidenceCommitScope
      : null;
    const hasValidFreshness = record?.maxAgeHours === null || (
      typeof record?.maxAgeHours === "number" && Number.isFinite(record.maxAgeHours)
    );
    const maxAgeHours = record?.maxAgeHours === null
      ? null
      : typeof record?.maxAgeHours === "number" && Number.isFinite(record.maxAgeHours)
        ? Math.min(maximumFreshnessHours, Math.max(1, Math.round(record.maxAgeHours)))
        : null;
    if (!type || !commitScope || typeof record?.required !== "boolean" || !hasValidFreshness) continue;
    const key = `${type}:${commitScope}:${maxAgeHours ?? "none"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ type, required: record.required, commitScope, maxAgeHours });
    if (normalized.length >= maximumRequirements) break;
  }
  return normalized;
}

export function evaluateEvidenceRequirements(
  requirements: ObjectiveEvidenceRequirement[],
  evidence: unknown[],
  context: {
    sourceCommit: string | null;
    targetCommit: string | null;
    now?: number;
  }
): EvidenceGateEvaluation {
  const now = context.now ?? Date.now();
  const checks = requirements.map((requirement): EvidenceRequirementCheck => {
    const matching = evidence.map(objectValue).filter((item): item is Record<string, unknown> => (
      item !== null && evidenceMatchesType(item, requirement.type)
    ));
    const available = matching.filter((item) => evidenceIsAvailable(item, requirement.type));
    const atCommit = available.filter((item) => evidenceMatchesCommit(item, requirement.commitScope, context));
    const fresh = atCommit.filter((item) => evidenceIsFresh(item, requirement.maxAgeHours, now));
    const selected = fresh.at(-1) ?? atCommit.at(-1) ?? available.at(-1) ?? matching.at(-1) ?? null;
    const payload = objectValue(selected?.payload);
    const capturedAt = typeof payload?.capturedAt === "string" ? payload.capturedAt : null;
    let status: EvidenceRequirementCheckStatus;
    if (fresh.length) status = "passed";
    else if (!matching.length) status = requirement.required ? "missing" : "optional_missing";
    else if (!available.length) status = "unavailable";
    else if (!atCommit.length) status = "commit_mismatch";
    else status = "stale";
    return {
      requirement,
      status,
      evidenceTitle: typeof selected?.title === "string" ? selected.title : null,
      capturedAt
    };
  });
  return {
    passed: checks.every((check) => check.status === "passed" || !check.requirement.required),
    checks
  };
}

export function evidenceGateFailureSummary(evaluation: EvidenceGateEvaluation): string {
  return evaluation.checks
    .filter((check) => check.requirement.required && check.status !== "passed")
    .map((check) => `${check.requirement.type} (${check.status.replaceAll("_", " ")})`)
    .join(", ");
}

function evidenceMatchesType(item: Record<string, unknown>, type: ObjectiveEvidenceType): boolean {
  if (item.type === type) return true;
  const payload = objectValue(item.payload);
  return ["review", "qa", "verifier"].includes(type) && item.type === "agent_job" && payload?.agentType === type;
}

function evidenceIsAvailable(item: Record<string, unknown>, type: ObjectiveEvidenceType): boolean {
  const payload = objectValue(item.payload);
  const status = typeof payload?.status === "string" ? payload.status : null;
  if (status && ["failed", "canceled", "unavailable", "waiting_human"].includes(status)) return false;
  if (type !== "screenshot") return true;
  const artifact = objectValue(payload?.artifact);
  return artifact?.kind === "image" && artifact.status === "available";
}

function evidenceMatchesCommit(
  item: Record<string, unknown>,
  scope: EvidenceCommitScope,
  context: { sourceCommit: string | null; targetCommit: string | null }
): boolean {
  if (scope === "none") return true;
  const payload = objectValue(item.payload);
  const sourceMatches = Boolean(context.sourceCommit) && payload?.sourceCommit === context.sourceCommit;
  const targetMatches = Boolean(context.targetCommit) && payload?.targetCommit === context.targetCommit;
  if (scope === "source") return sourceMatches;
  if (scope === "target") return targetMatches;
  return sourceMatches && targetMatches;
}

function evidenceIsFresh(item: Record<string, unknown>, maxAgeHours: number | null, now: number): boolean {
  if (maxAgeHours === null) return true;
  const payload = objectValue(item.payload);
  const capturedAt = typeof payload?.capturedAt === "string" ? Date.parse(payload.capturedAt) : Number.NaN;
  if (!Number.isFinite(capturedAt)) return false;
  const age = now - capturedAt;
  return age >= 0 && age <= maxAgeHours * 60 * 60 * 1000;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
