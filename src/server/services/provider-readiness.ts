import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import type { AiProvider, AiSettingsDto } from "../../shared/ai-providers";
import { ensureCodexLogin, type CodexLoginLauncher } from "./codex-auth";

export type ProviderReadinessOptions = {
  loginLauncher?: CodexLoginLauncher;
};

type ProcessResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export async function ensureProviderReady(
  provider: AiProvider,
  settings: AiSettingsDto,
  options: ProviderReadinessOptions = {}
): Promise<void> {
  if (provider === "codex") {
    const login = await ensureCodexLogin(settings.codex.command, {
      enabled: settings.codex.autoLogin,
      launcher: options.loginLauncher
    });
    if (login.status === "failed") {
      throw new Error(login.message);
    }
    if (login.status === "login_started") {
      throw new Error("Codex login was started. Complete login, then retry the agent job.");
    }
    return;
  }

  if (provider === "claude_code") {
    const login = await ensureClaudeCodeLogin(settings.claudeCode.command, options.loginLauncher);
    if (login.status === "failed") {
      throw new Error(login.message);
    }
    if (login.status === "login_started") {
      throw new Error("Claude Code login was started. Complete login, then retry the agent job.");
    }
    return;
  }

  const baseUrl = settings.lmStudio.baseUrl.replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/models`).catch(() => null);
  if (!response?.ok) {
    throw new Error(`LM Studio server is not reachable at ${baseUrl}. Start LM Studio local server and retry.`);
  }
}

async function ensureClaudeCodeLogin(
  command: string,
  launcher?: CodexLoginLauncher
): Promise<
  | { status: "authenticated"; message: string }
  | { status: "login_started"; message: string }
  | { status: "failed"; message: string }
> {
  const resolvedCommand = resolveCommand(command);
  const status = await runCommand(resolvedCommand, ["auth", "status"], 10_000);
  if (status.exitCode === 0) {
    return {
      status: "authenticated",
      message: status.stdout.trim() || "Claude Code is already authenticated."
    };
  }

  const args = ["auth", "login"];
  if (launcher) {
    await launcher({ command: resolvedCommand, args });
    return {
      status: "login_started",
      message: "Claude Code login was started."
    };
  }

  const login = await runCommand(resolvedCommand, args, 120_000, process.stdin.isTTY && process.stdout.isTTY);
  if (login.exitCode !== 0) {
    return {
      status: "failed",
      message: login.stderr.trim() || login.stdout.trim() || "Claude Code login failed."
    };
  }
  return {
    status: "authenticated",
    message: "Claude Code login completed."
  };
}

function resolveCommand(command: string): string {
  if (command.includes("/") || command.includes("\\")) {
    return isAbsolute(command) ? command : resolve(process.cwd(), command);
  }
  return command;
}

async function runCommand(command: string, args: string[], timeoutMs: number, inherit = false): Promise<ProcessResult> {
  return new Promise((resolveProcess) => {
    const child = spawn(command, args, {
      stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"]
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

    if (!inherit && child.stdout && child.stderr) {
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
    }
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolveProcess({
        exitCode: 1,
        stdout,
        stderr: error instanceof Error ? error.message : String(error)
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
        stdout,
        stderr
      });
    });
  });
}
