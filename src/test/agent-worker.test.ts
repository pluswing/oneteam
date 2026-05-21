import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { AgentWorker } from "../server/agents/worker";
import type { AgentAdapter } from "../server/agents/types";
import { createDatabaseContext } from "../server/db/client";
import { runMigrations } from "../server/db/migrations";
import { createRepositories } from "../server/db/repositories";
import { resolveAgentJobLockKey } from "../server/services/agent-job-locks";

const execFileAsync = promisify(execFile);

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: repo });
  return stdout.trim();
}

async function createGitRepo(prefix: string): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), prefix));
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "Test User"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await writeFile(join(repo, "README.md"), "# Example\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
  return repo;
}

describe("agent worker", () => {
  it("runs a queued job and persists comments, activities, and label transitions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneteam-worker-"));
    const context = createDatabaseContext(`file:${join(dir, "test.db")}`);
    await runMigrations(context.client);

    const repos = createRepositories(context.db);
    const project = await repos.projects.create({
      name: "Example",
      repoPath: dir,
      defaultBranch: "main",
      locale: "en"
    });
    const issue = await repos.issues.create({
      projectId: project.id,
      title: "Add setup",
      body: "Create a setup wizard."
    });
    await repos.commands.upsertMany(project.id, [
      {
        commandType: "test",
        command: "npm test",
        detectionSource: "manual",
        isRequired: true,
        isAvailable: true
      }
    ]);
    const job = await repos.agentJobs.create({
      projectId: project.id,
      agentType: "requirements",
      targetType: "issue",
      targetId: issue.id
    });

    const fakeAdapter: AgentAdapter = {
      async run(input) {
        await input.onActivity?.({
          type: "thinking",
          title: "Reviewed issue",
          body: "The request is clear enough for implementation."
        });
        return {
          status: "succeeded",
          message: "Requirements are ready.",
          comment: {
            targetType: "issue",
            targetId: issue.id,
            body: "## Requirements\n\nBuild the setup wizard."
          },
          activities: [
            {
              type: "progress",
              title: "Requirements completed"
            }
          ],
          metadata: {
            nextLabel: "実装待ち"
          }
        };
      }
    };

    const worker = new AgentWorker(repos, fakeAdapter, { pollIntervalMs: 1000 });
    await worker.tick();

    const updatedJob = await repos.agentJobs.get(project.id, job.id);
    const comments = await repos.comments.list(project.id, "issue", issue.id);
    const activities = await repos.activities.list(project.id, "issue", issue.id);
    const updatedIssue = await repos.issues.get(project.id, issue.id);

    expect(updatedJob?.status).toBe("succeeded");
    expect(comments[0].body).toContain("Build the setup wizard");
    expect(activities.map((activity) => activity.title)).toContain("Reviewed issue");
    expect(updatedIssue?.labels.map((label) => label.name)).toContain("実装待ち");

    context.client.close();
  });

  it("does not apply an agent result after the job has been canceled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneteam-worker-cancel-"));
    const context = createDatabaseContext(`file:${join(dir, "test.db")}`);
    await runMigrations(context.client);

    const repos = createRepositories(context.db);
    const project = await repos.projects.create({
      name: "Example",
      repoPath: dir,
      defaultBranch: "main",
      locale: "en"
    });
    const issue = await repos.issues.create({
      projectId: project.id,
      title: "Add setup",
      body: "Create a setup wizard."
    });
    const job = await repos.agentJobs.create({
      projectId: project.id,
      agentType: "requirements",
      targetType: "issue",
      targetId: issue.id
    });

    const fakeAdapter: AgentAdapter = {
      async run(input) {
        expect(await input.isCanceled?.()).toBe(false);
        await repos.agentJobs.updateStatus(project.id, job.id, "canceled", { error: "Cancellation requested." });
        expect(await input.isCanceled?.()).toBe(true);
        return {
          status: "succeeded",
          message: "This result should not be applied.",
          comment: {
            targetType: "issue",
            targetId: issue.id,
            body: "Do not save this."
          }
        };
      }
    };

    const worker = new AgentWorker(repos, fakeAdapter, { pollIntervalMs: 1000 });
    await worker.tick();

    const updatedJob = await repos.agentJobs.get(project.id, job.id);
    const comments = await repos.comments.list(project.id, "issue", issue.id);
    const activities = await repos.activities.list(project.id, "issue", issue.id);

    expect(updatedJob?.status).toBe("canceled");
    expect(comments).toHaveLength(0);
    expect(activities.map((activity) => activity.title)).toContain("Agent job canceled");

    context.client.close();
  });

  it("moves the target into human gate when an agent asks questions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneteam-worker-human-gate-"));
    const context = createDatabaseContext(`file:${join(dir, "test.db")}`);
    await runMigrations(context.client);

    const repos = createRepositories(context.db);
    const project = await repos.projects.create({
      name: "Example",
      repoPath: dir,
      defaultBranch: "main",
      locale: "en"
    });
    const requirementsLabel = await repos.labels.findByName(project.id, "要件定義中");
    const issue = await repos.issues.create({
      projectId: project.id,
      title: "Add setup",
      body: "Create a setup wizard.",
      labelIds: requirementsLabel ? [requirementsLabel.id] : []
    });
    const job = await repos.agentJobs.create({
      projectId: project.id,
      agentType: "requirements",
      targetType: "issue",
      targetId: issue.id
    });

    const fakeAdapter: AgentAdapter = {
      async run() {
        return {
          status: "waiting_human",
          message: "Need more detail.",
          questions: ["Which users should see the setup wizard?"]
        };
      }
    };

    const worker = new AgentWorker(repos, fakeAdapter, { pollIntervalMs: 1000 });
    await worker.tick();

    const updatedJob = await repos.agentJobs.get(project.id, job.id);
    const updatedIssue = await repos.issues.get(project.id, issue.id);
    const comments = await repos.comments.list(project.id, "issue", issue.id);
    const activities = await repos.activities.list(project.id, "issue", issue.id);
    const output = updatedJob?.output as
      | {
          metadata?: {
            humanGate?: {
              previousLabelNames?: string[];
            };
          };
        }
      | null
      | undefined;

    expect(updatedJob?.status).toBe("waiting_human");
    expect(updatedIssue?.labels.map((label) => label.name)).toEqual(["確認待ち"]);
    expect(comments[0].body).toContain("Which users");
    expect(output?.metadata?.humanGate?.previousLabelNames).toContain("要件定義中");
    expect(activities.map((activity) => activity.title)).toContain("Waiting for human input");

    context.client.close();
  });

  it("skips queued jobs whose lock key is already running", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneteam-worker-lock-"));
    const context = createDatabaseContext(`file:${join(dir, "test.db")}`);
    await runMigrations(context.client);

    const repos = createRepositories(context.db);
    const project = await repos.projects.create({
      name: "Example",
      repoPath: dir,
      defaultBranch: "main",
      locale: "en"
    });
    const issue = await repos.issues.create({
      projectId: project.id,
      title: "Add setup",
      body: "Create a setup wizard."
    });
    const lockKey = resolveAgentJobLockKey({
      projectId: project.id,
      agentType: "implementation",
      targetType: "issue",
      targetId: issue.id
    });
    const runningJob = await repos.agentJobs.create({
      projectId: project.id,
      agentType: "implementation",
      targetType: "issue",
      targetId: issue.id,
      lockKey
    });
    await repos.agentJobs.updateStatus(project.id, runningJob.id, "running");
    const lockedQueuedJob = await repos.agentJobs.create({
      projectId: project.id,
      agentType: "implementation",
      targetType: "issue",
      targetId: issue.id,
      lockKey
    });
    const unlockedQueuedJob = await repos.agentJobs.create({
      projectId: project.id,
      agentType: "requirements",
      targetType: "issue",
      targetId: issue.id
    });

    const fakeAdapter: AgentAdapter = {
      async run() {
        return {
          status: "succeeded",
          message: "Unlocked job completed."
        };
      }
    };

    const worker = new AgentWorker(repos, fakeAdapter, { pollIntervalMs: 1000 });
    await worker.tick();

    const lockedJobAfterTick = await repos.agentJobs.get(project.id, lockedQueuedJob.id);
    const unlockedJobAfterTick = await repos.agentJobs.get(project.id, unlockedQueuedJob.id);

    expect(lockedJobAfterTick?.status).toBe("queued");
    expect(unlockedJobAfterTick?.status).toBe("succeeded");

    context.client.close();
  });

  it("pauses implementation jobs before Codex when the working tree is dirty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneteam-worker-dirty-db-"));
    const repoPath = await createGitRepo("oneteam-worker-dirty-repo-");
    const context = createDatabaseContext(`file:${join(dir, "test.db")}`);
    await runMigrations(context.client);

    const repos = createRepositories(context.db);
    const project = await repos.projects.create({
      name: "Example",
      repoPath,
      defaultBranch: "main",
      locale: "en"
    });
    const implementationLabel = await repos.labels.findByName(project.id, "実装待ち");
    const issue = await repos.issues.create({
      projectId: project.id,
      title: "Add setup",
      body: "Create a setup wizard.",
      labelIds: implementationLabel ? [implementationLabel.id] : []
    });
    await writeFile(join(repoPath, "README.md"), "# Example\n\nDirty change\n");
    const job = await repos.agentJobs.create({
      projectId: project.id,
      agentType: "implementation",
      targetType: "issue",
      targetId: issue.id
    });
    let adapterCalled = false;

    const fakeAdapter: AgentAdapter = {
      async run() {
        adapterCalled = true;
        return {
          status: "succeeded",
          message: "Should not run."
        };
      }
    };

    const worker = new AgentWorker(repos, fakeAdapter, { pollIntervalMs: 1000 });
    await worker.tick();

    const updatedJob = await repos.agentJobs.get(project.id, job.id);
    const updatedIssue = await repos.issues.get(project.id, issue.id);
    const comments = await repos.comments.list(project.id, "issue", issue.id);
    const activities = await repos.activities.list(project.id, "issue", issue.id);
    const currentBranch = await git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);

    expect(adapterCalled).toBe(false);
    expect(updatedJob?.status).toBe("waiting_human");
    expect(updatedIssue?.labels.map((label) => label.name)).toEqual(["確認待ち"]);
    expect(comments[0].body).toContain("commit, stash, or discard");
    expect(activities.map((activity) => activity.title)).toContain("Implementation branch blocked");
    expect(currentBranch).toBe("main");

    context.client.close();
  });
});
