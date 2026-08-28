import { describe, expect, it } from "vitest";
import { collectPullRequestFindings } from "../server/services/pull-request-findings";
import type { AgentJobDto } from "../shared/types";

describe("pull request findings", () => {
  it("normalizes review and QA findings with file and line locations", () => {
    const findings = collectPullRequestFindings([
      job(1, "review", {
        review: {
          verdict: "changes_requested",
          findings: [
            {
              severity: "HIGH",
              path: "src/app.ts",
              line: 12,
              side: "old",
              title: "Missing validation",
              body: "Reject empty input."
            }
          ]
        }
      }),
      job(2, "qa", {
        qa: {
          verdict: "defects_found",
          defects: [{ file: "src/form.ts", lineNumber: "8", title: "Keyboard trap", description: "Focus cannot leave." }]
        }
      })
    ]);

    expect(findings).toEqual([
      expect.objectContaining({ source: "review", severity: "high", path: "src/app.ts", line: 12, side: "L" }),
      expect.objectContaining({ source: "qa", severity: "medium", path: "src/form.ts", line: 8, side: "R" })
    ]);
  });

  it("retains findings and marks them resolved by a fix or later approval", () => {
    const findings = collectPullRequestFindings([
      job(1, "review", {
        review: {
          verdict: "changes_requested",
          findings: [
            { path: "a.ts", line: 2, title: "First finding", body: "Fix first." },
            { path: "b.ts", line: 4, title: "Second finding", body: "Fix second." }
          ]
        }
      }),
      job(2, "fix", { fix: { resolvedFindings: ["First finding"] } }),
      job(3, "review", { review: { verdict: "approved", findings: [] } })
    ]);

    expect(findings).toHaveLength(2);
    expect(findings.find((finding) => finding.title === "First finding")).toMatchObject({
      status: "resolved",
      resolvedByJobId: 2
    });
    expect(findings.find((finding) => finding.title === "Second finding")).toMatchObject({
      status: "resolved",
      resolvedByJobId: 3
    });
  });

  it("ignores failed jobs and findings without a path or title", () => {
    const failed = job(1, "review", {
      review: { verdict: "changes_requested", findings: [{ path: "a.ts", title: "Ignored" }] }
    });
    failed.status = "failed";
    const findings = collectPullRequestFindings([
      failed,
      job(2, "review", { review: { verdict: "changes_requested", findings: [{ title: "No path" }] } })
    ]);

    expect(findings).toEqual([]);
  });
});

function job(id: number, agentType: AgentJobDto["agentType"], metadata: Record<string, unknown>): AgentJobDto {
  const timestamp = new Date(Date.UTC(2026, 7, 28, 0, id)).toISOString();
  return {
    id,
    projectId: "project-1",
    aiProvider: "codex",
    aiModel: null,
    agentType,
    targetType: "pull_request",
    targetId: 1,
    status: "succeeded",
    triggerType: "automatic",
    parentJobId: null,
    input: {},
    output: { status: "succeeded", message: "done", metadata },
    error: null,
    attempt: 1,
    lockKey: null,
    waitReason: null,
    waitMetadata: null,
    nextRetryAt: null,
    createdAt: timestamp,
    startedAt: timestamp,
    finishedAt: timestamp
  };
}
