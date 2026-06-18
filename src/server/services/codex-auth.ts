import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

export type CodexLoginLauncher = (input: { command: string; args: string[] }) => Promise<void> | void;

export type CodexLoginOptions = {
  enabled?: boolean;
  launcher?: CodexLoginLauncher;
};

export type CodexLoginResult =
  | {
      status: "disabled" | "authenticated";
      message: string;
    }
  | {
      status: "login_started" | "login_completed";
      message: string;
    }
  | {
      status: "failed";
      message: string;
    };

type ProcessResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export function resolveCodexCommandPath(command: string): string {
  if (command.includes("/") || command.includes("\\")) {
    return isAbsolute(command) ? command : resolve(process.cwd(), command);
  }
  return command;
}

export async function ensureCodexLogin(
  command: string,
  options: CodexLoginOptions = {}
): Promise<CodexLoginResult> {
  if (options.enabled === false || process.env.ONETEAM_CODEX_AUTO_LOGIN === "false") {
    return {
      status: "disabled",
      message: "Codex auto login is disabled."
    };
  }

  const resolvedCommand = resolveCodexCommandPath(command);
  const status = await checkCodexLoginStatus(resolvedCommand);
  if (status.exitCode === 0) {
    return {
      status: "authenticated",
      message: status.stdout.trim() || "Codex is already logged in."
    };
  }

  const loginArgs = ["login"];
  if (options.launcher) {
    await options.launcher({ command: resolvedCommand, args: loginArgs });
    return {
      status: "login_started",
      message: "Codex login was started."
    };
  }

  if (process.stdin.isTTY && process.stdout.isTTY) {
    const login = await runCodexLogin(resolvedCommand, loginArgs);
    if (login.exitCode !== 0) {
      return {
        status: "failed",
        message: login.stderr.trim() || login.stdout.trim() || "Codex login failed."
      };
    }
    return {
      status: "login_completed",
      message: "Codex login completed."
    };
  }

  const child = spawn(resolvedCommand, loginArgs, {
    detached: true,
    stdio: "ignore"
  });
  child.on("error", () => {
    // Detached login is best-effort; agent jobs will still surface auth failures if login cannot start.
  });
  child.unref();

  return {
    status: "login_started",
    message: "Codex login was started in a detached process."
  };
}

async function checkCodexLoginStatus(command: string): Promise<ProcessResult> {
  return runCodexCommand(command, ["login", "status"], 10_000);
}

async function runCodexLogin(command: string, args: string[]): Promise<ProcessResult> {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit"
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolveProcess({
        exitCode: exitCode ?? 1,
        stdout: "",
        stderr: ""
      });
    });
  });
}

async function runCodexCommand(command: string, args: string[], timeoutMs: number): Promise<ProcessResult> {
  return new Promise((resolveProcess) => {
    const child = spawn(command, args, {
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
