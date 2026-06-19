import { serve, type ServerType } from "@hono/node-server";
import { normalizeAiSettings } from "../shared/ai-providers";
import type { KnownRepositoryDto } from "../shared/types";
import { AgentWorker } from "./agents/worker";
import { ProviderRoutingAdapter } from "./agents/provider-router";
import { createApp } from "./app";
import { loadConfig, rememberRepositoryPath, repositoryDatabaseUrl, type AppConfig } from "./config";
import { createDatabaseContext, type DatabaseContext } from "./db/client";
import { runMigrations } from "./db/migrations";
import { createRepositories, type Repositories } from "./db/repositories";
import type { CodexLoginOptions } from "./services/codex-auth";
import { ensureProviderReady } from "./services/provider-readiness";

export type OneTeamRuntime = {
  app: ReturnType<typeof createApp>;
  repos: Repositories;
  runtime: {
    server: AppConfig["server"];
    database: AppConfig["database"];
  };
  stop: () => void;
};

export type StartedOneTeamServer = OneTeamRuntime & {
  server: ServerType;
  url: string;
  stop: () => void;
};

type OneTeamRuntimeOptions = {
  staticRoot?: string;
  codexLogin?: CodexLoginOptions;
};

export async function createOneTeamRuntime(
  config: AppConfig = loadConfig(),
  options: OneTeamRuntimeOptions = {}
): Promise<OneTeamRuntime> {
  let activeDatabase: {
    context: DatabaseContext;
    repos: Repositories;
    url: string;
  };

  const database = createDatabaseContext(config.database.url);
  await runMigrations(database.client);
  activeDatabase = {
    context: database,
    repos: createRepositories(database.db),
    url: config.database.url
  };
  await ensureDefaultAiSettings(activeDatabase.repos, config);

  const runtime = {
    server: { ...config.server },
    database: {
      url: activeDatabase.url
    }
  };
  const repos = new Proxy({} as Repositories, {
    get(_target, property: keyof Repositories) {
      return activeDatabase.repos[property];
    }
  });

  async function switchDatabaseForRepository(repoPath: string, name?: string): Promise<KnownRepositoryDto | null> {
    if (process.env.ONETEAM_DATABASE_URL) {
      return null;
    }

    const nextUrl = repositoryDatabaseUrl(repoPath);
    const repository = rememberRepositoryPath(repoPath, name);
    if (nextUrl === activeDatabase.url) {
      runtime.database.url = nextUrl;
      return repository;
    }

    const nextContext = createDatabaseContext(nextUrl);
    await runMigrations(nextContext.client);
    const previousContext = activeDatabase.context;
    activeDatabase = {
      context: nextContext,
      repos: createRepositories(nextContext.db),
      url: nextUrl
    };
    await ensureDefaultAiSettings(activeDatabase.repos, config);
    runtime.database.url = nextUrl;
    previousContext.client.close();
    return repository;
  }

  const app = createApp({
    ai: {
      ...config.agents.ai
    },
    repos,
    runtime,
    staticRoot: options.staticRoot,
    switchDatabaseForRepository
  });

  let worker: AgentWorker | null = null;
  if (config.agents.workerEnabled) {
    worker = new AgentWorker(
      repos,
      new ProviderRoutingAdapter({
        defaults: config.agents.ai,
        loadSettings: () => repos.settings.get("ai"),
        ensureReady: (provider, settings) =>
          ensureProviderReady(provider, settings, {
            loginLauncher: options.codexLogin?.launcher
          })
      }),
      {
        pollIntervalMs: config.agents.pollIntervalMs
      }
    );
    worker.start();
    console.log("OneTeam agent worker started");
  }

  return {
    app,
    repos,
    runtime,
    stop() {
      worker?.stop();
      activeDatabase.context.client.close();
    }
  };
}

async function ensureDefaultAiSettings(repos: Repositories, config: AppConfig): Promise<void> {
  const current = await repos.settings.get("ai");
  if (current) {
    return;
  }
  await repos.settings.set("ai", normalizeAiSettings(config.agents.ai) as unknown as Record<string, unknown>);
}

export async function startOneTeamServer(
  config: AppConfig = loadConfig(),
  options: OneTeamRuntimeOptions = {}
): Promise<StartedOneTeamServer> {
  const oneTeam = await createOneTeamRuntime(config, options);
  let server: ServerType;
  const url = await new Promise<string>((resolve) => {
    server = serve(
      {
        fetch: oneTeam.app.fetch,
        hostname: oneTeam.runtime.server.host,
        port: oneTeam.runtime.server.port
      },
      (info) => {
        oneTeam.runtime.server.port = info.port;
        resolve(`http://${info.address}:${info.port}`);
      }
    );
  });

  return {
    ...oneTeam,
    server: server!,
    url,
    stop() {
      server.close();
      oneTeam.stop();
    }
  };
}
