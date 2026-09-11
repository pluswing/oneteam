import { Hono } from "hono";
import type { Repositories } from "./db/repositories";
import { controlDevelopmentLoop } from "./services/development-loop";
import { restoreKnowledgeRevision } from "./services/retrospective";

export function developmentApi(repos: Repositories): Hono {
  const app = new Hono();
  app.post("/api/projects/:projectId/knowledge-revisions/:revisionId/restore", async (c) => {
    const project = await repos.projects.get(c.req.param("projectId"));
    if (!project) return c.json({ error: { message: "Folder was not found." } }, 404);
    try { await restoreKnowledgeRevision(repos, project, Number(c.req.param("revisionId"))); return c.json({ restored: true }); }
    catch (error) { return c.json({ error: { message: error instanceof Error ? error.message : "Knowledge restoration failed." } }, 409); }
  });
  app.get("/api/projects/:projectId/development-loops", async (c) => c.json({ items: await repos.development.list(c.req.param("projectId")) }));
  app.get("/api/projects/:projectId/development-loops/:loopId", async (c) => {
    const projectId = c.req.param("projectId");
    const id = Number(c.req.param("loopId"));
    const loop = await repos.development.get(projectId, id);
    if (!loop) return c.json({ error: { message: "Loop was not found." } }, 404);
    const [retrospective, revisions, jobs] = await Promise.all([
      repos.development.retrospectives.get(projectId, id), repos.development.revisions.list(projectId, id), repos.agentJobs.list({ projectId })
    ]);
    return c.json({ loop, retrospective, revisions, jobs: jobs.filter((job) => job.input.developmentLoopId === id) });
  });
  app.post("/api/projects/:projectId/development-loops/:loopId/:action", async (c) => {
    const { projectId, action } = c.req.param();
    const loop = await repos.development.get(projectId, Number(c.req.param("loopId")));
    if (!loop) return c.json({ error: { message: "Loop was not found." } }, 404);
    if (!["pause", "resume", "cancel"].includes(action)) return c.json({ error: { message: "Unknown Loop action." } }, 400);
    try { return c.json({ loop: await controlDevelopmentLoop(repos, loop, action as "pause" | "resume" | "cancel") }); }
    catch (error) { return c.json({ error: { message: error instanceof Error ? error.message : "Loop control failed." } }, 409); }
  });
  app.get("/api/projects/:projectId/agent-jobs/:jobId/executions", async (c) => c.json({ items: await repos.development.executions.list(c.req.param("projectId"), Number(c.req.param("jobId"))) }));
  return app;
}
