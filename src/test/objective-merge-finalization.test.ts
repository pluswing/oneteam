import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDatabaseContext } from "../server/db/client";
import { runMigrations } from "../server/db/migrations";
import { createRepositories } from "../server/db/repositories";
import { ensureObjectiveForTarget, markObjectiveMerged } from "../server/services/objective-runs";

describe("Objective merge finalization", () => {
  it("keeps merge Evidence and Memory idempotent across local retries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oneteam-merge-finalization-"));
    const context = createDatabaseContext(`file:${join(directory, "test.db")}`);
    await runMigrations(context.client);
    const repos = createRepositories(context.db);
    const project = await repos.projects.create({ name: "Finalization", repoPath: directory, defaultBranch: "main" });
    const issue = await repos.issues.create({ projectId: project.id, title: "Finalize once" });
    const pullRequest = await repos.pullRequests.create({
      projectId: project.id,
      issueId: issue.id,
      title: "Idempotent records",
      sourceBranch: "feature/finalize",
      targetBranch: "main"
    });
    const objective = await ensureObjectiveForTarget(repos, {
      projectId: project.id,
      targetType: "pull_request",
      targetId: pullRequest.id
    });
    const verifierJob = await repos.agentJobs.create({
      projectId: project.id,
      agentType: "verifier",
      targetType: "pull_request",
      targetId: pullRequest.id,
      input: { objectiveRunId: objective?.id ?? null }
    });
    const mergeCommit = "a".repeat(40);
    const input = {
      project,
      pullRequest,
      mergeCommit,
      verifierJob,
      importantDiffs: [{ path: "src/index.ts", line: 7, href: `/pulls/${pullRequest.id}#diff-line` }],
      mergeRetries: []
    };

    const firstMemory = await markObjectiveMerged(repos, input);
    const secondMemory = await markObjectiveMerged(repos, input);
    const [updatedObjective, memory] = await Promise.all([
      objective ? repos.objectives.get(project.id, objective.id) : null,
      repos.loopMemory.list(project.id)
    ]);
    const evidence = Array.isArray(updatedObjective?.evidence?.items) ? updatedObjective.evidence.items : [];

    expect(secondMemory?.id).toBe(firstMemory?.id);
    expect(memory.filter((entry) => entry.tags.includes(`pull_request:${pullRequest.id}`))).toHaveLength(1);
    expect(evidence.filter((item) => item.type === "merge" && item.payload?.mergeCommit === mergeCommit)).toHaveLength(1);
    expect(evidence.filter((item) => item.type === "memory" && item.payload?.memoryEntryId === firstMemory?.id)).toHaveLength(1);

    context.client.close();
  });
});
