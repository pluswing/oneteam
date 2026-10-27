import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Finder launches do not inherit the user's terminal PATH (including Codex and Node). */
export async function desktopCliPath(inheritedPath = process.env.PATH ?? "", shell = process.env.SHELL ?? "/bin/zsh"): Promise<string> {
  if (process.platform === "win32") return inheritedPath;
  let shellPath = "";
  try {
    const { stdout } = await execute(shell, ["-ilc", 'printf "\\0%s\\0" "$PATH"'], { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024 });
    // Ignore messages printed by shell startup files; only the delimited PATH is used.
    shellPath = stdout.split("\0")[1] ?? "";
  } catch {
    // A broken shell profile must not prevent the app from opening.
  }
  return [...new Set([
    ...shellPath.split(delimiter), ...inheritedPath.split(delimiter),
    join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"
  ].filter(Boolean))].join(delimiter);
}
