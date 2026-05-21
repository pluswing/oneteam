import type { AgentType } from "../../shared/types";

export type AgentJobLockInput = {
  projectId: string;
  agentType: AgentType;
  targetType: "issue" | "pull_request" | "project";
  targetId: number;
};

export function resolveAgentJobLockKey(input: AgentJobLockInput): string | null {
  if (input.agentType === "implementation" && input.targetType === "issue") {
    return `project:${input.projectId}:issue:${input.targetId}:write`;
  }

  if (input.agentType === "fix" && input.targetType === "pull_request") {
    return `project:${input.projectId}:pull_request:${input.targetId}:write`;
  }

  if (input.agentType === "command_detection") {
    return `project:${input.projectId}:repository:commands`;
  }

  return null;
}
