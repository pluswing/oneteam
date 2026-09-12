import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { AgentWorker } from "../server/agents/worker";
import type { AgentAdapter, AgentRunResult } from "../server/agents/types";
import { createDatabaseContext } from "../server/db/client";
import { runMigrations } from "../server/db/migrations";
import { createRepositories } from "../server/db/repositories";
import { startLoopRun } from "../server/services/loop-runner";
import { cleanupWorktree, prepareLoopSnapshotWorktree } from "../server/services/worktree-service";

const execFileAsync = promisify(execFile);

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: repoPath });
  return stdout.trim();
}

async function createGitRepo(prefix: string): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), prefix));
  await git(repoPath, ["init", "-b", "main"]);
  await git(repoPath, ["config", "user.name", "Test User"]);
  await git(repoPath, ["config", "user.email", "test@example.com"]);
  await writeFile(join(repoPath, "README.md"), "# Example\n");
  await git(repoPath, ["add", "README.md"]);
  await git(repoPath, ["commit", "-m", "initial"]);
  return repoPath;
}

describe("Loop snapshot worktrees", () => {
  it("creates and recovers a detached snapshot without touching a dirty primary workspace", async () => {
    const repoPath = await createGitRepo("oneteam-loop-snapshot-");
    await writeFile(join(repoPath, "README.md"), "# Example\n\nDirty primary change\n");
    const project = { id: `snapshot-${Date.now()}`, repoPath, defaultBranch: "main" };
    const snapshot = await prepareLoopSnapshotWorktree(project, "main");

    try {
      expect(snapshot.kind).toBe("snapshot");
      expect(snapshot.repoPath).not.toBe(repoPath);
      expect(await git(snapshot.repoPath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("HEAD");
      expect(snapshot.snapshotCommit).toBe(await git(repoPath, ["rev-parse", "main"]));
      expect(await git(snapshot.repoPath, ["status", "--porcelain"])).toBe("");
      expect(await git(repoPath, ["status", "--porcelain"])).toContain("README.md");

      const recovered = await prepareLoopSnapshotWorktree(project, "main", snapshot.worktreePath);
      expect(recovered).toMatchObject({
        kind: "snapshot",
        worktreePath: snapshot.worktreePath,
        snapshotCommit: snapshot.snapshotCommit,
        recovered: true,
        recoveryReason: "reused_loop_snapshot_worktree"
      });
    } finally {
      await cleanupWorktree(project, snapshot.worktreePath);
    }
  });

  it("isolates and blocks mutations made by a non-writing Loop role", async () => {
    const databaseDir = await mkdtemp(join(tmpdir(), "oneteam-loop-snapshot-db-"));
    const repoPath = await createGitRepo("oneteam-loop-snapshot-worker-");
    await git(repoPath, ["checkout", "-b", "feature/review"]);
    await writeFile(join(repoPath, "feature.txt"), "review me\n");
    await git(repoPath, ["add", "feature.txt"]);
    await git(repoPath, ["commit", "-m", "feature"]);
    await git(repoPath, ["checkout", "main"]);

    const context = createDatabaseContext(`file:${join(databaseDir, "test.db")}`);
    await runMigrations(context.client);
    const repos = createRepositories(context.db);
    const project = await repos.projects.create({ name: "Snapshot guard", repoPath, defaultBranch: "main" });
    const pullRequest = await repos.pullRequests.create({
      projectId: project.id,
      title: "Review snapshot",
      sourceBranch: "feature/review",
      targetBranch: "main"
    });
    const loop = await repos.loops.create({
      projectId: project.id,
      name: "Review loop",
      purpose: "Review without repository writes.",
      triggerType: "manual",
      targetScope: "pull_request"
    });
    const started = await startLoopRun(repos, {
      projectId: project.id,
      loopId: loop.id,
      agentType: "review",
      targetType: "pull_request",
      targetId: pullRequest.id,
      triggerType: "test"
    });
    let executionRepoPath = "";
    const adapter: AgentAdapter = {
      async run(input) {
        executionRepoPath = input.repoPath;
        await writeFile(join(input.repoPath, "unexpected.txt"), "mutation\n");
        return {
          status: "succeeded",
          message: "Review completed.",
          metadata: { review: { verdict: "approved", findings: [], checked: [] } }
        };
      }
    };

    const worker = new AgentWorker(repos, adapter, { pollIntervalMs: 1_000 });
    await worker.tick();

    const job = await repos.agentJobs.get(project.id, started.job.id);
    const run = await repos.loopRuns.get(project.id, started.run.id);
    const output = job?.output as AgentRunResult | null;
    expect(executionRepoPath).not.toBe(repoPath);
    expect(job?.status).toBe("waiting_human");
    expect(run?.status).toBe("waiting_human");
    expect(output?.stopReason).toBe("risk_detected");
    expect(output?.evidence?.map((item) => item.title)).toContain("Snapshot mutation blocked");
    expect(output?.metadata?.worktreeRetention).toMatchObject({
      action: "retain",
      reason: "human_gate",
      worktreeKind: "snapshot"
    });
    expect(await git(repoPath, ["status", "--porcelain"])).toBe("");

    if (run?.worktreePath) await cleanupWorktree(project, run.worktreePath);
    context.client.close();
  });
});
