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

export type PullRequestDto = {
  id: number;
  issueId: number | null;
  title: string;
  body: string;
  status: PullRequestStatus;
  sourceBranch: string;
  targetBranch: string;
  labels: LabelDto[];
  commentCount: number;
  changedFileCount: number;
  commitCount: number;
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

export type AgentJobDto = {
  id: number;
  agentType: AgentType;
  targetType: "issue" | "pull_request" | "project";
  targetId: number;
  status: AgentJobStatus;
  triggerType: string;
  parentJobId: number | null;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: string | null;
  attempt: number;
  lockKey: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type RepositoryStatusDto = {
  branch: string;
  clean: boolean;
  changedFiles: string[];
  ahead: number;
  behind: number;
};

export type RepositoryBranchDto = {
  name: string;
  current: boolean;
};

export type RepositoryCommitDto = {
  hash: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  date: string;
};

export type RepositoryFileChangeDto = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
};

export type MergeConflictDto = {
  hasConflicts: boolean;
  files: Array<{
    path: string;
    reason: string;
  }>;
};

export type ApiError = {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
};
