export const defaultCodexCommand = "codex";

export function normalizeCodexCommand(command: string | undefined): string {
  if (!command || command === "codex" || command === "node_modules/.bin/codex" || command === "./node_modules/.bin/codex") {
    return defaultCodexCommand;
  }
  return command;
}
