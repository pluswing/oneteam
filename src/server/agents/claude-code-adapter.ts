import { isAbsolute, resolve } from "node:path";
import type { ClaudeCodePermissionMode } from "../../shared/ai-providers";
import type { AgentAdapter, AgentActivityResult, AgentRunResult } from "./types";
import { agentOutputSchema, extractAgentRunResult } from "./codex-adapter";
import { runAgentProcess } from "./process";

export type ClaudeCodeAdapterOptions = {
  command: string;
  model?: string | null;
  permissionMode?: ClaudeCodePermissionMode;
  maxTurns?: number | null;
  loadOptions?: () => Promise<Partial<Pick<ClaudeCodeAdapterOptions, "command" | "model" | "permissionMode" | "maxTurns">>>;
};

export class ClaudeCodeAdapter implements AgentAdapter {
  constructor(private readonly options: ClaudeCodeAdapterOptions) {}

  async run(input: Parameters<AgentAdapter["run"]>[0]): Promise<AgentRunResult> {
    const options = await this.resolveOptions();
    const command = resolveCommand(options.command);
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--json-schema",
      JSON.stringify(agentOutputSchema),
      "--permission-mode",
      options.permissionMode ?? "bypassPermissions",
      "--no-session-persistence"
    ];

    if (options.model) {
      args.push("--model", options.model);
    }
    if (options.maxTurns) {
      args.push("--max-turns", String(options.maxTurns));
    }

    await input.onActivity?.({
      type: "command",
      title: "Started Claude Code",
      body: `${command} ${args.map(shellQuote).join(" ")}`,
      payload: {
        command,
        args,
        cwd: input.repoPath
      }
    });

    let activityQueue = Promise.resolve();
    let activityError: unknown = null;
    const telemetry: ClaudeTelemetry = { sessionId: null, usage: null };
    const enqueueActivity = (activity: AgentActivityResult) => {
      activityQueue = activityQueue.then(async () => {
        try {
          await input.onActivity?.(activity);
        } catch (error) {
          activityError ??= error;
        }
      });
    };

    const { stdout, stderr, exitCode, canceled } = await runAgentProcess(command, args, input.prompt, {
      cwd: input.repoPath,
      isCanceled: input.isCanceled,
      onStdoutLine: (line) => {
        captureClaudeTelemetry(line, telemetry);
        const activity = parseClaudeJsonLine(line);
        if (activity) {
          enqueueActivity(activity);
        }
      }
    });
    await activityQueue;
    if (activityError) {
      throw activityError;
    }

    if (canceled) {
      return {
        status: "canceled",
        message: "Claude Code execution was canceled.",
        stopReason: "canceled",
        evidence: [
          {
            type: "system",
            title: "Claude Code canceled",
            summary: "The running Claude Code process was terminated after the job was canceled.",
            payload: null
          }
        ],
        activities: [
          {
            type: "system",
            title: "Claude Code canceled",
            body: "The running Claude Code process was terminated after the job was canceled."
          }
        ],
        metadata: {
          providerExecution: providerExecutionMetadata(options.model ?? null, telemetry)
        }
      };
    }

    await input.onActivity?.({
      type: exitCode === 0 ? "progress" : "error",
      title: exitCode === 0 ? "Claude Code completed" : "Claude Code failed",
      body: exitCode === 0 ? "Claude Code completed successfully." : claudeFailureMessage(exitCode, stdout, stderr),
      payload: {
        exitCode,
        stdoutTail: stdout.slice(-4000),
        stderrTail: stderr.slice(-4000)
      }
    });

    if (exitCode !== 0) {
      const message = claudeFailureMessage(exitCode, stdout, stderr);
      return {
        status: "failed",
        message,
        stopReason: "failed",
        evidence: [
          {
            type: "command",
            title: "Claude Code failed",
            summary: message,
            payload: { exitCode }
          }
        ],
        activities: [],
        metadata: {
          providerExecution: providerExecutionMetadata(options.model ?? null, telemetry)
        }
      };
    }

    const result = extractAgentRunResult(finalClaudeText(stdout), "Claude Code");
    return {
      ...result,
      metadata: {
        ...(result.metadata ?? {}),
        providerExecution: providerExecutionMetadata(options.model ?? null, telemetry)
      }
    };
  }

  private async resolveOptions(): Promise<Pick<ClaudeCodeAdapterOptions, "command" | "model" | "permissionMode" | "maxTurns">> {
    const loaded = await this.options.loadOptions?.();
    return {
      command: loaded?.command ?? this.options.command,
      model: loaded?.model ?? this.options.model,
      permissionMode: loaded?.permissionMode ?? this.options.permissionMode,
      maxTurns: loaded?.maxTurns ?? this.options.maxTurns
    };
  }
}

type ClaudeTelemetry = {
  sessionId: string | null;
  usage: Record<string, unknown> | null;
};

function captureClaudeTelemetry(line: string, telemetry: ClaudeTelemetry): void {
  try {
    const event = JSON.parse(line) as unknown;
    if (!isRecord(event)) return;
    telemetry.sessionId = stringValue(event.session_id) ?? stringValue(event.sessionId) ?? telemetry.sessionId;
    const usage = isRecord(event.usage) ? event.usage : null;
    const totalCostUsd = typeof event.total_cost_usd === "number" ? event.total_cost_usd : null;
    if (usage || totalCostUsd !== null) {
      telemetry.usage = {
        ...(telemetry.usage ?? {}),
        ...(usage ?? {}),
        ...(totalCostUsd === null ? {} : { total_cost_usd: totalCostUsd })
      };
    }
  } catch {
    // Non-JSON stdout is still handled by the result parser.
  }
}

function providerExecutionMetadata(model: string | null, telemetry: ClaudeTelemetry) {
  return {
    model,
    sessionId: telemetry.sessionId,
    resumedSession: false,
    usage: telemetry.usage
  };
}

function parseClaudeJsonLine(line: string): AgentActivityResult | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  let event: Record<string, unknown>;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    event = parsed;
  } catch {
    return null;
  }

  const eventType = stringValue(event.type) ?? stringValue(event.event) ?? "event";
  const subtype = stringValue(event.subtype);
  const message = isRecord(event.message) ? event.message : null;
  const content = visibleText(event.result) ?? visibleText(event.content) ?? visibleText(message?.content) ?? visibleText(event);

  if (eventType === "system" || subtype === "init") {
    return {
      type: "system",
      title: "Claude Code session started",
      body: content,
      payload: event
    };
  }

  if (eventType === "assistant") {
    const toolText = toolUseText(message?.content ?? event.content);
    if (toolText) {
      return {
        type: "command",
        title: "Claude Code tool use",
        body: toolText,
        payload: event
      };
    }
    return content
      ? {
          type: "progress",
          title: "Claude Code message",
          body: truncate(content, 4000),
          payload: event
        }
      : null;
  }

  if (eventType === "result") {
    return {
      type: subtype === "error" ? "error" : "progress",
      title: subtype === "error" ? "Claude Code result error" : "Claude Code result",
      body: truncate(content, 4000),
      payload: event
    };
  }

  if (content) {
    return {
      type: eventType.includes("error") ? "error" : "progress",
      title: `Claude Code ${eventType}`,
      body: truncate(content, 4000),
      payload: event
    };
  }

  return null;
}

function finalClaudeText(stdout: string): string {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as unknown;
      if (!isRecord(event)) {
        continue;
      }
      const result = stringValue(event.result);
      if (result) {
        return result;
      }
      const message = isRecord(event.message) ? visibleText(event.message.content) : null;
      if (message) {
        return message;
      }
    } catch {
      continue;
    }
  }
  return stdout;
}

function claudeFailureMessage(exitCode: number, stdout: string, stderr: string): string {
  const result = finalClaudeText(stdout).trim();
  const fallback = stderr.trim() || result;
  return truncate(fallback, 4000) || `Claude Code failed with exit code ${exitCode}`;
}

function toolUseText(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const tools = value
    .filter(isRecord)
    .filter((item) => stringValue(item.type) === "tool_use")
    .map((item) => stringValue(item.name) ?? stringValue(item.id))
    .filter(Boolean);
  return tools.length ? tools.join("\n") : null;
}

function resolveCommand(command: string): string {
  if (command.includes("/") || command.includes("\\")) {
    return isAbsolute(command) ? command : resolve(process.cwd(), command);
  }
  return command;
}

function visibleText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const text = value.map((item) => visibleText(item)).filter(Boolean).join("\n");
    return text || undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  return (
    stringValue(value.text) ??
    stringValue(value.message) ??
    stringValue(value.summary) ??
    stringValue(value.result) ??
    visibleText(value.content)
  );
}

function shellQuote(value: string): string {
  return /[\s"'\\]/.test(value) ? JSON.stringify(value) : value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(value: string | undefined, maxLength: number): string | undefined {
  if (!value || value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}
