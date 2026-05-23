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

function nodeCommand(source: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`;
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
            nextLabel: "ready-for-implementation"
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
    expect(updatedIssue?.labels.map((label) => label.name)).toContain("ready-for-implementation");

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
    const requirementsLabel = await repos.labels.findByName(project.id, "requirements");
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
    expect(updatedIssue?.labels.map((label) => label.name)).toEqual(["needs-input"]);
    expect(comments[0].body).toContain("Which users");
    expect(output?.metadata?.humanGate?.previousLabelNames).toContain("requirements");
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

  it("records implementation changed files and verification command results", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneteam-worker-verify-db-"));
    const repoPath = await createGitRepo("oneteam-worker-verify-repo-");
    const context = createDatabaseContext(`file:${join(dir, "test.db")}`);
    await runMigrations(context.client);

    const repos = createRepositories(context.db);
    const project = await repos.projects.create({
      name: "Example",
      repoPath,
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
        commandType: "lint",
        command: nodeCommand("console.log('lint ok')"),
        detectionSource: "manual",
        isRequired: true,
        isAvailable: true
      },
      {
        commandType: "test",
        command: nodeCommand("console.log('test ok')"),
        detectionSource: "manual",
        isRequired: true,
        isAvailable: true
      }
    ]);
    const job = await repos.agentJobs.create({
      projectId: project.id,
      agentType: "implementation",
      targetType: "issue",
      targetId: issue.id
    });

    const fakeAdapter: AgentAdapter = {
      async run(input) {
        await writeFile(join(input.repoPath, "feature.txt"), "implemented\n");
        const sourceBranch = await git(input.repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
        return {
          status: "succeeded",
          message: "Implemented setup.",
          metadata: {
            pullRequest: {
              title: "Add setup",
              body: "Implements setup.",
              sourceBranch,
              targetBranch: "main",
              issueId: issue.id
            }
          }
        };
      }
    };

    const worker = new AgentWorker(repos, fakeAdapter, { pollIntervalMs: 1000 });
    await worker.tick();

    const updatedJob = await repos.agentJobs.get(project.id, job.id);
    const activities = await repos.activities.list(project.id, "issue", issue.id);
    const pullRequests = await repos.pullRequests.list({ projectId: project.id, limit: 10, offset: 0 });
    const output = updatedJob?.output as AgentRunResult | null | undefined;
    const worktreeStatus = await git(repoPath, ["status", "--porcelain"]);
    const sourceDiffFiles = await git(repoPath, ["diff", "--name-only", "main...HEAD"]);

    expect(updatedJob?.status).toBe("succeeded");
    expect(output?.changedFiles).toContain("feature.txt");
    expect(output?.testResults?.map((result) => result.command)).toEqual(
      expect.arrayContaining([expect.stringContaining("lint ok"), expect.stringContaining("test ok")])
    );
    expect(activities.map((activity) => activity.title)).toEqual(
      expect.arrayContaining(["Changed files captured", "lint command passed", "test command passed"])
    );
    expect(pullRequests.total).toBe(1);
    expect(pullRequests.items[0].sourceBranch).toBe("oneteam/issue-1-add-setup");
    expect(worktreeStatus).toBe("");
    expect(sourceDiffFiles).toContain("feature.txt");

    context.client.close();
  });

  it("fails implementation jobs when verification commands fail", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneteam-worker-verify-fail-db-"));
    const repoPath = await createGitRepo("oneteam-worker-verify-fail-repo-");
    const context = createDatabaseContext(`file:${join(dir, "test.db")}`);
    await runMigrations(context.client);

    const repos = createRepositories(context.db);
    const project = await repos.projects.create({
      name: "Example",
      repoPath,
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
        command: nodeCommand("console.error('test failed'); process.exit(7)"),
        detectionSource: "manual",
        isRequired: true,
        isAvailable: true
      }
    ]);
    const job = await repos.agentJobs.create({
      projectId: project.id,
      agentType: "implementation",
      targetType: "issue",
      targetId: issue.id
    });

    const fakeAdapter: AgentAdapter = {
      async run(input) {
        const sourceBranch = await git(input.repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
        return {
          status: "succeeded",
          message: "Implemented setup.",
          metadata: {
            pullRequest: {
              title: "Add setup",
              sourceBranch,
              targetBranch: "main",
              issueId: issue.id
            }
          }
        };
      }
    };

    const worker = new AgentWorker(repos, fakeAdapter, { pollIntervalMs: 1000 });
    await worker.tick();

    const updatedJob = await repos.agentJobs.get(project.id, job.id);
    const activities = await repos.activities.list(project.id, "issue", issue.id);
    const pullRequests = await repos.pullRequests.list({ projectId: project.id, limit: 10, offset: 0 });
    const output = updatedJob?.output as AgentRunResult | null | undefined;

    expect(updatedJob?.status).toBe("failed");
    expect(output?.testResults?.[0].status).toBe("failed");
    expect(output?.testResults?.[0].exitCode).toBe(7);
    expect(activities.map((activity) => activity.title)).toContain("test command failed");
    expect(pullRequests.total).toBe(0);

    context.client.close();
  });

  it("routes structured review outcomes to fix or QA", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneteam-worker-review-flow-"));
    const context = createDatabaseContext(`file:${join(dir, "test.db")}`);
    await runMigrations(context.client);

    const repos = createRepositories(context.db);
    const project = await repos.projects.create({
      name: "Example",
      repoPath: dir,
      defaultBranch: "main",
      locale: "en"
    });
    const changesRequestedPr = await repos.pullRequests.create({
      projectId: project.id,
      title: "Needs fix",
      sourceBranch: "feature/fix",
      targetBranch: "main"
    });
    const approvedPr = await repos.pullRequests.create({
      projectId: project.id,
      title: "Looks good",
      sourceBranch: "feature/good",
      targetBranch: "main"
    });
    await repos.agentJobs.create({
      projectId: project.id,
      agentType: "review",
      targetType: "pull_request",
      targetId: changesRequestedPr.id
    });
    await repos.agentJobs.create({
      projectId: project.id,
      agentType: "review",
      targetType: "pull_request",
      targetId: approvedPr.id
    });

    const fakeAdapter: AgentAdapter = {
      async run(input) {
        if (input.job.targetId === changesRequestedPr.id) {
          return {
            status: "succeeded",
            message: "Review found one issue.",
            metadata: {
              review: {
                verdict: "changes_requested",
                findings: [
                  {
                    severity: "high",
                    path: "src/app.ts",
                    line: 10,
                    title: "Missing validation",
                    body: "Handle empty input before saving."
                  }
                ],
                checked: ["requirements", "tests"]
              }
            }
          };
        }
        return {
          status: "succeeded",
          message: "Review approved.",
          metadata: {
            review: {
              verdict: "approved",
              findings: [],
              checked: ["requirements", "tests"]
            }
          }
        };
      }
    };

    const worker = new AgentWorker(repos, fakeAdapter, { pollIntervalMs: 1000 });
    await worker.tick();
    await worker.tick();

    const changesRequestedAfter = await repos.pullRequests.get(project.id, changesRequestedPr.id);
    const approvedAfter = await repos.pullRequests.get(project.id, approvedPr.id);
    const changesRequestedActivities = await repos.activities.list(project.id, "pull_request", changesRequestedPr.id);
    const approvedActivities = await repos.activities.list(project.id, "pull_request", approvedPr.id);
    const jobs = await repos.agentJobs.list({ projectId: project.id });

    expect(changesRequestedAfter?.labels.map((label) => label.name)).toContain("fixing");
    expect(approvedAfter?.labels.map((label) => label.name)).toContain("testing");
    expect(changesRequestedActivities.map((activity) => activity.title)).toContain("Review findings captured");
    expect(approvedActivities.map((activity) => activity.title)).toContain("Review approval captured");
    expect(jobs.some((job) => job.agentType === "fix" && job.targetId === changesRequestedPr.id)).toBe(true);
    expect(jobs.some((job) => job.agentType === "qa" && job.targetId === approvedPr.id)).toBe(true);

    context.client.close();
  });

  it("routes fix completion and QA outcomes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneteam-worker-fix-qa-flow-"));
    const context = createDatabaseContext(`file:${join(dir, "test.db")}`);
    await runMigrations(context.client);

    const repos = createRepositories(context.db);
    const project = await repos.projects.create({
      name: "Example",
      repoPath: dir,
      defaultBranch: "main",
      locale: "en"
    });
    const fixPr = await repos.pullRequests.create({
      projectId: project.id,
      title: "Fix this",
      sourceBranch: "feature/fix",
      targetBranch: "main"
    });
    const defectPr = await repos.pullRequests.create({
      projectId: project.id,
      title: "QA defect",
      sourceBranch: "feature/defect",
      targetBranch: "main"
    });
    const passedPr = await repos.pullRequests.create({
      projectId: project.id,
      title: "QA pass",
      sourceBranch: "feature/pass",
      targetBranch: "main"
    });
    await repos.agentJobs.create({
      projectId: project.id,
      agentType: "fix",
      targetType: "pull_request",
      targetId: fixPr.id
    });
    await repos.agentJobs.create({
      projectId: project.id,
      agentType: "qa",
      targetType: "pull_request",
      targetId: defectPr.id
    });
    await repos.agentJobs.create({
      projectId: project.id,
      agentType: "qa",
      targetType: "pull_request",
      targetId: passedPr.id
    });

    const fakeAdapter: AgentAdapter = {
      async run(input) {
        if (input.job.agentType === "fix") {
          return {
            status: "succeeded",
            message: "Fix completed.",
            metadata: {
              fix: {
                resolvedFindings: ["Handled empty input."],
                conflictVerification: null
              }
            }
          };
        }
        if (input.job.targetId === defectPr.id) {
          return {
            status: "succeeded",
            message: "QA found a defect.",
            metadata: {
              qa: {
                verdict: "defects_found",
                defects: [{ severity: "medium", title: "Button does not submit", body: "Clicking submit has no effect." }],
                observations: ["Manual smoke failed."]
              }
            }
          };
        }
        return {
          status: "succeeded",
          message: "QA passed.",
          metadata: {
            qa: {
              verdict: "passed",
              defects: [],
              observations: ["Manual smoke passed."]
            }
          }
        };
      }
    };

    const worker = new AgentWorker(repos, fakeAdapter, { pollIntervalMs: 1000 });
    await worker.tick();
    await worker.tick();
    await worker.tick();

    const fixAfter = await repos.pullRequests.get(project.id, fixPr.id);
    const defectAfter = await repos.pullRequests.get(project.id, defectPr.id);
    const passedAfter = await repos.pullRequests.get(project.id, passedPr.id);
    const fixActivities = await repos.activities.list(project.id, "pull_request", fixPr.id);
    const defectActivities = await repos.activities.list(project.id, "pull_request", defectPr.id);
    const passedActivities = await repos.activities.list(project.id, "pull_request", passedPr.id);

    expect(fixAfter?.labels.map((label) => label.name)).toContain("reviewing");
    expect(defectAfter?.labels.map((label) => label.name)).toContain("fixing");
    expect(passedAfter?.labels.map((label) => label.name)).toContain("done");
    expect(fixActivities.map((activity) => activity.title)).toContain("Fix summary captured");
    expect(defectActivities.map((activity) => activity.title)).toContain("QA defects captured");
    expect(passedActivities.map((activity) => activity.title)).toContain("QA pass captured");

    context.client.close();
  });

  it("fails conflict fix jobs when merge conflicts remain", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneteam-worker-conflict-db-"));
    const repoPath = await createGitRepo("oneteam-worker-conflict-repo-");
    await git(repoPath, ["checkout", "-b", "feature/conflict"]);
    await writeFile(join(repoPath, "README.md"), "# Feature\n");
    await git(repoPath, ["commit", "-am", "feature change"]);
    await git(repoPath, ["checkout", "main"]);
    await writeFile(join(repoPath, "README.md"), "# Main\n");
    await git(repoPath, ["commit", "-am", "main change"]);

    const context = createDatabaseContext(`file:${join(dir, "test.db")}`);
    await runMigrations(context.client);

    const repos = createRepositories(context.db);
    const project = await repos.projects.create({
      name: "Example",
      repoPath,
      defaultBranch: "main",
      locale: "en"
    });
    const conflictLabel = await repos.labels.findByName(project.id, "resolving-conflicts");
    const pullRequest = await repos.pullRequests.create({
      projectId: project.id,
      title: "Resolve conflict",
      sourceBranch: "feature/conflict",
      targetBranch: "main",
      labelIds: conflictLabel ? [conflictLabel.id] : []
    });
    const job = await repos.agentJobs.create({
      projectId: project.id,
      agentType: "fix",
      targetType: "pull_request",
      targetId: pullRequest.id
    });

    const fakeAdapter: AgentAdapter = {
      async run() {
        return {
          status: "succeeded",
          message: "Conflict fix completed.",
          metadata: {
            nextLabel: "reviewing",
            fix: {
              resolvedFindings: ["Attempted conflict resolution."],
              conflictVerification: null
            }
          }
        };
      }
    };

    const worker = new AgentWorker(repos, fakeAdapter, { pollIntervalMs: 1000 });
    await worker.tick();

    const updatedJob = await repos.agentJobs.get(project.id, job.id);
    const updatedPullRequest = await repos.pullRequests.get(project.id, pullRequest.id);
    const activities = await repos.activities.list(project.id, "pull_request", pullRequest.id);

    expect(updatedJob?.status).toBe("failed");
    expect(updatedPullRequest?.labels.map((label) => label.name)).toEqual(["resolving-conflicts"]);
    expect(activities.map((activity) => activity.title)).toContain("Merge conflicts remain");

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
    const implementationLabel = await repos.labels.findByName(project.id, "ready-for-implementation");
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
    expect(updatedIssue?.labels.map((label) => label.name)).toEqual(["needs-input"]);
    expect(comments[0].body).toContain("commit, stash, or discard");
    expect(activities.map((activity) => activity.title)).toContain("Implementation branch blocked");
    expect(currentBranch).toBe("main");

    context.client.close();
  });
});
