import type { AgentJobDto, LoopDto, ProjectCommandDto } from "../../shared/types";
import type { Repositories } from "../db/repositories";

export type AutomaticMergeLoopRiskPolicy = {
  humanGateOnRisk: boolean;
  maxChangedFiles: number | null;
  maxDiffLines: number | null;
  allowedCommands: string[];
  deniedCommands: string[];
  protectedPaths: string[];
  protectedBranches: string[];
};

export type AutomaticMergeLoopContext = {
  loop: LoopDto;
  loopRunId: number;
  policy: AutomaticMergeLoopRiskPolicy;
};

export type AutomaticMergeLoopRiskSignal = {
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  blocking: boolean;
};

export async function resolveAutomaticMergeLoopContext(
  repos: Repositories,
  verifierJob: AgentJobDto
): Promise<AutomaticMergeLoopContext | null> {
  const step = await repos.loopSteps.getByAgentJob(verifierJob.projectId, verifierJob.id);
  if (!step) return null;
  const run = await repos.loopRuns.get(verifierJob.projectId, step.loopRunId);
  if (!run) return null;
  const loop = await repos.loops.get(verifierJob.projectId, run.loopId);
  if (!loop) return null;
  return {
    loop,
    loopRunId: run.id,
    policy: normalizeAutomaticMergeLoopRiskPolicy(loop.riskPolicy)
  };
}

export function normalizeAutomaticMergeLoopRiskPolicy(value: unknown): AutomaticMergeLoopRiskPolicy {
  const policy = objectValue(value);
  return {
    humanGateOnRisk: policy?.humanGateOnRisk !== false,
    maxChangedFiles: nonNegativeNumber(policy?.maxChangedFiles),
    maxDiffLines: nonNegativeNumber(policy?.maxDiffLines),
    allowedCommands: stringArray(policy?.allowedCommands),
    deniedCommands: stringArray(policy?.deniedCommands),
    protectedPaths: stringArray(policy?.protectedPaths),
    protectedBranches: stringArray(policy?.protectedBranches)
  };
}

export function applyAutomaticMergeCommandPolicy(
  commands: ProjectCommandDto[],
  context: AutomaticMergeLoopContext | null
): { commands: ProjectCommandDto[]; riskSignals: AutomaticMergeLoopRiskSignal[] } {
  if (!context) return { commands, riskSignals: [] };
  const allowed: ProjectCommandDto[] = [];
  const riskSignals: AutomaticMergeLoopRiskSignal[] = [];
  for (const command of commands) {
    if (!command.isRequired || !command.isAvailable || !command.command) {
      allowed.push(command);
      continue;
    }
    const deniedPattern = context.policy.deniedCommands.find((pattern) => matchesPattern(command.command ?? "", pattern));
    const allowedByList = context.policy.allowedCommands.length === 0 ||
      context.policy.allowedCommands.some((pattern) => matchesPattern(command.command ?? "", pattern));
    if (deniedPattern || !allowedByList) {
      riskSignals.push({
        title: "Verification command blocked by Loop policy",
        summary: `${command.commandType} command was not executed because Loop #${context.loop.id} does not allow it.`,
        payload: {
          loopId: context.loop.id,
          loopRunId: context.loopRunId,
          loopName: context.loop.name,
          policySource: "loop",
          severity: "high",
          commandType: command.commandType,
          command: command.command,
          deniedPattern: deniedPattern ?? null,
          allowedCommands: context.policy.allowedCommands
        },
        // A denied command is never executed merely because observation-only
        // risk signals are enabled; required verification would be incomplete.
        blocking: true
      });
      continue;
    }
    allowed.push(command);
  }
  return { commands: allowed, riskSignals };
}

export function evaluateAutomaticMergeLoopDiffPolicy(input: {
  context: AutomaticMergeLoopContext | null;
  sourceBranch: string;
  changedFiles: string[];
  diffLineCount: number;
}): AutomaticMergeLoopRiskSignal[] {
  const { context } = input;
  if (!context) return [];
  const { policy } = context;
  const basePayload = {
    loopId: context.loop.id,
    loopRunId: context.loopRunId,
    loopName: context.loop.name,
    policySource: "loop",
    severity: "high"
  };
  const signals: AutomaticMergeLoopRiskSignal[] = [];
  if (typeof policy.maxChangedFiles === "number" && input.changedFiles.length > policy.maxChangedFiles) {
    signals.push({
      title: "Changed file budget exceeded",
      summary: `${input.changedFiles.length} changed file(s) exceeded Loop #${context.loop.id}'s limit of ${policy.maxChangedFiles}.`,
      payload: { ...basePayload, changedFiles: input.changedFiles, maxChangedFiles: policy.maxChangedFiles },
      blocking: policy.humanGateOnRisk
    });
  }
  if (typeof policy.maxDiffLines === "number" && input.diffLineCount > policy.maxDiffLines) {
    signals.push({
      title: "Diff line budget exceeded",
      summary: `${input.diffLineCount} diff line(s) exceeded Loop #${context.loop.id}'s limit of ${policy.maxDiffLines}.`,
      payload: { ...basePayload, diffLineCount: input.diffLineCount, maxDiffLines: policy.maxDiffLines },
      blocking: policy.humanGateOnRisk
    });
  }
  const protectedFiles = input.changedFiles.filter((file) =>
    policy.protectedPaths.some((pattern) => matchesPathPattern(file, pattern))
  );
  if (protectedFiles.length) {
    signals.push({
      title: "Protected path changed",
      summary: `Changes touched protected path(s) governed by Loop #${context.loop.id}: ${protectedFiles.join(", ")}.`,
      payload: { ...basePayload, protectedFiles, protectedPaths: policy.protectedPaths },
      blocking: policy.humanGateOnRisk
    });
  }
  const protectedSourcePattern = policy.protectedBranches.find((pattern) => matchesPattern(input.sourceBranch, pattern));
  if (protectedSourcePattern) {
    signals.push({
      title: "Protected source branch",
      summary: `Source branch ${input.sourceBranch} matched Loop #${context.loop.id}'s protected branch policy.`,
      payload: {
        ...basePayload,
        sourceBranch: input.sourceBranch,
        protectedPattern: protectedSourcePattern,
        protectedBranches: policy.protectedBranches
      },
      blocking: policy.humanGateOnRisk
    });
  }
  return signals;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function matchesPathPattern(value: string, pattern: string): boolean {
  return matchesPattern(value, pattern) || value.startsWith(`${pattern.replace(/\/+$/, "")}/`);
}

function matchesPattern(value: string, pattern: string): boolean {
  if (!pattern) return false;
  if (pattern.includes("*")) {
    const escaped = pattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return new RegExp(`^${escaped}$`).test(value);
  }
  return value === pattern || value.includes(pattern);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
