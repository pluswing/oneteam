import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureCodexLogin } from "../server/services/codex-auth";

describe("Codex auth startup", () => {
  it("does not start login when Codex is already authenticated", async () => {
    const command = await fakeCodexCommand("authenticated");
    let launched = false;

    const result = await ensureCodexLogin(command, {
      launcher: () => {
        launched = true;
      }
    });

    expect(result.status).toBe("authenticated");
    expect(launched).toBe(false);
  });

  it("starts login when Codex is not authenticated", async () => {
    const command = await fakeCodexCommand("unauthenticated");
    let launchedArgs: string[] | null = null;

    const result = await ensureCodexLogin(command, {
      launcher: (input) => {
        launchedArgs = input.args;
      }
    });

    expect(result.status).toBe("login_started");
    expect(launchedArgs).toEqual(["login"]);
  });
});

async function fakeCodexCommand(mode: "authenticated" | "unauthenticated"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "oneteam-codex-auth-"));
  const command = join(dir, "codex.mjs");
  await writeFile(
    command,
    `#!/usr/bin/env node
if (process.argv[2] === "login" && process.argv[3] === "status") {
  process.stdout.write("${mode === "authenticated" ? "Logged in" : "Not logged in"}\\n");
  process.exit(${mode === "authenticated" ? "0" : "1"});
}
process.exit(0);
`,
    "utf8"
  );
  await chmod(command, 0o755);
  return command;
}
