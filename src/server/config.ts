import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defaultCodexCommand, normalizeCodexCommand } from "../shared/codex";

export type AppConfig = {
  server: {
    host: string;
    port: number;
  };
  database: {
    url: string;
  };
  agents: {
    workerEnabled: boolean;
    pollIntervalMs: number;
    codexCommand: string;
    codexModel?: string;
  };
};

export function loadConfig(): AppConfig {
  return {
    server: {
      host: process.env.HOST ?? "127.0.0.1",
      port: Number(process.env.PORT ?? "3580")
    },
    database: {
      url: process.env.ONETEAM_DATABASE_URL ?? "file:./data/oneteam.db"
    },
    agents: {
      workerEnabled: process.env.ONETEAM_AGENT_WORKER !== "false",
      pollIntervalMs: Number(process.env.ONETEAM_AGENT_POLL_INTERVAL_MS ?? "3000"),
      codexCommand: normalizeCodexCommand(process.env.ONETEAM_CODEX_COMMAND ?? defaultCodexCommand),
      codexModel: process.env.ONETEAM_CODEX_MODEL || undefined
    }
  };
}

export function ensureDatabaseDirectory(databaseUrl: string): void {
  if (!databaseUrl.startsWith("file:")) {
    return;
  }

  const filePath = databaseUrl.replace(/^file:/, "");
  if (filePath === ":memory:" || filePath === "") {
    return;
  }

  mkdirSync(dirname(resolve(filePath)), { recursive: true });
}
