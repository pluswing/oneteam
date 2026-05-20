import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, AgentRunResult } from "./types";

export type CodexAdapterOptions = {
  command: string;
  model?: string;
  loadOptions?: () => Promise<Partial<Pick<CodexAdapterOptions, "command" | "model">>>;
};

function extractJson(text: string): AgentRunResult {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = fenced?.[1] ?? trimmed;

  try {
    return JSON.parse(candidate) as AgentRunResult;
  } catch {
    return {
      status: "succeeded",
      message: trimmed || "Codex completed without a structured response.",
      activities: [
        {
          type: "progress",
          title: "Codex response captured",
          body: trimmed
        }
      ]
    };
  }
}

export class CodexAdapter implements AgentAdapter {
  constructor(private readonly options: CodexAdapterOptions) {}

  async run(input: Parameters<AgentAdapter["run"]>[0]): Promise<AgentRunResult> {
    const options = await this.resolveOptions();
    const tempDir = await mkdtemp(join(tmpdir(), "oneteam-codex-"));
    const lastMessagePath = join(tempDir, "last-message.txt");
    const args = [
      "exec",
      "--json",
      "--sandbox",
      "danger-full-access",
      "--ask-for-approval",
      "never",
      "--cd",
      input.repoPath,
      "--output-last-message",
      lastMessagePath
    ];

    if (options.model) {
      args.push("--model", options.model);
    }

    args.push("-");

    await input.onActivity?.({
      type: "command",
      title: "Started Codex CLI",
      body: `${options.command} ${args.join(" ")}`,
      payload: {
        command: options.command,
        args,
        cwd: input.repoPath
      }
    });

    try {
      const { stdout, stderr, exitCode } = await runProcess(options.command, args, input.prompt);
      await input.onActivity?.({
        type: exitCode === 0 ? "progress" : "error",
        title: exitCode === 0 ? "Codex CLI completed" : "Codex CLI failed",
        body: stderr || stdout.slice(-4000),
        payload: {
          exitCode,
          stdoutTail: stdout.slice(-4000),
          stderrTail: stderr.slice(-4000)
        }
      });

      if (exitCode !== 0) {
        return {
          status: "failed",
          message: stderr || `Codex CLI failed with exit code ${exitCode}`,
          activities: []
        };
      }

      const finalMessage = await readFile(lastMessagePath, "utf8").catch(() => stdout);
      return extractJson(finalMessage);
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

async function runProcess(command: string, args: string[], stdin: string): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({
        stdout,
        stderr,
        exitCode: exitCode ?? 1
      });
    });

    child.stdin.end(stdin);
  });
}
