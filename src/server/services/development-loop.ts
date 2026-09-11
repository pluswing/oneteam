import type { AgentJobDto, AgentType } from "../../shared/types";
import type { DevelopmentLoopDto, DevelopmentPhase } from "../../shared/development-loop";
import type { Repositories } from "../db/repositories";

export function phaseForAgent(agent: string): DevelopmentPhase {
  if (agent === "requirements") return "planning";
  if (agent === "implementation") return "implementing";
  if (agent === "review") return "reviewing";
  if (agent === "fix") return "fixing";
  if (agent === "retrospective") return "reflecting";
  return "validating";
}

export async function ensureDevelopmentLoop(repos: Repositories, projectId: string, issueId: number): Promise<DevelopmentLoopDto> {
  const existing = await repos.development.forIssue(projectId, issueId);
  if (existing && !["succeeded", "canceled"].includes(existing.status)) return existing;
  const issue = await repos.issues.get(projectId, issueId);
  if (!issue) throw new Error("Issue was not found.");
  // The existing evidence store is retained as a projection for verification/merge.
  // It does not schedule work; DevelopmentLoop is the only workflow authority.
  const previousObjective = await repos.objectives.findByIssue(projectId, issueId);
  const objective = previousObjective && !["succeeded", "canceled"].includes(previousObjective.status)
    ? previousObjective
    : await repos.objectives.createForIssue({ projectId, issueId, title: issue.title, goal: issue.body, maxRounds: 24 });
  return repos.development.create(projectId, issueId, objective.id);
}

export async function queueDevelopmentJob(repos: Repositories, loop: DevelopmentLoopDto): Promise<AgentJobDto> {
  const all = await repos.agentJobs.list({ projectId: loop.projectId });
  const sequence = loop.rounds + 1;
  const existing = all.find((job) => job.input.developmentLoopId === loop.id && job.input.sequence === sequence);
  const agentType = loop.nextAgent as AgentType;
  const isIssue = ["requirements", "implementation"].includes(agentType);
  if (!isIssue && !loop.pullRequestId) throw new Error("This Loop needs a pull request before continuing.");
  const legacy = await repos.settings.get(`development-legacy:${loop.id}`);
  const job = existing ?? await repos.agentJobs.create({
    projectId: loop.projectId, aiProvider: "codex", aiModel: null, agentType,
    targetType: isIssue ? "issue" : "pull_request", targetId: isIssue ? loop.issueId : loop.pullRequestId!,
    triggerType: "development_loop", lockKey: `development:${loop.projectId}`,
    input: { developmentLoopId: loop.id, objectiveRunId: loop.objectiveId, sequence, qualityFailures: loop.failures, implementationBranchTitle: legacy?.branchTitle ?? `loop ${loop.id}` }
  });
  await repos.development.update(loop.projectId, loop.id, { currentJobId: job.id, rounds: sequence, phase: phaseForAgent(agentType), status: "running" });
  return job;
}

export async function controlDevelopmentLoop(repos: Repositories, loop: DevelopmentLoopDto, action: "pause" | "resume" | "cancel"): Promise<DevelopmentLoopDto> {
  if (loop.status === "succeeded" || loop.status === "canceled") return loop;
  if (loop.phase === "merging" && loop.status === "running") throw new Error("The merge is being finalized. Wait for it to finish before controlling the Loop.");
  const job = loop.currentJobId ? await repos.agentJobs.get(loop.projectId, loop.currentJobId) : null;
  if (action === "pause") {
    if (job) await repos.agentJobs.pause(loop.projectId, job.id);
    return repos.development.update(loop.projectId, loop.id, { status: "paused" });
  }
  if (action === "cancel") {
    if (loop.objectiveId && !loop.mergeCommit) await repos.objectives.update(loop.projectId, loop.objectiveId, { status: "canceled", stopReason: "canceled_by_user", finishedAt: new Date().toISOString() });
    if (job && !["succeeded", "failed", "canceled"].includes(job.status)) await repos.agentJobs.updateStatus(loop.projectId, job.id, "canceled");
    return repos.development.update(loop.projectId, loop.id, { status: "canceled", finishedAt: new Date().toISOString() });
  }
  if (job && (await repos.development.executions.list(loop.projectId, job.id)).some((execution) => ["starting", "running"].includes(execution.status))) {
    throw new Error("Codex is still stopping. Resume again after the current execution has stopped.");
  }
  if (job?.status === "paused") await repos.agentJobs.resumePaused(loop.projectId, job.id);
  else if (job && ["waiting_human", "failed", "canceled"].includes(job.status)) {
    await repos.development.retryJob(loop.projectId, job.id);
  }
  if (loop.objectiveId && loop.phase !== "reflecting") await repos.objectives.update(loop.projectId, loop.objectiveId, { status: "running", stopReason: null, finishedAt: null });
  if (loop.rounds >= 24) {
    await repos.settings.set(`development-round-limit:${loop.id}`, { maxRounds: loop.rounds + 12 });
    if (loop.objectiveId) await repos.objectives.update(loop.projectId, loop.objectiveId, { maxRounds: loop.rounds + 12 });
  }
  return repos.development.update(loop.projectId, loop.id, { status: "running", failures: 0, summary: "Resumed." });
}

export async function migrateActiveDevelopmentLoops(repos: Repositories, projectId: string): Promise<void> {
  const marker = `development-migration:${projectId}`;
  if (await repos.settings.get(marker)) return;
  const objectives = await repos.objectives.list({ projectId });
  for (const objective of objectives) {
    if (!objective.issueId || ["succeeded", "canceled"].includes(objective.status)) continue;
    if (await repos.development.forIssue(projectId, objective.issueId)) continue;
    const issue = await repos.issues.get(projectId, objective.issueId);
    if (!issue || issue.status !== "open") continue;
    const loop = await repos.development.create(projectId, objective.issueId, objective.id);
    const jobs = (await repos.agentJobs.list({ projectId })).filter((job) => job.input.objectiveRunId === objective.id);
    const current = jobs.find((job) => ["queued", "running", "waiting_provider", "waiting_human", "paused"].includes(job.status));
    const nextAgent = current?.agentType ?? ({ requirements: "requirements", implementation: "implementation", review: "review", fix: "fix", qa: "qa", verification: "verifier", ready_to_merge: "verifier", merged: "retrospective" }[objective.workflowStage]);
    // Preserve provider/thread history. Imported work starts a fresh Codex Job.
    for (const job of jobs) await repos.development.updateJobInput(projectId, job.id, { ...job.input, developmentLoopId: loop.id, imported: true });
    await repos.settings.set(`development-legacy:${loop.id}`, { branchTitle: issue.title });
    await repos.development.update(projectId, loop.id, {
      pullRequestId: objective.pullRequestId, currentJobId: null, rounds: 0,
      phase: phaseForAgent(nextAgent), nextAgent, status: "paused", summary: "Previous execution imported. Resume to continue with Codex."
    });
    await repos.objectives.update(projectId, objective.id, { maxRounds: 24, tokenBudget: null, costBudgetUsd: null });
    for (const job of jobs.filter((item) => ["queued", "running", "waiting_provider", "waiting_human"].includes(item.status))) await repos.agentJobs.pause(projectId, job.id);
  }
  await repos.settings.set(marker, { completedAt: new Date().toISOString() });
}
