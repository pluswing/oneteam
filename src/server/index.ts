import { serve } from "@hono/node-server";
import { normalizeCodexCommand } from "../shared/codex";
import { loadConfig, rememberRepositoryPath, repositoryDatabaseUrl } from "./config";
import type { KnownRepositoryDto } from "../shared/types";
import { createApp } from "./app";
import { createDatabaseContext, type DatabaseContext } from "./db/client";
import { runMigrations } from "./db/migrations";
import { createRepositories, type Repositories } from "./db/repositories";
import { CodexAdapter } from "./agents/codex-adapter";
import { AgentWorker } from "./agents/worker";

const config = loadConfig();
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

const runtime = {
  server: config.server,
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
  runtime.database.url = nextUrl;
  previousContext.client.close();
  return repository;
}

const app = createApp({
  repos,
  runtime,
  switchDatabaseForRepository
});

let worker: AgentWorker | null = null;
if (config.agents.workerEnabled) {
  worker = new AgentWorker(
    repos,
    new CodexAdapter({
      command: config.agents.codexCommand,
      model: config.agents.codexModel,
      loadOptions: async () => {
        const ai = await repos.settings.get("ai");
        return {
          command: normalizeCodexCommand(typeof ai?.codexCommand === "string" ? ai.codexCommand : undefined),
          model: typeof ai?.model === "string" ? ai.model : undefined
        };
      }
    }),
    {
      pollIntervalMs: config.agents.pollIntervalMs
    }
  );
  worker.start();
  console.log("one team agent worker started");
}

function shutdown() {
  worker?.stop();
  activeDatabase.context.client.close();
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

serve(
  {
    fetch: app.fetch,
    hostname: config.server.host,
    port: config.server.port
  },
  (info) => {
    console.log(`one team API listening on http://${info.address}:${info.port}`);
  }
);
