import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexAdapter } from "../server/agents/codex-adapter";
import type { AgentJobDto } from "../shared/types";

describe("codex adapter", () => {
  it("runs the local Codex CLI with full access flags and captures JSONL activity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneteam-codex-adapter-"));
    const argsPath = join(dir, "args.json");
    const fakeCodexPath = join(dir, "fake-codex.mjs");
    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args));

process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-1" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "item.completed", item: { id: "item-1", type: "reasoning", text: "Reviewed the target issue." } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "item.completed", item: { id: "item-2", type: "command_execution", command: "npm test", status: "completed", exit_code: 0 } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1 } }) + "\\n");
process.stderr.write("WARN fake non-fatal warning\\n");

const outputPath = args[args.indexOf("--output-last-message") + 1];
writeFileSync(outputPath, JSON.stringify({
  status: "succeeded",
  message: "Codex completed.",
  activities: [{ type: "progress", title: "Finished" }]
}));
`,
      "utf8"
    );
    await chmod(fakeCodexPath, 0o755);

    const activities: Array<{ type: string; title: string; body?: string | null }> = [];
    const adapter = new CodexAdapter({ command: fakeCodexPath });
    const result = await adapter.run({
      job: fakeJob,
      repoPath: dir,
      prompt: "Implement the issue.",
      onActivity: (activity) => {
        activities.push(activity);
      }
    });

    const args = JSON.parse(await readFile(argsPath, "utf8")) as string[];
    expect(args).toEqual(
      expect.arrayContaining([
        "exec",
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
        "--cd",
        dir,
        "--output-schema",
        "--output-last-message"
      ])
    );
    expect(args).not.toContain("--ask-for-approval");
    expect(args).not.toContain("--sandbox");
    expect(args.at(-1)).toBe("-");
    expect(result.status).toBe("succeeded");
    expect(result.message).toBe("Codex completed.");
    expect(activities.map((activity) => activity.title)).toEqual(
      expect.arrayContaining([
        "Started Codex CLI",
        "Codex thread started",
        "Codex thinking summary",
        "Codex command completed",
        "Codex turn completed",
        "Codex CLI completed"
      ])
    );
    expect(activities.find((activity) => activity.title === "Codex command completed")?.body).toContain("npm test");
    expect(activities.find((activity) => activity.title === "Codex CLI completed")?.body).toContain("Non-fatal CLI warnings");
  });

  it("terminates the Codex CLI when cancellation is requested", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneteam-codex-adapter-cancel-"));
    const fakeCodexPath = join(dir, "fake-codex.mjs");
    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-cancel" }) + "\\n");
setInterval(() => {}, 1000);
`,
      "utf8"
    );
    await chmod(fakeCodexPath, 0o755);

    let cancellationChecks = 0;
    const adapter = new CodexAdapter({ command: fakeCodexPath });
    const result = await adapter.run({
      job: fakeJob,
      repoPath: dir,
      prompt: "Keep running.",
      isCanceled: () => {
        cancellationChecks += 1;
        return cancellationChecks >= 2;
      }
    });

    expect(result.status).toBe("canceled");
    expect(result.activities?.map((activity) => activity.title)).toContain("Codex CLI canceled");
  });
});

const fakeJob: AgentJobDto = {
  id: 1,
  projectId: "project-1",
  agentType: "implementation",
  targetType: "issue",
  targetId: 1,
  status: "running",
  triggerType: "manual",
  parentJobId: null,
  input: {},
  output: null,
  error: null,
  attempt: 1,
  lockKey: null,
  createdAt: "2026-05-21T00:00:00.000Z",
  startedAt: "2026-05-21T00:00:00.000Z",
  finishedAt: null
};
