import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { AgentWorker } from "../server/agents/worker";
import type { AgentAdapter, AgentRunResult } from "../server/agents/types";
import { createApp } from "../server/app";
import { createDatabaseContext } from "../server/db/client";
import { runMigrations } from "../server/db/migrations";
import { createRepositories } from "../server/db/repositories";
import { resolveAgentJobLockKey } from "../server/services/agent-job-locks";
import { implementationBranchName } from "../server/services/implementation-preflight";
import { workflowLabelNames } from "../shared/workflow-labels";

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
            body: "<section><h2>Requirements</h2><p>Build the setup wizard.</p></section>",
            bodyFormat: "html"
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
    expect((updatedJob?.output as AgentRunResult | null | undefined)?.stopReason).toBe("passed");
    expect(comments[0].body).toContain("Build the setup wizard");
    expect(comments[0].bodyFormat).toBe("html");
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
    expect((updatedJob?.output as AgentRunResult | null | undefined)?.stopReason).toBe("waiting_human");
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

  it("auto-requeues recoverable runtime errors instead of failing the workflow", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneteam-worker-recovery-"));
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

    let calls = 0;
    const fakeAdapter: AgentAdapter = {
      async run() {
        calls += 1;
        if (calls === 1) {
          throw Object.assign(new Error("SQLITE_BUSY: database is locked"), { code: "SQLITE_BUSY" });
        }
        return {
          status: "succeeded",
          message: "Recovered and completed."
        };
      }
    };

    const worker = new AgentWorker(repos, fakeAdapter, { pollIntervalMs: 1000 });
    await worker.tick();

    const recoveredJob = await repos.agentJobs.get(project.id, job.id);
    const activitiesAfterRecovery = await repos.activities.list(project.id, "issue", issue.id);

    expect(recoveredJob?.status).toBe("queued");
    expect(recoveredJob?.attempt).toBe(2);
    expect((recoveredJob?.output as Record<string, unknown> | null | undefined)?.stopReason).toBe("auto_recovered");
    expect(activitiesAfterRecovery.map((activity) => activity.title)).toContain("Agent job auto-recovered");

    await worker.tick();
    const completedJob = await repos.agentJobs.get(project.id, job.id);

    expect(completedJob?.status).toBe("succeeded");
    expect(calls).toBe(2);

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
    const issueComments = await repos.comments.list(project.id, "issue", issue.id);
    const output = updatedJob?.output as AgentRunResult | null | undefined;
    const worktreeStatus = await git(repoPath, ["status", "--porcelain"]);
    const sourceDiffFiles = await git(repoPath, ["diff", "--name-only", `main...${pullRequests.items[0].sourceBranch}`]);

    expect(updatedJob?.status).toBe("succeeded");
    expect(output?.stopReason).toBe("passed");
    expect(output?.changedFiles).toContain("feature.txt");
    expect(output?.evidence?.map((item) => item.title)).toEqual(
      expect.arrayContaining(["Changed files captured", "lint command passed", "test command passed"])
    );
    expect(output?.testResults?.map((result) => result.command)).toEqual(
      expect.arrayContaining([expect.stringContaining("lint ok"), expect.stringContaining("test ok")])
    );
    expect(activities.map((activity) => activity.title)).toEqual(
      expect.arrayContaining([
        "Worktree ready",
        "Changed files captured",
        "lint command passed",
        "test command passed",
        "Worktree cleaned up"
      ])
    );
    expect(output?.metadata?.worktreeRetention).toMatchObject({ action: "cleanup", reason: "completed" });
    expect(pullRequests.total).toBe(1);
    expect(pullRequests.items[0].sourceBranch).toBe("oneteam/issue-1-add-setup");
    expect(issueComments.some((comment) => comment.body.includes("## Implementation started"))).toBe(true);
    expect(issueComments.some((comment) => comment.metadata?.workflowMilestoneEvent === "implementation-started")).toBe(
      true
    );
    expect(issueComments.some((comment) => comment.body.includes("## Pull request created"))).toBe(true);
    expect(issueComments.some((comment) => comment.metadata?.workflowMilestoneEvent === "pull-request-created")).toBe(true);
    expect(worktreeStatus).toBe("");
    expect(sourceDiffFiles).toContain("feature.txt");

    context.client.close();
  });

  it("recovers implementation jobs by reusing an existing OneTeam worktree for the same branch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneteam-worker-worktree-recovery-db-"));
    const repoPath = await createGitRepo("oneteam-worker-worktree-recovery-repo-");
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
    const branchName = implementationBranchName(issue);
    const projectWorktreeRoot = join(homedir(), ".oneteam", "worktrees", project.id);
    await mkdir(projectWorktreeRoot, { recursive: true });
    const existingWorktreePath = await mkdtemp(join(projectWorktreeRoot, "run-"));
    await git(repoPath, ["worktree", "add", "-b", branchName, existingWorktreePath, "main"]);

    const job = await repos.agentJobs.create({
      projectId: project.id,
      agentType: "implementation",
      targetType: "issue",
      targetId: issue.id
    });

    let adapterRepoPath = "";
    const fakeAdapter: AgentAdapter = {
      async run(input) {
        adapterRepoPath = input.repoPath;
        await writeFile(join(input.repoPath, "feature.txt"), "implemented\n");
        const sourceBranch = await git(input.repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
        return {
          status: "succeeded",
          message: "Implemented in recovered worktree.",
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
    const sourceDiffFiles = await git(repoPath, ["diff", "--name-only", `main...${branchName}`]);

    expect(adapterRepoPath).toBe(existingWorktreePath);
    expect(updatedJob?.status).toBe("succeeded");
    expect(activities.find((activity) => activity.title === "Worktree ready")?.body).toContain("Recovered");
    expect(pullRequests.total).toBe(1);
    expect(pullRequests.items[0].sourceBranch).toBe(branchName);
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
    expect(output?.stopReason).toBe("failed");
    expect(output?.evidence?.map((item) => item.title)).toContain("test command failed");
    expect(output?.testResults?.[0].status).toBe("failed");
    expect(output?.testResults?.[0].exitCode).toBe(7);
    expect(activities.map((activity) => activity.title)).toContain("test command failed");
    expect(activities.map((activity) => activity.title)).toContain("Worktree retained");
    expect(output?.metadata?.worktreeRetention).toMatchObject({ action: "retain", reason: "failed" });
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
    const linkedIssue = await repos.issues.create({
      projectId: project.id,
      title: "Ship reviewed behavior",
      body: "Track the review and fix lifecycle."
    });
    const changesRequestedPr = await repos.pullRequests.create({
      projectId: project.id,
      issueId: linkedIssue.id,
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
    const [changesRequestedObjective, approvedObjective] = await Promise.all([
      repos.objectives.findByPullRequest(project.id, changesRequestedPr.id),
      repos.objectives.findByPullRequest(project.id, approvedPr.id)
    ]);
    const findingsResponse = await createApp({ repos }).request(
      `/api/projects/${project.id}/pull-requests/${changesRequestedPr.id}/findings`
    );
    const findings = (await findingsResponse.json()) as { items: Array<{ path: string; line: number; status: string }> };
    const linkedIssueComments = await repos.comments.list(project.id, "issue", linkedIssue.id);

    expect(changesRequestedAfter?.labels.map((label) => label.name)).toContain("fixing");
    expect(approvedAfter?.labels.map((label) => label.name)).toContain("testing");
    expect(changesRequestedActivities.map((activity) => activity.title)).toContain("Review findings captured");
    expect(approvedActivities.map((activity) => activity.title)).toContain("Review approval captured");
    expect(jobs.some((job) => job.agentType === "fix" && job.targetId === changesRequestedPr.id)).toBe(true);
    expect(jobs.some((job) => job.agentType === "qa" && job.targetId === approvedPr.id)).toBe(true);
    expect(changesRequestedObjective?.workflowStage).toBe("fix");
    expect(approvedObjective?.workflowStage).toBe("qa");
    expect(linkedIssueComments.some((comment) => comment.body.includes("## Review requested changes"))).toBe(true);
    expect(linkedIssueComments.some((comment) => comment.body.includes("[/pulls/"))).toBe(false);
    expect(linkedIssueComments.some((comment) => comment.body.includes(`](/pulls/${changesRequestedPr.id})`))).toBe(true);
    expect(findings.items).toContainEqual(expect.objectContaining({ path: "src/app.ts", line: 10, status: "open" }));

    context.client.close();
  });

  it("routes fix completion and QA outcomes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneteam-worker-fix-qa-flow-"));
    const repoPath = await createGitRepo("oneteam-worker-fix-qa-repo-");
    const context = createDatabaseContext(`file:${join(dir, "test.db")}`);
    await runMigrations(context.client);

    const repos = createRepositories(context.db);
    const project = await repos.projects.create({
      name: "Example",
      repoPath,
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

  it("marks verified pull requests as ready to merge and notifies the user", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneteam-worker-verifier-db-"));
    const repoPath = await createGitRepo("oneteam-worker-verifier-repo-");
    const context = createDatabaseContext(`file:${join(dir, "test.db")}`);
    await runMigrations(context.client);

    const repos = createRepositories(context.db);
    const project = await repos.projects.create({
      name: "Example",
      repoPath,
      defaultBranch: "main",
      locale: "en"
    });
    const linkedIssue = await repos.issues.create({
      projectId: project.id,
      title: "Verify the complete Objective",
      body: "Keep final verification visible from the Issue."
    });
    const doneLabel = await repos.labels.findByName(project.id, workflowLabelNames.done);
    const pullRequest = await repos.pullRequests.create({
      projectId: project.id,
      issueId: linkedIssue.id,
      title: "Verified change",
      sourceBranch: "feature/verified",
      targetBranch: "main",
      labelIds: doneLabel ? [doneLabel.id] : []
    });
    await repos.agentJobs.create({
      projectId: project.id,
      agentType: "verifier",
      targetType: "pull_request",
      targetId: pullRequest.id
    });

    const fakeAdapter: AgentAdapter = {
      async run() {
        return {
          status: "succeeded",
          message: "Stop condition is met.",
          metadata: {
            nextLabel: workflowLabelNames.done,
            verifier: {
              verdict: "passed",
              stopConditionMet: true,
              missingEvidence: [],
              notes: ["Evidence is sufficient."]
            }
          }
        };
      }
    };

    const worker = new AgentWorker(repos, fakeAdapter, { pollIntervalMs: 1000 });
    await worker.tick();

    const updatedPullRequest = await repos.pullRequests.get(project.id, pullRequest.id);
    const comments = await repos.comments.list(project.id, "pull_request", pullRequest.id);
    const activities = await repos.activities.list(project.id, "pull_request", pullRequest.id);
    const linkedIssueComments = await repos.comments.list(project.id, "issue", linkedIssue.id);

    expect(updatedPullRequest?.labels.map((label) => label.name)).toContain(workflowLabelNames.readyToMerge);
    expect(comments.some((comment) => comment.body.includes("## Pull request ready to merge"))).toBe(true);
    expect(comments.some((comment) => comment.body.includes("> **Outcome · READY**"))).toBe(true);
    expect(activities.map((activity) => activity.title)).toContain("Pull request ready to merge");
    expect(linkedIssueComments.some((comment) => comment.body.includes("## Final verification passed"))).toBe(true);
    expect(linkedIssueComments.some((comment) => comment.metadata?.workflowMilestoneEvent === "verification-passed")).toBe(
      true
    );

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

  it("runs implementation jobs in a worktree when the main working tree is dirty", async () => {
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
      async run(input) {
        adapterCalled = true;
        await writeFile(join(input.repoPath, "feature.txt"), "implemented\n");
        const sourceBranch = await git(input.repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
        return {
          status: "succeeded",
          message: "Implemented in an isolated worktree.",
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
    const updatedIssue = await repos.issues.get(project.id, issue.id);
    const activities = await repos.activities.list(project.id, "issue", issue.id);
    const pullRequests = await repos.pullRequests.list({ projectId: project.id, limit: 10, offset: 0 });
    const currentBranch = await git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const mainStatus = await git(repoPath, ["status", "--porcelain"]);
    const sourceDiffFiles = await git(repoPath, ["diff", "--name-only", `main...${pullRequests.items[0].sourceBranch}`]);

    expect(adapterCalled).toBe(true);
    expect(updatedJob?.status).toBe("succeeded");
    expect((updatedJob?.output as AgentRunResult | null | undefined)?.stopReason).toBe("passed");
    expect(updatedIssue?.labels.map((label) => label.name)).toEqual(["ready-for-implementation"]);
    expect(activities.map((activity) => activity.title)).toContain("Worktree ready");
    expect(pullRequests.total).toBe(1);
    expect(sourceDiffFiles).toContain("feature.txt");
    expect(currentBranch).toBe("main");
    expect(mainStatus).toContain("README.md");

    context.client.close();
  });
});
