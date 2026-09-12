import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDatabaseContext } from "../server/db/client";
import { runMigrations } from "../server/db/migrations";
import { createRepositories } from "../server/db/repositories";
import {
  applyObjectiveHardGate,
  ensureObjectiveForTarget,
  preflightObjectiveJob,
  recordObjectiveJobResult
} from "../server/services/objective-runs";

async function createObjectiveFixture(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `oneteam-objective-gate-${name}-`));
  const context = createDatabaseContext(`file:${join(dir, "test.db")}`);
  await runMigrations(context.client);
  const repos = createRepositories(context.db);
  const project = await repos.projects.create({ name, repoPath: dir, defaultBranch: "main" });
  const issue = await repos.issues.create({ projectId: project.id, title: `${name} objective` });
  const objective = await ensureObjectiveForTarget(repos, {
    projectId: project.id,
    targetType: "issue",
    targetId: issue.id
  });
  if (!objective) throw new Error("Objective was not created.");
  return { context, repos, project, issue, objective };
}

describe("Objective hard gates", () => {
  it("blocks implementation success without evidence", async () => {
    const fixture = await createObjectiveFixture("implementation-evidence");
    const job = await fixture.repos.agentJobs.create({
      projectId: fixture.project.id,
      agentType: "implementation",
      targetType: "issue",
      targetId: fixture.issue.id,
      input: { objectiveRunId: fixture.objective.id }
    });

    const result = await applyObjectiveHardGate(fixture.repos, job, {
      status: "succeeded",
      message: "Implementation reported completion."
    });

    expect(result).toMatchObject({ status: "waiting_human", stopReason: "waiting_human" });
    expect(result.message).toContain("Implementation cannot finish without evidence");
    expect(result.evidence?.at(-1)).toMatchObject({
      type: "objective_gate",
      title: "Implementation evidence missing"
    });
    fixture.context.client.close();
  });

  it("stops at max rounds without charging a preflight gate as another round", async () => {
    const fixture = await createObjectiveFixture("max-rounds");
    await fixture.repos.objectives.update(fixture.project.id, fixture.objective.id, {
      status: "running",
      roundCount: 2,
      maxRounds: 2
    });
    const job = await fixture.repos.agentJobs.create({
      projectId: fixture.project.id,
      agentType: "review",
      targetType: "issue",
      targetId: fixture.issue.id,
      input: { objectiveRunId: fixture.objective.id }
    });

    const blocked = await preflightObjectiveJob(fixture.repos, job);
    expect(blocked).toMatchObject({
      status: "waiting_human",
      stopReason: "max_rounds_exceeded",
      metadata: { objectivePreflightGate: true }
    });
    if (!blocked) throw new Error("Max-rounds gate did not return a result.");
    const recorded = await recordObjectiveJobResult(fixture.repos, { job, result: blocked });
    expect(recorded).toMatchObject({
      status: "waiting_human",
      stopReason: "max_rounds_exceeded",
      roundCount: 2,
      maxRounds: 2
    });
    fixture.context.client.close();
  });

  it("routes the same failure twice to a human gate", async () => {
    const fixture = await createObjectiveFixture("repeated-failure");
    const failure = {
      status: "failed" as const,
      message: "Tests still fail in the same way.",
      stopReason: "failed" as const,
      testResults: [{ command: "npm test", status: "failed", exitCode: 1 }]
    };
    const firstJob = await fixture.repos.agentJobs.create({
      projectId: fixture.project.id,
      agentType: "fix",
      targetType: "issue",
      targetId: fixture.issue.id,
      input: { objectiveRunId: fixture.objective.id }
    });
    const first = await recordObjectiveJobResult(fixture.repos, { job: firstJob, result: failure });
    expect(first).toMatchObject({ status: "failed", roundCount: 1, repeatedFailureCount: 1 });

    const secondJob = await fixture.repos.agentJobs.create({
      projectId: fixture.project.id,
      agentType: "fix",
      targetType: "issue",
      targetId: fixture.issue.id,
      input: { objectiveRunId: fixture.objective.id }
    });
    const second = await recordObjectiveJobResult(fixture.repos, { job: secondJob, result: failure });
    expect(second).toMatchObject({
      status: "waiting_human",
      stopReason: "waiting_human",
      roundCount: 2,
      repeatedFailureCount: 2
    });
    fixture.context.client.close();
  });
});
