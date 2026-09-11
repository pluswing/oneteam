import { expect, it } from "vitest";
import { createApp } from "../server/app";
import { ensureDevelopmentLoop, queueDevelopmentJob } from "../server/services/development-loop";
import { developmentFixture } from "./development-fixture";

it("pauses, resumes, and cancels the current Loop without reusing job sequence numbers", async () => {
  const fixture = await developmentFixture();
  try {
    const { repos, project } = fixture; const app = createApp({ repos });
    const issue = await repos.issues.create({ projectId: project.id, title: "Controllable Loop" });
    const loop = await ensureDevelopmentLoop(repos, project.id, issue.id);
    const job = await queueDevelopmentJob(repos, loop);
    await repos.agentJobs.updateStatus(project.id, job.id, "running");
    const control = (action: string) => app.request(`/api/projects/${project.id}/development-loops/${loop.id}/${action}`, { method: "POST" });
    expect((await control("pause")).status).toBe(200);
    expect(await repos.agentJobs.get(project.id, job.id)).toMatchObject({ status: "paused" });
    expect(await repos.development.get(project.id, loop.id)).toMatchObject({ status: "paused", currentJobId: job.id });
    await repos.development.update(project.id, loop.id, { rounds: 24 });
    expect((await control("resume")).status).toBe(200);
    expect(await repos.agentJobs.get(project.id, job.id)).toMatchObject({ status: "queued" });
    expect(await repos.development.get(project.id, loop.id)).toMatchObject({ status: "running", rounds: 24 });
    expect(await repos.settings.get(`development-round-limit:${loop.id}`)).toMatchObject({ maxRounds: 36 });
    expect((await control("cancel")).status).toBe(200);
    expect(await repos.agentJobs.get(project.id, job.id)).toMatchObject({ status: "canceled" });
    expect(await repos.development.get(project.id, loop.id)).toMatchObject({ status: "canceled" });
    await control("resume"); expect(await repos.development.get(project.id, loop.id)).toMatchObject({ status: "canceled" });
    expect(await repos.agentJobs.list({ projectId: project.id })).toHaveLength(1);
  } finally { await fixture.cleanup(); }
});
