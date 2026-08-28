import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDatabaseContext } from "../server/db/client";
import { runMigrations } from "../server/db/migrations";
import { createRepositories } from "../server/db/repositories";
import { ensureSystemLoop, startLoopRun } from "../server/services/loop-runner";
import { ensureObjectiveForTarget } from "../server/services/objective-runs";
import { recoverInterruptedAgentJobs } from "../server/services/runtime-recovery";

describe("runtime recovery", () => {
  it("requeues interrupted jobs and synchronizes their loop, objective, and activity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneteam-runtime-recovery-"));
    const context = createDatabaseContext(`file:${join(dir, "test.db")}`);
    await runMigrations(context.client);
    const repos = createRepositories(context.db);
    const project = await repos.projects.create({
      name: "Recovery",
      repoPath: dir,
      defaultBranch: "main",
      locale: "en"
    });
    const issue = await repos.issues.create({ projectId: project.id, title: "Resume implementation" });
    const objective = await ensureObjectiveForTarget(repos, {
      projectId: project.id,
      targetType: "issue",
      targetId: issue.id
    });
    const loop = await ensureSystemLoop(repos, {
      projectId: project.id,
      name: "Recovery loop",
      purpose: "Verify restart recovery.",
      triggerType: "label",
      targetScope: "issue:ready-for-implementation"
    });
    const started = await startLoopRun(repos, {
      projectId: project.id,
      loopId: loop.id,
      agentType: "implementation",
      targetType: "issue",
      targetId: issue.id,
      triggerType: "label_applied",
      objectiveRunId: objective?.id ?? null,
      jobInput: { objectiveRunId: objective?.id ?? null }
    });
    await Promise.all([
      repos.agentJobs.updateStatus(project.id, started.job.id, "running"),
      repos.loopSteps.updateForAgentJob(project.id, started.job.id, { status: "running" }),
      repos.loopRuns.updateStatus(project.id, started.run.id, "running"),
      objective ? repos.objectives.update(project.id, objective.id, { status: "running", summary: "Implementation started." }) : null
    ]);

    const recovered = await recoverInterruptedAgentJobs(repos);
    const [job, step, run, updatedObjective, activities] = await Promise.all([
      repos.agentJobs.get(project.id, started.job.id),
      repos.loopSteps.getByAgentJob(project.id, started.job.id),
      repos.loopRuns.get(project.id, started.run.id),
      objective ? repos.objectives.get(project.id, objective.id) : null,
      repos.activities.list(project.id, "issue", issue.id)
    ]);

    expect(recovered).toHaveLength(1);
    expect(job).toMatchObject({ status: "queued", attempt: 2, error: "Recovered interrupted running job." });
    expect(step?.status).toBe("queued");
    expect(run).toMatchObject({ status: "queued", stopReason: "runtime_restarted" });
    expect(updatedObjective).toMatchObject({
      status: "running",
      roundCount: 0,
      stopReason: null
    });
    expect(activities.at(-1)).toMatchObject({
      agentJobId: started.job.id,
      title: "Interrupted agent job recovered",
      payload: { attempt: 2, recoveryReason: "runtime_restarted" }
    });
    await expect(recoverInterruptedAgentJobs(repos)).resolves.toEqual([]);

    context.client.close();
  });
});
