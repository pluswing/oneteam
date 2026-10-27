import { randomUUID } from "node:crypto";
import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createApp } from "../server/app";
import type { CodexRpc } from "../server/agents/codex-rpc";
import { createModelSelector } from "../server/agents/model-router";
import { createDatabaseContext } from "../server/db/client";
import { createRepositories } from "../server/db/repositories";
import { ChatService } from "../server/services/chat-service";
import type { ChatRunner, ChatTurnInput } from "../server/services/chat-codex";
import { validateChatRequest } from "../server/services/chat-tools";
import { ensureDevelopmentLoop } from "../server/services/development-loop";
import { trackJobWork } from "../server/services/job-execution-state";
import { developmentFixture } from "./development-fixture";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const catalog = ["gpt-5.6-sol", "gpt-6.1-sol"].map((model, index) => ({ id: model, model, displayName: model, hidden: false, isDefault: index === 0,
  defaultReasoningEffort: "medium", supportedReasoningEfforts: ["low", "medium", "high"].map((reasoningEffort) => ({ reasoningEffort })) }));
async function setup(runner: ChatRunner = async () => ({ text: "Done", model: "gpt-6.1-sol" })) {
  const fixture = await developmentFixture();
  const chats = new ChatService(fixture.repos, { command: "unused", runner,
    createRpc: () => ({ async initialize() {}, async closeAndDrain() {}, async request() { return { data: catalog, nextCursor: null }; } }) as unknown as CodexRpc });
  const app = createApp({ repos: fixture.repos, chats });
  cleanups.push(async () => { await chats.stopAndDrain(); await fixture.cleanup(); });
  const base = `/api/projects/${fixture.project.id}`;
  const request = async (path: string, method = "GET", body?: unknown) => app.request(`${base}${path}`, {
    method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const conversation = await fixture.repos.chats.create(fixture.project.id, "Test chat");
  return { ...fixture, chats, app, base, request, conversation };
}
async function waitForChat(chats: ChatService, projectId: string, id: string) {
  await expect.poll(async () => (await chats.detail(projectId, id))?.chat.status, { timeout: 3000, interval: 10 }).toBe("idle");
  return (await chats.detail(projectId, id))!;
}

it("stores independent histories and thread IDs, and restores them from the database", async () => {
  const inputs: ChatTurnInput[] = [];
  const { repos, chats, project, conversation, dir } = await setup(async (input) => {
    inputs.push(input); await input.onThread(`thread-${input.chat.id}`);
    return { text: `Reply to ${input.text}`, model: "gpt-6.1-sol" };
  });
  const second = await repos.chats.create(project.id, "Second chat");
  await chats.send(project.id, conversation.id, "Private context A"); await waitForChat(chats, project.id, conversation.id);
  await chats.send(project.id, second.id, "Independent B"); await waitForChat(chats, project.id, second.id);
  await chats.send(project.id, conversation.id, "Continue A"); await waitForChat(chats, project.id, conversation.id);
  expect(inputs[0].history).toEqual([]); expect(inputs[1].history).toEqual([]);
  expect(inputs[2].chat.threadId).toBe(`thread-${conversation.id}`);
  expect(inputs[2].history.map((message) => message.content)).toEqual(["Private context A", "Reply to Private context A"]);
  const persisted = createDatabaseContext(`file:${join(dir, ".oneteam/data/oneteam.db")}`);
  try {
    const otherRepos = createRepositories(persisted.db);
    expect(await otherRepos.chats.get(project.id, second.id)).toMatchObject({ threadId: `thread-${second.id}`, title: "Independent B" });
    expect((await otherRepos.chats.messages(project.id, conversation.id)).map((message) => message.content)).not.toContain("Independent B");
  } finally { persisted.client.close(); }
});

it("uses the real Issue API and records a duplicate tool call exactly once", async () => {
  const { chats, project, repos, conversation, base } = await setup(async (input) => {
    const help = await input.tool("oneteam_help", {}, "help") as { operations: Array<{ path: string; method: string }> };
    expect(help.operations).toContainEqual({ method: "POST", path: `${base}/issues` });
    const args = { method: "POST", path: `${base}/issues`, body: { title: "Chat-created Issue", body: "Acceptance criteria" } };
    const first = await input.tool("oneteam_request", args, "same-call");
    expect(await input.tool("oneteam_request", args, "same-call")).toEqual(first);
    return { text: "Created [Issue #1](/issues/1).", model: "gpt-6.1-sol" };
  });
  await chats.send(project.id, conversation.id, "Create the agreed Issue");
  const result = await waitForChat(chats, project.id, conversation.id);
  expect((await repos.issues.list({ projectId: project.id, limit: 50, offset: 0 })).items).toHaveLength(1);
  expect(await repos.development.forIssue(project.id, 1)).toMatchObject({ status: "queued" });
  expect(result.messages.filter((message) => message.role === "tool")).toHaveLength(1);
  expect(result.messages.find((message) => message.role === "tool")).toMatchObject({ status: "completed", metadata: { method: "POST", result: { status: 201, ok: true } } });
});

it("keeps completed actions after a response fails, without replaying them on recovery", async () => {
  const { chats, project, repos, conversation, base } = await setup(async (input) => {
    await input.tool("oneteam_request", { method: "POST", path: `${base}/issues`, body: { title: "Already created" } }, "create");
    throw new Error("Connection lost after the operation");
  });
  await chats.send(project.id, conversation.id, "Create an Issue");
  const result = await waitForChat(chats, project.id, conversation.id);
  expect(result.chat.error).toContain("Connection lost");
  expect(result.messages.find((message) => message.role === "tool")?.status).toBe("completed");
  await chats.recover();
  expect((await repos.issues.list({ projectId: project.id, limit: 50, offset: 0 })).items).toHaveLength(1);
});

it("lets a chat inspect and change only its own title and model settings", async () => {
  const { chats, repos, project, conversation } = await setup(async (input) => {
    input.onModel("gpt-5.6-sol");
    expect(await input.tool("oneteam_current_chat", {}, "read")).toMatchObject({ model: null, resolvedModel: "gpt-5.6-sol" });
    expect(await input.tool("oneteam_current_chat", { title: "Model discussion", model: "gpt-6.1-sol", effort: "high" }, "update"))
      .toMatchObject({ ok: true, appliesTo: "next_response", resolvedModel: "gpt-5.6-sol" });
    await expect(input.tool("oneteam_current_chat", { chatId: "another-chat", title: "Wrong" }, "invalid")).rejects.toThrow();
    return { text: "Changed the settings for the next response.", model: "gpt-5.6-sol" };
  });
  const other = await repos.chats.create(project.id, "Other conversation");
  await chats.send(project.id, conversation.id, "Change this chat's model"); await waitForChat(chats, project.id, conversation.id);
  expect(await repos.chats.get(project.id, conversation.id)).toMatchObject({ title: "Model discussion", model: "gpt-6.1-sol", effort: "high" });
  expect(await repos.chats.get(project.id, other.id)).toMatchObject({ title: "Other conversation", model: null });
});

it("rejects invented endpoints and direct PR status changes that bypass Git merge", async () => {
  const { chats, project, conversation, base } = await setup(async (input) => {
    const unknown = await input.tool("oneteam_request", { method: "GET", path: `${base}/invented-endpoint`, body: null }, "unknown");
    expect(unknown).toMatchObject({ ok: false, error: expect.stringContaining("Unknown OneTeam operation") });
    const bypass = await input.tool("oneteam_request", { method: "PATCH", path: `${base}/pull-requests/1`, body: { status: "merged" } }, "bypass");
    expect(bypass).toMatchObject({ ok: false, error: expect.stringContaining("verification and Git checks") });
    return { text: "No changes were made.", model: "gpt-6.1-sol" };
  });
  await chats.send(project.id, conversation.id, "Check operations");
  const result = await waitForChat(chats, project.id, conversation.id);
  expect(result.messages.filter((message) => message.role === "tool").map((message) => message.status)).toEqual(["failed", "failed"]);
});

it("rejects concurrent turns, deduplicates delivery retries and supports stopping a response", async () => {
  let starts = 0;
  const { chats, project, conversation, request } = await setup(async (input) => {
    starts++;
    await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
    throw new Error("Stopped");
  });
  const requestId = randomUUID();
  expect((await request(`/chats/${conversation.id}/messages`, "POST", { content: "Long request", requestId })).status).toBe(202);
  expect((await request(`/chats/${conversation.id}/messages`, "POST", { content: "Long request", requestId })).status).toBe(202);
  expect((await request(`/chats/${conversation.id}/messages`, "POST", { content: "Another request" })).status).toBe(409);
  expect((await request(`/chats/${conversation.id}`, "DELETE")).status).toBe(409);
  expect((await request(`/chats/${conversation.id}/stop`, "POST", {})).status).toBe(200);
  expect(starts).toBe(1);
  expect((await chats.detail(project.id, conversation.id))?.messages.map((message) => message.status)).toEqual(["completed", "canceled"]);
});

it("recovers interrupted conversations without starting any model or operation", async () => {
  let calls = 0;
  const { chats, repos, project, conversation } = await setup(async () => { calls++; return { text: "Unexpected", model: "unused" }; });
  await repos.chats.update(project.id, conversation.id, { status: "running" });
  await repos.chats.append(project.id, conversation.id, "assistant", "Partial response", "running");
  await chats.recover();
  expect(calls).toBe(0);
  expect(await chats.detail(project.id, conversation.id)).toMatchObject({ chat: { status: "idle", error: expect.stringContaining("interrupted") }, messages: [{ status: "failed", content: "Partial response" }] });
});

it("enforces project and conversation boundaries and rejects path escapes", async () => {
  const { request, base, project, repos, conversation } = await setup();
  for (const path of ["https://example.com", "//example.com", "/api/projects/another/issues", `${base}/chats/${conversation.id}`, `${base}/%63hats/${conversation.id}`, `${base}/%2e%2e/another/issues`, `${base}/repository\\file`]) {
    expect(() => validateChatRequest(project.id, { method: "GET", path, body: null }), path).toThrow();
  }
  const other = await repos.projects.create({ name: "Other", repoPath: "/another", defaultBranch: "main" });
  const hidden = await repos.chats.create(other.id, "Other conversation");
  expect((await request(`/chats/${hidden.id}`)).status).toBe(404);
  expect(validateChatRequest(project.id, { method: "GET", path: `${base}/issues?status=open`, body: null }).path).toBe(`${base}/issues?status=open`);
});

it("reads repository source files while keeping external files and workspace databases private", async () => {
  const { dir, request } = await setup();
  expect((await request("/repository/file?path=README.md")).status).toBe(200);
  expect((await request("/repository/file?path=.oneteam/data/oneteam.db")).status).toBe(400);
  expect((await request("/repository/file?path=../outside.txt")).status).toBe(400);
  await symlink("/etc/hosts", join(dir, "outside-link"));
  expect((await request("/repository/file?path=outside-link")).status).toBe(403);
});

it("applies project, role and Job model settings in order of specificity", async () => {
  const { request, project, repos, dir } = await setup();
  expect((await request("/model-settings", "PATCH", { model: "gpt-6.1-sol", effort: "high", roles: { implementation: { model: "gpt-5.6-sol", effort: "low" } } })).status).toBe(200);
  const issue = await repos.issues.create({ projectId: project.id, title: "Feature" });
  const job = await repos.agentJobs.create({ projectId: project.id, agentType: "implementation", targetType: "issue", targetId: issue.id, triggerType: "test" });
  const selector = createModelSelector(repos);
  expect(await selector(catalog, { job, repoPath: dir, prompt: "Implement" })).toMatchObject({ model: "gpt-5.6-sol", effort: "low" });
  expect((await request(`/agent-jobs/${job.id}/model`, "PATCH", { model: "gpt-6.1-sol", effort: "medium" })).status).toBe(200);
  const updated = (await repos.agentJobs.get(project.id, job.id))!;
  expect(await selector(catalog, { job: updated, repoPath: dir, prompt: "Implement" })).toMatchObject({ model: "gpt-6.1-sol", effort: "medium" });
  expect((await request(`/agent-jobs/${job.id}/model`, "PATCH", { model: "gpt-6.1-sol", effort: "made-up" })).status).toBe(409);
  expect((await request("/model-settings", "PATCH", { roles: { unknown: { model: null, effort: null } } })).status).toBe(409);
});

it("changes a running current Job's model only after its previous execution stops", async () => {
  const { request, project, repos } = await setup();
  const issue = await repos.issues.create({ projectId: project.id, title: "Current feature" });
  const loop = await ensureDevelopmentLoop(repos, project.id, issue.id);
  const job = await repos.agentJobs.create({ projectId: project.id, agentType: "implementation", targetType: "issue", targetId: issue.id, triggerType: "test", input: { developmentLoopId: loop.id } });
  await repos.development.update(project.id, loop.id, { status: "running", phase: "implementing", currentJobId: job.id });
  await repos.agentJobs.updateStatus(project.id, job.id, "running");
  const execution = await repos.development.executions.create({ projectId: project.id, jobId: job.id, selectedModel: "gpt-5.6-sol", effort: "low", selectionReason: "test", policyVersion: "test" });
  let finishWork!: () => void;
  const retainingWorktree = trackJobWork(repos, project.id, job.id, () => new Promise<void>((resolve) => { finishWork = resolve; }));
  const restarting = request(`/agent-jobs/${job.id}/model`, "PATCH", { model: "gpt-6.1-sol", effort: "high", restart: true });
  await expect.poll(async () => (await repos.agentJobs.get(project.id, job.id))?.status).toBe("paused");
  expect((await repos.agentJobs.get(project.id, job.id))?.input.modelOverride).toBeUndefined();
  await repos.development.executions.update(project.id, execution.id, { status: "canceled" });
  expect((await repos.agentJobs.get(project.id, job.id))?.status).toBe("paused");
  expect((await repos.agentJobs.get(project.id, job.id))?.input.modelOverride).toBeUndefined();
  finishWork(); await retainingWorktree;
  expect((await restarting).status).toBe(200);
  expect(await repos.agentJobs.get(project.id, job.id)).toMatchObject({ status: "queued", input: { modelOverride: { model: "gpt-6.1-sol", effort: "high" } } });
  expect(await repos.development.get(project.id, loop.id)).toMatchObject({ status: "running" });
});

it("merges a real PR through a chat operation and reports the real API result", async () => {
  const { chats, repos, project, dir, git, conversation, base } = await setup(async (input) => {
    const result = await input.tool("oneteam_request", { method: "POST", path: `${base}/pull-requests/1/merge`, body: {} }, "merge") as { ok: boolean; status: number };
    expect(result).toMatchObject({ ok: true, status: 200 });
    return { text: "Merged [PR #1](/pulls/1).", model: "gpt-6.1-sol" };
  });
  await git("checkout", "-b", "feature/chat"); await writeFile(join(dir, "feature.txt"), "Chat merge\n");
  await git("add", "feature.txt"); await git("commit", "-m", "feature"); await git("checkout", "main");
  await repos.pullRequests.create({ projectId: project.id, title: "Chat merge", sourceBranch: "feature/chat", targetBranch: "main" });
  await chats.send(project.id, conversation.id, "Merge PR #1");
  await waitForChat(chats, project.id, conversation.id);
  expect(await repos.pullRequests.get(project.id, 1)).toMatchObject({ status: "merged" });
  expect(await git("show", "main:feature.txt")).toBe("Chat merge");
});
