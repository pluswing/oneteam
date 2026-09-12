import { createModelSelector } from "./agents/model-router";
import { dirname, resolve } from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { z } from "zod";
import { createApp } from "./app";
import { loadConfig, rememberRepositoryPath, repositoryDatabaseUrl, type AppConfig } from "./config";
import { createDatabaseContext, type DatabaseContext } from "./db/client";
import { runMigrations } from "./db/migrations";
import { createRepositories, type Repositories } from "./db/repositories";
import { LoopEngine } from "./services/loop-engine";
import { CodexRuntime } from "./agents/codex-runtime";
import { checkCodexLoginStatus, ensureCodexLogin, type CodexLoginOptions } from "./services/codex-auth";
import { recoverInterruptedAgentJobs } from "./services/runtime-recovery";
import { acquireWorkspaceLock, backupBeforeLoopMigration, completeWorkspace, inspectWorkspace, prepareWorkspace } from "./services/workspace";
import { ensureKnowledgeFiles } from "./services/knowledge-files";
import { detectRepositoryCommands } from "./services/command-detection";

export type OneTeamRuntime = {
  app: Hono;
  repos: Repositories;
  runtime: { server: AppConfig["server"]; database: AppConfig["database"] };
  stop: () => Promise<void>;
};
export type StartedOneTeamServer = OneTeamRuntime & { server: ServerType; url: string };
type OneTeamRuntimeOptions = { staticRoot?: string; codexLogin?: CodexLoginOptions };
type WorkspaceRuntime = { context: DatabaseContext; repos: Repositories; app: Hono; worker: LoopEngine | null; release: (() => Promise<void>) | null; url: string };

export async function createOneTeamRuntime(config: AppConfig = loadConfig(), options: OneTeamRuntimeOptions = {}): Promise<OneTeamRuntime> {
  const runtime = { server: { ...config.server }, database: { ...config.database } };
  let switching = false;
  let stopped = false;
  let opening: Promise<void> | null = null;
  let active: WorkspaceRuntime;
  const requests = new Set<Promise<Response>>();
  async function drainRequests(): Promise<void> { await Promise.allSettled([...requests]); }

  async function openDatabase(url: string, repoPath?: string): Promise<WorkspaceRuntime> {
    const release = repoPath ? await acquireWorkspaceLock(repoPath) : null;
    let context: DatabaseContext | undefined;
    try {
      context = createDatabaseContext(url);
      await backupBeforeLoopMigration(context.client, url);
      await runMigrations(context.client);
      const repos = createRepositories(context.db);
      return { context, repos, release, worker: null, url, app: createApp({ repos, runtime, staticRoot: options.staticRoot }) };
    } catch (error) {
      context?.client.close();
      await release?.();
      throw error;
    }
  }

  async function startWorker(workspace: WorkspaceRuntime): Promise<void> {
    if (stopped || !config.agents.workerEnabled || workspace.worker) return;
    const projects = await workspace.repos.projects.list();
    if (!projects.length) return;
    if (!workspace.release) workspace.release = await acquireWorkspaceLock(projects[0].repoPath);
    await recoverInterruptedAgentJobs(workspace.repos);
    for (const project of projects) await workspace.repos.development.executions.interrupt(project.id);
    const adapter = new CodexRuntime({
      command: config.agents.ai.codex.command, repos: workspace.repos, selectModel: createModelSelector(workspace.repos),
      ensureReady: async () => {
        const result = await ensureCodexLogin(config.agents.ai.codex.command, { enabled: config.agents.ai.codex.autoLogin, launcher: options.codexLogin?.launcher });
        if (result.status === "failed" || result.status === "login_started") throw new Error(result.message);
      }
    });
    workspace.worker = new LoopEngine(workspace.repos, adapter, config.agents.pollIntervalMs);
    await workspace.worker.initialize();
    workspace.worker.start();
  }

  async function closeWorkspace(workspace: WorkspaceRuntime): Promise<void> {
    await workspace.worker?.stopAndDrain();
    workspace.worker = null;
    workspace.context.client.close();
    await workspace.release?.();
  }

  const initialPath = config.database.url.startsWith("file:") && config.database.url.endsWith("/.oneteam/data/oneteam.db")
    ? dirname(dirname(dirname(resolve(config.database.url.slice(5))))) : undefined;
  if (initialPath) { await inspectWorkspace(initialPath); await prepareWorkspace(initialPath); }
  active = await openDatabase(config.database.url, initialPath);
  try {
    if (initialPath) {
      const project = (await active.repos.projects.list())[0];
      if (project) {
        if (project.repoPath !== initialPath) await active.repos.projects.update(project.id, { repoPath: initialPath });
        await ensureKnowledgeFiles(initialPath);
        await completeWorkspace(initialPath);
      }
    }
    await startWorker(active);
  } catch (error) { await closeWorkspace(active); throw error; }
  const app = new Hono();
  let connectionCache: { at: number; status: "connected" | "login_required" } | null = null;
  app.get("/api/codex/status", async (c) => {
    if (!connectionCache || Date.now() - connectionCache.at > 30_000) {
      const result = await checkCodexLoginStatus(config.agents.ai.codex.command);
      connectionCache = { at: Date.now(), status: result.exitCode === 0 ? "connected" : "login_required" };
    }
    return c.json({ status: connectionCache.status });
  });
  app.post("/api/projects", async (c) => {
    if (switching || stopped) return c.json({ error: { message: "A folder is already opening. Try again shortly." } }, 409);
    switching = true;
    let opened!: () => void;
    opening = new Promise<void>((resolve) => { opened = resolve; });
    let next: WorkspaceRuntime | null = null;
    try {
      const input = z.object({ repoPath: z.string().min(1), locale: z.enum(["en", "ja"]).default("en") }).parse(await c.req.json());
      const inspected = await inspectWorkspace(input.repoPath);
      const url = process.env.ONETEAM_DATABASE_URL ?? repositoryDatabaseUrl(inspected.repoPath);
      const currentProject = (await active.repos.projects.list()).find((project) => project.repoPath === inspected.repoPath);
      if (currentProject && active.url === url) return c.json({ project: currentProject, onboardingIssueId: null });
      if (process.env.ONETEAM_DATABASE_URL) {
        const existing = await active.repos.projects.list();
        if (existing.length) throw new Error("A fixed database cannot be switched to another repository.");
      } else await prepareWorkspace(inspected.repoPath);
      // Interrupt and persist the old job before changing any runtime references.
      await drainRequests();
      await active.worker?.stopAndDrain();
      active.worker = null;
      next = active.url === url ? active : await openDatabase(url, inspected.repoPath);
      let project = (await next.repos.projects.list())[0];
      if (project && project.repoPath !== inspected.repoPath) {
        project = (await next.repos.projects.update(project.id, { repoPath: inspected.repoPath })) ?? project;
      }
      if (!project) {
        project = await next.repos.projects.create({ ...inspected, locale: input.locale });
        const detection = await detectRepositoryCommands(project.repoPath);
        await next.repos.commands.upsertMany(project.id, detection.commands);
      }
      await ensureKnowledgeFiles(project.repoPath);
      if (!process.env.ONETEAM_DATABASE_URL) await completeWorkspace(project.repoPath);
      await startWorker(next);
      if (next !== active) await closeWorkspace(active);
      active = next;
      next = null;
      runtime.database.url = url;
      rememberRepositoryPath(inspected.repoPath);
      return c.json({ project, onboardingIssueId: null }, 201);
    } catch (error) {
      if (next && next !== active) await closeWorkspace(next);
      await startWorker(active);
      return c.json({ error: { message: error instanceof Error ? error.message : "Unable to open folder." } }, 400);
    } finally { switching = false; opening = null; opened(); }
  });
  app.all("*", async (c) => {
    if (switching || stopped) return c.json({ error: { message: "Workspace is changing. Retry shortly." } }, 409);
    // Capture the app for the duration of this request; jobs never use a repositories Proxy.
    const request = Promise.resolve(active.app.fetch(c.req.raw));
    requests.add(request);
    try { return await request; } finally { requests.delete(request); }
  });
  return {
    app, get repos() { return active.repos; }, runtime,
    async stop() { if (stopped) return; stopped = true; await opening; await drainRequests(); await closeWorkspace(active); }
  };
}

export async function startOneTeamServer(config: AppConfig = loadConfig(), options: OneTeamRuntimeOptions = {}): Promise<StartedOneTeamServer> {
  const oneTeam = await createOneTeamRuntime(config, options);
  let server!: ServerType;
  const url = await new Promise<string>((resolve) => {
    server = serve({ fetch: oneTeam.app.fetch, hostname: config.server.host, port: config.server.port }, (info) => {
      oneTeam.runtime.server.port = info.port;
      resolve(`http://${info.address}:${info.port}`);
    });
  });
  return { ...oneTeam, server, url, async stop() { server.close(); await oneTeam.stop(); } };
}
