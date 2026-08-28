import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentWorker } from "../server/agents/worker";
import type { AgentAdapter, AgentRunResult } from "../server/agents/types";
import { createDatabaseContext } from "../server/db/client";
import { runMigrations } from "../server/db/migrations";
import { createRepositories } from "../server/db/repositories";
import { saveAutomationSettings } from "../server/services/automation-settings";
import { runVerificationCommands } from "../server/services/verification-runner";
import type { ProjectCommandDto } from "../shared/types";

describe("execution timeouts", () => {
  it("stops an Agent job at its overall deadline and preserves timeout evidence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneteam-agent-deadline-"));
    const context = createDatabaseContext(`file:${join(dir, "test.db")}`);
    await runMigrations(context.client);
    const repos = createRepositories(context.db);
    const project = await repos.projects.create({ name: "Deadline", repoPath: dir, defaultBranch: "main" });
    await saveAutomationSettings(repos, {
      autoMergeEnabled: true,
      autoMergeTargetBranches: [],
      autoMergeStrategy: "merge",
      autoMergeRiskThreshold: "medium",
      objectiveMaxRounds: 12,
      objectiveTokenBudget: null,
      objectiveCostBudgetUsd: null,
      agentTimeBudgetMinutes: 0.001,
      verificationCommandTimeoutMinutes: 5
    });
    const issue = await repos.issues.create({ projectId: project.id, title: "Bounded execution" });
    const job = await repos.agentJobs.create({
      projectId: project.id,
      agentType: "requirements",
      targetType: "issue",
      targetId: issue.id
    });
    let adapterCalls = 0;
    const adapter: AgentAdapter = {
      async run(input) {
        adapterCalls += 1;
        while (!(await input.isCanceled?.())) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return {
          status: "canceled",
          message: "Adapter observed cancellation.",
          stopReason: "canceled",
          metadata: { providerExecution: { model: "deadline-test", usage: { input_tokens: 7 } } }
        };
      }
    };

    await new AgentWorker(repos, adapter, { pollIntervalMs: 1000 }).tick();

    const updated = await repos.agentJobs.get(project.id, job.id);
    const output = updated?.output as AgentRunResult | null;
    expect(adapterCalls).toBe(1);
    expect(updated).toMatchObject({ status: "waiting_human" });
    expect(updated?.startedAt).not.toBeNull();
    expect(output).toMatchObject({
      status: "waiting_human",
      stopReason: "timeout",
      metadata: {
        providerExecution: { model: "deadline-test" },
        agentDeadline: { agentTimeBudgetMinutes: 0.001 }
      }
    });
    expect(output?.evidence?.some((item) => item.type === "time_budget")).toBe(true);
    context.client.close();
  });

  it("applies command timeout independently from the Agent deadline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneteam-command-timeout-"));
    const command = commandFixture(
      `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
        "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);"
      )}`
    );

    const [result] = await runVerificationCommands(dir, [command], 30, Date.now() + 5_000);
    expect(result).toMatchObject({
      commandType: "test",
      status: "failed",
      timedOut: true
    });

    const [notStarted] = await runVerificationCommands(dir, [command], 5_000, Date.now() - 1);
    expect(notStarted).toMatchObject({
      status: "failed",
      durationMs: 0,
      timedOut: true,
      output: "Command was not started because the Agent job deadline was reached."
    });
  });
});

function commandFixture(command: string): ProjectCommandDto {
  const timestamp = "2026-08-29T00:00:00.000Z";
  return {
    id: 1,
    commandType: "test",
    command,
    detectionSource: "test",
    detectionDetails: null,
    isRequired: true,
    isAvailable: true,
    lastDetectedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}
