import type { ActivityDto, AgentJobDto } from "../shared/types";
import { stringValue } from "./value-parsers";

export function isNoisyCodexText(text: string): boolean {
  return (
    text.length > 1000 &&
    (text.includes("<html>") || text.includes("codex_core_plugins") || text.includes("codex_core_skills"))
  );
}

function agentJobFailureMessage(activities: ActivityDto[]): string | null {
  const meaningfulError = [...activities]
    .reverse()
    .find((activity) => ["Codex turn failed", "Codex error", "Agent job failed"].includes(activity.title) && activity.body);
  return meaningfulError?.body ?? null;
}

export function agentJobMessage(job: AgentJobDto, activities: ActivityDto[]): string | null {
  const output = job.output ?? {};
  if (job.status === "failed") {
    const activityMessage = agentJobFailureMessage(activities);
    if (activityMessage) {
      return activityMessage;
    }
  }

  const outputMessage = stringValue(output.message);
  if (outputMessage && !isNoisyCodexText(outputMessage)) {
    return outputMessage;
  }

  if (job.error && !isNoisyCodexText(job.error)) {
    return job.error;
  }

  return job.status === "failed" ? "Agent job failed. No concise error message was captured." : null;
}
