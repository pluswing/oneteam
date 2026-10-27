import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { desktopCliPath } from "../server/services/desktop-cli-path";
import { defaultCodexCommand, normalizeCodexCommand } from "../shared/codex";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

it("normalizes the default command token and legacy relative CLI paths", () => {
  expect(defaultCodexCommand).toBe("codex");
  expect(normalizeCodexCommand(undefined)).toBe("codex");
  expect(normalizeCodexCommand("node_modules/.bin/codex")).toBe("codex");
  expect(normalizeCodexCommand("/custom/bin/codex")).toBe("/custom/bin/codex");
});

it("finds terminal-installed tools during Finder launches without treating shell startup output as PATH", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oneteam-cli-path-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const shell = join(dir, "fake-shell");
  await writeFile(shell, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify("Startup message\n\0/custom/codex/bin:/custom/node/bin:/usr/bin\0Trailing message\n")});\n`);
  await chmod(shell, 0o755);
  const path = (await desktopCliPath("/usr/bin:/bin", shell)).split(delimiter);
  expect(path.slice(0, 4)).toEqual(["/custom/codex/bin", "/custom/node/bin", "/usr/bin", "/bin"]);
  expect(path.filter((item) => item === "/usr/bin")).toHaveLength(1);
  expect(path.every((item) => !item.includes("message"))).toBe(true);
});

it("preserves inherited tool paths when the login shell fails", async () => {
  const path = await desktopCliPath("/existing/bin:/usr/bin", "/missing/shell");
  expect(path.split(delimiter).slice(0, 2)).toEqual(["/existing/bin", "/usr/bin"]);
});
