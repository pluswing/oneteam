import { spawn } from "node:child_process";
import type { CommandType, ProjectCommandDto } from "../../shared/types";

export type VerificationCommandResult = {
  commandType: CommandType;
  command: string;
  status: "passed" | "failed";
  exitCode: number | null;
  signal: string | null;
  output: string;
  durationMs: number;
  timedOut: boolean;
};

const verificationOrder: CommandType[] = ["lint", "test", "build"];
const defaultTimeoutMs = 5 * 60 * 1000;
const maxOutputLength = 12_000;

export function selectVerificationCommands(commands: ProjectCommandDto[]): ProjectCommandDto[] {
  const byType = new Map(commands.map((command) => [command.commandType, command]));
  return verificationOrder
    .map((commandType) => byType.get(commandType))
    .filter((command): command is ProjectCommandDto => Boolean(command?.isRequired && command.isAvailable && command.command));
}

export async function runVerificationCommands(
  repoPath: string,
  commands: ProjectCommandDto[],
  timeoutMs = defaultTimeoutMs
): Promise<VerificationCommandResult[]> {
  const results: VerificationCommandResult[] = [];
  for (const command of selectVerificationCommands(commands)) {
    results.push(await runCommand(repoPath, command.commandType, command.command ?? "", timeoutMs));
  }
  return results;
}

async function runCommand(
  repoPath: string,
  commandType: CommandType,
  command: string,
  timeoutMs: number
): Promise<VerificationCommandResult> {
  const startedAt = Date.now();
  let stdout = "";
  let stderr = "";
  let timedOut = false;

  const result = await new Promise<{ exitCode: number | null; signal: string | null }>((resolve) => {
    const child = spawn(command, {
      cwd: repoPath,
      shell: true,
      env: {
        ...process.env,
        CI: process.env.CI ?? "1"
      }
    });
    let resolved = false;
    let timeout: NodeJS.Timeout | null = null;

    const finish = (exitCode: number | null, signal: string | null) => {
      if (resolved) {
        return;
      }
      resolved = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve({ exitCode, signal });
    };

    timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      stderr += error instanceof Error ? error.message : "Command failed to start.";
      finish(null, null);
    });
    child.on("close", (exitCode, signal) => {
      finish(exitCode, signal);
    });
  });

  const output = trimOutput([stdout.trim(), stderr.trim()].filter(Boolean).join("\n\n"));
  const passed = !timedOut && result.exitCode === 0;

  return {
    commandType,
    command,
    status: passed ? "passed" : "failed",
    exitCode: result.exitCode,
    signal: result.signal,
    output,
    durationMs: Date.now() - startedAt,
    timedOut
  };
}

function trimOutput(output: string): string {
  if (output.length <= maxOutputLength) {
    return output;
  }
  const headLength = Math.floor(maxOutputLength / 2);
  const tailLength = maxOutputLength - headLength;
  return `${output.slice(0, headLength)}\n...\n${output.slice(-tailLength)}`;
}
