import { serve } from "@hono/node-server";
import { loadConfig } from "./config";
import { createApp } from "./app";
import { createDatabaseContext } from "./db/client";
import { runMigrations } from "./db/migrations";
import { createRepositories } from "./db/repositories";

const config = loadConfig();
const database = createDatabaseContext(config.database.url);

await runMigrations(database.client);

const app = createApp({
  repos: createRepositories(database.db)
});

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
