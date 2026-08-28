import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../server/agents/claude-code-adapter";
import { LmStudioAdapter } from "../server/agents/lm-studio-adapter";
import type { AgentJobDto } from "../shared/types";

const servers: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
  }
});

describe("provider adapters", () => {
  it("runs Claude Code with stream JSON output and extracts the final result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneteam-claude-adapter-"));
    const argsPath = join(dir, "args.json");
    const promptPath = join(dir, "prompt.txt");
    const fakeClaudePath = join(dir, "fake-claude.mjs");
    await writeFile(
      fakeClaudePath,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";

const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));
  writeFileSync(${JSON.stringify(promptPath)}, Buffer.concat(chunks).toString("utf8"));
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", message: "started" }) + "\\n");
  process.stdout.write(JSON.stringify({
    type: "result",
    session_id: "claude-session-1",
    usage: { input_tokens: 120, cache_read_input_tokens: 30, cache_creation_input_tokens: 10, output_tokens: 45 },
    total_cost_usd: 0.0125,
    result: JSON.stringify({
    status: "succeeded",
    message: "Claude completed.",
    comment: null,
    questions: null,
    activities: null,
    changedFiles: null,
    testResults: null,
    stopReason: "passed",
    evidence: null,
    metadata: null
  }) }) + "\\n");
});
`,
      "utf8"
    );
    await chmod(fakeClaudePath, 0o755);

    const activities: string[] = [];
    const adapter = new ClaudeCodeAdapter({ command: fakeClaudePath, model: "claude-test" });
    const result = await adapter.run({
      job: { ...fakeJob, aiProvider: "claude_code" },
      repoPath: dir,
      prompt: "Review the pull request.",
      onActivity: (activity) => {
        activities.push(activity.title);
      }
    });

    const args = JSON.parse(await readFile(argsPath, "utf8")) as string[];
    expect(args).toEqual(expect.arrayContaining(["-p", "--output-format", "stream-json", "--json-schema"]));
    expect(args).toEqual(expect.arrayContaining(["--model", "claude-test"]));
    await expect(readFile(promptPath, "utf8")).resolves.toBe("Review the pull request.");
    expect(result.status).toBe("succeeded");
    expect(result.message).toBe("Claude completed.");
    expect(result.metadata?.providerExecution).toEqual({
      model: "claude-test",
      sessionId: "claude-session-1",
      resumedSession: false,
      usage: {
        input_tokens: 120,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 10,
        output_tokens: 45,
        total_cost_usd: 0.0125
      }
    });
    expect(activities).toContain("Started Claude Code");
    expect(activities).toContain("Claude Code completed");
  });

  it("runs an LM Studio tool loop against the local OpenAI-compatible API", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneteam-lm-studio-adapter-"));
    await writeFile(join(dir, "README.md"), "# Example\n", "utf8");
    let chatRequests = 0;
    const server = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "local-test-model" }] }));
        return;
      }

      if (request.method === "POST" && request.url === "/v1/chat/completions") {
        chatRequests += 1;
        response.writeHead(200, { "Content-Type": "application/json" });
        if (chatRequests === 1) {
          response.end(
            JSON.stringify({
              usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "tool-1",
                        type: "function",
                        function: {
                          name: "read_file",
                          arguments: JSON.stringify({ path: "README.md" })
                        }
                      }
                    ]
                  }
                }
              ]
            })
          );
          return;
        }

        response.end(
          JSON.stringify({
            usage: { prompt_tokens: 150, completion_tokens: 30, total_tokens: 180 },
            choices: [
              {
                message: {
                  role: "assistant",
                  content: JSON.stringify({
                    status: "succeeded",
                    message: "LM Studio completed.",
                    comment: null,
                    questions: null,
                    activities: null,
                    changedFiles: null,
                    testResults: null,
                    stopReason: "passed",
                    evidence: null,
                    metadata: null
                  })
                }
              }
            ]
          })
        );
        return;
      }

      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const address = server.address() as AddressInfo;
    const activities: string[] = [];

    const adapter = new LmStudioAdapter({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: null,
      maxToolRounds: 3,
      temperature: null
    });
    const result = await adapter.run({
      job: { ...fakeJob, aiProvider: "lm_studio" },
      repoPath: dir,
      prompt: "Read README.",
      onActivity: (activity) => {
        activities.push(activity.title);
      }
    });

    expect(result.status).toBe("succeeded");
    expect(result.message).toBe("LM Studio completed.");
    expect(result.metadata?.providerExecution).toEqual({
      model: "local-test-model",
      sessionId: null,
      resumedSession: false,
      usage: {
        inputTokens: 250,
        cachedInputTokens: 0,
        outputTokens: 50,
        reasoningTokens: 0,
        totalTokens: 300,
        costUsd: 0,
        requestCount: 2
      }
    });
    expect(activities).toContain("Started LM Studio");
    expect(activities).toContain("LM Studio read README.md");
  });
});

const fakeJob: AgentJobDto = {
  id: 1,
  projectId: "project-1",
  aiProvider: "codex",
  aiModel: null,
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
  waitReason: null,
  waitMetadata: null,
  nextRetryAt: null,
  createdAt: "2026-05-21T00:00:00.000Z",
  startedAt: "2026-05-21T00:00:00.000Z",
  finishedAt: null
};
