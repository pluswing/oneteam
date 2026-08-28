import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createDatabaseContext } from "../server/db/client";
import { runMigrations } from "../server/db/migrations";
import { createRepositories } from "../server/db/repositories";
import { ObjectiveScheduler } from "../server/services/objective-scheduler";

const execFileAsync = promisify(execFile);

describe("Objective scheduler discovery", () => {
  it("discovers stale Objectives, verification failures, regressions, and tracked TODOs without duplicates", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "oneteam-scheduler-repo-"));
    await execFileAsync("git", ["init", "-b", "main"], { cwd: repoPath });
    await execFileAsync("git", ["config", "user.name", "Scheduler Test"], { cwd: repoPath });
    await execFileAsync("git", ["config", "user.email", "scheduler@example.com"], { cwd: repoPath });
    await mkdir(join(repoPath, "src"));
    await writeFile(join(repoPath, "src", "worker.ts"), "// TODO: add bounded retry handling\n", "utf8");
    await execFileAsync("git", ["add", "src/worker.ts"], { cwd: repoPath });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repoPath });

    const databaseDir = await mkdtemp(join(tmpdir(), "oneteam-scheduler-db-"));
    const context = createDatabaseContext(`file:${join(databaseDir, "test.db")}`);
    await runMigrations(context.client);
    const repos = createRepositories(context.db);
    const project = await repos.projects.create({ name: "Discovery", repoPath, defaultBranch: "main" });
    await repos.commands.upsertMany(project.id, [{
      commandType: "test",
      command: null,
      detectionSource: "test",
      isRequired: true,
      isAvailable: false
    }]);
    const issue = await repos.issues.create({ projectId: project.id, title: "Observe scheduler" });
    const successfulQa = await repos.agentJobs.create({
      projectId: project.id,
      agentType: "qa",
      targetType: "issue",
      targetId: issue.id
    });
    await repos.agentJobs.updateStatus(project.id, successfulQa.id, "succeeded", {
      output: { status: "succeeded", message: "QA passed.", stopReason: "passed" }
    });
    const failedQa = await repos.agentJobs.create({
      projectId: project.id,
      agentType: "qa",
      targetType: "issue",
      targetId: issue.id
    });
    await repos.agentJobs.updateStatus(project.id, failedQa.id, "failed", {
      error: "Regression test failed.",
      output: {
        status: "failed",
        message: "Regression test failed.",
        stopReason: "failed",
        testResults: [{ command: "npm test", status: "failed", exitCode: 1, output: "1 failed" }]
      }
    });

    const scheduler = new ObjectiveScheduler(repos, {
      intervalMs: 60_000,
      staleObjectiveAfterMs: 24 * 60 * 60 * 1000,
      now: () => new Date(Date.now() + 8 * 24 * 60 * 60 * 1000)
    });
    await scheduler.tick();

    const firstItems = await repos.triage.list(project.id);
    const discoveries = firstItems.map((item) => item.metadata?.discovery);
    expect(discoveries).toEqual(expect.arrayContaining([
      "missing_command",
      "stale_objective",
      "verification_failure",
      "regression",
      "todo_fixme"
    ]));
    expect(firstItems.find((item) => item.metadata?.discovery === "todo_fixme")?.body).toContain(
      "src/worker.ts:1"
    );
    expect(firstItems.find((item) => item.metadata?.discovery === "verification_failure")?.body).toContain(
      "`npm test` — exit 1"
    );
    await scheduler.tick();
    await expect(repos.triage.list(project.id)).resolves.toHaveLength(firstItems.length);
    await expect(repos.objectives.list({ projectId: project.id })).resolves.toHaveLength(1);
    context.client.close();
  });
});
