import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import { createDatabaseContext } from "../server/db/client";
import { runMigrations } from "../server/db/migrations";
import { createRepositories } from "../server/db/repositories";
import type { ProjectSettingsDto } from "../shared/types";

describe("settings API", () => {
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
