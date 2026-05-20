import type { ActivityType, AgentJobDto, AgentJobStatus } from "../../shared/types";

export type AgentActivityResult = {
  type: ActivityType;
  title: string;
  body?: string;
  payload?: Record<string, unknown>;
};

export type AgentRunResult = {
  status: Extract<AgentJobStatus, "succeeded" | "waiting_human" | "failed">;
  message: string;
  comment?: {
    targetType: "issue" | "pull_request";
    targetId: number;
    body: string;
  };
  questions?: string[];
  activities?: AgentActivityResult[];
  changedFiles?: string[];
  testResults?: Array<Record<string, unknown>>;
  metadata?: {
    nextLabel?: string;
    pullRequest?: {
      title: string;
      body?: string;
      sourceBranch: string;
      targetBranch: string;
      issueId?: number | null;
    };
    [key: string]: unknown;
  };
};

export type AgentAdapter = {
  run(input: {
    job: AgentJobDto;
    repoPath: string;
    prompt: string;
    onActivity?: (activity: AgentActivityResult) => Promise<void> | void;
  }): Promise<AgentRunResult>;
};
