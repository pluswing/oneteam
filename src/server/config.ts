import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { CodexProviderSettings } from "../shared/ai-providers";
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
    ai: { codex: CodexProviderSettings };
  };
};

export function loadConfig(): AppConfig {
  return {
    server: {
      host: process.env.HOST ?? "127.0.0.1",
      port: Number(process.env.PORT ?? "3580")
    },
    database: {
      url: process.env.ONETEAM_DATABASE_URL ?? defaultDatabaseUrl()
    },
    agents: {
      workerEnabled: process.env.ONETEAM_AGENT_WORKER !== "false",
      pollIntervalMs: Number(process.env.ONETEAM_AGENT_POLL_INTERVAL_MS ?? "3000"),
      ai: {
        codex: {
          command: normalizeCodexCommand(process.env.ONETEAM_CODEX_COMMAND ?? defaultCodexCommand),
          model: null,
          fullAccess: true,
          autoLogin: process.env.ONETEAM_CODEX_AUTO_LOGIN !== "false"
        }
      }
    }
  };
}

export function applicationRoot(): string {
  return resolve(process.env.ONETEAM_HOME ?? process.cwd());
}

function activeRepositoryPathFile(): string {
  return join(applicationRoot(), ".oneteam", "active-repository");
}

function rememberedRepositoryPath(): string | null {
  try {
    const value = readFileSync(activeRepositoryPathFile(), "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

export function rememberRepositoryPath(repoPath: string): void {
  const path = activeRepositoryPathFile();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, resolve(repoPath), "utf8");
}

export function repositoryDatabaseUrl(repoPath: string): string {
  return `file:${join(resolve(repoPath), ".oneteam", "data", "oneteam.db")}`;
}

export function defaultDatabaseUrl(): string {
  const activeRepositoryPath = process.env.ONETEAM_REPOSITORY_PATH || rememberedRepositoryPath();
  return activeRepositoryPath ? repositoryDatabaseUrl(activeRepositoryPath) : ":memory:";
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
