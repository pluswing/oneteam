import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeAiSettings, resolveAgentAiSelection } from "../shared/ai-providers";
import { createDatabaseContext } from "../server/db/client";
import { runMigrations } from "../server/db/migrations";
import { createRepositories } from "../server/db/repositories";

describe("role-based AI routing", () => {
  it("resolves provider and model overrides independently for each workflow role", () => {
    const settings = normalizeAiSettings({
      provider: "claude_code",
      codex: { model: "gpt-default" },
      claudeCode: { model: "claude-default" },
      lmStudio: { model: "local-default" },
      roleOverrides: {
        implementation: { provider: "codex", model: "gpt-implementer" },
        review: { provider: null, model: "claude-reviewer" },
        qa: { provider: "lm_studio", model: null },
        verifier: { provider: "unsupported", model: 42 }
      }
    });

    expect(resolveAgentAiSelection(settings, "requirements")).toEqual({
      provider: "claude_code",
      model: "claude-default"
    });
    expect(resolveAgentAiSelection(settings, "implementation")).toEqual({
      provider: "codex",
      model: "gpt-implementer"
    });
    expect(resolveAgentAiSelection(settings, "review")).toEqual({
      provider: "claude_code",
      model: "claude-reviewer"
    });
    expect(resolveAgentAiSelection(settings, "qa")).toEqual({
      provider: "lm_studio",
      model: "local-default"
    });
    expect(resolveAgentAiSelection(settings, "verifier")).toEqual({
      provider: "claude_code",
      model: "claude-default"
    });
  });

  it("freezes routing on a queued job, preserves it on retry, and updates model on provider switch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneteam-role-routing-"));
    const context = createDatabaseContext(`file:${join(dir, "test.db")}`);
    await runMigrations(context.client);
    const repos = createRepositories(context.db);
    const project = await repos.projects.create({ name: "Role routing", repoPath: dir, defaultBranch: "main" });
    await repos.settings.set("ai", normalizeAiSettings({
      provider: "codex",
      codex: { model: "gpt-default" },
      claudeCode: { model: "claude-fallback" },
      roleOverrides: {
        implementation: { provider: "claude_code", model: "claude-implementer" }
      }
    }) as unknown as Record<string, unknown>);

    const job = await repos.agentJobs.create({
      projectId: project.id,
      agentType: "implementation",
      targetType: "project",
      targetId: 0
    });
    expect(job).toMatchObject({ aiProvider: "claude_code", aiModel: "claude-implementer" });

    await repos.settings.set("ai", normalizeAiSettings({
      provider: "lm_studio",
      claudeCode: { model: "claude-new-default" },
      lmStudio: { model: "local-new-default" }
    }) as unknown as Record<string, unknown>);
    const retried = await repos.agentJobs.retry(project.id, job.id);
    expect(retried).toMatchObject({ aiProvider: "claude_code", aiModel: "claude-implementer" });

    const running = await repos.agentJobs.updateStatus(project.id, retried!.id, "running");
    if (!running) throw new Error("Retry job did not start.");
    const waiting = await repos.agentJobs.waitForProvider(project.id, running.id, {
      reason: "provider_quota_exhausted",
      metadata: {},
      nextRetryAt: new Date(Date.now() + 60_000).toISOString(),
      output: {}
    });
    if (!waiting) throw new Error("Retry job did not enter provider wait.");
    const switched = await repos.agentJobs.resumeProviderWait(project.id, waiting.id, "lm_studio");
    expect(switched).toMatchObject({ aiProvider: "lm_studio", aiModel: "local-new-default" });
    context.client.close();
  });
});
