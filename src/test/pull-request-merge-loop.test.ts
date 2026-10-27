import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createApp } from "../server/app";
import { controlDevelopmentLoop, ensureDevelopmentLoop } from "../server/services/development-loop";
import { LoopEngine } from "../server/services/loop-engine";
import { mergePullRequest } from "../server/services/pull-request-merge";
import { cleanupWorktree } from "../server/services/worktree-service";
import { developmentFixture } from "./development-fixture";
import { fakeDevelopmentAdapter } from "./fake-development-adapter";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function verifiedPullRequest() {
  const fixture = await developmentFixture();
  const { repos, project, git, dir } = fixture;
  const engine = new LoopEngine(repos, fakeDevelopmentAdapter(repos));
  cleanups.push(async () => {
    await engine.stopAndDrain();
    for (const line of (await git("worktree", "list", "--porcelain")).split("\n")) {
      if (line.startsWith("worktree ") && line.slice(9) !== dir) await cleanupWorktree(project, line.slice(9));
    }
    await fixture.cleanup();
  });
  const issue = await repos.issues.create({ projectId: project.id, title: "Add a feature" });
  const loop = await ensureDevelopmentLoop(repos, project.id, issue.id);
  for (let step = 0; step < 5; step++) await engine.tick();
  const current = (await repos.development.get(project.id, loop.id))!;
  expect(current).toMatchObject({ phase: "merging", status: "running" });
  const pullRequest = (await repos.pullRequests.get(project.id, current.pullRequestId!))!;
  const verifier = (await repos.agentJobs.get(project.id, current.currentJobId!))!;
  expect(verifier).toMatchObject({ agentType: "verifier", status: "succeeded" });
  const needsInput = (await repos.labels.findByName(project.id, "needs-input"))!;
  await repos.pullRequests.update(project.id, pullRequest.id, { labelIds: [needsInput.id] });
  const blocked = await repos.development.update(project.id, loop.id, { status: "waiting_input", summary: "The pull request is not marked ready-to-merge." });
  return { ...fixture, engine, loop: blocked, pullRequest, verifier, issue, app: createApp({ repos }),
    mergeUrl: `/api/projects/${project.id}/pull-requests/${pullRequest.id}/merge` };
}

it("merges a verified managed PR through the button API despite stale workflow labels", async () => {
  const { repos, project, engine, loop, pullRequest, app, mergeUrl, git } = await verifiedPullRequest();
  const response = await app.request(mergeUrl, { method: "POST" });
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ queued: true });
  await engine.tick();
  expect(await repos.pullRequests.get(project.id, pullRequest.id)).toMatchObject({ status: "merged" });
  expect(await repos.development.get(project.id, loop.id)).toMatchObject({ phase: "reflecting", status: "running" });
  expect(await git("show", "main:feature-1.txt")).toBe("Implemented");
});

it.each(["canceled", "succeeded"] as const)("allows manual merge after a %s Loop without restarting it", async (status) => {
  const { repos, project, engine, loop, pullRequest, app, mergeUrl, git } = await verifiedPullRequest();
  const ended = status === "canceled"
    ? await controlDevelopmentLoop(repos, loop, "cancel")
    : await repos.development.update(project.id, loop.id, { status, finishedAt: new Date().toISOString() });
  const response = await app.request(mergeUrl, { method: "POST" });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ pullRequest: { status: "merged" }, mergeCommit: expect.stringMatching(/^[a-f0-9]{40}$/) });
  expect(await git("show", "main:feature-1.txt")).toBe("Implemented");
  await engine.tick();
  expect(await repos.development.get(project.id, loop.id)).toMatchObject({ status, phase: ended.phase, finishedAt: ended.finishedAt });
  expect(await repos.development.retrospectives.get(project.id, loop.id)).toBeNull();
  expect(await repos.pullRequests.get(project.id, pullRequest.id)).toMatchObject({ status: "merged" });
});

it("retains conflict checks when manually merging a canceled Loop's PR", async () => {
  const { repos, project, dir, git, loop, pullRequest, app, mergeUrl } = await verifiedPullRequest();
  await controlDevelopmentLoop(repos, loop, "cancel");
  await writeFile(join(dir, "feature-1.txt"), "Conflicting target content\n");
  await git("add", "feature-1.txt"); await git("commit", "-m", "conflicting target change");
  const targetHead = await git("rev-parse", "main");
  const response = await app.request(mergeUrl, { method: "POST" });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { message: expect.stringContaining("Merge conflicts detected") } });
  expect(await git("rev-parse", "main")).toBe(targetHead);
  expect(await repos.pullRequests.get(project.id, pullRequest.id)).toMatchObject({ status: "open" });
  expect(await repos.development.get(project.id, loop.id)).toMatchObject({ status: "canceled" });
});

it("does not queue a managed merge without successful verification", async () => {
  const { repos, project, loop, verifier, app, mergeUrl, git } = await verifiedPullRequest();
  await repos.agentJobs.updateStatus(project.id, verifier.id, "failed", { error: "Verification failed" });
  const targetHead = await git("rev-parse", "main");
  const response = await app.request(mergeUrl, { method: "POST" });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { message: "Complete verification before merging this Loop." } });
  expect(await git("rev-parse", "main")).toBe(targetHead);
  expect((await repos.development.get(project.id, loop.id))?.mergeCommit).toBeNull();
});

it("does not automatically merge a canceled Loop", async () => {
  const { repos, project, loop, pullRequest, verifier } = await verifiedPullRequest();
  await controlDevelopmentLoop(repos, loop, "cancel");
  expect(await mergePullRequest(repos, { project, pullRequest, mode: "automatic", verifierJob: verifier })).toMatchObject({ state: "skipped" });
  expect(await repos.pullRequests.get(project.id, pullRequest.id)).toMatchObject({ status: "open" });
});

it("still runs required commands before merging a managed PR with stale labels", async () => {
  const { repos, project, loop, pullRequest, engine, git, app, mergeUrl } = await verifiedPullRequest();
  await repos.commands.upsertMany(project.id, [{ commandType: "test", command: "exit 1", isRequired: true, isAvailable: true, detectionSource: "manual" }]);
  const targetHead = await git("rev-parse", "main");
  expect((await app.request(mergeUrl, { method: "POST" })).status).toBe(202);
  await engine.tick();
  expect(await repos.development.get(project.id, loop.id)).toMatchObject({ status: "waiting_input", summary: expect.stringContaining("Required commands failed") });
  expect(await repos.pullRequests.get(project.id, pullRequest.id)).toMatchObject({ status: "open" });
  expect(await git("rev-parse", "main")).toBe(targetHead);
});
