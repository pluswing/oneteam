import type { ActivityDto } from "../shared/types";

/** Job events belong to the optional execution history, rather than the conversation. */
export function isAgentDiagnosticActivity(activity: ActivityDto): boolean {
  return activity.agentJobId !== null
    || /^(?:Model selected|Model unavailable|Codex |Started (?:Codex|Claude Code|LM Studio)|Claude Code |AI provider selected|Worktree ready|Agent job queued)/.test(activity.title)
    || activity.title.endsWith(" agent started");
}
