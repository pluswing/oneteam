import { access, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import { createDatabaseContext } from "../server/db/client";
import { runMigrations } from "../server/db/migrations";
import { createRepositories } from "../server/db/repositories";
import { ensureSystemLoop, startLoopRun } from "../server/services/loop-runner";
import { ensureObjectiveForTarget } from "../server/services/objective-runs";
import type { AgentJobDto, ObjectiveRunDto } from "../shared/types";

describe("objective controls", () => {
  it("pauses, resumes, and cancels the whole persisted workflow", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneteam-objective-control-"));
    const context = createDatabaseContext(`file:${join(dir, "test.db")}`);
    await runMigrations(context.client);
    const repos = createRepositories(context.db);
    const app = createApp({ repos });
    const project = await repos.projects.create({
      name: "Controls",
      repoPath: dir,
      defaultBranch: "main",
      locale: "en"
    });
    const issue = await repos.issues.create({ projectId: project.id, title: "Controllable objective" });
    const objective = await ensureObjectiveForTarget(repos, {
      projectId: project.id,
      targetType: "issue",
      targetId: issue.id
    });
    const loop = await ensureSystemLoop(repos, {
      projectId: project.id,
      name: "Controlled loop",
      purpose: "Verify persisted workflow controls.",
      triggerType: "manual",
      targetScope: "issue"
    });
    const started = await startLoopRun(repos, {
      projectId: project.id,
      loopId: loop.id,
      agentType: "implementation",
      targetType: "issue",
      targetId: issue.id,
      triggerType: "manual",
      objectiveRunId: objective?.id ?? null,
      jobInput: { objectiveRunId: objective?.id ?? null }
    });
    const retainedWorktreePath = join(dir, "retained-worktree");
    await mkdir(retainedWorktreePath);
    await repos.loopRuns.setWorktreeState(project.id, started.run.id, { worktreePath: retainedWorktreePath });
    await Promise.all([
      repos.agentJobs.updateStatus(project.id, started.job.id, "running"),
      repos.loopSteps.updateForAgentJob(project.id, started.job.id, { status: "running" }),
      repos.loopRuns.updateStatus(project.id, started.run.id, "running"),
      objective ? repos.objectives.update(project.id, objective.id, { status: "running" }) : null
    ]);
    if (!objective) throw new Error("Expected an objective.");

    const pauseResponse = await app.request(`/api/projects/${project.id}/objectives/${objective.id}/pause`, {
      method: "POST"
    });
    const paused = (await pauseResponse.json()) as { objective: ObjectiveRunDto; jobs: AgentJobDto[] };
    const [pausedStep, pausedRun] = await Promise.all([
      repos.loopSteps.getByAgentJob(project.id, started.job.id),
      repos.loopRuns.get(project.id, started.run.id)
    ]);

    expect(pauseResponse.status).toBe(200);
    expect(paused.objective).toMatchObject({ status: "paused", roundCount: 0, stopReason: "paused_by_user" });
    expect(paused.jobs).toMatchObject([{ id: started.job.id, status: "paused", attempt: 1 }]);
    expect(pausedStep?.status).toBe("paused");
    expect(pausedRun).toMatchObject({ status: "paused", stopReason: "paused_by_user" });
    await expect(access(retainedWorktreePath)).resolves.toBeUndefined();
    await expect(repos.agentJobs.updateStatus(project.id, started.job.id, "running")).resolves.toBeNull();

    const blockedManualJob = await app.request(`/api/projects/${project.id}/agent-jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentType: "implementation",
        targetType: "issue",
        targetId: issue.id,
        triggerType: "manual"
      })
    });
    expect(blockedManualJob.status).toBe(409);

    const resumeResponse = await app.request(`/api/projects/${project.id}/objectives/${objective.id}/resume`, {
      method: "POST"
    });
    const resumed = (await resumeResponse.json()) as { objective: ObjectiveRunDto; jobs: AgentJobDto[] };
    expect(resumeResponse.status).toBe(200);
    expect(resumed.objective).toMatchObject({ status: "running", roundCount: 0, stopReason: null });
    expect(resumed.jobs).toMatchObject([{ id: started.job.id, status: "queued", attempt: 2 }]);
    await expect(repos.loopSteps.getByAgentJob(project.id, started.job.id)).resolves.toMatchObject({ status: "queued" });
    await expect(repos.loopRuns.get(project.id, started.run.id)).resolves.toMatchObject({ status: "queued", stopReason: null });

    const cancelResponse = await app.request(`/api/projects/${project.id}/objectives/${objective.id}/cancel`, {
      method: "POST"
    });
    const canceled = (await cancelResponse.json()) as { objective: ObjectiveRunDto; jobs: AgentJobDto[] };
    const [comments, activities] = await Promise.all([
      repos.comments.list(project.id, "issue", issue.id),
      repos.activities.list(project.id, "issue", issue.id)
    ]);
    expect(cancelResponse.status).toBe(200);
    expect(canceled.objective).toMatchObject({ status: "canceled", roundCount: 0, stopReason: "canceled_by_user" });
    expect(canceled.jobs).toMatchObject([{ id: started.job.id, status: "canceled" }]);
    expect(comments.map((comment) => comment.metadata?.objectiveControl)).toEqual(["pause", "resume", "cancel"]);
    expect(activities.map((activity) => activity.title)).toEqual([
      "Objective paused",
      "Objective resumed",
      "Worktree cleaned up",
      "Objective canceled"
    ]);
    await expect(access(retainedWorktreePath)).rejects.toThrow();
    await expect(repos.loopRuns.get(project.id, started.run.id)).resolves.toMatchObject({ worktreePath: null });

    context.client.close();
  });
});
