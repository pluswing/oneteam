import { afterEach, expect, it } from "vitest";
import { CodexRuntime } from "../server/agents/codex-runtime";
import type { CodexModel, CodexRpc, RpcMessage } from "../server/agents/codex-rpc";
import { selectTaskModel } from "../server/agents/model-router";
import { developmentFixture } from "./development-fixture";
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const models: CodexModel[] = ["gpt-5.4-mini", "gpt-5.5"].map((model) => ({ model, id: model, isDefault: model === "gpt-5.5", hidden: false, displayName: model, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }] }));

it("falls back on an account rejection after turn start, records rerouting, and resumes the thread", async () => {
  const fixture = await developmentFixture(); cleanups.push(fixture.cleanup);
  const { repos, project, dir } = fixture;
  const job = await repos.agentJobs.create({ projectId: project.id, agentType: "requirements", targetType: "issue", targetId: 1, triggerType: "test" });
  const starts: Record<string, unknown>[] = [];
  let connection = 0;
  const adapter = new CodexRuntime({ command: "unused", repos,
    selectModel: (catalog) => selectTaskModel(catalog, { text: "README typo", role: "requirements", fileCount: 1, qualityFailures: 0 }),
    createRpc: () => {
      const index = connection++; let listener: (message: RpcMessage) => void = () => {};
      return { async initialize() {}, close() {}, async closeAndDrain() {}, subscribe(callback: typeof listener) { listener = callback; return () => {}; },
        async request(method: string, input: Record<string, unknown>) {
          if (method === "model/list") return { data: models, nextCursor: null };
          if (method.startsWith("thread/")) { starts.push({ method, ...input }); return { thread: { id: "thread-1" }, model: input.model }; }
          if (method === "turn/start") {
            const saved = (await repos.development.executions.list(project.id, job.id)).at(-1);
            expect(saved).toMatchObject({ status: "running", threadId: "thread-1" }); expect(saved?.selectedModel).toBeTruthy();
            queueMicrotask(() => {
              listener({ method: "item/started", params: { threadId: "thread-1", item: { type: "userMessage" } } });
              if (index === 0) listener({ method: "turn/completed", params: { threadId: "thread-1", turn: { status: "failed", error: { message: "The model is not supported when using this account." } } } });
              else {
                listener({ method: "model/rerouted", params: { threadId: "thread-1", fromModel: "gpt-5.5", toModel: "gpt-5.5-resolved", reason: "capacity" } });
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
  expect(executions[1]).toMatchObject({ selectedModel: "gpt-5.5", resolvedModel: "gpt-5.5-resolved", usage: { total_tokens: 14 } });
  expect(starts.at(-1)).toMatchObject({ method: "thread/resume", threadId: "thread-1", modelProvider: "openai", sandbox: "read-only" });
});

it("persists model, thread and turn when the connection closes mid-execution", async () => {
  const fixture = await developmentFixture(); cleanups.push(fixture.cleanup);
  const { repos, project, dir } = fixture;
  const job = await repos.agentJobs.create({ projectId: project.id, agentType: "implementation", targetType: "issue", targetId: 1, triggerType: "test" });
  let listener: (message: RpcMessage) => void = () => {};
  const rpc = { async initialize() {}, close() {}, async closeAndDrain() {}, subscribe(callback: typeof listener) { listener = callback; return () => {}; }, async request(method: string, input: Record<string, unknown>) {
    if (method === "model/list") return { data: models, nextCursor: null };
    if (method === "thread/start") { expect(input.sandbox).toBe("workspace-write"); return { thread: { id: "thread-2" }, model: "gpt-5.5" }; }
    if (method === "turn/start") { queueMicrotask(() => listener({ method: "connection/closed", params: { message: "connection lost" } })); return { turn: { id: "turn-2" } }; }
    throw new Error(method);
  } } as unknown as CodexRpc;
  const runtime = new CodexRuntime({ command: "unused", repos, createRpc: () => rpc });
  expect(await runtime.run({ job, repoPath: dir, prompt: "Task" })).toMatchObject({ status: "failed", message: "connection lost" });
  expect(await repos.development.executions.list(project.id, job.id)).toMatchObject([{ selectedModel: "gpt-5.5", resolvedModel: "gpt-5.5", threadId: "thread-2", turnId: "turn-2", status: "failed" }]);
});
