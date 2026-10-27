import { afterEach, expect, it, vi } from "vitest";
import { CodexRuntime, codexModelCatalogKey } from "../server/agents/codex-runtime";
import type { CodexModel, CodexRpc, RpcMessage } from "../server/agents/codex-rpc";
import { createModelSelector, selectTaskModel } from "../server/agents/model-router";
import { developmentFixture } from "./development-fixture";
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
const models: CodexModel[] = ["gpt-5.4-mini", "gpt-5.5"].map((model) => ({ model, id: model, isDefault: model === "gpt-5.5", hidden: false, displayName: model, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }] }));

it.each([
  "implementation", "fix", "qa", "verifier", "requirements", "review", "command_detection", "retrospective"
] as const)("allows %s commands outside the worktree for both new and resumed jobs", async (agentType) => {
  const { repos, project, dir, cleanup } = await developmentFixture(); cleanups.push(cleanup);
  const job = await repos.agentJobs.create({ projectId: project.id, agentType, targetType: "issue", targetId: 1, triggerType: "test" });
  const threads: Record<string, unknown>[] = [];
  const turns: Record<string, unknown>[] = [];
  const runtime = new CodexRuntime({ command: "unused", repos, createRpc: () => {
    let listener: (message: RpcMessage) => void = () => {};
    return { async initialize() {}, async closeAndDrain() {}, subscribe(callback: typeof listener) { listener = callback; return () => {}; },
      async request(method: string, input: Record<string, unknown>) {
        if (method === "model/list") return { data: models, nextCursor: null };
        if (method === "thread/start" || method === "thread/resume") {
          threads.push({ method, ...input }); return { thread: { id: "command-thread" }, model: input.model };
        }
        if (method === "turn/start") {
          turns.push(input);
          queueMicrotask(() => {
            listener({ method: "item/completed", params: { item: { type: "agentMessage", text: '{"status":"succeeded","message":"OK"}' } } });
            listener({ method: "turn/completed", params: { turn: { status: "completed" } } });
          });
          return { turn: { id: "command-turn" } };
        }
        throw new Error(method);
      }
    } as unknown as CodexRpc;
  } });
  expect(await runtime.run({ job, repoPath: dir, prompt: "Run project checks" })).toMatchObject({ status: "succeeded" });
  expect(await runtime.run({ job, repoPath: dir, prompt: "Retry project checks" })).toMatchObject({ status: "succeeded" });
  expect(threads).toMatchObject([
    { method: "thread/start", sandbox: "danger-full-access", approvalPolicy: "never", cwd: dir },
    { method: "thread/resume", threadId: "command-thread", sandbox: "danger-full-access", approvalPolicy: "never", cwd: dir }
  ]);
  expect(turns).toHaveLength(2);
  for (const turn of turns) {
    expect(turn).toMatchObject({ approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } });
  }
});

it("falls back on an account rejection after turn start, records rerouting, and resumes the thread", async () => {
  const fixture = await developmentFixture(); cleanups.push(fixture.cleanup);
  const { repos, project, dir } = fixture;
  const job = await repos.agentJobs.create({ projectId: project.id, agentType: "requirements", targetType: "issue", targetId: 1, triggerType: "test" });
  const starts: Record<string, unknown>[] = [];
  const catalogReads: number[] = [];
  let connection = 0;
  const adapter = new CodexRuntime({ command: "unused", repos,
    selectModel: (catalog) => selectTaskModel(catalog, { text: "README typo", role: "requirements", fileCount: 1, qualityFailures: 0 }),
    createRpc: () => {
      const index = connection++; let listener: (message: RpcMessage) => void = () => {};
      return { async initialize() {}, close() {}, async closeAndDrain() {}, subscribe(callback: typeof listener) { listener = callback; return () => {}; },
        async request(method: string, input: Record<string, unknown>) {
          if (method === "model/list") { catalogReads.push(index); return { data: index === 0 ? models : [{ ...models[0], id: "new-catalog-model", model: "new-catalog-model", isDefault: true }], nextCursor: null }; }
          if (method.startsWith("thread/")) {
            expect(input).toMatchObject({ sandbox: "danger-full-access", approvalPolicy: "never" });
            starts.push({ method, ...input }); return { thread: { id: "thread-1" }, model: input.model };
          }
          if (method === "turn/start") {
            expect(input).toMatchObject({ approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } });
            const saved = (await repos.development.executions.list(project.id, job.id)).at(-1);
            expect(saved).toMatchObject({ status: "running", threadId: "thread-1" }); expect(saved?.selectedModel).toBeTruthy();
            expect(input.model).toBe(saved?.selectedModel);
            queueMicrotask(() => {
              listener({ method: "item/started", params: { threadId: "thread-1", item: { type: "userMessage" } } });
              if (index === 0) listener({ method: "turn/completed", params: { threadId: "thread-1", turn: { status: "failed", error: { message: "The model is not supported when using this account." } } } });
              else {
                listener({ method: "model/rerouted", params: { threadId: "thread-1", fromModel: input.model, toModel: "catalog-resolved", reason: "capacity" } });
                listener({ method: "thread/tokenUsage/updated", params: { threadId: "thread-1", tokenUsage: { last: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } } } });
                listener({ method: "item/completed", params: { threadId: "thread-1", item: { type: "agentMessage", text: JSON.stringify({ status: "succeeded", message: "OK" }) } } });
                listener({ method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } });
              }
            });
            return { turn: { id: `turn-${index}` } };
          }
          throw new Error(method);
        }
      } as unknown as CodexRpc;
    }
  });
  expect(await adapter.run({ job, repoPath: dir, prompt: "Read only" })).toMatchObject({ status: "succeeded" });
  expect(await adapter.run({ job, repoPath: dir, prompt: "Continue" })).toMatchObject({ metadata: { providerExecution: { resumedSession: true } } });
  const executions = await repos.development.executions.list(project.id, job.id);
  expect(executions.map((entry) => entry.status)).toEqual(["failed", "succeeded", "succeeded"]);
  expect(executions[0].selectedModel).toBe("gpt-5.5");
  expect(executions[1]).toMatchObject({ selectedModel: "new-catalog-model", resolvedModel: "catalog-resolved", usage: { total_tokens: 14 } });
  expect(catalogReads).toEqual([0, 1, 2]);
  expect(await repos.settings.get(codexModelCatalogKey)).toMatchObject({ models: [{ model: "new-catalog-model" }], fetchedAt: expect.any(String) });
  expect(starts.at(-1)).toMatchObject({ method: "thread/resume", threadId: "thread-1", modelProvider: "openai", sandbox: "danger-full-access" });
});

it("refreshes before each execution and never falls back to an old catalog when retrieval fails", async () => {
  const fixture = await developmentFixture(); cleanups.push(fixture.cleanup);
  const { repos, project, dir } = fixture;
  const job = await repos.agentJobs.create({ projectId: project.id, agentType: "requirements", targetType: "issue", targetId: 1, triggerType: "test" });
  let catalogsRead = 0;
  const starts: string[] = [];
  const runtime = new CodexRuntime({ command: "unused", repos, createRpc: () => {
    let listener: (message: RpcMessage) => void = () => {};
    return { async initialize() {}, async closeAndDrain() {}, subscribe(callback: typeof listener) { listener = callback; return () => {}; },
      async request(method: string, input: Record<string, unknown>) {
        if (method === "model/list") {
          catalogsRead++;
          if (catalogsRead === 3) throw new Error("Catalog service unavailable");
          return { data: [{ ...models[0], model: `future-model-${catalogsRead}`, id: `future-model-${catalogsRead}`, isDefault: true }], nextCursor: null };
        }
        if (method.startsWith("thread/")) { starts.push(String(input.model)); return { thread: { id: "refresh-thread" }, model: input.model }; }
        if (method === "turn/start") {
          queueMicrotask(() => {
            listener({ method: "item/completed", params: { item: { type: "agentMessage", text: '{"status":"succeeded","message":"OK"}' } } });
            listener({ method: "turn/completed", params: { turn: { status: "completed" } } });
          });
          return { turn: { id: "refresh-turn" } };
        }
        throw new Error(method);
      }
    } as unknown as CodexRpc;
  } });
  await runtime.run({ job, repoPath: dir, prompt: "First" });
  await runtime.run({ job, repoPath: dir, prompt: "Next" });
  await expect(runtime.run({ job, repoPath: dir, prompt: "Unavailable" })).rejects.toThrow("Catalog service unavailable");
  expect(catalogsRead).toBe(3);
  expect(starts).toEqual(["future-model-1", "future-model-2"]);
  expect(await repos.settings.get(codexModelCatalogKey)).toMatchObject({ models: [{ model: "future-model-2" }] });
  expect(await repos.development.executions.list(project.id, job.id)).toHaveLength(2);
});

it("stops an automatic legacy downgrade, cools down rejections and retries when availability changes", async () => {
  const { repos, project, dir, cleanup } = await developmentFixture(); cleanups.push(cleanup);
  const job = await repos.agentJobs.create({ projectId: project.id, agentType: "implementation", targetType: "issue", targetId: 1, triggerType: "test" });
  const oldModel = { ...models[1], id: "gpt-5.6-sol", model: "gpt-5.6-sol", isDefault: true };
  const preferred = { ...oldModel, id: "gpt-6.1-sol", model: "gpt-6.1-sol", isDefault: false };
  let advertised = false;
  const starts: string[] = [];
  const runtime = new CodexRuntime({ command: "unused", repos, createRpc: () => {
    let listener: (message: RpcMessage) => void = () => {};
    return { async initialize() {}, async closeAndDrain() {}, subscribe(callback: typeof listener) { listener = callback; return () => {}; },
      async request(method: string, input: Record<string, unknown>) {
        if (method === "model/list") return { data: advertised ? [oldModel, preferred] : [oldModel], nextCursor: null };
        if (method === "thread/start" || method === "thread/resume") {
          starts.push(String(input.model));
          return { thread: { id: "sol-thread" }, model: input.model };
        }
        if (method === "turn/start") {
          queueMicrotask(() => {
            if (input.model === preferred.model && !advertised) {
              listener({ method: "item/started", params: { item: { type: "userMessage" } } });
              listener({ method: "turn/completed", params: { turn: { status: "failed", error: { message: "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account." } } } });
              return;
            }
            listener({ method: "item/completed", params: { item: { type: "agentMessage", text: '{"status":"succeeded","message":"OK"}' } } });
            listener({ method: "turn/completed", params: { turn: { status: "completed" } } });
          });
          return { turn: { id: "sol-turn" } };
        }
        throw new Error(method);
      }
    } as unknown as CodexRpc;
  } });
  const run = () => runtime.run({ job, repoPath: dir, prompt: "Add a filter" });
  await expect(run()).rejects.toThrow("GPT-6.1 Sol");
  expect(starts).toEqual([preferred.model]);
  expect(await repos.settings.get(codexModelCatalogKey)).toMatchObject({ models: [{ model: oldModel.model }] });
  await expect(run()).rejects.toThrow("GPT-6.1 Sol");
  expect(starts).toEqual([preferred.model]);
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 10 * 60_000 + 1);
  await expect(run()).rejects.toThrow("GPT-6.1 Sol");
  expect(starts).toEqual([preferred.model, preferred.model]);
  advertised = true;
  expect(await run()).toMatchObject({ status: "succeeded" });
  expect(starts.at(-1)).toBe(preferred.model);
  const executions = await repos.development.executions.list(project.id, job.id);
  expect(executions.map((execution) => execution.status)).toEqual(["failed", "failed", "succeeded"]);
  expect(executions.at(-1)).toMatchObject({ selectedModel: preferred.model, policyVersion: "2026-10-27-completion-cost-v4" });
});

it("excludes every rejected model even when a refreshed catalog continues to advertise it", async () => {
  const fixture = await developmentFixture(); cleanups.push(fixture.cleanup);
  const { repos, project, dir } = fixture;
  const job = await repos.agentJobs.create({ projectId: project.id, agentType: "requirements", targetType: "issue", targetId: 1, triggerType: "test" });
  let catalogsRead = 0;
  const starts: string[] = [];
  const runtime = new CodexRuntime({ command: "unused", repos, createRpc: () => ({
    async initialize() {}, async closeAndDrain() {},
    async request(method: string, input: Record<string, unknown>) {
      if (method === "model/list") { catalogsRead++; return { data: models, nextCursor: null }; }
      if (method.startsWith("thread/")) { starts.push(String(input.model)); throw new Error('{"code":"model_not_found","message":"Access rejected"}'); }
      throw new Error(method);
    }
  }) as unknown as CodexRpc });
  await expect(runtime.run({ job, repoPath: dir, prompt: "Task" })).rejects.toThrow("did not return any available models");
  expect(starts).toEqual(["gpt-5.5", "gpt-5.4-mini"]);
  expect(catalogsRead).toBe(3);
  expect((await repos.development.executions.list(project.id, job.id)).map((entry) => entry.status)).toEqual(["failed", "failed"]);
});

it("rejects a selector returning a model absent from the current catalog before starting work", async () => {
  const fixture = await developmentFixture(); cleanups.push(fixture.cleanup);
  const { repos, project, dir } = fixture;
  const job = await repos.agentJobs.create({ projectId: project.id, agentType: "requirements", targetType: "issue", targetId: 1, triggerType: "test" });
  const runtime = new CodexRuntime({ command: "unused", repos,
    selectModel: () => ({ model: "removed-model", effort: "medium", reason: "Old selection", policyVersion: "test" }),
    createRpc: () => ({ async initialize() {}, async closeAndDrain() {}, async request(method: string) {
      expect(method).toBe("model/list"); return { data: models, nextCursor: null };
    } }) as unknown as CodexRpc
  });
  await expect(runtime.run({ job, repoPath: dir, prompt: "Task" })).rejects.toThrow("absent from the current catalog");
  expect(await repos.development.executions.list(project.id, job.id)).toEqual([]);
});

it("persists model, thread and turn when the connection closes mid-execution", async () => {
  const fixture = await developmentFixture(); cleanups.push(fixture.cleanup);
  const { repos, project, dir } = fixture;
  const job = await repos.agentJobs.create({ projectId: project.id, agentType: "implementation", targetType: "issue", targetId: 1, triggerType: "test" });
  let listener: (message: RpcMessage) => void = () => {};
  const rpc = { async initialize() {}, close() {}, async closeAndDrain() {}, subscribe(callback: typeof listener) { listener = callback; return () => {}; }, async request(method: string, input: Record<string, unknown>) {
    if (method === "model/list") return { data: models, nextCursor: null };
    if (method === "thread/start") { expect(input.sandbox).toBe("danger-full-access"); return { thread: { id: "thread-2" }, model: "gpt-5.5" }; }
    if (method === "turn/start") { queueMicrotask(() => listener({ method: "connection/closed", params: { message: "connection lost" } })); return { turn: { id: "turn-2" } }; }
    throw new Error(method);
  } } as unknown as CodexRpc;
  const runtime = new CodexRuntime({ command: "unused", repos, createRpc: () => rpc });
  expect(await runtime.run({ job, repoPath: dir, prompt: "Task" })).toMatchObject({ status: "failed", message: "connection lost" });
  expect(await repos.development.executions.list(project.id, job.id)).toMatchObject([{ selectedModel: "gpt-5.5", resolvedModel: "gpt-5.5", threadId: "thread-2", turnId: "turn-2", status: "failed" }]);
});

it("records whole-turn cumulative usage and subtracts the previous turn on resume", async () => {
  const { repos, project, dir, cleanup } = await developmentFixture(); cleanups.push(cleanup);
  const job = await repos.agentJobs.create({ projectId: project.id, agentType: "implementation", targetType: "issue", targetId: 1, triggerType: "test" });
  let run = 0;
  const runtime = new CodexRuntime({ command: "unused", repos, createRpc: () => {
    const index = run++; let listener: (message: RpcMessage) => void = () => {};
    return { async initialize() {}, async closeAndDrain() {}, subscribe(callback: typeof listener) { listener = callback; return () => {}; },
      async request(method: string, input: Record<string, unknown>) {
        if (method === "model/list") return { data: models, nextCursor: null };
        if (method.startsWith("thread/")) return { thread: { id: "usage-thread" }, model: input.model };
        if (method === "turn/start") {
          expect(input.serviceTierForTurn).toBe("default");
          queueMicrotask(() => {
            for (const total of [{ inputTokens: 100 + index * 200, outputTokens: 30 + index * 80 }, { inputTokens: 200 + index * 100, outputTokens: 80 + index * 40 }]) {
              listener({ method: "thread/tokenUsage/updated", params: { threadId: "usage-thread", tokenUsage: { total, last: { inputTokens: 10, outputTokens: 5 } } } });
            }
            listener({ method: "item/completed", params: { item: { type: "agentMessage", text: '{"status":"succeeded","message":"OK"}' } } });
            listener({ method: "turn/completed", params: { turn: { status: "completed" } } });
          });
          return { turn: { id: `usage-turn-${index}` } };
        }
        throw new Error(method);
      }
    } as unknown as CodexRpc;
  } });
  await runtime.run({ job, repoPath: dir, prompt: "First" });
  await runtime.run({ job, repoPath: dir, prompt: "Next" });
  expect((await repos.development.executions.list(project.id, job.id)).map((execution) => execution.usage)).toMatchObject([
    { input_tokens: 200, output_tokens: 80, costBasis: "turn_total" },
    { input_tokens: 100, output_tokens: 40, costBasis: "turn_total" }
  ]);
});

it("honors an explicit model even during automatic-probe cooldown and never replaces a denied explicit model", async () => {
  const { repos, project, dir, cleanup } = await developmentFixture(); cleanups.push(cleanup);
  const job = await repos.agentJobs.create({ projectId: project.id, agentType: "implementation", targetType: "issue", targetId: 1, triggerType: "test" });
  const starts: unknown[] = [];
  const runtime = new CodexRuntime({ command: "unused", repos, selectModel: createModelSelector(repos), createRpc: () => ({
    async initialize() {}, async closeAndDrain() {}, async request(method: string, input: Record<string, unknown>) {
      if (method === "model/list") return { data: [{ ...models[0], id: "gpt-5.6-sol", model: "gpt-5.6-sol", isDefault: true }], nextCursor: null };
      if (method.startsWith("thread/")) { starts.push(input.model); throw new Error("model not supported for this account"); }
      throw new Error(method);
    }
  }) as unknown as CodexRpc });
  await expect(runtime.run({ job, repoPath: dir, prompt: "Automatic" })).rejects.toThrow("GPT-6.1 Sol");
  await expect(runtime.run({ job: { ...job, input: { modelOverride: { model: "gpt-6.1-sol" } } }, repoPath: dir, prompt: "Explicit" })).rejects.toThrow("model not supported");
  expect(starts).toEqual(["gpt-6.1-sol", "gpt-6.1-sol"]);
});
