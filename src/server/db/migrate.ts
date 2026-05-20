import { loadConfig } from "../config";
import { createDatabaseContext } from "./client";
import { runMigrations } from "./migrations";

const config = loadConfig();
const context = createDatabaseContext(config.database.url);

await runMigrations(context.client);
context.client.close();

console.log(`Database migrated: ${config.database.url}`);
