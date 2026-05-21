export const defaultCodexCommand = "node_modules/.bin/codex";

export function normalizeCodexCommand(command: string | undefined): string {
  if (!command || command === "codex") {
    return defaultCodexCommand;
  }
  return command;
}
