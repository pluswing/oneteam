import type { ActivityDto } from "../shared/types";
import { isRecord } from "./value-parsers";

/** Parse complete result documents, never snippets embedded in prose or commands. */
export function parseActivityBody(body: string): Record<string, unknown> | unknown[] | null {
  const text = body.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1").trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) || Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

export function newestActivities(activities: ActivityDto[]): ActivityDto[] {
  const time = (activity: ActivityDto) => Date.parse(activity.lastOccurredAt) || Date.parse(activity.createdAt) || 0;
  return [...activities].sort((a, b) => time(b) - time(a) || b.id - a.id);
}

export function activityStatusTone(status: string): string {
  if (["succeeded", "completed", "success", "passed", "approved", "resolved", "done"].includes(status)) return "succeeded";
  if (["failed", "error", "rejected", "defects_found", "timed_out"].includes(status)) return "failed";
  if (["running", "in_progress", "inProgress", "started", "queued", "pending", "changes_requested"].includes(status)) return "running";
  if (["waiting_human", "waiting_provider", "paused", "interrupted", "canceled", "cancelled", "skipped", "waiting_input", "waiting_capacity"].includes(status)) return "waiting";
  return "neutral";
}
