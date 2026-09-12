import { readFile, writeFile, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { developmentFixture } from "./development-fixture";
import { ensureDevelopmentLoop } from "../server/services/development-loop";
import { finalizeRetrospective } from "../server/services/retrospective";
import { knowledgeHash, readKnowledgeBody, replaceKnowledgeBody } from "../server/services/knowledge-files";
import { LoopEngine } from "../server/services/loop-engine";
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture() { const value = await developmentFixture(); cleanups.push(value.cleanup); return value; }

it("recovers the actual merge commit after a crash and completes retrospective only once", async () => {
  const { repos, project, dir, git } = await fixture();
  const issue = await repos.issues.create({ projectId: project.id, title: "Recover merge" });
  const created = await ensureDevelopmentLoop(repos, project.id, issue.id);
  const target = await git("rev-parse", "HEAD");
  await git("checkout", "-b", "feature"); await writeFile(join(dir, "feature.txt"), "done\n"); await git("add", "."); await git("commit", "-m", "feature");
  const source = await git("rev-parse", "HEAD"); await git("checkout", "main"); await git("merge", "--no-ff", "feature", "-m", "Merge feature");
  const merged = await git("rev-parse", "HEAD");
  const pr = await repos.pullRequests.create({ projectId: project.id, issueId: issue.id, title: "Feature", sourceBranch: "feature", targetBranch: "main" });
  await repos.development.update(project.id, created.id, { phase: "merging", status: "running", pullRequestId: pr.id, sourceCommit: source, targetCommit: target });
  let calls = 0;
  const engine = new LoopEngine(repos, { async run({ job }) { calls++; expect(job.agentType).toBe("retrospective"); return { status: "succeeded", message: "Recovered", metadata: { retrospective: { body: "The fixture merge was recovered; no new lesson.", changes: [] } } }; } });
  await engine.tick(); expect(await repos.development.get(project.id, created.id)).toMatchObject({ mergeCommit: merged, phase: "reflecting" });
  expect(await repos.issues.get(project.id, issue.id)).toMatchObject({ status: "closed" });
  await engine.tick(); await engine.tick(); await engine.tick();
  expect(calls).toBe(1); expect(await repos.development.get(project.id, created.id)).toMatchObject({ phase: "completed", status: "succeeded" });
  expect(await repos.development.revisions.list(project.id, created.id)).toHaveLength(1);
});

it("preflights every change, preserves concurrent user edits and replays a partial journal", async () => {
  const { repos, project, dir, git } = await fixture();
  const issue = await repos.issues.create({ projectId: project.id, title: "Learn" });
  const loop = await repos.development.update(project.id, (await ensureDevelopmentLoop(repos, project.id, issue.id)).id, { phase: "reflecting", status: "running", mergeCommit: await git("rev-parse", "HEAD") });
  const before = await readKnowledgeBody(dir, "AGENTS.md");
  await repos.development.retrospectives.create({ projectId: project.id, loopId: loop.id, mergeCommit: loop.mergeCommit!, summary: "Learning", body: "Evidence from fixture tests.", changes: [
    { path: "knowledge/testing.md", beforeHash: null, body: "Test the observed behavior.\n", reason: "Tests caught recovery defects." },
    { path: "AGENTS.md", beforeHash: knowledgeHash(before), body: "# Knowledge\nRead knowledge/testing.md.\n", reason: "Index the testing lesson." }
  ] });
  await writeFile(join(dir, ".oneteam/AGENTS.md"), "User changed these instructions.");
  await expect(finalizeRetrospective(repos, project, loop)).rejects.toThrow("changed since");
  expect(await readKnowledgeBody(dir, "knowledge/testing.md")).toBeNull();
  expect(await readKnowledgeBody(dir, "AGENTS.md")).toBe("User changed these instructions.");
  await replaceKnowledgeBody(dir, "AGENTS.md", before);
  // Simulate the first journaled file reaching disk before its applied flag was saved.
  await repos.development.revisions.create({ projectId: project.id, loopId: loop.id, path: "knowledge/testing.md", beforeBody: null, afterBody: "Test the observed behavior.\n", reason: "Tests caught recovery defects.", status: "pending" });
  await replaceKnowledgeBody(dir, "knowledge/testing.md", "Test the observed behavior.\n");
  await finalizeRetrospective(repos, project, loop); await finalizeRetrospective(repos, project, loop);
  expect(await repos.development.revisions.list(project.id, loop.id)).toHaveLength(3);
  expect((await repos.development.revisions.list(project.id, loop.id)).every((revision) => revision.status === "applied")).toBe(true);
  expect(await repos.development.retrospectives.get(project.id, loop.id)).toMatchObject({ status: "applied", error: null });
  expect(await readFile(join(dir, `.oneteam/retrospectives/loop-${loop.id}.md`), "utf8")).toContain(loop.mergeCommit);
});

it("rejects path traversal and symlinks without writing outside knowledge", async () => {
  const { dir } = await fixture();
  await expect(replaceKnowledgeBody(dir, "../README.md", "bad")).rejects.toThrow("must target");
  await expect(replaceKnowledgeBody(dir, "knowledge/../../README.md", "bad")).rejects.toThrow("must target");
  await mkdir(join(dir, ".oneteam/knowledge")); await symlink(join(dir, "README.md"), join(dir, ".oneteam/knowledge/link.md"));
  await expect(replaceKnowledgeBody(dir, "knowledge/link.md", "bad")).rejects.toThrow("symlink");
  expect(await readFile(join(dir, "README.md"), "utf8")).toBe("Example\n");
});

it("restores applied knowledge with an audit record and refuses to overwrite later edits", async () => {
  const { restoreKnowledgeRevision } = await import("../server/services/retrospective");
  const { repos, project, dir, git } = await fixture();
  const issue = await repos.issues.create({ projectId: project.id, title: "Restore knowledge" });
  const loop = await repos.development.update(project.id, (await ensureDevelopmentLoop(repos, project.id, issue.id)).id, { phase: "reflecting", status: "running", mergeCommit: await git("rev-parse", "HEAD") });
  const before = await readKnowledgeBody(dir, "AGENTS.md");
  await repos.development.retrospectives.create({ projectId: project.id, loopId: loop.id, mergeCommit: loop.mergeCommit!, summary: "Lesson", body: "Evidence from tests.", changes: [{ path: "AGENTS.md", beforeHash: knowledgeHash(before), body: "# A lesson\n", reason: "Fixture" }] });
  await finalizeRetrospective(repos, project, loop);
  const revision = (await repos.development.revisions.list(project.id, loop.id)).find((item) => item.path === "AGENTS.md")!;
  await replaceKnowledgeBody(dir, "AGENTS.md", "Later user edit");
  await expect(restoreKnowledgeRevision(repos, project, revision.id)).rejects.toThrow("edited after");
  await replaceKnowledgeBody(dir, "AGENTS.md", revision.afterBody);
  await restoreKnowledgeRevision(repos, project, revision.id); await restoreKnowledgeRevision(repos, project, revision.id);
  expect(await readKnowledgeBody(dir, "AGENTS.md")).toBe(before);
  expect((await repos.development.revisions.list(project.id, loop.id)).find((item) => item.id === revision.id)?.status).toBe("restored");
  expect((await repos.activities.list(project.id, "issue", issue.id)).filter((item) => item.title === "Knowledge revision restored")).toHaveLength(1);
});
