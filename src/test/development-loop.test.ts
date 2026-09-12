import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { createDatabaseContext } from "../server/db/client";
import { runMigrations } from "../server/db/migrations";
import { createRepositories } from "../server/db/repositories";
import { ensureDevelopmentLoop } from "../server/services/development-loop";
import { LoopEngine } from "../server/services/loop-engine";
import { ensureKnowledgeFiles, knowledgeHash, readKnowledgeBody } from "../server/services/knowledge-files";
import type { AgentAdapter } from "../server/agents/types";
import { selectTaskModel } from "../server/agents/model-router";
import type { CodexModel } from "../server/agents/codex-rpc";

const exec = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

it("merges two loops in sequence, edits knowledge, and supplies that knowledge to the next task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oneteam-new-loop-"));
  const git = async (...args: string[]) => (await exec("git", args, { cwd: dir })).stdout.trim();
  await git("init", "-b", "main");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  await writeFile(join(dir, "README.md"), "Example\n");
  await git("add", "."); await git("commit", "-m", "initial");
  const context = createDatabaseContext(`file:${join(dir, ".oneteam/data/oneteam.db")}`);
  cleanups.push(async () => { context.client.close(); await rm(dir, { recursive: true, force: true }); });
  await runMigrations(context.client);
  const repos = createRepositories(context.db);
  const project = await repos.projects.create({ name: "Example", repoPath: dir, defaultBranch: "main" });
  await ensureKnowledgeFiles(dir);
  const first = await repos.issues.create({ projectId: project.id, title: "First feature" });
  const second = await repos.issues.create({ projectId: project.id, title: "Second feature" });
  const loopA = await ensureDevelopmentLoop(repos, project.id, first.id);
  const loopB = await ensureDevelopmentLoop(repos, project.id, second.id);
  let readLearnedKnowledge = false;
  const calls: number[] = [];
  const adapter: AgentAdapter = { async run({ job, repoPath, prompt }) {
    calls.push(Number(job.input.developmentLoopId));
    const success = { status: "succeeded" as const, message: `${job.agentType} completed`, stopReason: "passed" as const };
    if (job.input.developmentLoopId === loopB.id && job.agentType === "requirements") readLearnedKnowledge = prompt.includes("Check fixtures before editing a feature.");
    if (job.agentType === "requirements") return { ...success, metadata: { goalContract: { evidenceRequired: [{ type: "file_change", required: true, commitScope: "source", maxAgeHours: 24 }] } } };
    if (job.agentType === "implementation") {
      await writeFile(join(repoPath, `feature-${job.targetId}.txt`), "Implemented\n");
      const branch = (await exec("git", ["branch", "--show-current"], { cwd: repoPath })).stdout.trim();
      return { ...success, metadata: { pullRequest: { title: "Feature", sourceBranch: branch, targetBranch: "main", issueId: job.targetId } } };
    }
    if (job.agentType === "review") return { ...success, metadata: { review: { verdict: "approved", findings: [], checked: ["diff"] } } };
    if (job.agentType === "qa") return { ...success, metadata: { qa: { verdict: "passed", defects: [], observations: [] } } };
    if (job.agentType === "verifier") return { ...success, metadata: { verifier: { verdict: "passed", stopConditionMet: true, missingEvidence: [], notes: [] } } };
    if (job.agentType === "retrospective") return { ...success, metadata: { retrospective: { body: `Job review confirmed the feature. Evidence: Issue #${job.input.developmentLoopId === loopA.id ? first.id : second.id}.`, changes: job.input.developmentLoopId === loopA.id ? [{ path: "AGENTS.md", beforeHash: knowledgeHash(await readKnowledgeBody(dir, "AGENTS.md")), body: "# Project knowledge\n\nCheck fixtures before editing a feature.\n", reason: `Learned from Loop #${loopA.id}.` }] : [] } } };
    throw new Error(`Unexpected role ${job.agentType}`);
  } };
  const engine = new LoopEngine(repos, adapter);
  for (let step = 0; step < 24; step += 1) await engine.tick();
  const completed = await repos.development.list(project.id);
  expect(completed.map(({ id, status, phase, summary }) => ({ id, status, phase, summary }))).toEqual([
    expect.objectContaining({ id: loopB.id, status: "succeeded", phase: "completed" }),
    expect.objectContaining({ id: loopA.id, status: "succeeded", phase: "completed" })
  ]);
  expect(readLearnedKnowledge).toBe(true);
  expect(calls).toEqual([...Array(6).fill(loopA.id), ...Array(6).fill(loopB.id)]);
  expect(await readFile(join(dir, `feature-${first.id}.txt`), "utf8")).toBe("Implemented\n");
  expect(await readFile(join(dir, `feature-${second.id}.txt`), "utf8")).toBe("Implemented\n");
  expect((await repos.development.revisions.list(project.id, loopA.id)).filter((revision) => revision.path === "AGENTS.md")).toHaveLength(1);
  expect((await repos.issues.get(project.id, first.id))?.status).toBe("closed");
  expect(await git("status", "--porcelain")).toBe("");
}, 30_000);

it("routes by task complexity and escalates quality failures within the available catalog", () => {
  const models: CodexModel[] = ["gpt-5.4-mini", "gpt-5.4", "gpt-5.5"].map((model) => ({ model, id: model, displayName: model, hidden: false, isDefault: model === "gpt-5.5", defaultReasoningEffort: "low", supportedReasoningEfforts: ["low", "medium", "high"].map((reasoningEffort) => ({ reasoningEffort })) }));
  expect(selectTaskModel(models, { text: "Fix a README typo", role: "implementation", fileCount: 1, qualityFailures: 0 }).model).toBe("gpt-5.4-mini");
  expect(selectTaskModel(models, { text: "Add a filter", role: "implementation", fileCount: 3, qualityFailures: 0 }).model).toBe("gpt-5.4");
  expect(selectTaskModel(models, { text: "認証の設計変更", role: "implementation", fileCount: 3, qualityFailures: 0 }).model).toBe("gpt-5.5");
  expect(selectTaskModel(models, { text: "Fix a README typo", role: "implementation", fileCount: 1, qualityFailures: 1 }).model).toBe("gpt-5.5");
  expect(selectTaskModel([models[1]], { text: "migration", role: "review", fileCount: 10, qualityFailures: 0 })).toMatchObject({ model: "gpt-5.4", effort: "high" });
});
