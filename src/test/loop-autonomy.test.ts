import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AgentWorker } from "../server/agents/worker";
import type { AgentAdapter, AgentRunResult } from "../server/agents/types";
import { ensureDevelopmentLoop, queueDevelopmentJob } from "../server/services/development-loop";
import { LoopEngine } from "../server/services/loop-engine";
import { developmentFixture } from "./development-fixture";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
const success = { status: "succeeded", message: "Step completed", stopReason: "passed" } as const;
const waiting: AgentRunResult = { status: "waiting_human", message: "Please confirm I should continue.", questions: ["Continue?"], stopReason: "waiting_human" };

it("continues routine decisions in the same worktree and repairs missing verification before a real merge", async () => {
  const f = await developmentFixture(); cleanups.push(f.cleanup);
  const issue = await f.repos.issues.create({ projectId: f.project.id, title: "Add a bounded feature" });
  const loop = await ensureDevelopmentLoop(f.repos, f.project.id, issue.id);
  const calls: Record<string, number> = {};
  let implementationPath = "";
  let fixSawFailure = false;
  const adapter: AgentAdapter = { async run({ job, repoPath, prompt }) {
    calls[job.agentType] = (calls[job.agentType] ?? 0) + 1;
    if (job.agentType === "requirements") {
      if (calls.requirements === 1) return waiting;
      expect(prompt).toContain("Reassess it using the current worktree");
      return { ...success, metadata: { goalContract: { evidenceRequired: [{ type: "file_change", required: true, commitScope: "source", maxAgeHours: 24 }] } } };
    }
    if (job.agentType === "implementation") {
      if (calls.implementation === 1) {
        implementationPath = repoPath;
        await writeFile(join(repoPath, "feature.txt"), "partial implementation\n");
        return waiting;
      }
      expect(repoPath).toBe(implementationPath);
      expect(await readFile(join(repoPath, "feature.txt"), "utf8")).toBe("partial implementation\n");
      await writeFile(join(repoPath, "feature.txt"), "complete implementation\n");
      const branch = (await promisify(execFile)("git", ["branch", "--show-current"], { cwd: repoPath })).stdout.trim();
      return { ...success, metadata: { pullRequest: { title: "Bounded feature", sourceBranch: branch, targetBranch: "main", issueId: job.targetId } } };
    }
    if (job.agentType === "review") return { ...success, metadata: { review: { verdict: "approved", findings: [] } } };
    if (job.agentType === "qa") return { ...success, metadata: { qa: { verdict: "passed", defects: [] } } };
    if (job.agentType === "verifier") return calls.verifier === 1
      ? { ...success, message: "Verification is incomplete", metadata: { verifier: { verdict: "missing_evidence", stopConditionMet: false, missingEvidence: ["Feature assertion"] } } }
      : { ...success, metadata: { verifier: { verdict: "passed", stopConditionMet: true, missingEvidence: [] } } };
    if (job.agentType === "fix") {
      fixSawFailure = prompt.includes("Verification is incomplete") && prompt.includes("Verifier cannot mark");
      await writeFile(join(repoPath, "feature.txt"), "verified implementation\n");
      return { ...success, evidence: [{ type: "file_change", title: "Verified feature implementation", summary: "The current source contains the verified implementation." }], metadata: { fix: { resolvedFindings: ["Added the missing feature assertion"] } } };
    }
    if (job.agentType === "retrospective") return { ...success, metadata: { retrospective: { body: "Routine confirmation was resolved automatically; verification was repaired before merging.", changes: [] } } };
    throw new Error(job.agentType);
  } };
  const engine = new LoopEngine(f.repos, adapter);
  for (let step = 0; step < 16; step++) await engine.tick();
  expect(await f.repos.development.get(f.project.id, loop.id)).toMatchObject({ status: "succeeded", phase: "completed", mergeCommit: expect.any(String) });
  expect(await readFile(join(f.dir, "feature.txt"), "utf8")).toBe("verified implementation\n");
  const jobs = await f.repos.agentJobs.list({ projectId: f.project.id });
  expect(jobs.some((job) => job.status === "waiting_human")).toBe(false);
  expect(jobs.find((job) => job.agentType === "verifier" && job.status === "failed")?.output).toMatchObject({ questions: null, metadata: { automaticRepair: true } });
  expect(calls).toMatchObject({ requirements: 2, implementation: 2, verifier: 2, fix: 1 });
  expect(fixSawFailure).toBe(true);
  expect((await f.repos.activities.list(f.project.id, "issue", issue.id)).filter((activity) => activity.title === "Automatic continuation")).toHaveLength(2);
}, 30000);

it("waits immediately when essential external access really requires the user", async () => {
  const f = await developmentFixture(); cleanups.push(f.cleanup);
  const issue = await f.repos.issues.create({ projectId: f.project.id, title: "Integrate the private service" });
  const loop = await ensureDevelopmentLoop(f.repos, f.project.id, issue.id);
  const run = vi.fn(async (): Promise<AgentRunResult> => ({ ...waiting, message: "Private service access is unavailable", questions: ["Configure the service account and resume."],
    metadata: { humanHandoff: { reason: "external_access", blocker: "The endpoint returns 401", attemptedResolution: "Read repository configuration and tried the existing credential.", whyHumanRequired: "Only the account owner can grant this service access." } } }));
  const engine = new LoopEngine(f.repos, { run });
  await engine.tick(); await engine.tick();
  expect(run).toHaveBeenCalledTimes(1);
  expect(await f.repos.development.get(f.project.id, loop.id)).toMatchObject({ status: "waiting_input" });
  expect((await f.repos.agentJobs.list({ projectId: f.project.id }))[0]).toMatchObject({ status: "waiting_human", output: { metadata: { humanHandoff: { reason: "external_access" } } } });
});

it("bounds unsupported handoff attempts without silently succeeding or asking routine questions", async () => {
  const f = await developmentFixture(); cleanups.push(f.cleanup);
  const issue = await f.repos.issues.create({ projectId: f.project.id, title: "Use existing conventions" });
  const loop = await ensureDevelopmentLoop(f.repos, f.project.id, issue.id);
  const run = vi.fn(async () => waiting);
  const engine = new LoopEngine(f.repos, { run });
  for (let step = 0; step < 6; step++) await engine.tick();
  expect(run).toHaveBeenCalledTimes(6);
  expect(await f.repos.development.get(f.project.id, loop.id)).toMatchObject({ status: "failed", rounds: 3 });
  expect((await f.repos.agentJobs.list({ projectId: f.project.id })).every((job) => job.status === "failed")).toBe(true);
});

it("preserves explicit pauses and does not start a continuation", async () => {
  const f = await developmentFixture(); cleanups.push(f.cleanup);
  const issue = await f.repos.issues.create({ projectId: f.project.id, title: "Pause current work" });
  const loop = await ensureDevelopmentLoop(f.repos, f.project.id, issue.id);
  const job = await queueDevelopmentJob(f.repos, loop);
  const run = vi.fn(async () => { await f.repos.agentJobs.pause(f.project.id, job.id); return waiting; });
  await new AgentWorker(f.repos, { run }, { pollIntervalMs: 1000 }).tick(job.id, f.project.id);
  expect(run).toHaveBeenCalledTimes(1);
  expect(await f.repos.agentJobs.get(f.project.id, job.id)).toMatchObject({ status: "paused" });
});

it("keeps a managed execution deadline as bounded retryable failure rather than a routine human question", async () => {
  const f = await developmentFixture(); cleanups.push(f.cleanup);
  const issue = await f.repos.issues.create({ projectId: f.project.id, title: "Long execution" });
  const loop = await ensureDevelopmentLoop(f.repos, f.project.id, issue.id);
  const job = await queueDevelopmentJob(f.repos, loop);
  const now = Date.now();
  const run = vi.fn(async () => { vi.spyOn(Date, "now").mockReturnValue(now + 31 * 60000); return success; });
  await new AgentWorker(f.repos, { run }, { pollIntervalMs: 1000 }).tick(job.id, f.project.id);
  expect(run).toHaveBeenCalledTimes(1);
  expect(await f.repos.agentJobs.get(f.project.id, job.id)).toMatchObject({ status: "failed", output: { stopReason: "timeout", questions: null, metadata: { worktreeRetention: { action: "retain" } } } });
});
