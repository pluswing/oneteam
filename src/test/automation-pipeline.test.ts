import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { AgentWorker } from "../server/agents/worker";
import type { AgentAdapter } from "../server/agents/types";
import { createApp } from "../server/app";
import { createDatabaseContext } from "../server/db/client";
import { runMigrations } from "../server/db/migrations";
import { createRepositories } from "../server/db/repositories";
import { getRevisionHash } from "../server/services/git-service";
import { ensureObjectiveForTarget } from "../server/services/objective-runs";
import { mergePullRequest } from "../server/services/pull-request-merge";
import { workflowLabelNames } from "../shared/workflow-labels";
import { diffFileAnchor } from "../shared/diff-anchors";

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
          ? {
              status: "failed",
              message: "You've hit your usage limit. Try again later.",
              metadata: {
                providerExecution: {
                  model: "gpt-test",
                  sessionId: "thread-wait",
                  usage: { remaining: 0 }
                }
              }
            }
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
    expect(waitingJob?.waitMetadata).toMatchObject({
      model: "gpt-test",
      sessionId: "thread-wait",
      usageSnapshot: { remaining: 0 }
    });
    expect(waitingObjective).toMatchObject({ status: "waiting_provider", roundCount: 0 });

    await context.client.execute({
      sql: "update agent_jobs set next_retry_at = ? where id = ?",
      args: ["2000-01-01T00:00:00.000Z", job.id]
    });
    const restartedWorker = new AgentWorker(repos, adapter, { pollIntervalMs: 1000 });
    await restartedWorker.tick();

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

  it("supports manual resume and keeps Objective state consistent when a provider wait is canceled", async () => {
    const databaseDir = await mkdtemp(join(tmpdir(), "oneteam-provider-controls-db-"));
    const repoPath = await createGitRepo("oneteam-provider-controls-repo-");
    const context = createDatabaseContext(`file:${join(databaseDir, "test.db")}`);
    await runMigrations(context.client);
    const repos = createRepositories(context.db);
    const project = await repos.projects.create({ name: "Provider controls", repoPath, defaultBranch: "main" });
    const issue = await repos.issues.create({ projectId: project.id, title: "Control provider wait" });
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
    const adapter: AgentAdapter = {
      async run() {
        return { status: "failed", message: "You've hit your usage limit. Try again later." };
      }
    };
    const worker = new AgentWorker(repos, adapter, { pollIntervalMs: 1000 });
    await worker.tick();
    const app = createApp({ repos });

    const resumeResponse = await app.request(`/api/projects/${project.id}/agent-jobs/${job.id}/resume`, {
      method: "POST"
    });
    expect(resumeResponse.status).toBe(200);
    expect((await resumeResponse.json()) as { job: { status: string } }).toMatchObject({ job: { status: "queued" } });

    await worker.tick();
    const waitingAgain = await repos.agentJobs.get(project.id, job.id);
    expect(waitingAgain).toMatchObject({ status: "waiting_provider", attempt: 2 });
    expect(waitingAgain?.waitMetadata?.retryCount).toBe(2);

    const cancelResponse = await app.request(`/api/projects/${project.id}/agent-jobs/${job.id}/cancel`, {
      method: "POST"
    });
    const [canceledJob, canceledObjective] = await Promise.all([
      repos.agentJobs.get(project.id, job.id),
      objective ? repos.objectives.get(project.id, objective.id) : null
    ]);
    expect(cancelResponse.status).toBe(200);
    expect(canceledJob?.status).toBe("canceled");
    expect(canceledObjective).toMatchObject({ status: "canceled", roundCount: 0, stopReason: "canceled" });

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
    await repos.commands.upsertMany(project.id, [
      {
        commandType: "test",
        command: "test -f result.txt",
        detectionSource: "test",
        isRequired: true,
        isAvailable: true
      }
    ]);
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
    const objectiveEvidence = Array.isArray(updatedObjective?.evidence?.items) ? updatedObjective.evidence.items : [];
    expect(
      objectiveEvidence.some(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          "type" in item &&
          item.type === "automatic_merge_gate" &&
          "payload" in item &&
          typeof item.payload === "object" &&
          item.payload !== null &&
          "status" in item.payload &&
          item.payload.status === "passed"
      )
    ).toBe(true);
    expect(mergedFile).toBe("verified\n");
    expect(prComments.some((comment) => comment.body.includes("## Automatically merged"))).toBe(true);
    expect(
      prComments.some((comment) => comment.body.includes(`/pulls/${pullRequest.id}#${diffFileAnchor("result.txt")}`))
    ).toBe(true);
    expect(issueComments.some((comment) => comment.body.includes("## Objective completed"))).toBe(true);
    expect(issueComments.some((comment) => comment.body.includes(`/pulls/${pullRequest.id}`))).toBe(true);

    context.client.close();
  });

  it("blocks automatic merge when verifier evidence references an older source commit", async () => {
    const databaseDir = await mkdtemp(join(tmpdir(), "oneteam-stale-evidence-db-"));
    const repoPath = await createGitRepo("oneteam-stale-evidence-repo-");
    await git(repoPath, ["checkout", "-b", "feature/stale"]);
    await writeFile(join(repoPath, "stale.txt"), "first\n");
    await git(repoPath, ["add", "stale.txt"]);
    await git(repoPath, ["commit", "-m", "first change"]);
    const oldSourceHead = await getRevisionHash(repoPath, "feature/stale");
    await git(repoPath, ["checkout", "main"]);

    const context = createDatabaseContext(`file:${join(databaseDir, "test.db")}`);
    await runMigrations(context.client);
    const repos = createRepositories(context.db);
    const project = await repos.projects.create({ name: "Stale evidence", repoPath, defaultBranch: "main" });
    const readyLabel = await repos.labels.findByName(project.id, workflowLabelNames.readyToMerge);
    const pullRequest = await repos.pullRequests.create({
      projectId: project.id,
      title: "Stale verification",
      sourceBranch: "feature/stale",
      targetBranch: "main",
      labelIds: readyLabel ? [readyLabel.id] : []
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
    const completedVerifier = await repos.agentJobs.updateStatus(project.id, verifierJob.id, "succeeded");
    if (!objective || !completedVerifier) {
      throw new Error("Failed to prepare stale evidence test.");
    }
    await repos.objectives.update(project.id, objective.id, {
      status: "ready_to_merge",
      judgeAgentJobId: completedVerifier.id,
      evidence: {
        items: [
          {
            type: "judge",
            title: "Old verifier evidence",
            payload: {
              judgeAgentJobId: completedVerifier.id,
              sourceCommit: oldSourceHead,
              capturedAt: new Date().toISOString()
            }
          }
        ]
      }
    });

    await git(repoPath, ["checkout", "feature/stale"]);
    await writeFile(join(repoPath, "stale.txt"), "second\n");
    await git(repoPath, ["commit", "-am", "second change"]);
    await git(repoPath, ["checkout", "main"]);

    const result = await mergePullRequest(repos, {
      project,
      pullRequest,
      mode: "automatic",
      verifierJob: completedVerifier
    });
    const [updatedPullRequest, updatedObjective] = await Promise.all([
      repos.pullRequests.get(project.id, pullRequest.id),
      repos.objectives.get(project.id, objective.id)
    ]);

    expect(result).toMatchObject({ state: "blocked" });
    expect(result.state === "blocked" ? result.reason : "").toContain("stale");
    expect(updatedPullRequest?.status).toBe("open");
    expect(updatedPullRequest?.labels.map((label) => label.name)).toContain(workflowLabelNames.needsInput);
    expect(updatedObjective?.status).toBe("waiting_human");

    context.client.close();
  });

  it("blocks automatic merge when a required command fails on the source branch", async () => {
    const databaseDir = await mkdtemp(join(tmpdir(), "oneteam-merge-check-db-"));
    const repoPath = await createGitRepo("oneteam-merge-check-repo-");
    await git(repoPath, ["checkout", "-b", "feature/check-failure"]);
    await writeFile(join(repoPath, "candidate.txt"), "candidate\n");
    await git(repoPath, ["add", "candidate.txt"]);
    await git(repoPath, ["commit", "-m", "candidate change"]);
    const sourceHead = await getRevisionHash(repoPath, "feature/check-failure");
    await git(repoPath, ["checkout", "main"]);

    const context = createDatabaseContext(`file:${join(databaseDir, "test.db")}`);
    await runMigrations(context.client);
    const repos = createRepositories(context.db);
    const project = await repos.projects.create({ name: "Required check", repoPath, defaultBranch: "main" });
    await repos.commands.upsertMany(project.id, [
      {
        commandType: "test",
        command: "test -f file-that-does-not-exist",
        detectionSource: "test",
        isRequired: true,
        isAvailable: true
      }
    ]);
    const readyLabel = await repos.labels.findByName(project.id, workflowLabelNames.readyToMerge);
    const pullRequest = await repos.pullRequests.create({
      projectId: project.id,
      title: "Failing required check",
      sourceBranch: "feature/check-failure",
      targetBranch: "main",
      labelIds: readyLabel ? [readyLabel.id] : []
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
    const completedVerifier = await repos.agentJobs.updateStatus(project.id, verifierJob.id, "succeeded");
    if (!objective || !completedVerifier) {
      throw new Error("Failed to prepare required check test.");
    }
    await repos.objectives.update(project.id, objective.id, {
      status: "ready_to_merge",
      judgeAgentJobId: completedVerifier.id,
      evidence: {
        items: [
          {
            type: "judge",
            title: "Current verifier evidence",
            payload: {
              judgeAgentJobId: completedVerifier.id,
              sourceCommit: sourceHead,
              capturedAt: new Date().toISOString()
            }
          }
        ]
      }
    });

    const result = await mergePullRequest(repos, {
      project,
      pullRequest,
      mode: "automatic",
      verifierJob: completedVerifier
    });
    const updatedObjective = await repos.objectives.get(project.id, objective.id);
    const objectiveEvidence = Array.isArray(updatedObjective?.evidence?.items) ? updatedObjective.evidence.items : [];

    expect(result).toMatchObject({ state: "blocked" });
    expect(result.state === "blocked" ? result.reason : "").toContain("Required commands failed");
    expect(
      objectiveEvidence.some(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          "type" in item &&
          item.type === "automatic_merge_gate" &&
          "payload" in item &&
          typeof item.payload === "object" &&
          item.payload !== null &&
          "status" in item.payload &&
          item.payload.status === "failed"
      )
    ).toBe(true);

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
