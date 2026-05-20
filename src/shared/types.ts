export type IssueStatus = "open" | "closed";
export type PullRequestStatus = "open" | "closed";
export type LabelKind = "system" | "custom";
export type AgentType =
  | "requirements"
  | "implementation"
  | "review"
  | "fix"
  | "qa"
  | "command_detection";
export type AgentJobStatus =
  | "queued"
  | "running"
  | "waiting_human"
  | "succeeded"
  | "failed"
  | "canceled";
export type ActivityType =
  | "thinking"
  | "progress"
  | "command"
  | "file_change"
  | "test"
  | "error"
  | "system";

export type ProjectDto = {
  id: string;
  name: string;
  repoPath: string;
  defaultBranch: string;
  locale: string;
  createdAt: string;
  updatedAt: string;
};

export type LabelDto = {
  id: number;
  name: string;
  color: string;
  kind: LabelKind;
  description: string;
  createdAt: string;
  updatedAt: string;
};

export type ProjectCommandDto = {
  id: number;
  commandType: CommandType;
  command: string | null;
  detectionSource: string;
  detectionDetails: Record<string, unknown> | null;
  isRequired: boolean;
  isAvailable: boolean;
  lastDetectedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CommandType = "install" | "dev" | "build" | "test" | "lint";

export type IssueDto = {
  id: number;
  title: string;
  body: string;
  status: IssueStatus;
  labels: LabelDto[];
  commentCount: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
};

export type CommentDto = {
  id: number;
  targetType: "issue" | "pull_request";
  targetId: number;
  authorType: "user" | "agent" | "system";
  agentType: AgentType | null;
  body: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

export type ActivityDto = {
  id: number;
  agentJobId: number | null;
  targetType: "issue" | "pull_request";
  targetId: number;
  activityType: ActivityType;
  title: string;
  body: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
};

export type ApiError = {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
};
