import type { Repositories } from "../db/repositories";
import { agentOutputSchema, classifyCodexRateLimitSnapshot, extractAgentRunResult } from "./codex-adapter";
import { CodexRpc, listCodexModels, type CodexModel, type RpcMessage } from "./codex-rpc";
import { assertAutomaticModelFallback, modelSelectionCandidates, selectTaskModel } from "./model-router";
import { requestedJobModel } from "../services/model-settings";
import { autonomyInstructions, humanHandoffSchema, type HumanHandoff } from "./autonomy-policy";
import type { AgentAdapter, AgentActivityResult, AgentRunResult, ProviderCapacityProbeResult } from "./types";

export type ModelSelection = { model: string; effort: string | null; reason: string; policyVersion: string };
export type ModelSelector = (models: CodexModel[], input: Parameters<AgentAdapter["run"]>[0]) => Promise<ModelSelection> | ModelSelection;
export const codexModelCatalogKey = "codex:model-catalog";

export class CodexRuntime implements AgentAdapter {
  private unlistedModelRejections = new Map<string, number>();

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
    return this.runAttempt(input, new Set());
  }

  private async runAttempt(input: Parameters<AgentAdapter["run"]>[0], rejectedModels: Set<string>): Promise<AgentRunResult> {
    await this.options.ensureReady?.();
    const rpc = this.connect(input.repoPath);
    let executionId: number | null = null;
    let threadId: string | null = null;
    let turnId: string | null = null;
    let model: string | null = null;
    let selectedModel: string | null = null;
    let selectedFromCatalog = true;
    let usage: Record<string, unknown> | null = null;
    let performedWork = false;
    let rerouted = false;
    const previousExecutions = await this.options.repos.development.executions.list(input.job.projectId, input.job.id);
    const previous = previousExecutions.at(-1);
    const resumeId = typeof input.job.waitMetadata?.sessionId === "string" ? input.job.waitMetadata.sessionId : previous?.threadId;
    const resumedSession = Boolean(resumeId);
    const requestedModel = await requestedJobModel(this.options.repos, input.job);
    const earlier = previousExecutions.filter((execution) => execution.threadId === resumeId);
    const hasKnownBaseline = !resumeId || earlier.length > 0 && earlier.every((execution) => execution.usage?.costBasis === "turn_total");
    const baseline = (key: string) => earlier.reduce((sum, execution) => sum + Number(execution.usage?.[key] ?? 0), 0);
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
      const catalog = await listCodexModels(rpc);
      await this.options.repos.settings.set(codexModelCatalogKey, {
        source: "codex_app_server", fetchedAt: new Date().toISOString(), models: catalog
      });
      const listedModels = new Set(catalog.map((candidate) => candidate.model));
      const models = modelSelectionCandidates(catalog).filter((candidate) => !rejectedModels.has(candidate.model)
        && (candidate.model === requestedModel || listedModels.has(candidate.model) || (this.unlistedModelRejections.get(candidate.model) ?? 0) <= Date.now()));
      if (!models.length) throw new Error("Codex did not return any available models. Reconnect and retry.");
      const selection = this.options.selectModel
        ? await this.options.selectModel(models, input)
        : selectTaskModel(models, { text: input.prompt, fileCount: 0, qualityFailures: Number(input.job.input.qualityFailures ?? 0), role: input.job.agentType });
      if (!requestedModel) {
        const unavailable = new Set([...rejectedModels, ...[...this.unlistedModelRejections].filter(([id, until]) => !listedModels.has(id) && until > Date.now()).map(([id]) => id)]);
        assertAutomaticModelFallback(selection.model, unavailable);
        if (unavailable.size) selection.reason += ` Unavailable models excluded: ${[...unavailable].join(", ")}.`;
      }
      const candidate = models.find((entry) => entry.model === selection.model);
      if (!candidate) throw new Error("The selected Codex model is absent from the current catalog and reviewed candidates.");
      if (selection.effort !== null && !candidate.supportedReasoningEfforts.some((option) => option.reasoningEffort === selection.effort)) {
        throw new Error("The selected reasoning effort is unsupported by the current Codex model.");
      }
      selectedModel = selection.model;
      selectedFromCatalog = listedModels.has(selectedModel);
      await this.options.repos.development.setJobModel(input.job.projectId, input.job.id, selection.model);
      const execution = await this.options.repos.development.executions.create({
        projectId: input.job.projectId, jobId: input.job.id, selectedModel: selection.model,
        effort: selection.effort, selectionReason: selection.reason, policyVersion: selection.policyVersion
      });
      executionId = execution.id;
      emit({ type: "system", title: "Model selected", body: `${selection.model} · ${selection.effort ?? "default"}\n${selection.reason}`, payload: { ...selection, executionId } });
      const started = await rpc.request<{ thread: { id: string }; model: string }>(resumeId ? "thread/resume" : "thread/start", {
        ...(resumeId ? { threadId: resumeId } : {}), model: selection.model, modelProvider: "openai", cwd: input.repoPath,
        // Git worktrees write into the source repository's .git directory; project
        // tools also use user caches and local daemons outside the worktree.
        approvalPolicy: "never", sandbox: "danger-full-access"
      });
      threadId = started.thread.id;
      model = started.model;
      await this.options.repos.development.executions.update(input.job.projectId, executionId, { threadId, resolvedModel: model, status: "running" });
      emit({ type: "system", title: resumedSession ? "Codex thread resumed" : "Codex thread started", body: model, payload: { executionId, threadId, resolvedModel: model } });

      let finalText = "";
      let questions: string[] = [];
      let routineInputRequests = 0;
      let requiredApproval: HumanHandoff | null = null;
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
          rerouted = true;
          if (usage) usage = { ...usage, costBasis: "mixed_models" };
          model = String(params.toModel);
          const resolved = model;
          activityQueue = activityQueue.then(async () => {
            await this.options.repos.development.executions.update(input.job.projectId, executionId!, { resolvedModel: resolved });
            await this.options.repos.development.setJobModel(input.job.projectId, input.job.id, resolved);
          }).catch((error: unknown) => { activityError ??= error; });
          emit({ type: "system", title: "Codex model changed", body: `${params.fromModel} → ${params.toModel}: ${params.reason}`, payload: { ...params, executionId } });
        }
        if (message.method === "thread/tokenUsage/updated") {
          const tokenUsage = asRecord(params.tokenUsage);
          const total = asRecord(tokenUsage.total);
          const hasTotal = typeof total.inputTokens === "number" && typeof total.outputTokens === "number";
          const counts = hasTotal ? total : asRecord(tokenUsage.last);
          const delta = (source: string, key: string) => typeof counts[source] === "number" ? Math.max(0, Number(counts[source]) - (hasTotal && hasKnownBaseline ? baseline(key) : 0)) : undefined;
          usage = { input_tokens: delta("inputTokens", "input_tokens"), cached_input_tokens: delta("cachedInputTokens", "cached_input_tokens"),
            cache_write_input_tokens: delta("cacheWriteInputTokens", "cache_write_input_tokens"),
            output_tokens: delta("outputTokens", "output_tokens"), reasoning_output_tokens: delta("reasoningOutputTokens", "reasoning_output_tokens"),
            total_tokens: delta("totalTokens", "total_tokens"), costBasis: rerouted ? "mixed_models" : hasTotal && hasKnownBaseline ? "turn_total" : "partial_turn" };
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
          if (/requestApproval|execCommandApproval|applyPatchApproval/.test(message.method)) requiredApproval = {
            reason: "external_access", blocker: `The configured execution policy requires approval for ${message.method}.`,
            attemptedResolution: "The approval request was canceled without granting consent or bypassing the execution policy.",
            whyHumanRequired: "Only the user or policy administrator can grant this required permission."
          };
          if (message.method === "item/tool/requestUserInput" && input.job.input.developmentLoopId && routineInputRequests++ < 2) {
            // No option is selected or consent invented. Ask the agent to use its
            // existing autonomy instructions and return a justified structured stop.
            rpc.respond(message.id, { answers: {} });
            emit({ type: "system", title: "Interactive question deferred", body: "No user answer was supplied. Continue ordinary work or explain an indispensable blocker in the structured result." });
            return;
          }
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
        threadId, model: selection.model, input: [{ type: "text", text: `${input.prompt}\n\n${autonomyInstructions}` }], effort: selection.effort,
        serviceTierForTurn: "default",
        // Reapply for resumed threads so older filesystem/network restrictions do not persist.
        approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" },
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
        ? { status: "waiting_human", message: questions.join("\n"), questions, stopReason: "waiting_human", ...(requiredApproval ? { metadata: { humanHandoff: requiredApproval } } : {}) }
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
      const message = error instanceof Error ? error.message : String(error);
      if (executionId !== null) await this.options.repos.development.executions.update(input.job.projectId, executionId, { resolvedModel: model, threadId, turnId, usage, status: "failed", finishedAt: new Date().toISOString(),
        ...(isUnavailableModel(message) ? { selectionReason: `Model unavailable: ${message}` } : {}) });
      if (!requestedModel && selectedModel && !performedWork && isUnavailableModel(message) && rejectedModels.size < 10) {
        rejectedModels.add(selectedModel);
        // Avoid repeating an unavailable release probe for every Loop role. A new
        // catalog advertising the model bypasses this short, process-local cooldown.
        if (!selectedFromCatalog) this.unlistedModelRejections.set(selectedModel, Date.now() + 10 * 60_000);
        emit({ type: "system", title: "Model unavailable; selecting another", body: message, payload: { rejectedModel: selectedModel, executionId } });
        if (cancellationTimer) clearInterval(cancellationTimer);
        unsubscribe?.();
        await rpc.closeAndDrain();
        await activityQueue;
        return this.runAttempt(input, rejectedModels);
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
}

function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function isUnavailableModel(message: string): boolean { return /model[_ -]not[_ -]found|model.*(not found|not supported|unsupported|unavailable|does not exist|do not have access|not available)|(?:do not have access|not have access).*model/is.test(message); }

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
    metadata: { type: "object", additionalProperties: false, required: ["retrospective", "humanHandoff"], properties: {
      humanHandoff: humanHandoffSchema,
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
