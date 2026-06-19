import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { AiSettingsDto, ClaudeCodePermissionMode } from "../shared/ai-providers";
import { defaultAiSettings, defaultClaudeCodeCommand, defaultLmStudioBaseUrl, isAiProvider } from "../shared/ai-providers";
import { defaultCodexCommand, normalizeCodexCommand } from "../shared/codex";
import type { KnownRepositoryDto } from "../shared/types";

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
    ai: AiSettingsDto;
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
      ai: defaultAiSettings({
        provider: isAiProvider(process.env.ONETEAM_AI_PROVIDER) ? process.env.ONETEAM_AI_PROVIDER : "codex",
        codex: {
          command: normalizeCodexCommand(process.env.ONETEAM_CODEX_COMMAND ?? defaultCodexCommand),
          model: process.env.ONETEAM_CODEX_MODEL || null,
          fullAccess: true,
          autoLogin: process.env.ONETEAM_CODEX_AUTO_LOGIN !== "false"
        },
        claudeCode: {
          command: process.env.ONETEAM_CLAUDE_CODE_COMMAND || defaultClaudeCodeCommand,
          model: process.env.ONETEAM_CLAUDE_CODE_MODEL || null,
          permissionMode: claudePermissionMode(process.env.ONETEAM_CLAUDE_CODE_PERMISSION_MODE),
          maxTurns: positiveInteger(process.env.ONETEAM_CLAUDE_CODE_MAX_TURNS)
        },
        lmStudio: {
          baseUrl: process.env.ONETEAM_LM_STUDIO_BASE_URL || defaultLmStudioBaseUrl,
          model: process.env.ONETEAM_LM_STUDIO_MODEL || null,
          maxToolRounds: positiveInteger(process.env.ONETEAM_LM_STUDIO_MAX_TOOL_ROUNDS) ?? 8,
          temperature: finiteNumber(process.env.ONETEAM_LM_STUDIO_TEMPERATURE)
        }
      })
    }
  };
}

function claudePermissionMode(value: string | undefined): ClaudeCodePermissionMode {
  return value === "default" || value === "auto" || value === "dontAsk" || value === "bypassPermissions"
    ? value
    : "bypassPermissions";
}

function positiveInteger(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function finiteNumber(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function applicationRoot(): string {
  return resolve(process.env.ONETEAM_HOME ?? process.cwd());
}

function activeRepositoryPathFile(): string {
  return join(applicationRoot(), ".oneteam", "active-repository");
}

function repositoryRegistryFile(): string {
  return join(applicationRoot(), ".oneteam", "repositories.json");
}

function rememberedRepositoryPath(): string | null {
  try {
    const value = readFileSync(activeRepositoryPathFile(), "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

export function listKnownRepositories(): KnownRepositoryDto[] {
  try {
    const parsed = JSON.parse(readFileSync(repositoryRegistryFile(), "utf8")) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((item): item is Partial<KnownRepositoryDto> => typeof item === "object" && item !== null)
      .filter((item): item is KnownRepositoryDto => typeof item.repoPath === "string")
      .map((item) => {
        const repoPath = resolve(item.repoPath);
        return {
          repoPath,
          name: typeof item.name === "string" && item.name ? item.name : basename(repoPath),
          databaseUrl: repositoryDatabaseUrl(repoPath),
          lastOpenedAt: typeof item.lastOpenedAt === "string" ? item.lastOpenedAt : new Date(0).toISOString()
        };
      })
      .sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
  } catch {
    return [];
  }
}

export function listSelectableRepositories(): KnownRepositoryDto[] {
  const knownRepositories = listKnownRepositories();
  const configuredRepositoryPath = process.env.ONETEAM_REPOSITORY_PATH ? resolve(process.env.ONETEAM_REPOSITORY_PATH) : null;
  if (!configuredRepositoryPath || knownRepositories.some((item) => item.repoPath === configuredRepositoryPath)) {
    return knownRepositories;
  }

  return [
    {
      repoPath: configuredRepositoryPath,
      name: basename(configuredRepositoryPath),
      databaseUrl: repositoryDatabaseUrl(configuredRepositoryPath),
      lastOpenedAt: new Date().toISOString()
    },
    ...knownRepositories
  ];
}

export function rememberRepositoryPath(repoPath: string, name?: string): KnownRepositoryDto {
  const resolvedRepoPath = resolve(repoPath);
  const current = listKnownRepositories();
  const existing = current.find((item) => item.repoPath === resolvedRepoPath);
  const entry: KnownRepositoryDto = {
    repoPath: resolvedRepoPath,
    name: name || existing?.name || basename(resolvedRepoPath),
    databaseUrl: repositoryDatabaseUrl(resolvedRepoPath),
    lastOpenedAt: new Date().toISOString()
  };
  const next = [entry, ...current.filter((item) => item.repoPath !== resolvedRepoPath)];

  const path = activeRepositoryPathFile();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, resolvedRepoPath, "utf8");
  writeFileSync(repositoryRegistryFile(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return entry;
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
