import type { Repositories } from "../db/repositories";
import { agentOutputSchema, classifyCodexRateLimitSnapshot, extractAgentRunResult } from "./codex-adapter";
import { CodexRpc, listCodexModels, type CodexModel, type RpcMessage } from "./codex-rpc";
import type { AgentAdapter, AgentActivityResult, AgentRunResult, ProviderCapacityProbeResult } from "./types";

export type ModelSelection = { model: string; effort: string | null; reason: string; policyVersion: string };
export type ModelSelector = (models: CodexModel[], input: Parameters<AgentAdapter["run"]>[0]) => Promise<ModelSelection> | ModelSelection;

export class CodexRuntime implements AgentAdapter {
  private unavailableModels = new Map<string, number>();
  private cachedModels: { at: number; models: CodexModel[] } | null = null;
  constructor(private readonly options: {
    command: string;
    repos: Repositories;
    ensureReady?: () => Promise<void>;
    selectModel?: ModelSelector;
    createRpc?: (command: string, cwd?: string) => CodexRpc;
  }) {}

  async probeCapacity(): Promise<ProviderCapacityProbeResult> {
    const rpc = this.connect();
    const checkedAt = new Date();
    try {
      await rpc.initialize();
      const snapshot = await rpc.request("account/rateLimits/read", null, 10_000);
      return { ...classifyCodexRateLimitSnapshot(snapshot, checkedAt), checkedAt: checkedAt.toISOString(), provider: "codex", source: "codex_app_server_rate_limits" };
    } finally { await rpc.closeAndDrain(); }
  }

  async run(input: Parameters<AgentAdapter["run"]>[0]): Promise<AgentRunResult> {
    await this.options.ensureReady?.();
    const rpc = this.connect(input.repoPath);
    let executionId: number | null = null;
    let threadId: string | null = null;
    let turnId: string | null = null;
    let model: string | null = null;
    let usage: Record<string, unknown> | null = null;
    let performedWork = false;
    const previous = (await this.options.repos.development.executions.list(input.job.projectId, input.job.id)).at(-1);
    const resumeId = typeof input.job.waitMetadata?.sessionId === "string" ? input.job.waitMetadata.sessionId : previous?.threadId;
    const resumedSession = Boolean(resumeId);
    let activityQueue = Promise.resolve();
    let activityError: unknown;
    const emit = (activity: AgentActivityResult) => {
      activityQueue = activityQueue.then(async () => { await input.onActivity?.(activity); }).catch((error: unknown) => { activityError ??= error; });
    };
    let cancellationTimer: NodeJS.Timeout | undefined;
    let unsubscribe: (() => void) | undefined;
    try {
      if (await input.isCanceled?.()) return { status: "canceled", message: "Execution canceled before starting Codex.", stopReason: "canceled" };
      await rpc.initialize();
      const models = (await this.models(rpc)).filter((candidate) => (this.unavailableModels.get(candidate.model) ?? 0) < Date.now());
      const defaultModel = models.find((candidate) => candidate.isDefault) ?? models[0];
      if (!defaultModel) throw new Error("Codex did not return any available models. Reconnect and retry.");
      const selection = Number(input.job.input.modelFallbacks ?? 0) > 0 && defaultModel.isDefault
        ? { model: defaultModel.model, effort: defaultModel.defaultReasoningEffort, reason: "The preferred model was rejected for this account. Retrying with Codex's available default.", policyVersion: "availability-fallback-v1" }
        : this.options.selectModel
        ? await this.options.selectModel(models, input)
        : { model: defaultModel.model, effort: defaultModel.defaultReasoningEffort, reason: "Codex default available model", policyVersion: "default-v1" };
      await this.options.repos.development.setJobModel(input.job.projectId, input.job.id, selection.model);
      const execution = await this.options.repos.development.executions.create({
        projectId: input.job.projectId, jobId: input.job.id, selectedModel: selection.model,
        effort: selection.effort, selectionReason: selection.reason, policyVersion: selection.policyVersion
      });
      executionId = execution.id;
      emit({ type: "system", title: "Model selected", body: `${selection.model} · ${selection.effort ?? "default"}\n${selection.reason}`, payload: { ...selection, executionId } });
      const writing = ["implementation", "fix"].includes(input.job.agentType);
      const started = await rpc.request<{ thread: { id: string }; model: string }>(resumeId ? "thread/resume" : "thread/start", {
        ...(resumeId ? { threadId: resumeId } : {}), model: selection.model, modelProvider: "openai", cwd: input.repoPath,
        approvalPolicy: "never", sandbox: writing ? "workspace-write" : "read-only"
      });
      threadId = started.thread.id;
      model = started.model;
      await this.options.repos.development.executions.update(input.job.projectId, executionId, { threadId, resolvedModel: model, status: "running" });
      emit({ type: "system", title: resumedSession ? "Codex thread resumed" : "Codex thread started", body: model, payload: { executionId, threadId, resolvedModel: model } });

      let finalText = "";
      let questions: string[] = [];
      let finished = false;
      let interrupting = false;
      let finish!: (result: { status: string; error?: { message?: string } }) => void;
      const completion = new Promise<{ status: string; error?: { message?: string } }>((resolve) => { finish = resolve; });
      const interrupt = async () => {
        if (interrupting || finished || !turnId) return;
        interrupting = true;
        try { await rpc.request("turn/interrupt", { threadId, turnId }, 5_000); }
        catch { finish({ status: "interrupted" }); }
        setTimeout(() => { if (!finished) finish({ status: "interrupted" }); }, 5_000).unref();
      };
      unsubscribe = rpc.subscribe((message: RpcMessage) => {
        const params = message.params ?? {};
        if (params.threadId && params.threadId !== threadId) return;
        if (message.method === "connection/closed") { finish({ status: "failed", error: { message: String(params.message) } }); return; }
        if (message.method === "turn/started") {
          const turn = asRecord(params.turn);
          if (typeof turn.id === "string") turnId = turn.id;
        }
        if (message.method === "model/rerouted") {
          model = String(params.toModel);
          activityQueue = activityQueue.then(() => this.options.repos.development.executions.update(input.job.projectId, executionId!, { resolvedModel: model })).catch((error: unknown) => { activityError ??= error; });
          emit({ type: "system", title: "Codex model changed", body: `${params.fromModel} → ${params.toModel}: ${params.reason}`, payload: { ...params, executionId } });
        }
        if (message.method === "thread/tokenUsage/updated") {
          const last = asRecord(asRecord(params.tokenUsage).last);
          usage = { input_tokens: last.inputTokens, cached_input_tokens: last.cachedInputTokens, output_tokens: last.outputTokens, reasoning_output_tokens: last.reasoningOutputTokens, total_tokens: last.totalTokens };
        }
        if (message.method === "item/completed" || message.method === "item/started") {
          const item = asRecord(params.item);
          if (!["userMessage", "agentMessage", "reasoning", "plan"].includes(String(item.type))) performedWork = true;
          if (item.type === "agentMessage" && message.method === "item/completed") {
            if (item.phase !== "commentary") finalText = String(item.text ?? "");
            else emit({ type: "progress", title: "Codex progress", body: String(item.text ?? "") });
          } else {
            const activity = activityForItem(item, message.method === "item/completed");
            if (activity) emit(activity);
          }
        }
        if (message.method === "item/commandExecution/outputDelta") {
          emit({ type: "command", title: "Command output", body: String(params.delta ?? "").slice(-8_000), payload: { itemId: params.itemId, executionId } });
        }
        if (message.method === "item/reasoning/summaryTextDelta") {
          emit({ type: "thinking", title: "Codex thinking summary", body: String(params.delta ?? "") });
        }
        if (message.id !== undefined && message.method) {
          questions = Array.isArray(params.questions)
            ? params.questions.map((question) => String(asRecord(question).question ?? "Input required"))
            : [`Codex requires input: ${message.method}`];
          rpc.respond(message.id, message.method === "item/tool/requestUserInput" ? { answers: {} } : { decision: "cancel" });
          void interrupt();
        }
        if (message.method === "turn/completed") {
          const turn = asRecord(params.turn);
          finished = true;
          finish({ status: String(turn.status), error: asRecord(turn.error) });
        }
      });
      const turn = await rpc.request<{ turn: { id: string } }>("turn/start", {
        threadId, input: [{ type: "text", text: input.prompt }], effort: selection.effort,
        outputSchema: input.job.agentType === "retrospective" ? retrospectiveOutputSchema : agentOutputSchema
      });
      turnId = turn.turn.id;
      await this.options.repos.development.executions.update(input.job.projectId, executionId, { turnId });
      const deadline = input.deadlineAt ? Date.parse(input.deadlineAt) : Date.now() + 30 * 60_000;
      cancellationTimer = setInterval(() => {
        void Promise.resolve(input.isCanceled?.()).then((canceled) => {
          if (canceled || Date.now() >= deadline || questions.length) return interrupt();
        }).catch(() => { void interrupt(); });
      }, 500);
      const completed = await completion;
      finished = true;
      await activityQueue;
      if (activityError) throw activityError;
      if (completed.status === "failed" && !performedWork && isUnavailableModel(completed.error?.message ?? "")) throw new Error(completed.error?.message);
      const result: AgentRunResult = questions.length
        ? { status: "waiting_human", message: questions.join("\n"), questions, stopReason: "waiting_human" }
        : completed.status === "interrupted"
          ? Date.now() >= deadline
            ? { status: "failed", message: "Codex execution timed out.", stopReason: "timeout" }
            : { status: "canceled", message: "Codex execution stopped.", stopReason: "canceled" }
          : completed.status === "failed"
            ? { status: "failed", message: completed.error?.message ?? "Codex turn failed.", stopReason: "failed" }
            : extractAgentRunResult(finalText, "Codex");
      await this.options.repos.development.executions.update(input.job.projectId, executionId, { resolvedModel: model, usage, status: result.status, finishedAt: new Date().toISOString() });
      return { ...result, metadata: { ...result.metadata, providerExecution: { model, sessionId: threadId, turnId, resumedSession, usage } } };
    } catch (error) {
      if (executionId !== null) await this.options.repos.development.executions.update(input.job.projectId, executionId, { resolvedModel: model, threadId, turnId, status: "failed", finishedAt: new Date().toISOString() });
      const message = error instanceof Error ? error.message : String(error);
      if (executionId !== null && !performedWork && isUnavailableModel(message) && Number(input.job.input.modelFallbacks ?? 0) < 2) {
        const attempts = await this.options.repos.development.executions.list(input.job.projectId, input.job.id);
        const rejected = attempts.at(-1)?.selectedModel;
        if (rejected) this.unavailableModels.set(rejected, Date.now() + 15 * 60_000);
        emit({ type: "system", title: "Model unavailable; selecting another", body: message, payload: { rejectedModel: rejected, executionId } });
        await rpc.closeAndDrain();
        await activityQueue;
        return this.run({ ...input, job: { ...input.job, input: { ...input.job.input, modelFallbacks: Number(input.job.input.modelFallbacks ?? 0) + 1 } } });
      }
      throw error;
    } finally {
      if (cancellationTimer) clearInterval(cancellationTimer);
      unsubscribe?.();
      await rpc.closeAndDrain();
      await activityQueue;
    }
  }

  private connect(cwd?: string): CodexRpc { return (this.options.createRpc ?? ((command, path) => new CodexRpc(command, path)))(this.options.command, cwd); }
  private async models(rpc: CodexRpc): Promise<CodexModel[]> {
    if (this.cachedModels && Date.now() - this.cachedModels.at < 5 * 60_000) return this.cachedModels.models;
    try {
      const models = await listCodexModels(rpc);
      this.cachedModels = { at: Date.now(), models };
      return models;
    } catch (error) {
      if (this.cachedModels && Date.now() - this.cachedModels.at < 60 * 60_000) return this.cachedModels.models;
      throw error;
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function isUnavailableModel(message: string): boolean { return /model.*(not found|not supported|unavailable|does not exist|do not have access)/i.test(message); }

function activityForItem(item: Record<string, unknown>, completed: boolean): AgentActivityResult | null {
  if (item.type === "commandExecution") return {
    type: completed && item.exitCode !== 0 && item.exitCode != null ? "error" : "command",
    title: completed ? "Codex command completed" : "Codex command started",
    body: [item.command, item.aggregatedOutput].filter(Boolean).join("\n").slice(-8_000),
    payload: { command: item.command, cwd: item.cwd, status: item.status, exitCode: item.exitCode, durationMs: item.durationMs }
  };
  if (item.type === "fileChange") return { type: "file_change", title: completed ? "Codex file change completed" : "Codex file change started", body: JSON.stringify(item.changes ?? []).slice(0, 8_000) };
  if (item.type === "reasoning" && completed && Array.isArray(item.summary)) return { type: "thinking", title: "Codex thinking summary", body: item.summary.join("\n") };
  return null;
}

const retrospectiveOutputSchema = {
  type: "object", additionalProperties: false, required: ["status", "message", "metadata"], properties: {
    status: { type: "string", enum: ["succeeded", "failed", "waiting_human"] }, message: { type: "string" },
    metadata: { type: "object", additionalProperties: false, required: ["retrospective"], properties: {
      retrospective: { type: "object", additionalProperties: false, required: ["body", "changes"], properties: {
        body: { type: "string" }, changes: { type: "array", items: {
          type: "object", additionalProperties: false, required: ["path", "beforeHash", "body", "reason"], properties: {
            path: { type: "string" }, beforeHash: { type: ["string", "null"] }, body: { type: ["string", "null"] }, reason: { type: "string" }
          }
        } }
      } }
    } }
  }
};
