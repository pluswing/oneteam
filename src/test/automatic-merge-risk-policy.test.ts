import { describe, expect, it } from "vitest";
import type { LoopDto, ProjectCommandDto } from "../shared/types";
import {
  applyAutomaticMergeCommandPolicy,
  evaluateAutomaticMergeLoopDiffPolicy,
  normalizeAutomaticMergeLoopRiskPolicy,
  type AutomaticMergeLoopContext
} from "../server/services/automatic-merge-risk-policy";

describe("automatic merge Loop risk policy", () => {
  it("blocks required commands that are denied or outside the allowlist", () => {
    const context = loopContext({
      allowedCommands: ["npm test*"],
      deniedCommands: ["--force"],
      humanGateOnRisk: false
    });
    const commands = [
      command("test", "npm test -- --run"),
      command("build", "npm run build --force"),
      command("lint", "eslint .")
    ];

    const result = applyAutomaticMergeCommandPolicy(commands, context);

    expect(result.commands.map((item) => item.commandType)).toEqual(["test"]);
    expect(result.riskSignals).toHaveLength(2);
    expect(result.riskSignals.every((signal) => signal.blocking)).toBe(true);
    expect(result.riskSignals.map((signal) => signal.payload.commandType)).toEqual(["build", "lint"]);
  });

  it("marks diff budget and protected path signals as observation-only when configured", () => {
    const context = loopContext({
      humanGateOnRisk: false,
      maxChangedFiles: 0,
      maxDiffLines: 1,
      protectedPaths: ["secrets", ".env*"],
      protectedBranches: ["release/*"]
    });

    const signals = evaluateAutomaticMergeLoopDiffPolicy({
      context,
      sourceBranch: "release/candidate",
      changedFiles: ["secrets/token.txt", ".env.local"],
      diffLineCount: 4
    });

    expect(signals.map((signal) => signal.title)).toEqual([
      "Changed file budget exceeded",
      "Diff line budget exceeded",
      "Protected path changed",
      "Protected source branch"
    ]);
    expect(signals.every((signal) => signal.blocking === false)).toBe(true);
  });

  it("normalizes malformed policy fields without widening permissions", () => {
    expect(normalizeAutomaticMergeLoopRiskPolicy({
      humanGateOnRisk: "no",
      maxChangedFiles: -1,
      maxDiffLines: 10,
      allowedCommands: ["npm *", 42, ""],
      deniedCommands: null
    })).toEqual({
      humanGateOnRisk: true,
      maxChangedFiles: null,
      maxDiffLines: 10,
      allowedCommands: ["npm *"],
      deniedCommands: [],
      protectedPaths: [],
      protectedBranches: []
    });
  });
});

function loopContext(riskPolicy: Record<string, unknown>): AutomaticMergeLoopContext {
  const loop: LoopDto = {
    id: 7,
    projectId: "project",
    name: "Policy loop",
    purpose: "Test policy",
    triggerType: "manual",
    cadence: null,
    targetScope: "pull_request",
    status: "enabled",
    maxRounds: 3,
    timeBudgetMinutes: null,
    costBudget: null,
    stopCondition: null,
    riskPolicy,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  return {
    loop,
    loopRunId: 9,
    policy: normalizeAutomaticMergeLoopRiskPolicy(riskPolicy)
  };
}

function command(commandType: ProjectCommandDto["commandType"], value: string): ProjectCommandDto {
  const now = new Date().toISOString();
  return {
    id: ["install", "dev", "build", "test", "lint"].indexOf(commandType) + 1,
    commandType,
    command: value,
    detectionSource: "test",
    detectionDetails: null,
    isRequired: true,
    isAvailable: true,
    lastDetectedAt: now,
    createdAt: now,
    updatedAt: now
  };
}
