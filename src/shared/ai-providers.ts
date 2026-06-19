import { defaultCodexCommand } from "./codex";

export const aiProviders = ["codex", "claude_code", "lm_studio"] as const;

export type AiProvider = (typeof aiProviders)[number];

export type ClaudeCodePermissionMode = "default" | "auto" | "dontAsk" | "bypassPermissions";

export type CodexProviderSettings = {
  command: string;
  model: string | null;
  fullAccess: boolean;
  autoLogin: boolean;
};

export type ClaudeCodeProviderSettings = {
  command: string;
  model: string | null;
  permissionMode: ClaudeCodePermissionMode;
  maxTurns: number | null;
};

export type LmStudioProviderSettings = {
  baseUrl: string;
  model: string | null;
  maxToolRounds: number;
  temperature: number | null;
};

export type AiSettingsDto = {
  provider: AiProvider;
  codex: CodexProviderSettings;
  claudeCode: ClaudeCodeProviderSettings;
  lmStudio: LmStudioProviderSettings;
};

export const defaultClaudeCodeCommand = "claude";
export const defaultLmStudioBaseUrl = "http://127.0.0.1:1234/v1";

export function aiProviderLabel(provider: AiProvider): string {
  switch (provider) {
    case "codex":
      return "Codex";
    case "claude_code":
      return "Claude Code";
    case "lm_studio":
      return "LM Studio";
  }
}

export function defaultAiSettings(overrides: Partial<AiSettingsDto> = {}): AiSettingsDto {
  return normalizeAiSettings(overrides);
}

export function normalizeAiSettings(value: unknown, defaults?: AiSettingsDto): AiSettingsDto {
  const fallback = defaults ?? {
    provider: "codex" as const,
    codex: {
      command: defaultCodexCommand,
      model: null,
      fullAccess: true,
      autoLogin: true
    },
    claudeCode: {
      command: defaultClaudeCodeCommand,
      model: null,
      permissionMode: "bypassPermissions" as const,
      maxTurns: null
    },
    lmStudio: {
      baseUrl: defaultLmStudioBaseUrl,
      model: null,
      maxToolRounds: 8,
      temperature: null
    }
  };
  const record = isRecord(value) ? value : {};
  const legacyProvider = record.provider === "codex-cli" ? "codex" : record.provider;
  const provider = isAiProvider(legacyProvider) ? legacyProvider : fallback.provider;
  const legacyCodexCommand =
    typeof record.codexCommand === "string" ? record.codexCommand : typeof record.command === "string" ? record.command : null;
  const legacyModel = typeof record.model === "string" ? record.model : null;
  const codexRecord = isRecord(record.codex) ? record.codex : {};
  const claudeRecord = isRecord(record.claudeCode) ? record.claudeCode : {};
  const lmStudioRecord = isRecord(record.lmStudio) ? record.lmStudio : {};

  return {
    provider,
    codex: {
      command: stringValue(codexRecord.command) ?? legacyCodexCommand ?? fallback.codex.command,
      model: nullableString(codexRecord.model) ?? legacyModel ?? fallback.codex.model,
      fullAccess: booleanValue(codexRecord.fullAccess) ?? booleanValue(record.fullAccess) ?? fallback.codex.fullAccess,
      autoLogin: booleanValue(codexRecord.autoLogin) ?? fallback.codex.autoLogin
    },
    claudeCode: {
      command: stringValue(claudeRecord.command) ?? fallback.claudeCode.command,
      model: nullableString(claudeRecord.model) ?? fallback.claudeCode.model,
      permissionMode: isClaudePermissionMode(claudeRecord.permissionMode)
        ? claudeRecord.permissionMode
        : fallback.claudeCode.permissionMode,
      maxTurns: positiveIntegerOrNull(claudeRecord.maxTurns) ?? fallback.claudeCode.maxTurns
    },
    lmStudio: {
      baseUrl: stringValue(lmStudioRecord.baseUrl) ?? fallback.lmStudio.baseUrl,
      model: nullableString(lmStudioRecord.model) ?? fallback.lmStudio.model,
      maxToolRounds: positiveIntegerOrNull(lmStudioRecord.maxToolRounds) ?? fallback.lmStudio.maxToolRounds,
      temperature: numberOrNull(lmStudioRecord.temperature) ?? fallback.lmStudio.temperature
    }
  };
}

export function isAiProvider(value: unknown): value is AiProvider {
  return typeof value === "string" && (aiProviders as readonly string[]).includes(value);
}

function isClaudePermissionMode(value: unknown): value is ClaudeCodePermissionMode {
  return value === "default" || value === "auto" || value === "dontAsk" || value === "bypassPermissions";
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === "string" ? value.trim() || null : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function positiveIntegerOrNull(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function numberOrNull(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
