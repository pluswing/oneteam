import type { AgentStopReason } from "../agents/types";

export type DiffRiskSignal = {
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  stopReason?: AgentStopReason;
};

export function scanScoreManipulationRisks(diffPatch: string): DiffRiskSignal[] {
  if (!diffPatch) {
    return [];
  }

  const checks: Array<{ title: string; pattern: RegExp; summary: string }> = [
    {
      title: "Test skip added",
      pattern: /^\+(?!\+\+).*?\b(?:it|test|describe)\.(?:skip|only)\s*\(/m,
      summary: "Diff appears to add .skip or .only to a test block."
    },
    {
      title: "Assertion count weakened",
      pattern: /^\+(?!\+\+).*?\bexpect\.assertions\s*\(\s*0\s*\)/m,
      summary: "Diff appears to reduce required assertions to zero."
    },
    {
      title: "Error swallowed",
      pattern: /^\+(?!\+\+).*?\bcatch\s*\([^)]*\)\s*\{\s*(?:return|\/[/*]|$)/m,
      summary: "Diff appears to add a catch block that may swallow errors."
    },
    {
      title: "Test file deleted",
      pattern: /^deleted file mode [^\n]+\nindex [^\n]+\n--- a\/.*(?:__tests__|\.test\.|\.spec\.)/m,
      summary: "Diff appears to delete a test file."
    }
  ];

  return checks
    .filter((check) => check.pattern.test(diffPatch))
    .map((check) => ({
      title: check.title,
      summary: check.summary,
      payload: {
        detector: "score_manipulation_diff_scan"
      },
      stopReason: "risk_detected" as const
    }));
}
