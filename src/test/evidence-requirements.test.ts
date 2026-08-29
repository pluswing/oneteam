import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateEvidenceRequirements,
  normalizeEvidenceRequirements,
  type ObjectiveEvidenceRequirement
} from "../shared/evidence-requirements";
import { createDatabaseContext } from "../server/db/client";
import { runMigrations } from "../server/db/migrations";
import { createRepositories } from "../server/db/repositories";
import {
  applyObjectiveHardGate,
  ensureObjectiveForTarget,
  recordObjectiveJobResult
} from "../server/services/objective-runs";

describe("typed Evidence Required gates", () => {
  it("normalizes supported requirement fields and discards unknown input", () => {
    expect(normalizeEvidenceRequirements([
      { type: "test", required: true, commitScope: "source", maxAgeHours: 24.4 },
      { type: "test", required: false, commitScope: "source", maxAgeHours: 24 },
      { type: "unknown", required: true, commitScope: "source", maxAgeHours: 1 },
      { type: "qa", required: true, commitScope: "both", maxAgeHours: 100_000 }
    ])).toEqual([
      { type: "test", required: true, commitScope: "source", maxAgeHours: 24 },
      { type: "qa", required: true, commitScope: "both", maxAgeHours: 720 }
    ]);
  });

  it("distinguishes missing, stale, commit-mismatched, and unavailable evidence", () => {
    const requirements: ObjectiveEvidenceRequirement[] = [
      { type: "test", required: true, commitScope: "source", maxAgeHours: 1 },
      { type: "build", required: true, commitScope: "target", maxAgeHours: null },
      { type: "screenshot", required: true, commitScope: "none", maxAgeHours: null },
      { type: "qa", required: true, commitScope: "both", maxAgeHours: 24 },
      { type: "performance", required: false, commitScope: "none", maxAgeHours: null }
    ];
    const now = Date.parse("2026-08-28T12:00:00.000Z");
    const evaluation = evaluateEvidenceRequirements(requirements, [
      {
        type: "test",
        title: "Tests passed yesterday",
        payload: {
          status: "passed",
          sourceCommit: "source-current",
          capturedAt: "2026-08-28T10:00:00.000Z"
        }
      },
      {
        type: "build",
        title: "Build for old target",
        payload: { status: "passed", targetCommit: "target-old" }
      },
      {
        type: "screenshot",
        title: "Missing screenshot artifact",
        payload: { artifact: { kind: "image", status: "unavailable" } }
      }
    ], {
      sourceCommit: "source-current",
      targetCommit: "target-current",
      now
    });

    expect(evaluation.passed).toBe(false);
    expect(evaluation.checks.map((check) => [check.requirement.type, check.status])).toEqual([
      ["test", "stale"],
      ["build", "commit_mismatch"],
      ["screenshot", "unavailable"],
      ["qa", "missing"],
      ["performance", "optional_missing"]
    ]);
  });

  it("treats failed GitHub Actions conclusions as unavailable CI Evidence", () => {
    const requirement: ObjectiveEvidenceRequirement[] = [
      { type: "ci_status", required: true, commitScope: "source", maxAgeHours: 1 }
    ];
    const evaluation = evaluateEvidenceRequirements(requirement, [{
      type: "ci_status",
      title: "GitHub Actions: CI",
      payload: {
        status: "failure",
        workflowStatus: "completed",
        conclusion: "failure",
        sourceCommit: "current",
        capturedAt: "2026-08-29T01:00:00.000Z"
      }
    }], {
      sourceCommit: "current",
      targetCommit: null,
      now: Date.parse("2026-08-29T01:05:00.000Z")
    });

    expect(evaluation.passed).toBe(false);
    expect(evaluation.checks[0]?.status).toBe("unavailable");
  });

  it("keeps pending CI Evidence unavailable until the workflow succeeds", () => {
    const requirement: ObjectiveEvidenceRequirement[] = [
      { type: "ci_status", required: true, commitScope: "source", maxAgeHours: null }
    ];
    const evidence = (status: string) => [{
      type: "ci_status",
      title: "GitHub Actions: CI",
      payload: { status, sourceCommit: "current" }
    }];
    const context = { sourceCommit: "current", targetCommit: null };

    expect(evaluateEvidenceRequirements(requirement, evidence("in_progress"), context).checks[0]?.status)
      .toBe("unavailable");
    expect(evaluateEvidenceRequirements(requirement, evidence("success"), context).checks[0]?.status)
      .toBe("passed");
  });

  it("persists requirements-agent rules and blocks a verifier with missing required evidence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneteam-evidence-required-"));
    const context = createDatabaseContext(`file:${join(dir, "test.db")}`);
    await runMigrations(context.client);
    const repos = createRepositories(context.db);
    const project = await repos.projects.create({ name: "Evidence gate", repoPath: dir, defaultBranch: "main" });
    const issue = await repos.issues.create({ projectId: project.id, title: "Require visual evidence" });
    const objective = await ensureObjectiveForTarget(repos, {
      projectId: project.id,
      targetType: "issue",
      targetId: issue.id
    });
    if (!objective) throw new Error("Objective was not created.");
    const requirementsJob = await repos.agentJobs.create({
      projectId: project.id,
      agentType: "requirements",
      targetType: "issue",
      targetId: issue.id,
      input: { objectiveRunId: objective.id }
    });
    const missingRules = await applyObjectiveHardGate(repos, requirementsJob, {
      status: "succeeded",
      message: "Requirements omitted machine-readable evidence rules.",
      metadata: { goalContract: null },
      evidence: [{ type: "test", title: "Requirements check" }]
    });
    expect(missingRules.status).toBe("waiting_human");
    expect(missingRules.message).toContain("at least one valid required Evidence Required rule");

    const updatedObjective = await recordObjectiveJobResult(repos, {
      job: requirementsJob,
      result: {
        status: "succeeded",
        message: "Goal Contract defined.",
        metadata: {
          goalContract: {
            evidenceRequired: [
              { type: "test", required: true, commitScope: "none", maxAgeHours: 24 },
              { type: "screenshot", required: true, commitScope: "none", maxAgeHours: 24 }
            ]
          }
        },
        evidence: [{ type: "test", title: "Requirements check" }]
      }
    });
    expect(updatedObjective?.evidenceRequirements).toEqual([
      { type: "test", required: true, commitScope: "none", maxAgeHours: 24 },
      { type: "screenshot", required: true, commitScope: "none", maxAgeHours: 24 }
    ]);

    const verifierJob = await repos.agentJobs.create({
      projectId: project.id,
      agentType: "verifier",
      targetType: "issue",
      targetId: issue.id,
      input: { objectiveRunId: objective.id }
    });
    const blocked = await applyObjectiveHardGate(repos, verifierJob, {
      status: "succeeded",
      message: "The stop condition appears complete.",
      stopReason: "passed",
      metadata: {
        verifier: { verdict: "passed", stopConditionMet: true, missingEvidence: [], notes: [] }
      },
      evidence: [{ type: "test", title: "Fresh test", payload: { status: "passed" } }]
    });

    expect(blocked.status).toBe("waiting_human");
    expect(blocked.message).toContain("screenshot (missing)");
    expect(blocked.evidence?.at(-1)?.payload?.evidenceGate).toMatchObject({ passed: false });
    context.client.close();
  });
});
