import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DevelopmentLoopDto } from "../../shared/development-loop";
import type { AgentJobDto, AgentType, ProjectDto } from "../../shared/types";
import { AgentWorker } from "../agents/worker";
import type { AgentAdapter, AgentRunResult } from "../agents/types";
import type { Repositories } from "../db/repositories";
import { migrateActiveDevelopmentLoops, phaseForAgent, queueDevelopmentJob } from "./development-loop";
import { mergePullRequest } from "./pull-request-merge";
import { finalizeRetrospective } from "./retrospective";

const exec = promisify(execFile);

/** Sole scheduler for an open workspace. Verification remains a reusable service. */
export class LoopEngine {
  private timer: NodeJS.Timeout | null = null;
  private pending: Promise<void> | null = null;
  private stopped = false;
  private readonly worker: AgentWorker;

  constructor(private readonly repos: Repositories, adapter: AgentAdapter, private readonly intervalMs = 1_000) {
    this.worker = new AgentWorker(repos, adapter, { pollIntervalMs: intervalMs });
  }

  async initialize(): Promise<void> {
    for (const project of await this.repos.projects.list()) await migrateActiveDevelopmentLoops(this.repos, project.id);
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    const tick = () => { void this.tick().catch((error: unknown) => { console.error("Loop scheduler failed:", error instanceof Error ? error.message : error); }); };
    this.timer = setInterval(tick, this.intervalMs);
    tick();
  }

  async stopAndDrain(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.worker.stopAndDrain();
    await this.pending;
  }

  async tick(): Promise<void> {
    if (this.pending || this.stopped) return;
    this.pending = this.advance();
    try { await this.pending; } finally { this.pending = null; }
  }

  private async advance(): Promise<void> {
    const project = (await this.repos.projects.list())[0];
    if (!project) return;
    // Paused/failed loops intentionally hold the queue until resumed or canceled.
    const loop = (await this.repos.development.list(project.id)).reverse().find((item) => !["succeeded", "canceled"].includes(item.status));
    if (!loop || ["paused", "failed", "waiting_input"].includes(loop.status)) return;
    try {
      const issue = await this.repos.issues.get(project.id, loop.issueId);
      if (!issue || (issue.status === "closed" && !loop.mergeCommit && loop.phase !== "merging")) {
        if (loop.currentJobId) await this.repos.agentJobs.updateStatus(project.id, loop.currentJobId, "canceled");
        await this.repos.development.update(project.id, loop.id, { status: "canceled", summary: "Issue closed before merge.", finishedAt: new Date().toISOString() });
        return;
      }
      if (loop.phase === "merging") { await this.merge(project, loop); return; }
      if (loop.phase === "reflecting" && loop.mergeCommit) {
        await this.repos.issues.update(project.id, loop.issueId, { status: "closed" });
        if (loop.pullRequestId) await this.repos.pullRequests.update(project.id, loop.pullRequestId, { status: "merged" });
        if (loop.objectiveId) await this.repos.objectives.update(project.id, loop.objectiveId, { workflowStage: "merged", status: "succeeded", stopReason: "merged", finishedAt: new Date().toISOString() });
      }
      if (loop.phase === "reflecting" && await this.repos.development.retrospectives.get(project.id, loop.id)) {
        await finalizeRetrospective(this.repos, project, loop);
        return;
      }
      const roundLimit = Number((await this.repos.settings.get(`development-round-limit:${loop.id}`))?.maxRounds ?? 24);
      if (loop.rounds >= roundLimit && !loop.currentJobId && loop.phase !== "reflecting") {
        await this.repos.development.update(project.id, loop.id, { status: "waiting_input", summary: "Loop reached the retry limit. Review progress and resume or cancel." });
        return;
      }
      let job = loop.currentJobId ? await this.repos.agentJobs.get(project.id, loop.currentJobId) : await queueDevelopmentJob(this.repos, loop);
      if (!job) throw new Error("The current Loop job is missing.");
      if (job.status === "queued" || job.status === "waiting_provider") {
        await this.worker.tick(job.id, project.id);
        if (this.stopped) return;
        job = (await this.repos.agentJobs.get(project.id, job.id))!;
      }
      const current = (await this.repos.development.get(project.id, loop.id))!;
      if (["paused", "canceled"].includes(current.status)) return;
      if (job.status === "succeeded") await this.afterSuccess(project, current, job);
      else if (job.status === "failed") await this.afterFailure(current, job);
      else if (job.status === "waiting_human") await this.repos.development.update(project.id, loop.id, { status: "waiting_input", summary: String(job.output?.message ?? "Input required.") });
      else if (job.status === "waiting_provider") await this.repos.development.update(project.id, loop.id, { status: "waiting_capacity", summary: String(job.output?.message ?? "Waiting for Codex capacity.") });
      else if (job.status === "paused" || job.status === "canceled") await this.repos.development.update(project.id, loop.id, { status: job.status });
    } catch (error) {
      const summary = error instanceof Error ? error.message : "Loop execution failed.";
      const current = await this.repos.development.get(project.id, loop.id);
      if (!this.stopped && current && !["paused", "canceled", "succeeded"].includes(current.status)) {
        await this.repos.development.update(project.id, loop.id, { status: "failed", summary });
        await this.repos.activities.create({ projectId: project.id, targetType: "issue", targetId: loop.issueId, activityType: "error", title: "Loop stopped", body: summary });
      }
    }
  }

  private async afterSuccess(project: ProjectDto, loop: DevelopmentLoopDto, job: AgentJobDto): Promise<void> {
    const result = job.output as AgentRunResult | null;
    if (job.agentType === "retrospective") {
      await finalizeRetrospective(this.repos, project, loop, job);
      return;
    }
    if (job.agentType === "verifier") {
      await this.repos.development.update(project.id, loop.id, { phase: "merging", status: "running", summary: result?.message ?? "Verification passed." });
      return;
    }
    let next: AgentType;
    if (job.agentType === "requirements") next = "implementation";
    else if (job.agentType === "implementation") {
      if (!loop.pullRequestId) throw new Error("Implementation completed without a pull request.");
      next = "review";
    } else if (job.agentType === "fix") next = "review";
    else if (job.agentType === "review") {
      const verdict = result?.metadata?.review?.verdict;
      if (verdict !== "approved" && verdict !== "changes_requested") throw new Error("Review did not return a verdict.");
      next = verdict === "approved" ? "qa" : "fix";
    } else {
      const verdict = result?.metadata?.qa?.verdict;
      if (verdict !== "passed" && verdict !== "defects_found") throw new Error("QA did not return a verdict.");
      next = verdict === "passed" ? "verifier" : "fix";
    }
    await this.repos.development.update(project.id, loop.id, { nextAgent: next, phase: phaseForAgent(next), currentJobId: null, status: "running", failures: 0, summary: result?.message ?? "Step completed." });
  }

  private async afterFailure(loop: DevelopmentLoopDto, job: AgentJobDto): Promise<void> {
    const message = job.error ?? String(job.output?.message ?? "Job failed.");
    // Infrastructure failures are not evidence that a more capable model is needed.
    const infrastructure = /login|authenticat|connection|timed out|quota|rate.limit|model.*(unavailable|not found|not supported)|permission|ENOENT/i.test(message);
    if (!infrastructure && loop.failures < 2 && loop.phase !== "reflecting") {
      if (loop.objectiveId) await this.repos.objectives.update(loop.projectId, loop.objectiveId, { status: "running", repeatedFailureCount: 0, stopReason: null });
      await this.repos.development.update(loop.projectId, loop.id, { currentJobId: null, failures: loop.failures + 1, status: "running", summary: `Retrying after: ${message}` });
    } else await this.repos.development.update(loop.projectId, loop.id, { status: "failed", summary: message });
  }

  private async merge(project: ProjectDto, loop: DevelopmentLoopDto): Promise<void> {
    if (!loop.pullRequestId) throw new Error("Loop has no pull request to merge.");
    const pr = await this.repos.pullRequests.get(project.id, loop.pullRequestId);
    if (!pr) throw new Error("Pull request was not found.");
    let recoveredCommit = loop.mergeCommit;
    if (!recoveredCommit && loop.sourceCommit && loop.targetCommit) {
      const log = (await exec("git", ["log", "--format=%H %P", "--first-parent", `${loop.targetCommit}..${pr.targetBranch}`], { cwd: project.repoPath })).stdout;
      recoveredCommit = log.split("\n").map((line) => line.split(" ")).find(([, parent, source]) => parent === loop.targetCommit && source === loop.sourceCommit)?.[0] ?? null;
    }
    if (recoveredCommit) {
      if (pr.status !== "merged") await this.repos.pullRequests.update(project.id, pr.id, { status: "merged" });
      await this.repos.issues.update(project.id, loop.issueId, { status: "closed" });
      await this.repos.development.update(project.id, loop.id, { mergeCommit: recoveredCommit, phase: "reflecting", nextAgent: "retrospective", currentJobId: null, status: "running", summary: "Merged. Preparing retrospective." });
      return;
    }
    if (pr.status === "merged") throw new Error("The merge commit could not be verified. The PR remains merged; inspect its history before retrying retrospective.");
    const verifier = loop.currentJobId ? await this.repos.agentJobs.get(project.id, loop.currentJobId) : null;
    if (!verifier) throw new Error("Verifier record is missing.");
    const result = await mergePullRequest(this.repos, { project, pullRequest: pr, mode: "automatic", verifierJob: verifier });
    if (result.state === "merged") {
      await this.repos.development.update(project.id, loop.id, { mergeCommit: result.mergeCommit, phase: "reflecting", nextAgent: "retrospective", currentJobId: null, status: "running", summary: "Merged. Preparing retrospective." });
    } else if (result.state === "requeued") {
      await this.repos.development.update(project.id, loop.id, { phase: "validating", nextAgent: "verifier", currentJobId: result.verifierJob.id, status: "running", summary: result.reason });
    } else if ((await this.repos.pullRequests.get(project.id, pr.id))?.labels.some((label) => label.name === "resolving-conflicts")) {
      await this.repos.development.update(project.id, loop.id, { nextAgent: "fix", phase: "fixing", currentJobId: null, sourceCommit: null, targetCommit: null, status: "running", summary: result.reason });
    } else {
      await this.repos.development.update(project.id, loop.id, { status: "waiting_input", summary: result.reason });
    }
  }
}
