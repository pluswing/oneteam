// Keep the historical entry point on the same isolated capture workflow.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "docs:screenshots"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "inherit"
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
