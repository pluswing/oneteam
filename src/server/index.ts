import { loadConfig } from "./config";
import { startOneTeamServer } from "./runtime";

const server = await startOneTeamServer(loadConfig());

async function shutdown() {
  await server.stop();
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

console.log(`OneTeam API listening on ${server.url}`);
