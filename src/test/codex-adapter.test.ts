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
    const schemaCopyPath = join(dir, "agent-output.schema.json");
    const fakeCodexPath = join(dir, "fake-codex.mjs");
    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args));
const schemaPath = args[args.indexOf("--output-schema") + 1];
writeFileSync(${JSON.stringify(schemaCopyPath)}, readFileSync(schemaPath, "utf8"));

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
    const schema = JSON.parse(await readFile(schemaCopyPath, "utf8")) as {
      properties: {
        metadata: {
          anyOf: Array<{
            properties?: {
              review?: {
                anyOf: Array<{
                  properties?: {
                    findings?: {
                      anyOf: Array<{
                        items?: {
                          required?: string[];
                        };
                      }>;
                    };
                  };
                }>;
              };
            };
            required?: string[];
          }>;
        };
      };
    };
    const metadataObjectSchema = schema.properties.metadata.anyOf.find((item) => item.properties);
    const reviewObjectSchema = metadataObjectSchema?.properties?.review?.anyOf.find((item) => item.properties);
    const findingItemSchema = reviewObjectSchema?.properties?.findings?.anyOf.find((item) => item.items)?.items;
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
    expect(metadataObjectSchema?.required).toEqual(["nextLabel", "pullRequest", "review", "fix", "qa"]);
    expect(findingItemSchema?.required).toEqual(["severity", "path", "line", "title", "body"]);
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

  it("parses structured output when comment markdown contains fenced code", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneteam-codex-adapter-fenced-"));
    const fakeCodexPath = join(dir, "fake-codex.mjs");
    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
const outputPath = args[args.indexOf("--output-last-message") + 1];
await import("node:fs/promises").then(({ writeFile }) => writeFile(outputPath, JSON.stringify({
  status: "succeeded",
  message: "Implemented test command.",
  comment: {
    targetType: "issue",
    targetId: 2,
    body: "Run this command:\\n\\n\`\`\`sh\\nnpm test\\n\`\`\`"
  },
  metadata: {
    nextLabel: null,
    pullRequest: {
      title: "Add npm test command",
      body: "Adds a test command.",
      sourceBranch: "oneteam/issue-2-add-test-command",
      targetBranch: "main",
      issueId: 2
    },
    review: null,
    fix: null,
    qa: null
  }
})));
`,
      "utf8"
    );
    await chmod(fakeCodexPath, 0o755);

    const adapter = new CodexAdapter({ command: fakeCodexPath });
    const result = await adapter.run({
      job: fakeJob,
      repoPath: dir,
      prompt: "Implement the issue."
    });

    expect(result.message).toBe("Implemented test command.");
    expect(result.comment?.body).toContain("```sh");
    expect(result.metadata?.pullRequest?.title).toBe("Add npm test command");
  });

  it("prefers structured Codex errors over noisy stderr output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneteam-codex-adapter-error-"));
    const fakeCodexPath = join(dir, "fake-codex.mjs");
    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "thread-error" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "error", message: "You've hit your usage limit. Try again later." }) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.failed", error: { message: "You've hit your usage limit. Try again later." } }) + "\\n");
process.stderr.write("WARN plugin cache failed\\n<html>cloudflare challenge</html>\\n");
process.exit(1);
`,
      "utf8"
    );
    await chmod(fakeCodexPath, 0o755);

    const activities: Array<{ type: string; title: string; body?: string | null }> = [];
    const adapter = new CodexAdapter({ command: fakeCodexPath });
    const result = await adapter.run({
      job: fakeJob,
      repoPath: dir,
      prompt: "Review the pull request.",
      onActivity: (activity) => {
        activities.push(activity);
      }
    });

    const failedActivity = activities.find((activity) => activity.title === "Codex CLI failed");
    expect(result.status).toBe("failed");
    expect(result.message).toBe("You've hit your usage limit. Try again later.");
    expect(failedActivity?.body).toBe("You've hit your usage limit. Try again later.");
    expect(failedActivity?.body).not.toContain("cloudflare");
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
