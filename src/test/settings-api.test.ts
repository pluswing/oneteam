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
        codexCommand: "managed-codex",
        model: "gpt-managed",
        fullAccess: true
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
    expect(settings.ai.codexCommand).toBe("managed-codex");
    expect(settings.ai.model).toBe("gpt-managed");
    expect(settings.runtime.database.url).toContain("test.db");
    expect(codexUpdateResponse.status).toBe(400);

    context.client.close();
  });
});
