import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import { repositoryDatabaseUrl } from "../server/config";
import { createDatabaseContext } from "../server/db/client";
import { runMigrations } from "../server/db/migrations";
import { createRepositories } from "../server/db/repositories";
import type { ProjectSettingsDto } from "../shared/types";

describe("settings API", () => {
  it("places project databases under the imported repository .oneteam directory", () => {
    const repoPath = join(tmpdir(), "example-repo");
    const url = repositoryDatabaseUrl(repoPath);
    expect(url).toBe(`file:${join(repoPath, ".oneteam", "data", "oneteam.db")}`);
  });

  it("switches to the imported repository database when creating a project", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneteam-project-switch-"));
    const context = createDatabaseContext(`file:${join(dir, "bootstrap.db")}`);
    await runMigrations(context.client);
    const repos = createRepositories(context.db);
    let switchedRepoPath: string | null = null;
    const app = createApp({
      repos,
      switchDatabaseForRepository: async (repoPath) => {
        switchedRepoPath = repoPath;
        return {
          repoPath,
          name: "Imported",
          databaseUrl: repositoryDatabaseUrl(repoPath),
          lastOpenedAt: new Date().toISOString()
        };
      }
    });

    const response = await app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "import",
        name: "Imported",
        repoPath: dir,
        defaultBranch: "main",
        locale: "en"
      })
    });

    expect(response.status).toBe(201);
    expect(switchedRepoPath).toBe(dir);
    await expect(readFile(join(dir, ".oneteam", "skills", "project.md"), "utf8")).resolves.toContain("# Project");
    await expect(readFile(join(dir, ".oneteam", "skills", "build.md"), "utf8")).resolves.toContain("# Build");
    await expect(readFile(join(dir, ".oneteam", "skills", "review.md"), "utf8")).resolves.toContain("# Review");
    await expect(readFile(join(dir, ".oneteam", "skills", "qa.md"), "utf8")).resolves.toContain("# QA");
    await expect(readFile(join(dir, ".oneteam", "memory", "loop-notes.md"), "utf8")).resolves.toContain("# Loop Notes");
    context.client.close();
  });

  it("reads managed Codex settings and only allows locale updates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneteam-settings-"));
    const context = createDatabaseContext(`file:${join(dir, "test.db")}`);
    await runMigrations(context.client);
    const repos = createRepositories(context.db);
    const app = createApp({
      ai: {
        provider: "codex",
        roleOverrides: {
          implementation: { provider: null, model: null },
          review: { provider: null, model: null },
          qa: { provider: null, model: null },
          verifier: { provider: null, model: null }
        },
        codex: {
          command: "managed-codex",
          model: "gpt-managed",
          fullAccess: true,
          autoLogin: true
        },
        claudeCode: {
          command: "claude",
          model: null,
          permissionMode: "bypassPermissions",
          maxTurns: null
        },
        lmStudio: {
          baseUrl: "http://127.0.0.1:1234/v1",
          model: null,
          maxToolRounds: 8,
          temperature: null
        }
      },
      repos,
      runtime: {
        server: { host: "127.0.0.1", port: 3580 },
        database: { url: `file:${join(dir, "test.db")}` }
      }
    });
    const project = await repos.projects.create({
      name: "Example",
      repoPath: dir,
      defaultBranch: "main",
      locale: "en"
    });

    const updateResponse = await app.request(`/api/projects/${project.id}/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        locale: "ja"
      })
    });
    const getResponse = await app.request(`/api/projects/${project.id}/settings`);
    const codexUpdateResponse = await app.request(`/api/projects/${project.id}/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        locale: "ja",
        codexCommand: join(dir, "missing-codex")
      })
    });
    const updated = (await updateResponse.json()) as ProjectSettingsDto;
    const settings = (await getResponse.json()) as ProjectSettingsDto;

    expect(updateResponse.status).toBe(200);
    expect(updated.project.locale).toBe("ja");
    expect(settings.ai.codex.command).toBe("managed-codex");
    expect(settings.ai.codex.model).toBe("gpt-managed");
    expect(settings.automation.autoMergeEnabled).toBe(true);
    expect(settings.automation.autoMergeTargetBranches).toEqual([]);
    expect(settings.automation.autoMergeStrategy).toBe("merge");
    expect(settings.automation.autoMergeRiskThreshold).toBe("medium");
    expect(settings.automation.objectiveTokenBudget).toBeNull();
    expect(settings.automation.objectiveCostBudgetUsd).toBeNull();
    expect(settings.runtime.database.url).toContain("test.db");
    expect(codexUpdateResponse.status).toBe(400);

    context.client.close();
  });

  it("stores the selected AI provider and stamps new agent jobs with it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneteam-provider-settings-"));
    const context = createDatabaseContext(`file:${join(dir, "test.db")}`);
    await runMigrations(context.client);
    const repos = createRepositories(context.db);
    const app = createApp({
      repos,
      runtime: {
        server: { host: "127.0.0.1", port: 3580 },
        database: { url: `file:${join(dir, "test.db")}` }
      }
    });

    const createResponse = await app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "import",
        name: "Provider test",
        repoPath: dir,
        defaultBranch: "main",
        locale: "en",
        aiProvider: "claude_code"
      })
    });
    const created = (await createResponse.json()) as { project: { id: string } };
    const initialSettings = (await (await app.request(`/api/projects/${created.project.id}/settings`)).json()) as ProjectSettingsDto;

    const updateResponse = await app.request(`/api/projects/${created.project.id}/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        locale: "en",
        ai: {
          provider: "lm_studio",
          roleOverrides: {
            implementation: { provider: "claude_code", model: "claude-implementation" },
            review: { provider: null, model: "review-specialist" }
          },
          lmStudio: {
            baseUrl: "http://127.0.0.1:1234/v1",
            model: "qwen-coder",
            maxToolRounds: 12,
            temperature: 0.2
          }
        },
        automation: {
          autoMergeEnabled: false,
          autoMergeTargetBranches: ["main", "release", "main"],
          autoMergeStrategy: "squash",
          autoMergeRiskThreshold: "high",
          objectiveTokenBudget: 750_000,
          objectiveCostBudgetUsd: 12.5
        }
      })
    });
    const settings = (await updateResponse.json()) as ProjectSettingsDto;
    const issue = await repos.issues.create({
      projectId: created.project.id,
      title: "Use provider",
      body: "Run with selected provider."
    });
    const jobResponse = await app.request(`/api/projects/${created.project.id}/agent-jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentType: "requirements",
        targetType: "issue",
        targetId: issue.id
      })
    });
    const jobPayload = (await jobResponse.json()) as { job: { aiProvider: string; aiModel: string | null } };
    const implementationJobResponse = await app.request(`/api/projects/${created.project.id}/agent-jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentType: "implementation",
        targetType: "issue",
        targetId: issue.id
      })
    });
    const implementationJobPayload = (await implementationJobResponse.json()) as {
      job: { aiProvider: string; aiModel: string | null };
    };

    expect(createResponse.status).toBe(201);
    expect(initialSettings.ai.provider).toBe("claude_code");
    expect(updateResponse.status).toBe(200);
    expect(settings.ai.provider).toBe("lm_studio");
    expect(settings.ai.roleOverrides.implementation).toEqual({
      provider: "claude_code",
      model: "claude-implementation"
    });
    expect(settings.ai.roleOverrides.review).toEqual({ provider: null, model: "review-specialist" });
    expect(settings.ai.lmStudio.model).toBe("qwen-coder");
    expect(settings.ai.lmStudio.maxToolRounds).toBe(12);
    expect(settings.automation.autoMergeEnabled).toBe(false);
    expect(settings.automation.autoMergeTargetBranches).toEqual(["main", "release"]);
    expect(settings.automation.autoMergeStrategy).toBe("squash");
    expect(settings.automation.autoMergeRiskThreshold).toBe("high");
    expect(settings.automation.objectiveTokenBudget).toBe(750_000);
    expect(settings.automation.objectiveCostBudgetUsd).toBe(12.5);
    expect(jobPayload.job.aiProvider).toBe("lm_studio");
    expect(jobPayload.job.aiModel).toBe("qwen-coder");
    expect(implementationJobResponse.status).toBe(201);
    expect(implementationJobPayload.job).toMatchObject({
      aiProvider: "claude_code",
      aiModel: "claude-implementation"
    });

    context.client.close();
  });
});
