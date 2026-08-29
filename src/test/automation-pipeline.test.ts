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
import { classifyProviderWait, enterProviderWait, resumeProviderWait } from "../server/services/provider-wait";
import { saveAutomationSettings } from "../server/services/automation-settings";
import { workflowLabelNames } from "../shared/workflow-labels";
import { diffFileAnchor, diffLineAnchor } from "../shared/diff-anchors";
import { startLoopRun } from "../server/services/loop-runner";

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
    let probeCalls = 0;
    const adapter: AgentAdapter = {
      async probeCapacity() {
        probeCalls += 1;
        return {
          status: probeCalls === 1 ? "exhausted" : "available",
          provider: "codex",
          checkedAt: new Date().toISOString(),
          source: "test_rate_limits",
          message: probeCalls === 1 ? "Capacity is still exhausted." : "Capacity recovered.",
          usageSnapshot: { remaining: probeCalls === 1 ? 0 : 50 },
          resetAt: null
        };
      },
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
    const waitComments = await repos.comments.list(project.id, "issue", issue.id);
    expect(waitComments.some((comment) => comment.metadata?.providerWaitEvent === "wait_started")).toBe(true);

    await context.client.execute({
      sql: "update agent_jobs set next_retry_at = ? where id = ?",
      args: ["2000-01-01T00:00:00.000Z", job.id]
    });
    const restartedWorker = new AgentWorker(repos, adapter, { pollIntervalMs: 1000 });
    await restartedWorker.tick();

    const extendedJob = await repos.agentJobs.get(project.id, job.id);
    const extendedObjective = objective ? await repos.objectives.get(project.id, objective.id) : null;
    expect(calls).toBe(1);
    expect(probeCalls).toBe(1);
    expect(extendedJob).toMatchObject({
      status: "waiting_provider",
      attempt: 1,
      waitMetadata: {
        probeCount: 1,
        probeFailureCount: 0,
        lastProbe: { status: "exhausted", source: "test_rate_limits" }
      }
    });
    expect(extendedJob?.nextRetryAt).toBeTruthy();
    expect(extendedObjective).toMatchObject({ status: "waiting_provider", roundCount: 0 });
    const probeActivities = await repos.activities.list(project.id, "issue", issue.id);
    expect(probeActivities.map((activity) => activity.title)).toContain("AI provider capacity still unavailable");

    await context.client.execute({
      sql: "update agent_jobs set next_retry_at = ? where id = ?",
      args: ["2000-01-01T00:00:00.000Z", job.id]
    });
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
    expect(probeCalls).toBe(2);
    const resumedComments = await repos.comments.list(project.id, "issue", issue.id);
    expect(resumedComments.some((comment) => comment.metadata?.providerWaitEvent === "probe_extended")).toBe(true);
    expect(
      resumedComments.some(
        (comment) => comment.metadata?.providerWaitEvent === "retry_queued" && comment.metadata?.trigger === "automatic"
      )
    ).toBe(true);
    const recoveredActivities = await repos.activities.list(project.id, "issue", issue.id);
    expect(recoveredActivities.map((activity) => activity.title)).toContain("AI provider capacity recovered");

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

    const invalidProviderResponse = await app.request(`/api/projects/${project.id}/agent-jobs/${job.id}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ aiProvider: "unknown" })
    });
    expect(invalidProviderResponse.status).toBe(400);
    expect((await repos.agentJobs.get(project.id, job.id))?.status).toBe("waiting_provider");

    const resumeResponse = await app.request(`/api/projects/${project.id}/agent-jobs/${job.id}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ aiProvider: "claude_code" })
    });
    expect(resumeResponse.status).toBe(200);
    expect((await resumeResponse.json()) as { job: { status: string; aiProvider: string } }).toMatchObject({
      job: { status: "queued", aiProvider: "claude_code" }
    });
    const manuallyResumedComments = await repos.comments.list(project.id, "issue", issue.id);
    expect(
      manuallyResumedComments.some(
        (comment) => comment.metadata?.providerWaitEvent === "retry_queued" && comment.metadata?.trigger === "manual"
      )
    ).toBe(true);
    expect(
      manuallyResumedComments.some(
        (comment) =>
          comment.metadata?.previousProvider === "codex" &&
          comment.metadata?.provider === "claude_code" &&
          comment.body.includes("## AI provider switched and retry queued")
      )
    ).toBe(true);

    await worker.tick();
    const waitingAgain = await repos.agentJobs.get(project.id, job.id);
    expect(waitingAgain).toMatchObject({ status: "waiting_provider", attempt: 2, aiProvider: "claude_code" });
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
    const canceledComments = await repos.comments.list(project.id, "issue", issue.id);
    expect(canceledComments.some((comment) => comment.metadata?.providerWaitEvent === "wait_canceled")).toBe(true);

    context.client.close();
  });

  it("mirrors provider wait and resume history from a PR to its linked Issue", async () => {
    const databaseDir = await mkdtemp(join(tmpdir(), "oneteam-provider-linked-issue-db-"));
    const context = createDatabaseContext(`file:${join(databaseDir, "test.db")}`);
    await runMigrations(context.client);
    const repos = createRepositories(context.db);
    const project = await repos.projects.create({ name: "Linked wait", repoPath: databaseDir, defaultBranch: "main" });
    const issue = await repos.issues.create({ projectId: project.id, title: "Keep provider history" });
    const pullRequest = await repos.pullRequests.create({
      projectId: project.id,
      issueId: issue.id,
      title: "Wait during review",
      sourceBranch: "feature/wait",
      targetBranch: "main"
    });
    const objective = await ensureObjectiveForTarget(repos, {
      projectId: project.id,
      targetType: "pull_request",
      targetId: pullRequest.id
    });
    const queuedJob = await repos.agentJobs.create({
      projectId: project.id,
      agentType: "review",
      targetType: "pull_request",
      targetId: pullRequest.id,
      input: { objectiveRunId: objective?.id ?? null }
    });
    const job = await repos.agentJobs.updateStatus(project.id, queuedJob.id, "running");
    expect(job).not.toBeNull();
    const decision = classifyProviderWait(
      job!,
      { status: "failed", message: "You've hit your usage limit. Try again later." },
      new Date("2026-08-28T00:00:00.000Z"),
      () => 0.5
    );
    expect(decision).not.toBeNull();

    const waitingJob = await enterProviderWait(repos, job!, decision!);
    expect(waitingJob?.status).toBe("waiting_provider");
    const [waitPrComments, waitIssueComments] = await Promise.all([
      repos.comments.list(project.id, "pull_request", pullRequest.id),
      repos.comments.list(project.id, "issue", issue.id)
    ]);
    expect(waitPrComments.some((comment) => comment.metadata?.providerWaitEvent === "wait_started")).toBe(true);
    expect(waitIssueComments.some((comment) => comment.metadata?.providerWaitEvent === "wait_started")).toBe(true);

    await resumeProviderWait(repos, waitingJob!, "manual");
    const [resumePrComments, resumeIssueComments] = await Promise.all([
      repos.comments.list(project.id, "pull_request", pullRequest.id),
      repos.comments.list(project.id, "issue", issue.id)
    ]);
    expect(resumePrComments.some((comment) => comment.metadata?.providerWaitEvent === "retry_queued")).toBe(true);
    expect(resumeIssueComments.some((comment) => comment.metadata?.providerWaitEvent === "retry_queued")).toBe(true);

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
    await saveAutomationSettings(repos, {
      autoMergeEnabled: true,
      autoMergeTargetBranches: ["main"],
      autoMergeStrategy: "squash",
      autoMergeRiskThreshold: "high",
      objectiveMaxRounds: 12,
      objectiveTokenBudget: null,
      objectiveCostBudgetUsd: null,
      agentTimeBudgetMinutes: null,
      verificationCommandTimeoutMinutes: 5
    });
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
    const issueActivities = await repos.activities.list(project.id, "issue", issue.id);
    const memory = await repos.loopMemory.list(project.id);
    const mergeParents = (await git(repoPath, ["rev-list", "--parents", "-n", "1", "main"])).split(" ");
    const mergeComment = prComments.find((comment) => comment.body.includes("## Automatically merged"));
    const completionComment = issueComments.find((comment) => comment.body.includes("## Objective completed"));
    const mergeMemory = memory.find((entry) => entry.tags.includes(`pull_request:${pullRequest.id}`));

    expect(updatedJob?.status).toBe("succeeded");
    expect(updatedPullRequest).toMatchObject({ status: "merged" });
    expect(updatedPullRequest?.labels.map((label) => label.name)).toContain(workflowLabelNames.done);
    expect(updatedIssue).toMatchObject({ status: "closed" });
    expect(updatedIssue?.labels.map((label) => label.name)).toContain(workflowLabelNames.done);
    expect(updatedObjective).toMatchObject({ status: "succeeded", workflowStage: "merged", judgeAgentJobId: job.id });
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
    expect(mergeParents).toHaveLength(2);
    expect(mergeComment).toBeDefined();
    expect(mergeComment?.body).toContain(`/issues/${issue.id}#completion-summary`);
    expect(mergeComment?.metadata?.summaryAnchor).toBe("merge-summary");
    expect(mergeComment?.metadata?.mergeRetries).toEqual([]);
    expect(mergeComment?.metadata?.memoryEntryId).toBe(mergeMemory?.id);
    expect(mergeComment?.body).toMatch(/\/repository#commit-[0-9a-f]{40}/);
    expect(prComments.some((comment) => comment.body.includes("| Merge strategy | `squash` |"))).toBe(true);
    expect(prComments.some((comment) => comment.body.includes("| Transient merge retries | 0 |"))).toBe(true);
    expect(
      prComments.some((comment) => comment.body.includes(`/pulls/${pullRequest.id}#${diffFileAnchor("result.txt")}`))
    ).toBe(true);
    expect(
      prComments.some((comment) => comment.body.includes(
        `/pulls/${pullRequest.id}#${diffLineAnchor("result.txt", "R", 1)}`
      ))
    ).toBe(true);
    expect(mergeComment?.body).toContain(`/loops#memory-${mergeMemory?.id}`);
    expect(completionComment?.body).toContain("| Merge strategy | `squash` |");
    expect(completionComment?.body).toContain("| Source snapshot |");
    expect(completionComment?.body).toContain("| Target snapshot |");
    expect(completionComment?.body).toContain("| Merge base |");
    expect(completionComment?.body).toContain("| Transient merge retries | 0 |");
    expect(completionComment?.body).toContain(`| Verifier job | \`#${job.id}\` |`);
    expect(completionComment?.body).toContain("test -f result.txt");
    expect(completionComment?.body).toContain("No diff risk signal met the `high` automatic-merge threshold");
    expect(completionComment?.body).toContain(`/pulls/${pullRequest.id}#${diffFileAnchor("result.txt")}`);
    expect(completionComment?.body).toContain(`/pulls/${pullRequest.id}#merge-summary`);
    expect(completionComment?.body).toContain(`/loops#memory-${mergeMemory?.id}`);
    expect(completionComment?.body).toMatch(/\/repository#commit-[0-9a-f]{40}/);
    expect(completionComment?.metadata).toMatchObject({
      summaryAnchor: "completion-summary",
      mergeMode: "automatic",
      mergeStrategy: "squash",
      mergeRetries: [],
      memoryEntryId: mergeMemory?.id,
      verifierJobId: job.id
    });
    expect(mergeMemory).toMatchObject({
      sourceType: "agent_job",
      sourceId: job.id,
      title: `Objective #${objective?.id} merged`
    });
    expect(mergeMemory?.body).toContain(`/pulls/${pullRequest.id}#${diffLineAnchor("result.txt", "R", 1)}`);
    expect(
      objectiveEvidence.some(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          "type" in item &&
          item.type === "memory" &&
          "payload" in item &&
          typeof item.payload === "object" &&
          item.payload !== null &&
          "memoryEntryId" in item.payload &&
          item.payload.memoryEntryId === mergeMemory?.id
      )
    ).toBe(true);
    expect(issueComments.some((comment) => comment.body.includes(`/pulls/${pullRequest.id}`))).toBe(true);
    expect(issueActivities.map((activity) => activity.title)).toContain("Objective completed");

    context.client.close();
  });

  it("automatically requeues verification when verifier evidence references an older source commit", async () => {
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
    const [updatedPullRequest, updatedObjective, jobs, prComments] = await Promise.all([
      repos.pullRequests.get(project.id, pullRequest.id),
      repos.objectives.get(project.id, objective.id),
      repos.agentJobs.list({ projectId: project.id, targetType: "pull_request", targetId: pullRequest.id }),
      repos.comments.list(project.id, "pull_request", pullRequest.id)
    ]);
    const requeuedVerifier = jobs.find((candidate) => candidate.id !== completedVerifier.id && candidate.agentType === "verifier");

    expect(result).toMatchObject({ state: "requeued" });
    expect(result.state === "requeued" ? result.reason : "").toContain("stale");
    expect(updatedPullRequest?.status).toBe("open");
    expect(updatedPullRequest?.labels.map((label) => label.name)).toContain(workflowLabelNames.done);
    expect(updatedObjective).toMatchObject({
      status: "running",
      workflowStage: "verification",
      judgeAgentJobId: null,
      stopReason: "automatic_merge_reverification",
      roundCount: 0
    });
    expect(requeuedVerifier).toMatchObject({
      status: "queued",
      triggerType: "automatic_merge_snapshot_drift",
      input: {
        automaticMergeReverification: true,
        previousVerifierJobId: completedVerifier.id,
        previousSourceHead: oldSourceHead
      }
    });
    expect(prComments.some((comment) => comment.body.includes("## Automatic merge verification restarted"))).toBe(true);
    expect(prComments.some((comment) => comment.body.includes(`| Reverification job | \`#${requeuedVerifier?.id}\` |`))).toBe(true);

    context.client.close();
  });

  it("re-evaluates typed Evidence Required against current target commit before automatic merge", async () => {
    const databaseDir = await mkdtemp(join(tmpdir(), "oneteam-typed-evidence-db-"));
    const repoPath = await createGitRepo("oneteam-typed-evidence-repo-");
    const targetHead = await getRevisionHash(repoPath, "main");
    await git(repoPath, ["checkout", "-b", "feature/typed-evidence"]);
    await writeFile(join(repoPath, "typed.txt"), "typed evidence\n");
    await git(repoPath, ["add", "typed.txt"]);
    await git(repoPath, ["commit", "-m", "add typed evidence fixture"]);
    const sourceHead = await getRevisionHash(repoPath, "feature/typed-evidence");
    await git(repoPath, ["checkout", "main"]);

    const context = createDatabaseContext(`file:${join(databaseDir, "test.db")}`);
    await runMigrations(context.client);
    const repos = createRepositories(context.db);
    const project = await repos.projects.create({ name: "Typed evidence", repoPath, defaultBranch: "main" });
    const readyLabel = await repos.labels.findByName(project.id, workflowLabelNames.readyToMerge);
    const pullRequest = await repos.pullRequests.create({
      projectId: project.id,
      title: "Typed evidence verification",
      sourceBranch: "feature/typed-evidence",
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
    if (!objective || !completedVerifier) throw new Error("Failed to prepare typed evidence test.");
    await repos.objectives.update(project.id, objective.id, {
      status: "ready_to_merge",
      judgeAgentJobId: completedVerifier.id,
      evidenceRequirements: [
        { type: "build", required: true, commitScope: "target", maxAgeHours: 24 }
      ],
      evidence: {
        items: [
          {
            type: "judge",
            title: "Current verifier evidence",
            payload: {
              judgeAgentJobId: completedVerifier.id,
              sourceCommit: sourceHead,
              targetCommit: targetHead,
              capturedAt: new Date().toISOString()
            }
          },
          {
            type: "build",
            title: "Build from a different target snapshot",
            payload: {
              status: "passed",
              sourceCommit: sourceHead,
              targetCommit: "0".repeat(40),
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

    expect(result).toMatchObject({ state: "requeued" });
    expect(result.state === "requeued" ? result.reason : "").toContain(
      "Evidence Required became invalid before merge: build (commit mismatch)"
    );
    expect((await repos.pullRequests.get(project.id, pullRequest.id))?.status).toBe("open");
    expect((await repos.objectives.get(project.id, objective.id))?.status).toBe("running");
    context.client.close();
  });

  it("leaves a verified PR for manual merge when its target branch is outside policy", async () => {
    const databaseDir = await mkdtemp(join(tmpdir(), "oneteam-target-policy-db-"));
    const repoPath = await createGitRepo("oneteam-target-policy-repo-");
    await git(repoPath, ["checkout", "-b", "feature/policy"]);
    await writeFile(join(repoPath, "policy.txt"), "candidate\n");
    await git(repoPath, ["add", "policy.txt"]);
    await git(repoPath, ["commit", "-m", "policy candidate"]);
    await git(repoPath, ["checkout", "main"]);

    const context = createDatabaseContext(`file:${join(databaseDir, "test.db")}`);
    await runMigrations(context.client);
    const repos = createRepositories(context.db);
    const project = await repos.projects.create({ name: "Target policy", repoPath, defaultBranch: "main" });
    await saveAutomationSettings(repos, {
      autoMergeEnabled: true,
      autoMergeTargetBranches: ["release"],
      autoMergeStrategy: "merge",
      autoMergeRiskThreshold: "medium",
      objectiveMaxRounds: 12,
      objectiveTokenBudget: null,
      objectiveCostBudgetUsd: null,
      agentTimeBudgetMinutes: null,
      verificationCommandTimeoutMinutes: 5
    });
    const readyLabel = await repos.labels.findByName(project.id, workflowLabelNames.readyToMerge);
    const pullRequest = await repos.pullRequests.create({
      projectId: project.id,
      title: "Policy candidate",
      sourceBranch: "feature/policy",
      targetBranch: "main",
      labelIds: readyLabel ? [readyLabel.id] : []
    });
    const verifierJob = await repos.agentJobs.create({
      projectId: project.id,
      agentType: "verifier",
      targetType: "pull_request",
      targetId: pullRequest.id
    });

    const result = await mergePullRequest(repos, {
      project,
      pullRequest,
      mode: "automatic",
      verifierJob
    });
    const [updatedPullRequest, mainHead, sourceHead] = await Promise.all([
      repos.pullRequests.get(project.id, pullRequest.id),
      getRevisionHash(repoPath, "main"),
      getRevisionHash(repoPath, "feature/policy")
    ]);

    expect(result).toEqual({
      state: "skipped",
      reason: "Target branch main is outside the automatic merge policy."
    });
    expect(updatedPullRequest?.status).toBe("open");
    expect(mainHead).not.toBe(sourceHead);

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

  it("re-evaluates the verifier Loop risk policy before automatic merge", async () => {
    const databaseDir = await mkdtemp(join(tmpdir(), "oneteam-loop-risk-db-"));
    const repoPath = await createGitRepo("oneteam-loop-risk-repo-");
    await git(repoPath, ["checkout", "-b", "feature/loop-risk"]);
    await writeFile(join(repoPath, "policy.txt"), "one\ntwo\n");
    await git(repoPath, ["add", "policy.txt"]);
    await git(repoPath, ["commit", "-m", "loop risk candidate"]);
    const sourceHead = await getRevisionHash(repoPath, "feature/loop-risk");
    await git(repoPath, ["checkout", "main"]);

    const context = createDatabaseContext(`file:${join(databaseDir, "test.db")}`);
    await runMigrations(context.client);
    const repos = createRepositories(context.db);
    const project = await repos.projects.create({ name: "Loop risk", repoPath, defaultBranch: "main" });
    await saveAutomationSettings(repos, {
      autoMergeEnabled: true,
      autoMergeTargetBranches: ["main"],
      autoMergeStrategy: "merge",
      autoMergeRiskThreshold: "high",
      objectiveMaxRounds: 12,
      objectiveTokenBudget: null,
      objectiveCostBudgetUsd: null,
      agentTimeBudgetMinutes: null,
      verificationCommandTimeoutMinutes: 5
    });
    const issue = await repos.issues.create({ projectId: project.id, title: "Enforce Loop risk" });
    const readyLabel = await repos.labels.findByName(project.id, workflowLabelNames.readyToMerge);
    const pullRequest = await repos.pullRequests.create({
      projectId: project.id,
      issueId: issue.id,
      title: "Loop risk candidate",
      sourceBranch: "feature/loop-risk",
      targetBranch: "main",
      labelIds: readyLabel ? [readyLabel.id] : []
    });
    const objective = await ensureObjectiveForTarget(repos, {
      projectId: project.id,
      targetType: "pull_request",
      targetId: pullRequest.id
    });
    if (!objective) throw new Error("Failed to prepare Loop risk Objective.");
    const loop = await repos.loops.create({
      projectId: project.id,
      name: "Strict merge risk",
      purpose: "Require human review for any changed file.",
      triggerType: "manual",
      targetScope: "pull_request",
      riskPolicy: {
        humanGateOnRisk: true,
        maxChangedFiles: 0,
        maxDiffLines: 1,
        protectedPaths: ["policy.txt"],
        protectedBranches: []
      }
    });
    const started = await startLoopRun(repos, {
      projectId: project.id,
      loopId: loop.id,
      agentType: "verifier",
      targetType: "pull_request",
      targetId: pullRequest.id,
      triggerType: "test_loop_policy",
      objectiveRunId: objective.id
    });
    const completedVerifier = await repos.agentJobs.updateStatus(project.id, started.job.id, "succeeded");
    if (!completedVerifier) throw new Error("Failed to complete Loop risk verifier.");
    await repos.objectives.update(project.id, objective.id, {
      status: "ready_to_merge",
      workflowStage: "ready_to_merge",
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
    const [updatedObjective, updatedPullRequest, prComments] = await Promise.all([
      repos.objectives.get(project.id, objective.id),
      repos.pullRequests.get(project.id, pullRequest.id),
      repos.comments.list(project.id, "pull_request", pullRequest.id)
    ]);
    const evidenceItems = Array.isArray(updatedObjective?.evidence?.items) ? updatedObjective.evidence.items : [];
    const gateEvidence = [...evidenceItems].reverse().find(
      (item: unknown) => typeof item === "object" && item !== null && "type" in item && item.type === "automatic_merge_gate"
    );

    expect(result).toMatchObject({ state: "blocked" });
    expect(result.state === "blocked" ? result.reason : "").toContain("Changed file budget exceeded");
    expect(updatedPullRequest?.labels.map((label) => label.name)).toContain(workflowLabelNames.needsInput);
    expect(updatedObjective).toMatchObject({ status: "waiting_human", stopReason: "risk_detected" });
    expect(gateEvidence).toMatchObject({
      payload: {
        status: "failed",
        loopPolicy: { loopId: loop.id, loopRunId: started.run.id, loopName: "Strict merge risk" }
      }
    });
    expect(prComments.some((comment) => comment.body.includes("Changed file budget exceeded"))).toBe(true);
    expect(prComments.some((comment) => comment.body.includes(`/loops/${loop.id}`))).toBe(true);

    context.client.close();
  });

  it("automatically requeues verification when the target branch drifts during gate verification", async () => {
    const databaseDir = await mkdtemp(join(tmpdir(), "oneteam-target-drift-db-"));
    const repoPath = await createGitRepo("oneteam-target-drift-repo-");
    await git(repoPath, ["checkout", "-b", "feature/target-drift"]);
    await writeFile(join(repoPath, "candidate.txt"), "candidate\n");
    await git(repoPath, ["add", "candidate.txt"]);
    await git(repoPath, ["commit", "-m", "candidate change"]);
    const sourceHead = await getRevisionHash(repoPath, "feature/target-drift");
    await git(repoPath, ["checkout", "main"]);

    const context = createDatabaseContext(`file:${join(databaseDir, "test.db")}`);
    await runMigrations(context.client);
    const repos = createRepositories(context.db);
    const project = await repos.projects.create({ name: "Target drift", repoPath, defaultBranch: "main" });
    await repos.commands.upsertMany(project.id, [
      {
        commandType: "test",
        command:
          "tree=$(git rev-parse 'main^{tree}') && parent=$(git rev-parse main) && commit=$(printf 'target drift\\n' | git commit-tree \"$tree\" -p \"$parent\") && git update-ref refs/heads/main \"$commit\"",
        detectionSource: "test",
        isRequired: true,
        isAvailable: true
      }
    ]);
    const issue = await repos.issues.create({ projectId: project.id, title: "Reject target drift" });
    const readyLabel = await repos.labels.findByName(project.id, workflowLabelNames.readyToMerge);
    const pullRequest = await repos.pullRequests.create({
      projectId: project.id,
      issueId: issue.id,
      title: "Target drift candidate",
      sourceBranch: "feature/target-drift",
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
    if (!objective || !completedVerifier) throw new Error("Failed to prepare target drift test.");
    await repos.objectives.update(project.id, objective.id, {
      status: "ready_to_merge",
      workflowStage: "ready_to_merge",
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
    const [updatedPullRequest, updatedObjective, prComments, issueComments, jobs, issueActivities] = await Promise.all([
      repos.pullRequests.get(project.id, pullRequest.id),
      repos.objectives.get(project.id, objective.id),
      repos.comments.list(project.id, "pull_request", pullRequest.id),
      repos.comments.list(project.id, "issue", issue.id),
      repos.agentJobs.list({ projectId: project.id, targetType: "pull_request", targetId: pullRequest.id }),
      repos.activities.list(project.id, "issue", issue.id)
    ]);
    const requeuedVerifier = jobs.find((candidate) => candidate.id !== completedVerifier.id && candidate.agentType === "verifier");

    expect(result).toMatchObject({ state: "requeued" });
    expect(result.state === "requeued" ? result.reason : "").toContain("target branch changed");
    expect(updatedPullRequest).toMatchObject({ status: "open" });
    expect(updatedPullRequest?.labels.map((label) => label.name)).toContain(workflowLabelNames.done);
    expect(updatedObjective).toMatchObject({
      status: "running",
      workflowStage: "verification",
      judgeAgentJobId: null,
      stopReason: "automatic_merge_reverification",
      roundCount: 0
    });
    expect(requeuedVerifier).toMatchObject({
      status: "queued",
      triggerType: "automatic_merge_snapshot_drift",
      input: {
        automaticMergeReverification: true,
        previousVerifierJobId: completedVerifier.id
      }
    });
    expect(prComments.some((comment) => comment.body.includes("## Automatic merge verification restarted"))).toBe(true);
    expect(issueComments.some((comment) => comment.body.includes("## Automatic merge verification restarted"))).toBe(true);
    expect(issueActivities.map((activity) => activity.title)).toContain("Automatic merge re-verification queued");

    context.client.close();
  });

  it("routes automatic merge conflicts back to a fix job", async () => {
    const databaseDir = await mkdtemp(join(tmpdir(), "oneteam-merge-conflict-db-"));
    const repoPath = await createGitRepo("oneteam-merge-conflict-repo-");
    await git(repoPath, ["checkout", "-b", "feature/conflict"]);
    await writeFile(join(repoPath, "README.md"), "# Feature\n");
    await git(repoPath, ["commit", "-am", "feature edit"]);
    const sourceHead = await getRevisionHash(repoPath, "feature/conflict");
    await git(repoPath, ["checkout", "main"]);
    await writeFile(join(repoPath, "README.md"), "# Main\n");
    await git(repoPath, ["commit", "-am", "target edit"]);

    const context = createDatabaseContext(`file:${join(databaseDir, "test.db")}`);
    await runMigrations(context.client);
    const repos = createRepositories(context.db);
    const project = await repos.projects.create({ name: "Merge conflict", repoPath, defaultBranch: "main" });
    const issue = await repos.issues.create({ projectId: project.id, title: "Resolve conflict automatically" });
    const readyLabel = await repos.labels.findByName(project.id, workflowLabelNames.readyToMerge);
    const pullRequest = await repos.pullRequests.create({
      projectId: project.id,
      issueId: issue.id,
      title: "Conflicting candidate",
      sourceBranch: "feature/conflict",
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
    if (!objective || !completedVerifier) throw new Error("Failed to prepare conflict test.");
    await repos.objectives.update(project.id, objective.id, {
      status: "ready_to_merge",
      workflowStage: "ready_to_merge",
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
    const [updatedPullRequest, updatedObjective, jobs, issueComments] = await Promise.all([
      repos.pullRequests.get(project.id, pullRequest.id),
      repos.objectives.get(project.id, objective.id),
      repos.agentJobs.list({ projectId: project.id, targetType: "pull_request", targetId: pullRequest.id }),
      repos.comments.list(project.id, "issue", issue.id)
    ]);

    expect(result).toMatchObject({ state: "blocked" });
    expect(result.state === "blocked" ? result.reason : "").toContain("Merge conflicts detected: README.md");
    expect(updatedPullRequest?.labels.map((label) => label.name)).toContain(workflowLabelNames.resolvingConflicts);
    expect(updatedObjective).toMatchObject({ status: "running", workflowStage: "fix", stopReason: "merge_conflict" });
    expect(jobs.some((job) => job.agentType === "fix" && job.status === "queued")).toBe(true);
    expect(issueComments.some((comment) => comment.body.includes("## Automatic merge paused"))).toBe(true);

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

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: repoPath });
  return stdout.trim();
}
