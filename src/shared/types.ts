import type { AiProvider, AiSettingsDto } from "./ai-providers";

export type IssueStatus = "open" | "closed";
export type PullRequestStatus = "open" | "closed" | "merged";
export type WorkItemAuthorType = "user" | "agent" | "system";
export type LabelKind = "system" | "custom";
export type AgentType =
  | "requirements"
  | "implementation"
  | "review"
  | "fix"
  | "qa"
  | "verifier"
  | "command_detection";
export type AgentJobStatus =
  | "queued"
  | "running"
  | "paused"
  | "waiting_provider"
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
export type CommentBodyFormat = "markdown" | "html";
export type LoopStatus = "enabled" | "disabled";
export type LoopRunStatus =
  | "queued"
  | "running"
  | "paused"
  | "waiting_provider"
  | "waiting_human"
  | "succeeded"
  | "failed"
  | "canceled";
export type LoopStepStatus =
  | "queued"
  | "running"
  | "paused"
  | "waiting_provider"
  | "waiting_human"
  | "succeeded"
  | "failed"
  | "canceled";
export type ObjectiveRunStatus =
  | "open"
  | "running"
  | "paused"
  | "waiting_provider"
  | "waiting_human"
  | "ready_to_merge"
  | "succeeded"
  | "failed"
  | "canceled";
export type ObjectiveWorkflowStage =
  | "requirements"
  | "implementation"
  | "review"
  | "fix"
  | "qa"
  | "verification"
  | "ready_to_merge"
  | "merged";
export type TriageItemStatus = "open" | "converted" | "ignored";

export type ProjectDto = {
  id: string;
  name: string;
  repoPath: string;
  defaultBranch: string;
  locale: string;
  createdAt: string;
  updatedAt: string;
};

export type KnownRepositoryDto = {
  repoPath: string;
  name: string;
  databaseUrl: string;
  lastOpenedAt: string;
};

export type ProjectSettingsDto = {
  project: {
    locale: string;
  };
  ai: AiSettingsDto;
  automation: {
    autoMergeEnabled: boolean;
    autoMergeTargetBranches: string[];
    autoMergeStrategy: "merge" | "squash";
    autoMergeRiskThreshold: "medium" | "high" | "none";
  };
  runtime: {
    server: {
      host: string;
      port: number;
    };
    database: {
      url: string;
    };
  };
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
  createdByType: WorkItemAuthorType;
  labels: LabelDto[];
  commentCount: number;
  lastAgentStatus: AgentJobStatus | null;
  lastAgentStopReason: string | null;
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
  createdByType: WorkItemAuthorType;
  sourceBranch: string;
  targetBranch: string;
  labels: LabelDto[];
  commentCount: number;
  changedFileCount: number;
  commitCount: number;
  lastAgentStatus: AgentJobStatus | null;
  lastAgentStopReason: string | null;
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
  bodyFormat: CommentBodyFormat;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

export type CommentRevisionDto = {
  id: number;
  commentId: number;
  editorType: "user";
  body: string;
  bodyFormat: CommentBodyFormat;
  createdAt: string;
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
  projectId: string;
  aiProvider: AiProvider;
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
  waitReason: string | null;
  waitMetadata: Record<string, unknown> | null;
  nextRetryAt: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type LoopDto = {
  id: number;
  projectId: string;
  name: string;
  purpose: string;
  triggerType: string;
  cadence: string | null;
  targetScope: string;
  status: LoopStatus;
  maxRounds: number;
  timeBudgetMinutes: number | null;
  costBudget: number | null;
  stopCondition: Record<string, unknown> | null;
  riskPolicy: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

export type LoopRunDto = {
  id: number;
  projectId: string;
  loopId: number;
  status: LoopRunStatus;
  triggerType: string;
  targetType: "issue" | "pull_request" | "project" | null;
  targetId: number | null;
  worktreePath: string | null;
  summary: string;
  stopReason: string | null;
  evidence: Record<string, unknown> | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type LoopStepDto = {
  id: number;
  projectId: string;
  loopRunId: number;
  agentJobId: number | null;
  agentType: AgentType;
  targetType: "issue" | "pull_request" | "project";
  targetId: number;
  status: LoopStepStatus;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  evidence: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

export type LoopMemoryEntryDto = {
  id: number;
  projectId: string;
  loopId: number | null;
  loopRunId: number | null;
  sourceType: "manual" | "loop_run" | "agent_job" | "triage";
  sourceId: number | null;
  title: string;
  body: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

export type ObjectiveRunDto = {
  id: number;
  projectId: string;
  issueId: number | null;
  pullRequestId: number | null;
  status: ObjectiveRunStatus;
  workflowStage: ObjectiveWorkflowStage;
  title: string;
  goal: string;
  roundCount: number;
  maxRounds: number;
  lastAgentJobId: number | null;
  judgeAgentJobId: number | null;
  generatorAiProvider: AiProvider | null;
  judgeAiProvider: AiProvider | null;
  lastFailureSignature: string | null;
  repeatedFailureCount: number;
  stopReason: string | null;
  evidence: Record<string, unknown> | null;
  summary: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export type TriageItemDto = {
  id: number;
  projectId: string;
  sourceType: string;
  sourceId: number | null;
  title: string;
  body: string;
  status: TriageItemStatus;
  priority: string;
  metadata: Record<string, unknown> | null;
  issueId: number | null;
  createdAt: string;
  updatedAt: string;
};

export type SkillFileDto = {
  path: string;
  title: string;
  body: string;
  updatedAt: string | null;
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
  previousPath?: string;
  status: string;
  additions: number;
  deletions: number;
  binary?: boolean;
  patch?: string;
};

export type RepositoryDiffSummaryDto = {
  files: RepositoryFileChangeDto[];
  sourceCommit: string;
  targetCommit: string;
};

export type PullRequestFindingDto = {
  id: string;
  agentJobId: number;
  source: "review" | "qa";
  severity: "critical" | "high" | "medium" | "low" | "info";
  path: string;
  line: number | null;
  side: "L" | "R";
  title: string;
  body: string;
  status: "open" | "resolved";
  resolvedByJobId: number | null;
  createdAt: string;
};

export type PullRequestLineCommentDto = CommentDto & {
  path: string;
  line: number;
  side: "L" | "R";
  sourceCommit: string;
  targetCommit: string;
};

export type MergeConflictDto = {
  hasConflicts: boolean;
  files: Array<{
    path: string;
    reason: string;
    baseContent?: string | null;
    targetContent?: string | null;
    sourceContent?: string | null;
  }>;
};

export type ApiError = {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
};
