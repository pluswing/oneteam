import type { AgentStopReason } from "../agents/types";

export type DiffRiskSeverity = "medium" | "high";
export type DiffRiskThreshold = DiffRiskSeverity | "none";

export type DiffRiskSignal = {
  title: string;
  summary: string;
  severity: DiffRiskSeverity;
  payload: Record<string, unknown>;
  stopReason?: AgentStopReason;
};

export function scanScoreManipulationRisks(diffPatch: string): DiffRiskSignal[] {
  if (!diffPatch) {
    return [];
  }

  const checks: Array<{ title: string; pattern: RegExp; summary: string; severity: DiffRiskSeverity }> = [
    {
      title: "Test skip added",
      severity: "high",
      pattern: /^\+(?!\+\+).*?\b(?:it|test|describe)\.(?:skip|only)\s*\(/m,
      summary: "Diff appears to add .skip or .only to a test block."
    },
    {
      title: "Assertion count weakened",
      severity: "high",
      pattern: /^\+(?!\+\+).*?\bexpect\.assertions\s*\(\s*0\s*\)/m,
      summary: "Diff appears to reduce required assertions to zero."
    },
    {
      title: "Error swallowed",
      severity: "medium",
      pattern: /^\+(?!\+\+).*?\bcatch\s*\([^)]*\)\s*\{\s*(?:return|\/[/*]|$)/m,
      summary: "Diff appears to add a catch block that may swallow errors."
    },
    {
      title: "Test file deleted",
      severity: "high",
      pattern: /^deleted file mode [^\n]+\nindex [^\n]+\n--- a\/.*(?:__tests__|\.test\.|\.spec\.)/m,
      summary: "Diff appears to delete a test file."
    }
  ];

  return checks
    .filter((check) => check.pattern.test(diffPatch))
    .map((check) => ({
      title: check.title,
      summary: check.summary,
      severity: check.severity,
      payload: {
        detector: "score_manipulation_diff_scan",
        severity: check.severity
      },
      stopReason: "risk_detected" as const
    }));
}

export function riskSignalsAtOrAbove(
  signals: DiffRiskSignal[],
  threshold: DiffRiskThreshold
): DiffRiskSignal[] {
  if (threshold === "none") return [];
  const ranks: Record<DiffRiskSeverity, number> = { medium: 1, high: 2 };
  return signals.filter((signal) => ranks[signal.severity] >= ranks[threshold]);
}
