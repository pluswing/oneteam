import type { ActivityType, AgentJobDto, AgentJobStatus } from "../../shared/types";

export type AgentActivityResult = {
  type: ActivityType;
  title: string;
  body?: string | null;
  payload?: Record<string, unknown> | null;
};

export type AgentRunResult = {
  status: Extract<AgentJobStatus, "succeeded" | "waiting_human" | "failed">;
  message: string;
  comment?: {
    targetType: "issue" | "pull_request";
    targetId: number;
    body: string;
  } | null;
  questions?: string[] | null;
  activities?: AgentActivityResult[] | null;
  changedFiles?: string[] | null;
  testResults?: Array<Record<string, unknown>> | null;
  metadata?: {
    nextLabel?: string | null;
    pullRequest?: {
      title: string;
      body?: string | null;
      sourceBranch: string;
      targetBranch: string;
      issueId?: number | null;
    } | null;
    [key: string]: unknown;
  } | null;
};

export type AgentAdapter = {
  run(input: {
    job: AgentJobDto;
    repoPath: string;
    prompt: string;
    onActivity?: (activity: AgentActivityResult) => Promise<void> | void;
  }): Promise<AgentRunResult>;
};
