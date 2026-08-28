import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentWorker } from "../server/agents/worker";
import type { AgentAdapter } from "../server/agents/types";
import { createDatabaseContext } from "../server/db/client";
import { runMigrations } from "../server/db/migrations";
import { createRepositories } from "../server/db/repositories";
import { saveAutomationSettings } from "../server/services/automation-settings";
import {
  ensureObjectiveForTarget,
  preflightObjectiveJob,
  recordObjectiveJobResult
} from "../server/services/objective-runs";

describe("Objective provider usage budgets", () => {
  it("accumulates reported usage and blocks the next provider run without consuming a round", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneteam-objective-budget-"));
    const context = createDatabaseContext(`file:${join(dir, "test.db")}`);
    await runMigrations(context.client);
    const repos = createRepositories(context.db);
    const project = await repos.projects.create({ name: "Usage budget", repoPath: dir, defaultBranch: "main" });
    await saveAutomationSettings(repos, {
      autoMergeEnabled: true,
      autoMergeTargetBranches: [],
      autoMergeStrategy: "merge",
      autoMergeRiskThreshold: "medium",
      objectiveTokenBudget: 100,
      objectiveCostBudgetUsd: 5,
      agentTimeBudgetMinutes: null,
      verificationCommandTimeoutMinutes: 5
    });
    const issue = await repos.issues.create({ projectId: project.id, title: "Bounded objective" });
    const objective = await ensureObjectiveForTarget(repos, {
      projectId: project.id,
      targetType: "issue",
      targetId: issue.id
    });
    if (!objective) throw new Error("Objective was not created.");

    const completedJob = await repos.agentJobs.create({
      projectId: project.id,
      agentType: "implementation",
      targetType: "issue",
      targetId: issue.id,
      input: { objectiveRunId: objective.id }
    });
    const afterUsage = await recordObjectiveJobResult(repos, {
      job: completedJob,
      result: {
        status: "succeeded",
        message: "Implementation completed.",
        stopReason: "passed",
        evidence: [{ type: "test", title: "Tests passed" }],
        metadata: {
          providerExecution: {
            model: "gpt-test",
            usage: { input_tokens: 75, output_tokens: 25, total_cost_usd: 1.25 }
          }
        }
      }
    });
    expect(afterUsage).toMatchObject({
      roundCount: 1,
      providerUsage: {
        inputTokens: 75,
        outputTokens: 25,
        totalTokens: 100,
        costUsd: 1.25,
        requestCount: 1
      }
    });

    const blockedJob = await repos.agentJobs.create({
      projectId: project.id,
      agentType: "review",
      targetType: "issue",
      targetId: issue.id,
      input: { objectiveRunId: objective.id }
    });
    const blocked = await preflightObjectiveJob(repos, blockedJob);
    expect(blocked).toMatchObject({
      status: "waiting_human",
      stopReason: "budget_exceeded",
      metadata: { objectivePreflightGate: true }
    });
    expect(blocked?.message).toContain("100/100 tokens");

    if (!blocked) throw new Error("Budget gate did not return a result.");
    const afterGate = await recordObjectiveJobResult(repos, { job: blockedJob, result: blocked });
    expect(afterGate).toMatchObject({
      status: "waiting_human",
      stopReason: "budget_exceeded",
      roundCount: 1,
      tokenBudget: 100,
      costBudgetUsd: 5
    });

    const evidence = afterGate?.evidence?.items;
    expect(Array.isArray(evidence) ? evidence.map((item) => (item as { type?: string }).type) : []).toContain(
      "provider_usage_budget"
    );
    context.client.close();
  });

  it("does not change a terminal Objective when its preflight gate is recorded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneteam-terminal-budget-"));
    const context = createDatabaseContext(`file:${join(dir, "test.db")}`);
    await runMigrations(context.client);
    const repos = createRepositories(context.db);
    const project = await repos.projects.create({ name: "Terminal gate", repoPath: dir, defaultBranch: "main" });
    const issue = await repos.issues.create({ projectId: project.id, title: "Finished objective" });
    const objective = await ensureObjectiveForTarget(repos, {
      projectId: project.id,
      targetType: "issue",
      targetId: issue.id
    });
    if (!objective) throw new Error("Objective was not created.");
    await repos.objectives.update(project.id, objective.id, {
      status: "succeeded",
      summary: "Already complete.",
      finishedAt: new Date().toISOString()
    });
    const job = await repos.agentJobs.create({
      projectId: project.id,
      agentType: "review",
      targetType: "issue",
      targetId: issue.id,
      input: { objectiveRunId: objective.id }
    });

    const blocked = await preflightObjectiveJob(repos, job);
    if (!blocked) throw new Error("Terminal gate did not return a result.");
    const afterGate = await recordObjectiveJobResult(repos, { job, result: blocked });
    expect(afterGate).toMatchObject({
      status: "succeeded",
      summary: "Already complete.",
      roundCount: 0
    });
    context.client.close();
  });

  it("blocks a queued job before it is marked running or calls its provider", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneteam-dequeue-budget-"));
    const context = createDatabaseContext(`file:${join(dir, "test.db")}`);
    await runMigrations(context.client);
    const repos = createRepositories(context.db);
    const project = await repos.projects.create({ name: "Dequeue gate", repoPath: dir, defaultBranch: "main" });
    await saveAutomationSettings(repos, {
      autoMergeEnabled: true,
      autoMergeTargetBranches: [],
      autoMergeStrategy: "merge",
      autoMergeRiskThreshold: "medium",
      objectiveTokenBudget: 50,
      objectiveCostBudgetUsd: null,
      agentTimeBudgetMinutes: null,
      verificationCommandTimeoutMinutes: 5
    });
    const issue = await repos.issues.create({ projectId: project.id, title: "Do not start provider" });
    const objective = await ensureObjectiveForTarget(repos, {
      projectId: project.id,
      targetType: "issue",
      targetId: issue.id
    });
    if (!objective) throw new Error("Objective was not created.");
    await repos.objectives.update(project.id, objective.id, {
      providerUsage: { ...objective.providerUsage, inputTokens: 50, totalTokens: 50, requestCount: 1 }
    });
    const job = await repos.agentJobs.create({
      projectId: project.id,
      agentType: "review",
      targetType: "issue",
      targetId: issue.id,
      input: { objectiveRunId: objective.id }
    });
    let providerCalls = 0;
    const adapter: AgentAdapter = {
      async run() {
        providerCalls += 1;
        return { status: "succeeded", message: "Provider should not run." };
      }
    };

    await new AgentWorker(repos, adapter, { pollIntervalMs: 1000 }).tick();

    const blockedJob = await repos.agentJobs.get(project.id, job.id);
    expect(providerCalls).toBe(0);
    expect(blockedJob).toMatchObject({
      status: "waiting_human",
      startedAt: null
    });
    expect((blockedJob?.output as { stopReason?: string } | null)?.stopReason).toBe("budget_exceeded");
    context.client.close();
  });
});
