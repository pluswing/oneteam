import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { AgentWorker } from "../server/agents/worker";
import type { AgentAdapter } from "../server/agents/types";
import { createDatabaseContext } from "../server/db/client";
import { runMigrations } from "../server/db/migrations";
import { createRepositories } from "../server/db/repositories";
import { ensureObjectiveForTarget } from "../server/services/objective-runs";
import { workflowLabelNames } from "../shared/workflow-labels";

const execFileAsync = promisify(execFile);

describe("automatic delivery pipeline", () => {
  it("persists provider quota waits without spending a round and resumes them when due", async () => {
    const databaseDir = await mkdtemp(join(tmpdir(), "oneteam-provider-wait-db-"));
    const repoPath = await createGitRepo("oneteam-provider-wait-repo-");
    const context = createDatabaseContext(`file:${join(databaseDir, "test.db")}`);
    await runMigrations(context.client);
    const repos = createRepositories(context.db);
    const project = await repos.projects.create({ name: "Provider wait", repoPath, defaultBranch: "main" });
    const issue = await repos.issues.create({ projectId: project.id, title: "Wait safely" });
    const objective = await ensureObjectiveForTarget(repos, {
      projectId: project.id,
      targetType: "issue",
      targetId: issue.id
    });
    const job = await repos.agentJobs.create({
      projectId: project.id,
      agentType: "requirements",
      targetType: "issue",
      targetId: issue.id,
      input: { objectiveRunId: objective?.id ?? null }
    });
    let calls = 0;
    const adapter: AgentAdapter = {
      async run() {
        calls += 1;
        return calls === 1
          ? { status: "failed", message: "You've hit your usage limit. Try again later." }
          : { status: "succeeded", message: "Requirements are complete." };
      }
    };
    const worker = new AgentWorker(repos, adapter, { pollIntervalMs: 1000 });

    await worker.tick();

    const waitingJob = await repos.agentJobs.get(project.id, job.id);
    const waitingObjective = objective ? await repos.objectives.get(project.id, objective.id) : null;
    expect(waitingJob).toMatchObject({
      status: "waiting_provider",
      waitReason: "provider_quota_exhausted",
      attempt: 1
    });
    expect(waitingJob?.nextRetryAt).toBeTruthy();
    expect(waitingJob?.waitMetadata?.retryCount).toBe(1);
    expect(waitingObjective).toMatchObject({ status: "waiting_provider", roundCount: 0 });

    await context.client.execute({
      sql: "update agent_jobs set next_retry_at = ? where id = ?",
      args: ["2000-01-01T00:00:00.000Z", job.id]
    });
    await worker.tick();

    const completedJob = await repos.agentJobs.get(project.id, job.id);
    const completedObjective = objective ? await repos.objectives.get(project.id, objective.id) : null;
    expect(completedJob).toMatchObject({
      status: "succeeded",
      attempt: 2,
      waitReason: null,
      waitMetadata: null,
      nextRetryAt: null
    });
    expect(completedObjective?.roundCount).toBe(1);
    expect(calls).toBe(2);

    context.client.close();
  });

  it("automatically merges a verified objective and closes its linked issue", async () => {
    const databaseDir = await mkdtemp(join(tmpdir(), "oneteam-auto-merge-db-"));
    const repoPath = await createGitRepo("oneteam-auto-merge-repo-");
    await git(repoPath, ["checkout", "-b", "feature/verified"]);
    await writeFile(join(repoPath, "result.txt"), "verified\n");
    await git(repoPath, ["add", "result.txt"]);
    await git(repoPath, ["commit", "-m", "verified change"]);
    await git(repoPath, ["checkout", "main"]);

    const context = createDatabaseContext(`file:${join(databaseDir, "test.db")}`);
    await runMigrations(context.client);
    const repos = createRepositories(context.db);
    const project = await repos.projects.create({ name: "Auto merge", repoPath, defaultBranch: "main" });
    const issue = await repos.issues.create({ projectId: project.id, title: "Deliver automatically" });
    const doneLabel = await repos.labels.findByName(project.id, workflowLabelNames.done);
    const pullRequest = await repos.pullRequests.create({
      projectId: project.id,
      issueId: issue.id,
      title: "Verified delivery",
      sourceBranch: "feature/verified",
      targetBranch: "main",
      labelIds: doneLabel ? [doneLabel.id] : []
    });
    const objective = await ensureObjectiveForTarget(repos, {
      projectId: project.id,
      targetType: "pull_request",
      targetId: pullRequest.id
    });
    const job = await repos.agentJobs.create({
      projectId: project.id,
      agentType: "verifier",
      targetType: "pull_request",
      targetId: pullRequest.id,
      input: { objectiveRunId: objective?.id ?? null }
    });
    const adapter: AgentAdapter = {
      async run() {
        return {
          status: "succeeded",
          message: "All stop conditions and evidence checks passed.",
          evidence: [{ type: "test", title: "Verification suite", summary: "All checks passed." }],
          metadata: {
            nextLabel: workflowLabelNames.done,
            verifier: {
              verdict: "passed",
              stopConditionMet: true,
              missingEvidence: []
            }
          }
        };
      }
    };

    const worker = new AgentWorker(repos, adapter, { pollIntervalMs: 1000 });
    await worker.tick();

    const [updatedJob, updatedPullRequest, updatedIssue, updatedObjective, mergedFile] = await Promise.all([
      repos.agentJobs.get(project.id, job.id),
      repos.pullRequests.get(project.id, pullRequest.id),
      repos.issues.get(project.id, issue.id),
      objective ? repos.objectives.get(project.id, objective.id) : null,
      readFile(join(repoPath, "result.txt"), "utf8")
    ]);
    const prComments = await repos.comments.list(project.id, "pull_request", pullRequest.id);
    const issueComments = await repos.comments.list(project.id, "issue", issue.id);

    expect(updatedJob?.status).toBe("succeeded");
    expect(updatedPullRequest).toMatchObject({ status: "merged" });
    expect(updatedPullRequest?.labels.map((label) => label.name)).toContain(workflowLabelNames.done);
    expect(updatedIssue).toMatchObject({ status: "closed" });
    expect(updatedIssue?.labels.map((label) => label.name)).toContain(workflowLabelNames.done);
    expect(updatedObjective).toMatchObject({ status: "succeeded", judgeAgentJobId: job.id });
    expect(mergedFile).toBe("verified\n");
    expect(prComments.some((comment) => comment.body.includes("## Automatically merged"))).toBe(true);
    expect(issueComments.some((comment) => comment.body.includes("## Objective completed"))).toBe(true);

    context.client.close();
  });
});

async function createGitRepo(prefix: string): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), prefix));
  await git(repoPath, ["init", "-b", "main"]);
  await git(repoPath, ["config", "user.email", "test@example.com"]);
  await git(repoPath, ["config", "user.name", "OneTeam Test"]);
  await writeFile(join(repoPath, "README.md"), "# Test\n");
  await git(repoPath, ["add", "README.md"]);
  await git(repoPath, ["commit", "-m", "initial"]);
  return repoPath;
}

async function git(repoPath: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: repoPath });
}
