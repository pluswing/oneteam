import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ensureCodexLogin, resolveCodexCommandPath } from "../server/services/codex-auth";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it("uses the terminal-installed Codex on PATH for login checks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oneteam-installed-codex-")); directories.push(dir);
  const command = join(dir, "codex");
  const invocation = join(dir, "invocation.json");
  await writeFile(command, `#!${process.execPath}\nconst { writeFileSync } = require('node:fs');\nwriteFileSync(${JSON.stringify(invocation)}, JSON.stringify(process.argv.slice(2)));\nconsole.log('Logged in');\n`, "utf8");
  await chmod(command, 0o755);
  vi.stubEnv("PATH", dir);
  vi.stubEnv("ONETEAM_CODEX_AUTO_LOGIN", "true");
  const launcher = vi.fn();
  expect(resolveCodexCommandPath("codex")).toBe("codex");
  expect(await ensureCodexLogin("codex", { launcher })).toMatchObject({ status: "authenticated" });
  expect(JSON.parse(await readFile(invocation, "utf8"))).toEqual(["login", "status"]);
  expect(launcher).not.toHaveBeenCalled();
});

it("preserves explicit executable paths and alternative command names", () => {
  expect(resolveCodexCommandPath("/custom/recent-codex")).toBe("/custom/recent-codex");
  expect(resolveCodexCommandPath("tools/codex")).toBe(resolve("tools/codex"));
  expect(resolveCodexCommandPath("custom-codex")).toBe("custom-codex");
});
