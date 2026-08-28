import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { ActivityType } from "../../shared/types";
import type { AgentAdapter, AgentActivityResult, AgentRunResult } from "./types";

export type CodexAdapterOptions = {
  command: string;
  model?: string;
  loadOptions?: () => Promise<Partial<Pick<CodexAdapterOptions, "command" | "model">>>;
};

export function extractAgentRunResult(text: string, fallbackName = "Agent"): AgentRunResult {
  const trimmed = text.trim();
  const parsed = parseAgentRunResult(trimmed);
  if (parsed) {
    return parsed;
  }

  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenced) {
    const parsedFenced = parseAgentRunResult(fenced[1]);
    if (parsedFenced) {
      return parsedFenced;
    }
  }

  return {
    status: "succeeded",
    message: trimmed || `${fallbackName} completed without a structured response.`,
    activities: [
      {
        type: "progress",
        title: `${fallbackName} response captured`,
        body: trimmed
      }
    ]
  };
}

function parseAgentRunResult(candidate: string): AgentRunResult | null {
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (typeof parsed === "string") {
      return parseAgentRunResult(parsed);
    }
    return isRecord(parsed) ? (parsed as AgentRunResult) : null;
  } catch {
    return null;
  }
}

export class CodexAdapter implements AgentAdapter {
  constructor(private readonly options: CodexAdapterOptions) {}

  async run(input: Parameters<AgentAdapter["run"]>[0]): Promise<AgentRunResult> {
    const options = await this.resolveOptions();
    const command = resolveCommand(options.command);
    const tempDir = await mkdtemp(join(tmpdir(), "oneteam-codex-"));
    const lastMessagePath = join(tempDir, "last-message.txt");
    const outputSchemaPath = join(tempDir, "agent-output.schema.json");
    await writeFile(outputSchemaPath, JSON.stringify(agentOutputSchema, null, 2), "utf8");

    const resumeSessionId = resumableCodexSessionId(input.job);
    const args = [
      "exec",
      ...(resumeSessionId ? ["resume"] : []),
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      ...(!resumeSessionId ? ["--cd", input.repoPath] : []),
      "--output-schema",
      outputSchemaPath,
      "--output-last-message",
      lastMessagePath
    ];

    if (options.model) {
      args.push("--model", options.model);
    }

    if (resumeSessionId) args.push(resumeSessionId);
    args.push("-");

    await input.onActivity?.({
      type: "command",
      title: "Started Codex CLI",
      body: `${command} ${args.join(" ")}`,
      payload: {
        command,
        args,
        cwd: input.repoPath,
        resumeSessionId
      }
    });

    try {
      let activityQueue = Promise.resolve();
      let activityError: unknown = null;
      const telemetry: CodexTelemetry = { sessionId: resumeSessionId, resumedSession: Boolean(resumeSessionId), usage: null };
      const enqueueActivity = (activity: AgentActivityResult) => {
        activityQueue = activityQueue.then(async () => {
          try {
            await input.onActivity?.(activity);
          } catch (error) {
            activityError ??= error;
          }
        });
      };

      const { stdout, stderr, exitCode, canceled } = await runProcess(command, args, input.prompt, {
        cwd: input.repoPath,
        onStdoutLine: (line) => {
          captureCodexTelemetry(line, telemetry);
          const activity = parseCodexJsonLine(line);
          if (activity) {
            enqueueActivity(activity);
          }
        },
        isCanceled: input.isCanceled
      });
      await activityQueue;
      if (activityError) {
        throw activityError;
      }

      if (canceled) {
        return {
          status: "canceled",
          message: "Codex CLI execution was canceled.",
          stopReason: "canceled",
          evidence: [
            {
              type: "system",
              title: "Codex CLI canceled",
              summary: "The running Codex process was terminated after the job was canceled.",
              payload: null
            }
          ],
          activities: [
            {
              type: "system",
              title: "Codex CLI canceled",
              body: "The running Codex process was terminated after the job was canceled."
            }
          ],
          metadata: {
            providerExecution: providerExecutionMetadata(options.model ?? null, telemetry)
          }
        };
      }

      const failureMessage = exitCode === 0 ? undefined : codexFailureMessage(exitCode, stdout, stderr);

      await input.onActivity?.({
        type: exitCode === 0 ? "progress" : "error",
        title: exitCode === 0 ? "Codex CLI completed" : "Codex CLI failed",
        body: exitCode === 0 ? completionBody(stderr) : failureMessage,
        payload: {
          exitCode,
          stdoutTail: stdout.slice(-4000),
          stderrTail: stderr.slice(-4000)
        }
      });

      if (exitCode !== 0) {
        return {
          status: "failed",
          message: failureMessage ?? `Codex CLI failed with exit code ${exitCode}`,
          stopReason: "failed",
          evidence: [
            {
              type: "command",
              title: "Codex CLI failed",
              summary: failureMessage ?? `Codex CLI failed with exit code ${exitCode}`,
              payload: {
                exitCode
              }
            }
          ],
          activities: [],
          metadata: {
            providerExecution: providerExecutionMetadata(options.model ?? null, telemetry)
          }
        };
      }

      const finalMessage = await readFile(lastMessagePath, "utf8").catch(() => stdout);
      const result = extractAgentRunResult(finalMessage, "Codex");
      return {
        ...result,
        metadata: {
          ...(result.metadata ?? {}),
          providerExecution: providerExecutionMetadata(options.model ?? null, telemetry)
        }
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  private async resolveOptions(): Promise<Pick<CodexAdapterOptions, "command" | "model">> {
    const loaded = await this.options.loadOptions?.();
    return {
      command: loaded?.command ?? this.options.command,
      model: loaded?.model ?? this.options.model
    };
  }
}

type CodexTelemetry = {
  sessionId: string | null;
  resumedSession: boolean;
  usage: Record<string, unknown> | null;
};

function resumableCodexSessionId(job: Parameters<AgentAdapter["run"]>[0]["job"]): string | null {
  if (job.aiProvider !== "codex" || job.waitReason !== "provider_quota_exhausted") return null;
  const sessionId = job.waitMetadata?.sessionId;
  return typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : null;
}

function captureCodexTelemetry(line: string, telemetry: CodexTelemetry): void {
  try {
    const event = JSON.parse(line.trim()) as unknown;
    if (!isRecord(event)) {
      return;
    }
    if (event.type === "thread.started" && typeof event.thread_id === "string") {
      telemetry.sessionId = event.thread_id;
    }
    if ((event.type === "turn.completed" || event.type === "turn.failed") && isRecord(event.usage)) {
      telemetry.usage = event.usage;
    }
  } catch {
    // Non-JSON stdout is handled by the normal CLI failure parser.
  }
}

function providerExecutionMetadata(model: string | null, telemetry: CodexTelemetry) {
  return {
    model,
    sessionId: telemetry.sessionId,
    resumedSession: telemetry.resumedSession,
    usage: telemetry.usage
  };
}

const activityTypes = new Set<ActivityType>(["thinking", "progress", "command", "file_change", "test", "error", "system"]);
const stopReasons = [
  "passed",
  "failed",
  "waiting_human",
  "timeout",
  "max_rounds_exceeded",
  "budget_exceeded",
  "risk_detected",
  "rollback_required",
  "canceled"
] as const;

export const agentOutputSchema = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["succeeded", "waiting_human", "failed"]
    },
    message: {
      type: "string"
    },
    comment: {
      anyOf: [
        {
          type: "object",
          properties: {
            targetType: {
              type: "string",
              enum: ["issue", "pull_request"]
            },
            targetId: {
              type: "number"
            },
            body: {
              type: "string"
            },
            bodyFormat: {
              type: ["string", "null"],
              enum: ["markdown", "html", null]
            }
          },
          required: ["targetType", "targetId", "body", "bodyFormat"],
          additionalProperties: false
        },
        {
          type: "null"
        }
      ]
    },
    questions: {
      anyOf: [
        {
          type: "array",
          items: {
            type: "string"
          }
        },
        {
          type: "null"
        }
      ]
    },
    activities: {
      anyOf: [
        {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: Array.from(activityTypes)
              },
              title: {
                type: "string"
              },
              body: {
                type: ["string", "null"]
              },
              payload: {
                anyOf: [
                  {
                    type: "object",
                    properties: {},
                    required: [],
                    additionalProperties: false
                  },
                  {
                    type: "null"
                  }
                ]
              }
            },
            required: ["type", "title", "body", "payload"],
            additionalProperties: false
          }
        },
        {
          type: "null"
        }
      ]
    },
    changedFiles: {
      anyOf: [
        {
          type: "array",
          items: {
            type: "string"
          }
        },
        {
          type: "null"
        }
      ]
    },
    testResults: {
      anyOf: [
        {
          type: "array",
          items: {
            type: "object",
            properties: {
              command: {
                type: ["string", "null"]
              },
              status: {
                type: ["string", "null"]
              },
              exitCode: {
                type: ["number", "null"]
              },
              output: {
                type: ["string", "null"]
              }
            },
            required: ["command", "status", "exitCode", "output"],
            additionalProperties: false
          }
        },
        {
          type: "null"
        }
      ]
    },
    stopReason: {
      anyOf: [
        {
          type: "string",
          enum: Array.from(stopReasons)
        },
        {
          type: "null"
        }
      ]
    },
    evidence: {
      anyOf: [
        {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string"
              },
              title: {
                type: "string"
              },
              summary: {
                type: ["string", "null"]
              },
              payload: {
                anyOf: [
                  {
                    type: "object",
                    properties: {},
                    required: [],
                    additionalProperties: false
                  },
                  {
                    type: "object",
                    properties: {
                      artifact: {
                        type: "object",
                        properties: {
                          kind: {
                            type: "string",
                            enum: ["image"]
                          },
                          path: {
                            type: "string"
                          },
                          caption: {
                            type: ["string", "null"]
                          }
                        },
                        required: ["kind", "path", "caption"],
                        additionalProperties: false
                      }
                    },
                    required: ["artifact"],
                    additionalProperties: false
                  },
                  {
                    type: "null"
                  }
                ]
              }
            },
            required: ["type", "title", "summary", "payload"],
            additionalProperties: false
          }
        },
        {
          type: "null"
        }
      ]
    },
    metadata: {
      anyOf: [
        {
          type: "object",
          properties: {
            nextLabel: {
              type: ["string", "null"]
            },
            goalContract: {
              anyOf: [
                {
                  type: "object",
                  properties: {
                    evidenceRequired: {
                      anyOf: [
                        {
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              type: {
                                type: "string",
                                enum: [
                                  "test",
                                  "lint",
                                  "build",
                                  "command",
                                  "screenshot",
                                  "ui_snapshot",
                                  "file_change",
                                  "diff_summary",
                                  "performance",
                                  "ci_status",
                                  "review",
                                  "qa",
                                  "verifier"
                                ]
                              },
                              required: {
                                type: "boolean"
                              },
                              commitScope: {
                                type: "string",
                                enum: ["source", "target", "both", "none"]
                              },
                              maxAgeHours: {
                                type: ["number", "null"]
                              }
                            },
                            required: ["type", "required", "commitScope", "maxAgeHours"],
                            additionalProperties: false
                          }
                        },
                        {
                          type: "null"
                        }
                      ]
                    }
                  },
                  required: ["evidenceRequired"],
                  additionalProperties: false
                },
                {
                  type: "null"
                }
              ]
            },
            pullRequest: {
              anyOf: [
                {
                  type: "object",
                  properties: {
                    title: {
                      type: "string"
                    },
                    body: {
                      type: ["string", "null"]
                    },
                    sourceBranch: {
                      type: "string"
                    },
                    targetBranch: {
                      type: "string"
                    },
                    issueId: {
                      type: ["number", "null"]
                    }
                  },
                  required: ["title", "body", "sourceBranch", "targetBranch", "issueId"],
                  additionalProperties: false
                },
                {
                  type: "null"
                }
              ]
            },
            review: {
              anyOf: [
                {
                  type: "object",
                  properties: {
                    verdict: {
                      type: ["string", "null"]
                    },
                    findings: {
                      anyOf: [
                        {
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              severity: {
                                type: ["string", "null"]
                              },
                              path: {
                                type: ["string", "null"]
                              },
                              line: {
                                type: ["number", "null"]
                              },
                              title: {
                                type: ["string", "null"]
                              },
                              body: {
                                type: ["string", "null"]
                              }
                            },
                            required: ["severity", "path", "line", "title", "body"],
                            additionalProperties: false
                          }
                        },
                        {
                          type: "null"
                        }
                      ]
                    },
                    checked: {
                      anyOf: [
                        {
                          type: "array",
                          items: {
                            type: "string"
                          }
                        },
                        {
                          type: "null"
                        }
                      ]
                    }
                  },
                  required: ["verdict", "findings", "checked"],
                  additionalProperties: false
                },
                {
                  type: "null"
                }
              ]
            },
            fix: {
              anyOf: [
                {
                  type: "object",
                  properties: {
                    resolvedFindings: {
                      anyOf: [
                        {
                          type: "array",
                          items: {
                            type: "string"
                          }
                        },
                        {
                          type: "null"
                        }
                      ]
                    },
                    conflictVerification: {
                      anyOf: [
                        {
                          type: "object",
                          properties: {},
                          required: [],
                          additionalProperties: false
                        },
                        {
                          type: "null"
                        }
                      ]
                    }
                  },
                  required: ["resolvedFindings", "conflictVerification"],
                  additionalProperties: false
                },
                {
                  type: "null"
                }
              ]
            },
            qa: {
              anyOf: [
                {
                  type: "object",
                  properties: {
                    verdict: {
                      type: ["string", "null"]
                    },
                    defects: {
                      anyOf: [
                        {
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              severity: {
                                type: ["string", "null"]
                              },
                              path: {
                                type: ["string", "null"]
                              },
                              title: {
                                type: ["string", "null"]
                              },
                              body: {
                                type: ["string", "null"]
                              }
                            },
                            required: ["severity", "path", "title", "body"],
                            additionalProperties: false
                          }
                        },
                        {
                          type: "null"
                        }
                      ]
                    },
                    observations: {
                      anyOf: [
                        {
                          type: "array",
                          items: {
                            type: "string"
                          }
                        },
                        {
                          type: "null"
                        }
                      ]
                    }
                  },
                  required: ["verdict", "defects", "observations"],
                  additionalProperties: false
                },
                {
                  type: "null"
                }
              ]
            },
            verifier: {
              anyOf: [
                {
                  type: "object",
                  properties: {
                    verdict: {
                      type: ["string", "null"]
                    },
                    stopConditionMet: {
                      type: ["boolean", "null"]
                    },
                    missingEvidence: {
                      anyOf: [
                        {
                          type: "array",
                          items: {
                            type: "string"
                          }
                        },
                        {
                          type: "null"
                        }
                      ]
                    },
                    notes: {
                      anyOf: [
                        {
                          type: "array",
                          items: {
                            type: "string"
                          }
                        },
                        {
                          type: "null"
                        }
                      ]
                    }
                  },
                  required: ["verdict", "stopConditionMet", "missingEvidence", "notes"],
                  additionalProperties: false
                },
                {
                  type: "null"
                }
              ]
            }
          },
          required: ["nextLabel", "goalContract", "pullRequest", "review", "fix", "qa", "verifier"],
          additionalProperties: false
        },
        {
          type: "null"
        }
      ]
    }
  },
  required: [
    "status",
    "message",
    "comment",
    "questions",
    "activities",
    "changedFiles",
    "testResults",
    "stopReason",
    "evidence",
    "metadata"
  ],
  additionalProperties: false
} as const;

function resolveCommand(command: string): string {
  if (command.includes("/") || command.includes("\\")) {
    return isAbsolute(command) ? command : resolve(process.cwd(), command);
  }
  return command;
}

function parseCodexJsonLine(line: string): AgentActivityResult | null {
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

  const eventType = stringValue(event.type);
  if (!eventType) {
    return null;
  }

  if (eventType === "thread.started") {
    return {
      type: "system",
      title: "Codex thread started",
      body: stringValue(event.thread_id),
      payload: event
    };
  }

  if (eventType === "turn.started") {
    return {
      type: "progress",
      title: "Codex turn started",
      payload: event
    };
  }

  if (eventType === "turn.completed") {
    return {
      type: "progress",
      title: "Codex turn completed",
      body: formatUsage(event.usage),
      payload: event
    };
  }

  if (eventType === "turn.failed" || eventType === "error") {
    return {
      type: "error",
      title: eventType === "turn.failed" ? "Codex turn failed" : "Codex error",
      body: visibleText(event.error) ?? stringValue(event.message),
      payload: event
    };
  }

  if (eventType === "item.started" || eventType === "item.completed") {
    return activityFromCodexItem(event.item, eventType);
  }

  return null;
}

function activityFromCodexItem(value: unknown, eventType: string): AgentActivityResult | null {
  if (!isRecord(value)) {
    return null;
  }

  const itemType = stringValue(value.type);
  if (itemType === "agent_message") {
    return null;
  }

  const status = stringValue(value.status);
  const exitCode = numberValue(value.exit_code) ?? numberValue(value.exitCode);
  const command = stringValue(value.command) ?? stringValue(value.cmd);
  const text = truncate(visibleText(value), 4000);
  const isCompleted = eventType === "item.completed";
  const failed = (typeof exitCode === "number" && exitCode !== 0) || status === "failed";

  if (command || itemType?.includes("command") || itemType?.includes("exec")) {
    return {
      type: failed ? "error" : "command",
      title: isCompleted ? "Codex command completed" : "Codex command started",
      body: [command, status ? `status: ${status}` : null, typeof exitCode === "number" ? `exit code: ${exitCode}` : null, text]
        .filter(Boolean)
        .join("\n"),
      payload: value
    };
  }

  if (itemType === "reasoning") {
    return {
      type: "thinking",
      title: "Codex thinking summary",
      body: text,
      payload: value
    };
  }

  if (itemType?.includes("patch") || itemType?.includes("file")) {
    return {
      type: "file_change",
      title: isCompleted ? "Codex file change completed" : "Codex file change started",
      body: text,
      payload: value
    };
  }

  if (text) {
    return {
      type: "progress",
      title: `Codex ${itemType ?? "item"} ${isCompleted ? "completed" : "started"}`,
      body: text,
      payload: value
    };
  }

  return null;
}

function formatUsage(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const parts = [
    ["input", numberValue(value.input_tokens)],
    ["cached", numberValue(value.cached_input_tokens)],
    ["output", numberValue(value.output_tokens)],
    ["reasoning", numberValue(value.reasoning_output_tokens)]
  ]
    .filter(([, amount]) => typeof amount === "number")
    .map(([label, amount]) => `${label}: ${amount}`);

  return parts.length ? parts.join(", ") : undefined;
}

function completionBody(stderr: string): string {
  return stderr.trim()
    ? "Codex completed successfully. Non-fatal CLI warnings were captured in the activity payload."
    : "Codex completed successfully.";
}

function codexFailureMessage(exitCode: number, stdout: string, stderr: string): string {
  const structuredError = structuredCodexError(stdout);
  if (structuredError) {
    return structuredError;
  }

  const fallback = stderr.trim() || stdout.trim();
  return truncate(fallback, 4000) ?? `Codex CLI failed with exit code ${exitCode}`;
}

function structuredCodexError(stdout: string): string | undefined {
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

      const eventType = stringValue(event.type);
      if (eventType !== "turn.failed" && eventType !== "error") {
        continue;
      }

      const message = visibleText(event.error) ?? stringValue(event.message);
      if (message) {
        return message;
      }
    } catch {
      continue;
    }
  }

  return undefined;
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
    visibleText(value.content) ??
    visibleText(value.output)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function truncate(value: string | undefined, maxLength: number): string | undefined {
  if (!value || value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}

async function runProcess(
  command: string,
  args: string[],
  stdin: string,
  callbacks: {
    cwd?: string;
    onStdoutLine?: (line: string) => void;
    isCanceled?: () => Promise<boolean> | boolean;
  } = {}
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  canceled: boolean;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: callbacks.cwd,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let stdoutBuffer = "";
    let canceled = false;
    let closed = false;
    let killTimer: NodeJS.Timeout | null = null;

    const cancelTimer = callbacks.isCanceled
      ? setInterval(() => {
          void checkCancellation().catch(recordCancellationError);
        }, 1000)
      : null;
    cancelTimer?.unref();

    async function checkCancellation() {
      if (closed || canceled || !callbacks.isCanceled) {
        return;
      }

      if (await callbacks.isCanceled()) {
        if (closed || canceled) {
          return;
        }
        canceled = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          if (!closed) {
            child.kill("SIGKILL");
          }
        }, 5000);
        killTimer.unref();
      }
    }

    function recordCancellationError(error: unknown) {
      stderr += `\nCancellation check failed: ${error instanceof Error ? error.message : String(error)}`;
    }

    void checkCancellation().catch(recordCancellationError);

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      stdoutBuffer += text;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        callbacks.onStdoutLine?.(line);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      closed = true;
      if (cancelTimer) {
        clearInterval(cancelTimer);
      }
      if (killTimer) {
        clearTimeout(killTimer);
      }
      reject(error);
    });
    child.on("close", (exitCode) => {
      closed = true;
      if (cancelTimer) {
        clearInterval(cancelTimer);
      }
      if (killTimer) {
        clearTimeout(killTimer);
      }
      if (stdoutBuffer) {
        callbacks.onStdoutLine?.(stdoutBuffer);
      }
      resolve({
        stdout,
        stderr,
        exitCode: exitCode ?? 1,
        canceled
      });
    });

    child.stdin.end(stdin);
  });
}
