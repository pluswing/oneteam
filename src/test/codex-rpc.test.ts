import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { CodexRpc, listCodexModels, type CodexModel } from "../server/agents/codex-rpc";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));
afterEach(() => { spawn.mockReset(); });
function childFixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null,
    kill: vi.fn(() => { child.exitCode = 0; queueMicrotask(() => child.emit("close", 0)); return true; })
  });
  spawn.mockReturnValue(child);
  return child;
}

it("keeps existing callers' launch arguments unchanged", async () => {
  const child = childFixture();
  const rpc = new CodexRpc("fixture-codex", "/tmp/fixture-workspace");
  expect(spawn).toHaveBeenCalledWith("fixture-codex", ["app-server", "--listen", "stdio://", "-c", 'model_provider="openai"'], {
    cwd: "/tmp/fixture-workspace", stdio: ["pipe", "pipe", "pipe"]
  });
  await rpc.closeAndDrain();
  expect(child.kill).toHaveBeenCalledWith("SIGTERM");
});

it("passes helper-specific config as literal child arguments without affecting later connections", async () => {
  childFixture();
  const helper = new CodexRpc("fixture-codex", "/tmp/fixture-translation", ['model_reasoning_effort="low"', "features.shell_tool=false"]);
  expect(spawn.mock.calls[0][1]).toEqual([
    "app-server", "--listen", "stdio://", "-c", 'model_reasoning_effort="low"', "-c", "features.shell_tool=false", "-c", 'model_provider="openai"'
  ]);
  await helper.closeAndDrain();
  childFixture();
  const ordinary = new CodexRpc("fixture-codex");
  expect(spawn.mock.calls[1][1]).not.toContain('model_reasoning_effort="low"');
  await ordinary.closeAndDrain();
});

const catalogModel: CodexModel = { id: "future-model", model: "future-model", displayName: "Future model", hidden: false, isDefault: true,
  defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] };

it("retrieves every catalog page, deduplicates models and excludes hidden entries", async () => {
  const request = vi.fn().mockResolvedValueOnce({ data: [catalogModel, { ...catalogModel, id: "hidden", model: "hidden", hidden: true }], nextCursor: "next" })
    .mockResolvedValueOnce({ data: [catalogModel, { ...catalogModel, id: "new", model: "new" }], nextCursor: null });
  expect((await listCodexModels({ request } as unknown as CodexRpc)).map((model) => model.model)).toEqual(["future-model", "new"]);
  expect(request.mock.calls.map((call) => call[1])).toEqual([
    { cursor: null, includeHidden: false, limit: 100 }, { cursor: "next", includeHidden: false, limit: 100 }
  ]);
});

it("rejects incomplete catalogs and repeated cursors instead of using a partial result", async () => {
  const looping = { request: vi.fn().mockResolvedValue({ data: [catalogModel], nextCursor: "same" }) };
  await expect(listCodexModels(looping as unknown as CodexRpc)).rejects.toThrow("repeated model catalog cursor");
  const malformed = { request: vi.fn().mockResolvedValue({ data: [{ model: "incomplete" }], nextCursor: null }) };
  await expect(listCodexModels(malformed as unknown as CodexRpc)).rejects.toThrow();
});

it("preserves official successor metadata for model selection", async () => {
  const model = { ...catalogModel, upgrade: "future-coder", upgradeInfo: { model: "future-coder", migrationMarkdown: "Release guidance" } };
  const rpc = { request: vi.fn().mockResolvedValue({ data: [model], nextCursor: null }) } as unknown as CodexRpc;
  expect(await listCodexModels(rpc)).toEqual([model]);
});
