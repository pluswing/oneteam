import type { ChatDetail } from "../../shared/chat";
import { z } from "zod";
import type { Repositories } from "../db/repositories";
import { CodexRpc, listCodexModels } from "../agents/codex-rpc";
import { modelSelectionCandidates, selectTaskModel } from "../agents/model-router";
import { createCodexChatRunner, type ChatRunner } from "./chat-codex";
import { boundedToolResult, chatApiHelp, executeChatRequest, validateChatRequest, type OneTeamApi } from "./chat-tools";
import { readModelSettings } from "./model-settings";

export class ChatService {
  private api: OneTeamApi | null = null;
  private active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private stopped = false;
  private runner: ChatRunner;
  constructor(private repos: Repositories, private options: { command: string; runner?: ChatRunner; ensureReady?: () => Promise<void>; createRpc?: () => CodexRpc }) {
    this.runner = options.runner ?? createCodexChatRunner(options.command);
  }
  setApi(api: OneTeamApi) { this.api = api; }

  async recover(): Promise<void> {
    for (const project of await this.repos.projects.list()) for (const chat of await this.repos.chats.list(project.id)) {
      if (chat.status !== "running") continue;
      const error = project.locale === "ja" ? "前回の応答はアプリの終了で中断されました。完了済みの操作は履歴に残っています。" : "The previous response was interrupted when the app closed. Completed operations remain recorded.";
      for (const message of await this.repos.chats.messages(project.id, chat.id)) {
        if (message.status === "running") await this.repos.chats.updateMessage(project.id, message.id, message.content || error, "failed", { ...message.metadata, interrupted: true });
      }
      await this.repos.chats.update(project.id, chat.id, { status: "idle", error });
    }
  }
  async models(projectId: string) {
    const rpc = this.options.createRpc?.() ?? new CodexRpc(this.options.command);
    try {
      await rpc.initialize();
      const catalog = await listCodexModels(rpc);
      const listed = new Set(catalog.map((model) => model.model));
      const candidates = modelSelectionCandidates(catalog);
      return { models: candidates.map((model) => ({ ...model, listed: listed.has(model.model) })),
        preferredModel: selectTaskModel(candidates, { text: "", fileCount: 0, qualityFailures: 0, role: "requirements" }).model, settings: await readModelSettings(this.repos, projectId) };
    } finally { await rpc.closeAndDrain(); }
  }
  async detail(projectId: string, id: string): Promise<ChatDetail | null> {
    const chat = await this.repos.chats.get(projectId, id);
    return chat ? { chat, messages: await this.repos.chats.messages(projectId, id) } : null;
  }
  async send(projectId: string, id: string, text: string, requestId?: string): Promise<ChatDetail> {
    if (this.stopped) throw new Error("The chat service is stopping.");
    const chat = await this.repos.chats.get(projectId, id);
    const project = await this.repos.projects.get(projectId);
    if (!chat || !project) throw new Error("Chat was not found.");
    if (!this.api) throw new Error("OneTeam operations are not connected.");
    const existing = requestId ? (await this.repos.chats.messages(projectId, id)).find((message) => message.role === "user" && message.metadata?.requestId === requestId) : null;
    if (existing) {
      if (existing.content !== text) throw new Error("A different message already uses this request ID.");
      return (await this.detail(projectId, id))!;
    }
    if (!await this.repos.chats.claim(projectId, id)) throw new Error("This chat is already responding. Wait or stop it before sending another message.");
    let assistantId: number;
    let history;
    try {
      history = await this.repos.chats.messages(projectId, id);
      await this.repos.chats.append(projectId, id, "user", text, "completed", requestId ? { requestId } : undefined);
      assistantId = (await this.repos.chats.append(projectId, id, "assistant", "", "running")).id;
      if (!history.length) await this.repos.chats.update(projectId, id, { title: text.replace(/\s+/g, " ").slice(0, 64) });
    } catch (error) { await this.repos.chats.update(projectId, id, { status: "idle" }); throw error; }
    const controller = new AbortController();
    let streamed = "";
    let model = "";
    let writeQueue = Promise.resolve();
    let lastWrite = 0;
    const api = this.api;
    const run = async () => {
      try {
        await this.options.ensureReady?.();
        const result = await this.runner({ chat, project, history, text, signal: controller.signal,
          onThread: async (threadId) => { await this.repos.chats.update(projectId, id, { threadId }); },
          onModel: (value) => { model = value; },
          onText: (value) => {
            streamed = value;
            if (Date.now() - lastWrite < 250) return;
            lastWrite = Date.now(); const content = value;
            writeQueue = writeQueue.then(() => this.repos.chats.updateMessage(projectId, assistantId, content, "running", { model })).catch(() => {});
          },
          tool: async (name, args, key) => {
            if (controller.signal.aborted) throw new Error("Chat response canceled.");
            if (name === "oneteam_help") return chatApiHelp(api, projectId);
            if (name === "oneteam_current_chat") {
              const patch = z.object({ title: z.string().trim().min(1).max(120).optional(), model: z.string().trim().min(1).max(200).nullable().optional(), effort: z.string().trim().min(1).max(40).nullable().optional() }).strict().parse(args);
              const current = (await this.repos.chats.get(projectId, id))!;
              if (patch.model !== undefined || patch.effort !== undefined) {
                const requestedModel = patch.model === undefined ? current.model : patch.model;
                const requestedEffort = patch.effort === undefined ? current.effort : patch.effort;
                const { models } = await this.models(projectId);
                const selected = requestedModel ? models.find((candidate) => candidate.model === requestedModel) : null;
                if (requestedModel && !selected) throw new Error(`Requested chat model is unavailable: ${requestedModel}`);
                if (requestedEffort && !(selected ? [selected] : models).some((candidate) => candidate.supportedReasoningEfforts.some((option) => option.reasoningEffort === requestedEffort))) throw new Error(`Unsupported chat reasoning effort: ${requestedEffort}`);
              }
              const updated = Object.keys(patch).length ? (await this.repos.chats.update(projectId, id, patch))! : current;
              const result = { ok: true, title: updated.title, model: updated.model, effort: updated.effort, resolvedModel: model, appliesTo: "next_response" };
              if (Object.keys(patch).length) await this.repos.chats.append(projectId, id, "tool", JSON.stringify(result), "completed", { key, method: "PATCH", path: `/api/projects/${projectId}/chats/${id}/model`, result });
              return result;
            }
            if (name !== "oneteam_request") throw new Error(`Unknown OneTeam operation: ${name}`);
            const request = validateChatRequest(projectId, args);
            const previous = (await this.repos.chats.messages(projectId, id)).find((message) => message.role === "tool" && message.metadata?.key === key);
            if (previous) return previous.metadata?.result ?? { ok: false, error: "This operation was already started. Inspect its current state before retrying." };
            const audit = await this.repos.chats.append(projectId, id, "tool", `${request.method} ${request.path}`, "running", { key, method: request.method, path: request.path, body: request.body ?? null });
            try {
              const result = await executeChatRequest(api, projectId, request);
              await this.repos.chats.updateMessage(projectId, audit.id, boundedToolResult(result), result.ok ? "completed" : "failed", { ...audit.metadata, result: JSON.parse(boundedToolResult(result)) as unknown });
              return result;
            } catch (error) {
              const result = { ok: false, error: error instanceof Error ? error.message : String(error) };
              await this.repos.chats.updateMessage(projectId, audit.id, JSON.stringify(result), "failed", { ...audit.metadata, result });
              return result;
            }
          }
        });
        await writeQueue;
        await this.repos.chats.updateMessage(projectId, assistantId, result.text, controller.signal.aborted ? "canceled" : "completed", { model: result.model });
        await this.repos.chats.update(projectId, id, { status: "idle", error: null });
      } catch (error) {
        await writeQueue;
        const message = error instanceof Error ? error.message : String(error);
        await this.repos.chats.updateMessage(projectId, assistantId, streamed, controller.signal.aborted ? "canceled" : "failed", { model, error: message });
        await this.repos.chats.update(projectId, id, { status: "idle", error: controller.signal.aborted ? null : message });
      } finally { this.active.delete(id); }
    };
    // Schedule after the active record exists; cancellation also works before the RPC starts.
    const promise = Promise.resolve().then(run);
    this.active.set(id, { controller, promise });
    void promise.catch((error: unknown) => { console.error("Chat persistence failed:", error instanceof Error ? error.message : error); });
    return (await this.detail(projectId, id))!;
  }
  async stop(projectId: string, id: string): Promise<void> {
    if (!await this.repos.chats.get(projectId, id)) throw new Error("Chat was not found.");
    const running = this.active.get(id);
    running?.controller.abort();
    await running?.promise;
  }
  async stopAndDrain(): Promise<void> {
    this.stopped = true;
    const active = [...this.active.values()];
    for (const run of active) run.controller.abort();
    await Promise.allSettled(active.map((run) => run.promise));
  }
}
