import { expect, it } from "vitest";
import { createApp } from "../server/app";
import { repositoryDatabaseUrl } from "../server/config";
import { developmentFixture } from "./development-fixture";
import { ensureDevelopmentLoop, queueDevelopmentJob } from "../server/services/development-loop";

it("keeps the database in the folder and disables obsolete settings and manual scheduling APIs", async () => {
  const fixture = await developmentFixture();
  try {
    const { repos, project, dir } = fixture; const app = createApp({ repos });
    expect(repositoryDatabaseUrl(dir)).toBe(`file:${dir}/.oneteam/data/oneteam.db`);
    for (const path of ["settings", "loops", "triage-items", "agent-jobs"]) {
      const response = await app.request(`/api/projects/${project.id}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(response.status).toBe(404);
    }
    expect((await app.request(`/api/projects/${project.id}/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ai: { provider: "claude_code" } }) })).status).toBe(404);
    expect((await app.request("/api/repositories/switch", { method: "POST" })).status).toBe(404);
    await repos.settings.set("ai", { provider: "claude_code" });
    const issue = await repos.issues.create({ projectId: project.id, title: "Codex only" });
    const loop = await ensureDevelopmentLoop(repos, project.id, issue.id);
    expect(await queueDevelopmentJob(repos, loop)).toMatchObject({ aiProvider: "codex", aiModel: null });
  } finally { await fixture.cleanup(); }
});
