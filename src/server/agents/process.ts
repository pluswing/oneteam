import { spawn } from "node:child_process";

export async function runAgentProcess(
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
