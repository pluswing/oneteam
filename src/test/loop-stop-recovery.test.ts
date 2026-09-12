import { access } from "node:fs/promises";
import { expect, it } from "vitest";
import { developmentFixture } from "./development-fixture";
import { ensureDevelopmentLoop } from "../server/services/development-loop";
import { LoopEngine } from "../server/services/loop-engine";

it("drains an active execution, retains its snapshot and resumes the same Job after restart", async () => {
  const fixture = await developmentFixture();
  try {
    const { repos, project } = fixture;
    const issue = await repos.issues.create({ projectId: project.id, title: "Restart safely" });
    const loop = await ensureDevelopmentLoop(repos, project.id, issue.id);
    let ready!: () => void; const entered = new Promise<void>((resolve) => { ready = resolve; });
    const first = new LoopEngine(repos, { async run({ isCanceled }) {
      ready();
      while (!await isCanceled?.()) await new Promise((resolve) => setTimeout(resolve, 10));
      return { status: "canceled", message: "Interrupted" };
    } });
    const running = first.tick(); await entered;
    await first.stopAndDrain(); await running;
    const stopped = (await repos.agentJobs.list({ projectId: project.id }))[0];
    expect(stopped).toMatchObject({ status: "queued", attempt: 2, input: { developmentLoopId: loop.id } });
    await expect(access(String(stopped.input.worktreePath))).resolves.toBeUndefined();
    const second = new LoopEngine(repos, { async run({ job, repoPath }) {
      expect(job.id).toBe(stopped.id); expect(repoPath).toBe(stopped.input.worktreePath);
      return { status: "succeeded", message: "Requirements resumed" };
    } });
    await second.tick();
    expect(await repos.development.get(project.id, loop.id)).toMatchObject({ phase: "implementing", status: "running", currentJobId: null, rounds: 1 });
    expect(await repos.agentJobs.list({ projectId: project.id })).toHaveLength(1);
    await expect(access(String(stopped.input.worktreePath))).rejects.toThrow();
    await second.stopAndDrain();
  } finally { await fixture.cleanup(); }
});
