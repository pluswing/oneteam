import type { AgentJobDto, AgentType, LoopDto, LoopRunDto, LoopStepDto } from "../../shared/types";
import type { Repositories } from "../db/repositories";
import { resolveAgentJobLockKey } from "./agent-job-locks";

export type StartLoopRunInput = {
  projectId: string;
  loopId: number;
  agentType: AgentType;
  targetType: "issue" | "pull_request" | "project";
  targetId: number;
  triggerType: string;
  objectiveRunId?: number | null;
  jobInput?: Record<string, unknown>;
};

export type StartedLoopRun = {
  run: LoopRunDto;
  job: AgentJobDto;
  step: LoopStepDto;
};

export async function createLoopStepJob(
  repos: Repositories,
  input: StartLoopRunInput & { loopRunId: number }
): Promise<{ job: AgentJobDto; step: LoopStepDto }> {
  const job = await repos.agentJobs.create({
    projectId: input.projectId,
    agentType: input.agentType,
    targetType: input.targetType,
    targetId: input.targetId,
    triggerType: input.triggerType,
    input: {
      ...(input.jobInput ?? {}),
      objectiveRunId: input.objectiveRunId ?? input.jobInput?.objectiveRunId ?? null,
      loopRunId: input.loopRunId
    },
    lockKey: resolveAgentJobLockKey({
      projectId: input.projectId,
      agentType: input.agentType,
      targetType: input.targetType,
      targetId: input.targetId
    })
  });

  const step = await repos.loopSteps.create({
    projectId: input.projectId,
    loopRunId: input.loopRunId,
    agentJobId: job.id,
    agentType: input.agentType,
    targetType: input.targetType,
    targetId: input.targetId,
    input: input.jobInput ?? null
  });

  return { job, step };
}

export async function startLoopRun(repos: Repositories, input: StartLoopRunInput): Promise<StartedLoopRun> {
  const run = await repos.loopRuns.create({
    projectId: input.projectId,
    loopId: input.loopId,
    triggerType: input.triggerType,
    targetType: input.targetType,
    targetId: input.targetId
  });
  const { job, step } = await createLoopStepJob(repos, {
    ...input,
    loopRunId: run.id
  });
  const runningRun = await repos.loopRuns.updateStatus(input.projectId, run.id, "running");
  return { run: runningRun ?? run, job, step };
}

export async function ensureSystemLoop(
  repos: Repositories,
  input: {
    projectId: string;
    name: string;
    purpose: string;
    triggerType: string;
    targetScope: string;
    stopCondition?: Record<string, unknown> | null;
    riskPolicy?: Record<string, unknown> | null;
  }
): Promise<LoopDto> {
  const existing = (await repos.loops.list(input.projectId)).find(
    (loop) => loop.name === input.name && loop.triggerType === input.triggerType && loop.targetScope === input.targetScope
  );
  if (existing) {
    return existing;
  }

  return repos.loops.create({
    projectId: input.projectId,
    name: input.name,
    purpose: input.purpose,
    triggerType: input.triggerType,
    targetScope: input.targetScope,
    stopCondition: input.stopCondition ?? {
      stopReasons: ["passed", "failed", "waiting_human", "risk_detected"]
    },
    riskPolicy: input.riskPolicy ?? {
      maxChangedFiles: 20,
      maxDiffLines: 800,
      allowedCommands: [],
      deniedCommands: ["rm -rf", "sudo"],
      protectedPaths: [".env", "secrets", ".oneteam/skills"],
      protectedBranches: ["main", "master"],
      humanGateOnRisk: true
    }
  });
}
