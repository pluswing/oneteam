import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Repositories } from "./db/repositories";
import type { ChatService } from "./services/chat-service";
import { controlDevelopmentLoop } from "./services/development-loop";
import { modelSettingsKey, readModelSettings } from "./services/model-settings";
import { waitForJobWork } from "./services/job-execution-state";

const modelOption = z.object({ model: z.string().trim().min(1).max(200).nullable(), effort: z.string().trim().min(1).max(40).nullable() }).strict();
const roles = ["requirements", "implementation", "review", "fix", "qa", "verifier", "command_detection", "retrospective"];
function conflict(message: string): never { throw new HTTPException(409, { message }); }

export function chatApi(repos: Repositories, chats: ChatService): Hono {
  const app = new Hono();
  const base = "/api/projects/:projectId";
  app.use(`${base}/*`, async (c, next) => {
    if (!await repos.projects.get(c.req.param("projectId")!)) throw new HTTPException(404, { message: "Folder was not found." });
    await next();
  });
  const validateModel = async (projectId: string, option: { model?: string | null; effort?: string | null }) => {
    if (!option.model && !option.effort) return;
    const { models } = await chats.models(projectId);
    const model = option.model ? models.find((candidate) => candidate.model === option.model) : null;
    if (option.model && !model) conflict(`Model is not in the current catalog or reviewed candidates: ${option.model}`);
    if (option.effort && !(model ? [model] : models).some((candidate) => candidate.supportedReasoningEfforts.some((entry) => entry.reasoningEffort === option.effort))) {
      conflict(`The selected model does not support reasoning effort ${option.effort}.`);
    }
  };
  const getChat = async (projectId: string, id: string) => {
    const chat = await repos.chats.get(projectId, id);
    if (!chat) throw new HTTPException(404, { message: "Chat was not found." });
    return chat;
  };
  app.get(`${base}/chats`, async (c) => c.json({ items: await repos.chats.list(c.req.param("projectId")) }));
  app.post(`${base}/chats`, zValidator("json", z.object({ title: z.string().trim().min(1).max(120).optional() })), async (c) => {
    const projectId = c.req.param("projectId");
    const project = (await repos.projects.get(projectId))!;
    return c.json({ chat: await repos.chats.create(projectId, c.req.valid("json").title ?? (project.locale === "ja" ? "新しいチャット" : "New chat")) }, 201);
  });
  app.get(`${base}/chats/:chatId`, async (c) => {
    await getChat(c.req.param("projectId"), c.req.param("chatId"));
    return c.json(await chats.detail(c.req.param("projectId"), c.req.param("chatId")));
  });
  app.patch(`${base}/chats/:chatId`, zValidator("json", modelOption.partial().extend({ title: z.string().trim().min(1).max(120).optional() }).strict()), async (c) => {
    const { projectId, chatId } = c.req.param();
    const chat = await getChat(projectId, chatId);
    if (chat.status === "running") conflict("Stop the response before changing this chat.");
    const input = c.req.valid("json");
    if (input.model !== undefined || input.effort !== undefined) await validateModel(projectId, { model: input.model === undefined ? chat.model : input.model, effort: input.effort === undefined ? chat.effort : input.effort });
    return c.json({ chat: await repos.chats.update(projectId, chatId, input) });
  });
  app.delete(`${base}/chats/:chatId`, async (c) => {
    const { projectId, chatId } = c.req.param();
    if ((await getChat(projectId, chatId)).status === "running") conflict("Stop the response before deleting this chat.");
    await repos.chats.remove(projectId, chatId);
    return c.json({ deleted: true });
  });
  app.post(`${base}/chats/:chatId/messages`, zValidator("json", z.object({ content: z.string().trim().min(1).max(32000), requestId: z.string().uuid().optional() }).strict()), async (c) => {
    const { projectId, chatId } = c.req.param();
    await getChat(projectId, chatId);
    try { const input = c.req.valid("json"); return c.json(await chats.send(projectId, chatId, input.content, input.requestId), 202); }
    catch (error) { conflict(error instanceof Error ? error.message : "Unable to send message."); }
  });
  app.post(`${base}/chats/:chatId/stop`, async (c) => {
    const { projectId, chatId } = c.req.param();
    await getChat(projectId, chatId); await chats.stop(projectId, chatId);
    return c.json(await chats.detail(projectId, chatId));
  });
  app.get(`${base}/models`, async (c) => c.json(await chats.models(c.req.param("projectId"))));
  app.get(`${base}/model-settings`, async (c) => c.json(await readModelSettings(repos, c.req.param("projectId"))));
  app.patch(`${base}/model-settings`, zValidator("json", modelOption.partial().extend({ roles: z.record(z.string(), modelOption).optional() }).strict()), async (c) => {
    const projectId = c.req.param("projectId"); const input = c.req.valid("json");
    const current = await readModelSettings(repos, projectId);
    const next = { ...current, ...input, roles: { ...current.roles, ...input.roles } };
    for (const role of Object.keys(next.roles)) if (!roles.includes(role)) conflict(`Unknown Agent role: ${role}`);
    await validateModel(projectId, next);
    for (const option of Object.values(next.roles)) await validateModel(projectId, option);
    await repos.settings.set(modelSettingsKey(projectId), next);
    return c.json(next);
  });

  const prepareRestart = async (projectId: string, jobId: number) => {
    const job = await repos.agentJobs.get(projectId, jobId);
    if (!job) throw new HTTPException(404, { message: "Agent Job was not found." });
    const loop = typeof job.input.developmentLoopId === "number" ? await repos.development.get(projectId, job.input.developmentLoopId) : null;
    if (loop && (loop.currentJobId !== jobId || ["succeeded", "canceled"].includes(loop.status))) conflict("Only the current incomplete Loop Job can be restarted. Create a new Issue for completed work.");
    if (loop && job.status === "succeeded") conflict("This Job has completed. Continue the Loop or create a new Issue instead.");
    if (loop) await controlDevelopmentLoop(repos, loop, "pause");
    else await repos.agentJobs.pause(projectId, jobId);
    const deadline = Date.now() + 12000;
    if (!await waitForJobWork(repos, projectId, jobId, 12000)) conflict("The Job is still stopping. Retry after its current worktree and execution have been retained.");
    while ((await repos.development.executions.list(projectId, jobId)).some((execution) => ["starting", "running"].includes(execution.status))) {
      if (Date.now() >= deadline) conflict("The Job is still stopping. Retry the restart after its current execution has stopped.");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const currentJob = (await repos.agentJobs.get(projectId, jobId))!;
    const currentLoop = loop ? await repos.development.get(projectId, loop.id) : null;
    if (currentLoop && (currentLoop.currentJobId !== jobId || ["succeeded", "canceled"].includes(currentLoop.status))) conflict("The Loop changed while stopping. Inspect its latest state before restarting.");
    return { job: currentJob, loop: currentLoop };
  };
  const resumeRestart = async (projectId: string, jobId: number, managed: boolean) => {
    if (managed) {
      const job = (await repos.agentJobs.get(projectId, jobId))!;
      const loop = (await repos.development.get(projectId, Number(job.input.developmentLoopId)))!;
      await controlDevelopmentLoop(repos, loop, "resume");
      return jobId;
    }
    if (await repos.agentJobs.resumePaused(projectId, jobId)) return jobId;
    const retried = await repos.agentJobs.retry(projectId, jobId);
    if (!retried) conflict("This Job cannot be restarted.");
    return retried.id;
  };
  app.post(`${base}/agent-jobs/:jobId/restart`, async (c) => {
    const projectId = c.req.param("projectId"), jobId = Number(c.req.param("jobId"));
    try {
      const { loop } = await prepareRestart(projectId, jobId);
      return c.json({ jobId: await resumeRestart(projectId, jobId, Boolean(loop)), queued: true }, 202);
    } catch (error) { if (error instanceof HTTPException) throw error; conflict(error instanceof Error ? error.message : "Job restart failed."); }
  });
  app.patch(`${base}/agent-jobs/:jobId/model`, zValidator("json", modelOption.extend({ restart: z.boolean().default(false) }).strict()), async (c) => {
    const projectId = c.req.param("projectId"), jobId = Number(c.req.param("jobId"));
    const input = c.req.valid("json");
    await validateModel(projectId, input);
    let job = await repos.agentJobs.get(projectId, jobId);
    if (!job) throw new HTTPException(404, { message: "Agent Job was not found." });
    let managed = false;
    if (input.restart) { const prepared = await prepareRestart(projectId, jobId); job = prepared.job; managed = Boolean(prepared.loop); }
    await repos.development.updateJobInput(projectId, jobId, { ...job.input, modelOverride: { model: input.model, effort: input.effort } });
    const nextJobId = input.restart ? await resumeRestart(projectId, jobId, managed) : jobId;
    return c.json({ jobId: nextJobId, model: input.model, effort: input.effort, queued: input.restart, appliesTo: "next_execution" });
  });
  app.get(`${base}/repository/file`, async (c) => {
    const project = (await repos.projects.get(c.req.param("projectId")))!;
    const path = c.req.query("path") ?? "";
    if (!path || isAbsolute(path) || path.includes("\0") || path.split(/[\\/]/).some((part) => ["..", ".git", ".oneteam"].includes(part))) throw new HTTPException(400, { message: "Choose a repository-relative source file." });
    const root = await realpath(project.repoPath);
    let full: string;
    try { full = await realpath(resolve(root, path)); } catch { throw new HTTPException(404, { message: "File was not found." }); }
    const inside = relative(root, full);
    if (inside.startsWith(`..${sep}`) || isAbsolute(inside) || inside.split(sep).some((part) => [".git", ".oneteam"].includes(part))) throw new HTTPException(403, { message: "The file is outside the permitted repository sources." });
    const info = await stat(full);
    if (!info.isFile() || info.size > 300000) throw new HTTPException(400, { message: "Choose a text file smaller than 300 KB." });
    const content = await readFile(full, "utf8");
    if (content.includes("\0")) throw new HTTPException(400, { message: "This file is not text." });
    return c.json({ path: inside, content });
  });
  return app;
}
