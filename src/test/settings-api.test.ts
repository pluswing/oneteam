import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
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

  it("reads runtime settings and validates Codex command updates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneteam-settings-"));
    const fakeCodexPath = join(dir, "fake-codex.mjs");
    await writeFile(
      fakeCodexPath,
      `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("fake-codex 1.0.0\\n");
  process.exit(0);
}
process.exit(1);
`,
      "utf8"
    );
    await chmod(fakeCodexPath, 0o755);

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
        locale: "ja",
        codexCommand: fakeCodexPath,
        model: "gpt-test"
      })
    });
    const getResponse = await app.request(`/api/projects/${project.id}/settings`);
    const invalidResponse = await app.request(`/api/projects/${project.id}/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        locale: "ja",
        codexCommand: join(dir, "missing-codex"),
        model: "gpt-test"
      })
    });
    const updated = (await updateResponse.json()) as ProjectSettingsDto;
    const settings = (await getResponse.json()) as ProjectSettingsDto;

    expect(updateResponse.status).toBe(200);
    expect(updated.project.locale).toBe("ja");
    expect(settings.ai.codexCommand).toBe(fakeCodexPath);
    expect(settings.ai.model).toBe("gpt-test");
    expect(settings.runtime.database.url).toContain("test.db");
    expect(invalidResponse.status).toBe(400);

    context.client.close();
  });
});
