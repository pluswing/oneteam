import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { LmStudioProviderSettings } from "../../shared/ai-providers";
import { addProviderUsage, emptyProviderUsage, normalizeProviderUsage } from "../../shared/provider-usage";
import type { AgentAdapter, AgentRunResult } from "./types";
import { agentOutputSchema, extractAgentRunResult } from "./codex-adapter";

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

type ToolCall = {
  id: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
};

type LmStudioResponse = {
  choices?: Array<{
    message?: ChatMessage;
  }>;
  error?: {
    message?: string;
  };
  usage?: Record<string, unknown>;
};

export type LmStudioAdapterOptions = LmStudioProviderSettings & {
  loadOptions?: () => Promise<Partial<LmStudioProviderSettings>>;
};

export class LmStudioAdapter implements AgentAdapter {
  constructor(private readonly options: LmStudioAdapterOptions) {}

  async run(input: Parameters<AgentAdapter["run"]>[0]): Promise<AgentRunResult> {
    const options = await this.resolveOptions();
    const baseUrl = normalizeBaseUrl(options.baseUrl);
    const model = options.model ?? (await resolveLmStudioModel(baseUrl));
    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "You are an autonomous local coding agent running inside OneTeam. Use tools to inspect and modify the repository. When the task is complete, return only the final AgentRunResult JSON."
      },
      {
        role: "user",
        content: input.prompt
      }
    ];
    let usage = { ...emptyProviderUsage };

    await input.onActivity?.({
      type: "system",
      title: "Started LM Studio",
      body: `${baseUrl} model=${model}`,
      payload: {
        baseUrl,
        model,
        maxToolRounds: options.maxToolRounds
      }
    });

    for (let round = 0; round < options.maxToolRounds; round += 1) {
      if (await input.isCanceled?.()) {
        return canceledResult(model, usage);
      }

      const completion = await chatCompletion(baseUrl, {
        model,
        messages,
        tools: toolDefinitions,
        temperature: options.temperature
      }, input.deadlineAt);
      usage = addProviderUsage(usage, normalizeProviderUsage(completion.usage));
      const message = completion.message;
      messages.push(message);

      if (!message.tool_calls?.length) {
        const content = message.content ?? "";
        if (content.trim()) {
          return withProviderExecution(extractAgentRunResult(content, "LM Studio"), model, usage);
        }
        break;
      }

      for (const toolCall of message.tool_calls) {
        if (await input.isCanceled?.()) {
          return canceledResult(model, usage);
        }
        const toolResult = await executeToolCall(input.repoPath, toolCall, input.deadlineAt);
        await input.onActivity?.({
          type: toolResult.activityType,
          title: toolResult.title,
          body: toolResult.summary,
          payload: toolResult.payload
        });
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(toolResult.response)
        });
      }
    }

    if (await input.isCanceled?.()) {
      return canceledResult(model, usage);
    }

    messages.push({
      role: "user",
      content:
        "Stop using tools and return the final AgentRunResult JSON now. Use null or empty arrays for fields that are not relevant."
    });
    const finalCompletion = await chatCompletion(baseUrl, {
      model,
      messages,
      responseFormat: {
        type: "json_schema",
        json_schema: {
          name: "oneteam_agent_result",
          strict: true,
          schema: agentOutputSchema
        }
      },
      temperature: options.temperature
    }, input.deadlineAt);
    usage = addProviderUsage(usage, normalizeProviderUsage(finalCompletion.usage));

    return withProviderExecution(
      extractAgentRunResult(finalCompletion.message.content ?? "", "LM Studio"),
      model,
      usage
    );
  }

  private async resolveOptions(): Promise<LmStudioProviderSettings> {
    const loaded = await this.options.loadOptions?.();
    return {
      baseUrl: loaded?.baseUrl ?? this.options.baseUrl,
      model: loaded?.model ?? this.options.model,
      maxToolRounds: loaded?.maxToolRounds ?? this.options.maxToolRounds,
      temperature: loaded?.temperature ?? this.options.temperature
    };
  }
}

const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List tracked and untracked files under the repository.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Optional directory relative to the repository root."
          }
        },
        required: [],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 file from the repository.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          maxBytes: { type: "number" }
        },
        required: ["path"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write a UTF-8 file inside the repository, creating parent directories as needed.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" }
        },
        required: ["path", "content"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a shell command in the repository and return stdout, stderr, and exit code.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeoutMs: { type: "number" }
        },
        required: ["command"],
        additionalProperties: false
      }
    }
  }
] as const;

async function chatCompletion(
  baseUrl: string,
  body: {
    model: string;
    messages: ChatMessage[];
    tools?: typeof toolDefinitions;
    responseFormat?: Record<string, unknown>;
    temperature?: number | null;
  },
  deadlineAt?: string | null
): Promise<{ message: ChatMessage; usage: Record<string, unknown> | null }> {
  const remainingMs = remainingDeadlineMs(deadlineAt);
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: body.model,
      messages: body.messages,
      tools: body.tools,
      response_format: body.responseFormat,
      temperature: body.temperature ?? undefined
    }),
    signal: remainingMs === null ? undefined : AbortSignal.timeout(remainingMs)
  });
  const payload = (await response.json().catch(() => null)) as LmStudioResponse | null;
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `LM Studio request failed: ${response.status}`);
  }
  const message = payload?.choices?.[0]?.message;
  if (!message) {
    throw new Error("LM Studio did not return a message.");
  }
  return { message, usage: payload?.usage ?? null };
}

async function resolveLmStudioModel(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/models`).catch(() => null);
  if (!response?.ok) {
    return "local-model";
  }
  const payload = (await response.json().catch(() => null)) as { data?: Array<{ id?: string }> } | null;
  return payload?.data?.find((model) => typeof model.id === "string" && model.id)?.id ?? "local-model";
}

async function executeToolCall(repoPath: string, toolCall: ToolCall, deadlineAt?: string | null): Promise<{
  activityType: "command" | "file_change" | "progress" | "error";
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  response: Record<string, unknown>;
}> {
  const name = toolCall.function?.name ?? "";
  const args = parseToolArgs(toolCall.function?.arguments);
  try {
    if (name === "list_files") {
      const subdir = typeof args.path === "string" ? args.path : ".";
      const cwd = resolveRepoPath(repoPath, subdir);
      const result = await runShellCommand("git ls-files --others --cached --exclude-standard", cwd, 15_000);
      const files = result.stdout
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 300);
      return toolSuccess("progress", "LM Studio listed files", `${files.length} file(s)`, { files });
    }

    if (name === "read_file") {
      const path = stringArg(args.path, "path");
      const maxBytes = typeof args.maxBytes === "number" ? Math.max(Math.min(args.maxBytes, 100_000), 1) : 40_000;
      const content = await readFile(resolveRepoPath(repoPath, path), "utf8");
      return toolSuccess("progress", `LM Studio read ${path}`, `${Math.min(content.length, maxBytes)} byte(s)`, {
        path,
        content: content.slice(0, maxBytes),
        truncated: content.length > maxBytes
      });
    }

    if (name === "write_file") {
      const path = stringArg(args.path, "path");
      const content = stringArg(args.content, "content");
      const target = resolveRepoPath(repoPath, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
      return toolSuccess("file_change", `LM Studio wrote ${path}`, `${content.length} byte(s)`, { path });
    }

    if (name === "run_command") {
      const command = stringArg(args.command, "command");
      const timeoutMs =
        typeof args.timeoutMs === "number" ? Math.max(1000, Math.min(args.timeoutMs, 300_000)) : 120_000;
      const remainingMs = remainingDeadlineMs(deadlineAt);
      const result = await runShellCommand(command, repoPath, remainingMs === null ? timeoutMs : Math.min(timeoutMs, remainingMs));
      return toolSuccess(result.exitCode === 0 ? "command" : "error", `LM Studio command ${result.exitCode === 0 ? "completed" : "failed"}`, command, {
        command,
        ...result
      });
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      activityType: "error",
      title: "LM Studio tool failed",
      summary: message,
      payload: {
        tool: name,
        args
      },
      response: {
        ok: false,
        error: message
      }
    };
  }
}

function toolSuccess(
  activityType: "command" | "file_change" | "progress" | "error",
  title: string,
  summary: string,
  payload: Record<string, unknown>
) {
  return {
    activityType,
    title,
    summary,
    payload,
    response: {
      ok: true,
      ...payload
    }
  };
}

function parseToolArgs(value: string | undefined): Record<string, unknown> {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function stringArg(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`Missing required tool argument: ${name}`);
  }
  return value;
}

function resolveRepoPath(repoPath: string, requestedPath: string): string {
  const root = resolve(repoPath);
  const resolved = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(root, requestedPath);
  const relativePath = relative(root, resolved);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Path is outside the repository: ${requestedPath}`);
  }
  if (relativePath === ".git" || relativePath.startsWith(".git/")) {
    throw new Error(`Path is protected: ${requestedPath}`);
  }
  return resolved;
}

async function runShellCommand(command: string, cwd: string, timeoutMs: number): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolveProcess) => {
    const child = spawn(process.platform === "win32" ? "cmd.exe" : "sh", process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        child.kill("SIGTERM");
      }
    }, timeoutMs);
    timer.unref();

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolveProcess({
        exitCode: 1,
        stdout: truncate(stdout, 12000),
        stderr: truncate(error instanceof Error ? error.message : String(error), 12000)
      });
    });
    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolveProcess({
        exitCode: exitCode ?? 1,
        stdout: truncate(stdout, 12000),
        stderr: truncate(stderr, 12000)
      });
    });
  });
}

function canceledResult(
  model: string,
  usage: ReturnType<typeof normalizeProviderUsage>
): AgentRunResult {
  return {
    status: "canceled",
    message: "LM Studio execution was canceled.",
    stopReason: "canceled",
    evidence: [
      {
        type: "system",
        title: "LM Studio canceled",
        summary: "The running LM Studio job was canceled.",
        payload: null
      }
    ],
    metadata: {
      providerExecution: providerExecutionMetadata(model, usage)
    }
  };
}

function withProviderExecution(
  result: AgentRunResult,
  model: string,
  usage: ReturnType<typeof normalizeProviderUsage>
): AgentRunResult {
  return {
    ...result,
    metadata: {
      ...(result.metadata ?? {}),
      providerExecution: providerExecutionMetadata(model, usage)
    }
  };
}

function providerExecutionMetadata(model: string, usage: ReturnType<typeof normalizeProviderUsage>) {
  return {
    model,
    sessionId: null,
    resumedSession: false,
    usage: { ...usage }
  };
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/$/, "");
}

function remainingDeadlineMs(deadlineAt: string | null | undefined): number | null {
  if (!deadlineAt) return null;
  return Math.max(1, Date.parse(deadlineAt) - Date.now());
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}
