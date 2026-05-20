import { serve } from "@hono/node-server";
import { loadConfig } from "./config";
import { createApp } from "./app";
import { createDatabaseContext } from "./db/client";
import { runMigrations } from "./db/migrations";
import { createRepositories } from "./db/repositories";
import { CodexAdapter } from "./agents/codex-adapter";
import { AgentWorker } from "./agents/worker";

const config = loadConfig();
const database = createDatabaseContext(config.database.url);

await runMigrations(database.client);

const repos = createRepositories(database.db);
const app = createApp({ repos });

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
          command: typeof ai?.codexCommand === "string" ? ai.codexCommand : undefined,
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
  database.client.close();
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
