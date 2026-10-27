import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { resolveCodexCommandPath } from "../services/codex-auth";

export type RpcMessage = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message: string; code?: number } };

/** One process per connection; never shares a thread between workspaces. */
export class CodexRpc {
  private child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private listeners = new Set<(message: RpcMessage) => void>();
  private closed = false;
  private stderr = "";
  private buffer = "";
  private decoder = new StringDecoder("utf8");
  private exited: Promise<void>;

  constructor(command: string, cwd?: string, configOverrides: readonly string[] = []) {
    this.child = spawn(resolveCodexCommandPath(command), ["app-server", "--listen", "stdio://", ...configOverrides.flatMap((config) => ["-c", config]), "-c", 'model_provider="openai"'], {
      cwd, stdio: ["pipe", "pipe", "pipe"]
    });
    this.exited = new Promise((resolve) => { this.child.once("close", () => resolve()); });
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.buffer += this.decoder.write(chunk);
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        this.receive(line);
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString("utf8")).slice(-4_000); });
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.on("error", (error) => this.fail(error));
    this.child.on("close", (code) => this.fail(new Error(`Codex connection closed (${code}). ${this.stderr}`)));
  }

  async initialize(capabilities?: { experimentalApi?: boolean }): Promise<void> {
    await this.request("initialize", { clientInfo: { name: "oneteam", version: "0.2.0" }, ...(capabilities ? { capabilities } : {}) });
    this.send({ method: "initialized" });
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Codex connection is closed."));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      this.send({ id, method, params });
    });
  }

  subscribe(listener: (message: RpcMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  respond(id: string | number, result: unknown): void { this.send({ id, result }); }

  close(): void {
    this.fail(new Error("Codex connection stopped."));
    this.child.stdin.end();
    this.child.kill("SIGTERM");
    const child = this.child;
    const timer = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 2_000);
    timer.unref();
  }

  async closeAndDrain(): Promise<void> { this.close(); await this.exited; }

  private send(message: unknown): void {
    if (!this.closed) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string): void {
    let message: RpcMessage;
    try { message = JSON.parse(line) as RpcMessage; } catch { return; }
    if (typeof message.id === "number" && !message.method) {
      const request = this.pending.get(message.id);
      if (request) {
        clearTimeout(request.timer);
        this.pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
      }
      return;
    }
    for (const listener of this.listeners) listener(message);
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
    for (const listener of this.listeners) listener({ method: "connection/closed", params: { message: error.message } });
  }
}

export type CodexModel = {
  id: string;
  model: string;
  displayName: string;
  hidden: boolean;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: Array<{ reasoningEffort: string }>;
  upgrade?: string | null;
  upgradeInfo?: { model: string } | null;
};

const modelCatalogPageSchema = z.object({
  data: z.array(z.object({
    id: z.string().min(1), model: z.string().trim().min(1), displayName: z.string(), hidden: z.boolean(), isDefault: z.boolean(),
    defaultReasoningEffort: z.string().min(1), supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string().min(1) }).passthrough()),
    upgrade: z.string().nullable().optional(),
    upgradeInfo: z.object({ model: z.string() }).passthrough().nullable().optional().catch(undefined)
  }).passthrough()),
  nextCursor: z.string().nullable()
});

export async function listCodexModels(rpc: CodexRpc): Promise<CodexModel[]> {
  const models: CodexModel[] = [];
  const modelIds = new Set<string>();
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const page = modelCatalogPageSchema.parse(await rpc.request("model/list", { limit: 100, includeHidden: false, cursor }));
    for (const model of page.data) {
      if (!model.hidden && !modelIds.has(model.model)) { models.push(model); modelIds.add(model.model); }
    }
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error("Codex returned a repeated model catalog cursor.");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return models;
}
