import type { AiProvider } from "../shared/ai-providers";
import type {
  AgentJobDto,
  ActivityDto,
  CommentDto,
  CommentRevisionDto,
  IssueDto,
  KnownRepositoryDto,
  LabelDto,
  LoopDto,
  LoopMemoryEntryDto,
  LoopRunDto,
  LoopStepDto,
  MergeConflictDto,
  ObjectiveRunDto,
  ProjectCommandDto,
  ProjectDto,
  ProjectSettingsDto,
  PullRequestDto,
  PullRequestFindingDto,
  PullRequestLineCommentDto,
  RepositoryCommitDto,
  RepositoryDiffSummaryDto,
  RepositoryFileChangeDto,
  RepositoryStatusDto,
  SkillFileDto,
  TriageItemDto
} from "../shared/types";

type ListResponse<T> = {
  items: T[];
};

type IssueListResponse = ListResponse<IssueDto> & {
  page: {
    limit: number;
    offset: number;
    total: number;
  };
};

type PullRequestListResponse = ListResponse<PullRequestDto> & {
  page: {
    limit: number;
    offset: number;
    total: number;
  };
};

type IssueMutationResponse = {
  issue: IssueDto;
  automationJobIds?: number[];
};

type PullRequestMutationResponse = {
  pullRequest: PullRequestDto;
  automationJobIds?: number[];
};

type PullRequestMergeResponse = {
  pullRequest: PullRequestDto;
  mergeCommit: string;
  output: string;
};

type LoopDetailResponse = {
  loop: LoopDto;
  runs: LoopRunDto[];
};

type LoopRunDetailResponse = {
  run: LoopRunDto;
  steps: LoopStepDto[];
};

type ObjectiveResponse = {
  objective: ObjectiveRunDto | null;
};

type ObjectiveControlResponse = {
  objective: ObjectiveRunDto;
  jobs: AgentJobDto[];
};

type RepositorySwitchResponse = {
  repository: KnownRepositoryDto;
  projects: ProjectDto[];
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers
    }
  });

  if (!response.ok) {
    const error = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(error?.error?.message ?? `Request failed: ${response.status}`);
  }

  return (await response.json()) as T;
}

export const api = {
  async listRepositories(): Promise<KnownRepositoryDto[]> {
    const response = await request<ListResponse<KnownRepositoryDto>>("/api/repositories");
    return response.items;
  },

  async switchRepository(input: { repoPath: string; name?: string }): Promise<RepositorySwitchResponse> {
    return request<RepositorySwitchResponse>("/api/repositories/switch", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  async listProjects(): Promise<ProjectDto[]> {
    const response = await request<ListResponse<ProjectDto>>("/api/projects");
    return response.items;
  },

  async createProject(input: {
    mode: "import" | "create";
    name: string;
    repoPath: string;
    defaultBranch: string;
    locale: string;
    aiProvider: AiProvider;
  }): Promise<ProjectDto> {
    const response = await request<{ project: ProjectDto }>("/api/projects", {
      method: "POST",
      body: JSON.stringify(input)
    });
    return response.project;
  },

  async listLabels(projectId: string): Promise<LabelDto[]> {
    const response = await request<ListResponse<LabelDto>>(`/api/projects/${projectId}/labels`);
    return response.items;
  },

  async listIssues(projectId: string): Promise<IssueListResponse> {
    return request<IssueListResponse>(`/api/projects/${projectId}/issues?status=open`);
  },

  async getIssue(projectId: string, issueId: number): Promise<IssueDto> {
    const response = await request<{ issue: IssueDto }>(`/api/projects/${projectId}/issues/${issueId}`);
    return response.issue;
  },

  async getIssueObjective(projectId: string, issueId: number): Promise<ObjectiveRunDto | null> {
    const response = await request<ObjectiveResponse>(`/api/projects/${projectId}/issues/${issueId}/objective`);
    return response.objective;
  },

  async createIssue(projectId: string, input: { title: string; body: string; labelIds: number[] }): Promise<IssueDto> {
    const response = await request<IssueMutationResponse>(`/api/projects/${projectId}/issues`, {
      method: "POST",
      body: JSON.stringify(input)
    });
    return response.issue;
  },

  async updateIssue(
    projectId: string,
    issueId: number,
    input: {
      title?: string;
      body?: string;
      status?: IssueDto["status"];
      labelIds?: number[];
      goalChangeReason?: string;
    }
  ): Promise<IssueMutationResponse> {
    return request<IssueMutationResponse>(`/api/projects/${projectId}/issues/${issueId}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    });
  },

  async deleteIssue(projectId: string, issueId: number): Promise<void> {
    await request<{ deleted: boolean }>(`/api/projects/${projectId}/issues/${issueId}`, {
      method: "DELETE"
    });
  },

  async listIssueComments(projectId: string, issueId: number): Promise<CommentDto[]> {
    const response = await request<ListResponse<CommentDto>>(`/api/projects/${projectId}/issues/${issueId}/comments`);
    return response.items;
  },

  async createIssueComment(projectId: string, issueId: number, body: string): Promise<CommentDto> {
    const response = await request<{ comment: CommentDto }>(`/api/projects/${projectId}/issues/${issueId}/comments`, {
      method: "POST",
      body: JSON.stringify({ body })
    });
    return response.comment;
  },

  async updateComment(
    projectId: string,
    commentId: number,
    input: { body: string; expectedUpdatedAt: string }
  ): Promise<CommentDto> {
    const response = await request<{ comment: CommentDto }>(`/api/projects/${projectId}/comments/${commentId}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    });
    return response.comment;
  },

  async listCommentRevisions(projectId: string, commentId: number): Promise<CommentRevisionDto[]> {
    const response = await request<ListResponse<CommentRevisionDto>>(
      `/api/projects/${projectId}/comments/${commentId}/revisions`
    );
    return response.items;
  },

  async listIssueActivities(projectId: string, issueId: number): Promise<ActivityDto[]> {
    const response = await request<ListResponse<ActivityDto>>(`/api/projects/${projectId}/issues/${issueId}/activities`);
    return response.items;
  },

  async listCommands(projectId: string): Promise<ProjectCommandDto[]> {
    const response = await request<ListResponse<ProjectCommandDto>>(`/api/projects/${projectId}/commands`);
    return response.items;
  },

  async detectCommands(projectId: string): Promise<void> {
    await request(`/api/projects/${projectId}/commands/detect`, {
      method: "POST",
      body: JSON.stringify({ createIssuesForMissingCommands: true })
    });
  },

  async getSettings(projectId: string): Promise<ProjectSettingsDto> {
    return request<ProjectSettingsDto>(`/api/projects/${projectId}/settings`);
  },

  async updateSettings(
    projectId: string,
    input: {
      locale: string;
      ai?: {
        provider?: ProjectSettingsDto["ai"]["provider"];
        claudeCode?: Partial<ProjectSettingsDto["ai"]["claudeCode"]>;
        lmStudio?: Partial<ProjectSettingsDto["ai"]["lmStudio"]>;
      };
      automation?: Partial<ProjectSettingsDto["automation"]>;
    }
  ): Promise<ProjectSettingsDto> {
    return request<ProjectSettingsDto>(`/api/projects/${projectId}/settings`, {
      method: "PUT",
      body: JSON.stringify(input)
    });
  },

  async listPullRequests(
    projectId: string,
    filters: { status?: PullRequestDto["status"] | null; issueId?: number } = { status: "open" }
  ): Promise<PullRequestListResponse> {
    const params = new URLSearchParams();
    if (filters.status) {
      params.set("status", filters.status);
    }
    if (typeof filters.issueId === "number") {
      params.set("issueId", String(filters.issueId));
    }
    const query = params.toString();
    return request<PullRequestListResponse>(`/api/projects/${projectId}/pull-requests${query ? `?${query}` : ""}`);
  },

  async getPullRequest(projectId: string, pullRequestId: number): Promise<PullRequestDto> {
    const response = await request<{ pullRequest: PullRequestDto }>(
      `/api/projects/${projectId}/pull-requests/${pullRequestId}`
    );
    return response.pullRequest;
  },

  async getPullRequestObjective(projectId: string, pullRequestId: number): Promise<ObjectiveRunDto | null> {
    const response = await request<ObjectiveResponse>(
      `/api/projects/${projectId}/pull-requests/${pullRequestId}/objective`
    );
    return response.objective;
  },

  async controlObjective(
    projectId: string,
    objectiveId: number,
    action: "pause" | "resume" | "cancel"
  ): Promise<ObjectiveControlResponse> {
    return request<ObjectiveControlResponse>(`/api/projects/${projectId}/objectives/${objectiveId}/${action}`, {
      method: "POST"
    });
  },

  async createPullRequest(
    projectId: string,
    input: {
      issueId?: number | null;
      title: string;
      body: string;
      sourceBranch: string;
      targetBranch: string;
      labelIds?: number[];
    }
  ): Promise<PullRequestDto> {
    const response = await request<PullRequestMutationResponse>(`/api/projects/${projectId}/pull-requests`, {
      method: "POST",
      body: JSON.stringify(input)
    });
    return response.pullRequest;
  },

  async updatePullRequest(
    projectId: string,
    pullRequestId: number,
    input: {
      issueId?: number | null;
      title?: string;
      body?: string;
      status?: PullRequestDto["status"];
      sourceBranch?: string;
      targetBranch?: string;
      labelIds?: number[];
    }
  ): Promise<PullRequestMutationResponse> {
    return request<PullRequestMutationResponse>(`/api/projects/${projectId}/pull-requests/${pullRequestId}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    });
  },

  async deletePullRequest(projectId: string, pullRequestId: number): Promise<void> {
    await request<{ deleted: boolean }>(`/api/projects/${projectId}/pull-requests/${pullRequestId}`, {
      method: "DELETE"
    });
  },

  async listPullRequestComments(projectId: string, pullRequestId: number): Promise<CommentDto[]> {
    const response = await request<ListResponse<CommentDto>>(
      `/api/projects/${projectId}/pull-requests/${pullRequestId}/comments`
    );
    return response.items;
  },

  async createPullRequestComment(projectId: string, pullRequestId: number, body: string): Promise<CommentDto> {
    const response = await request<{ comment: CommentDto }>(
      `/api/projects/${projectId}/pull-requests/${pullRequestId}/comments`,
      {
        method: "POST",
        body: JSON.stringify({ body })
      }
    );
    return response.comment;
  },

  async listPullRequestActivities(projectId: string, pullRequestId: number): Promise<ActivityDto[]> {
    const response = await request<ListResponse<ActivityDto>>(
      `/api/projects/${projectId}/pull-requests/${pullRequestId}/activities`
    );
    return response.items;
  },

  async listPullRequestFiles(projectId: string, pullRequestId: number): Promise<RepositoryDiffSummaryDto> {
    return request<RepositoryDiffSummaryDto>(
      `/api/projects/${projectId}/pull-requests/${pullRequestId}/files`
    );
  },

  async listPullRequestFindings(projectId: string, pullRequestId: number): Promise<PullRequestFindingDto[]> {
    const response = await request<ListResponse<PullRequestFindingDto>>(
      `/api/projects/${projectId}/pull-requests/${pullRequestId}/findings`
    );
    return response.items;
  },

  async listPullRequestLineComments(projectId: string, pullRequestId: number): Promise<PullRequestLineCommentDto[]> {
    const response = await request<ListResponse<PullRequestLineCommentDto>>(
      `/api/projects/${projectId}/pull-requests/${pullRequestId}/line-comments`
    );
    return response.items;
  },

  async createPullRequestLineComment(
    projectId: string,
    pullRequestId: number,
    input: {
      body: string;
      path: string;
      line: number;
      side: "L" | "R";
      sourceCommit: string;
      targetCommit: string;
    }
  ): Promise<PullRequestLineCommentDto> {
    const response = await request<{ comment: PullRequestLineCommentDto }>(
      `/api/projects/${projectId}/pull-requests/${pullRequestId}/line-comments`,
      { method: "POST", body: JSON.stringify(input) }
    );
    return response.comment;
  },

  async getPullRequestFileDiff(
    projectId: string,
    pullRequestId: number,
    path: string,
    options: {
      context?: "default" | "wide" | "full";
      ignoreWhitespace?: boolean;
      signal?: AbortSignal;
      sourceCommit?: string;
      targetCommit?: string;
    } = {}
  ): Promise<RepositoryFileChangeDto> {
    const params = new URLSearchParams({ path });
    if (options.ignoreWhitespace) {
      params.set("whitespace", "ignore");
    }
    if (options.context && options.context !== "default") {
      params.set("context", options.context);
    }
    if (options.sourceCommit) {
      params.set("sourceCommit", options.sourceCommit);
    }
    if (options.targetCommit) {
      params.set("targetCommit", options.targetCommit);
    }
    const response = await request<{ file: RepositoryFileChangeDto }>(
      `/api/projects/${projectId}/pull-requests/${pullRequestId}/diff-file?${params.toString()}`,
      { signal: options.signal }
    );
    return response.file;
  },

  async listPullRequestCommits(projectId: string, pullRequestId: number): Promise<RepositoryCommitDto[]> {
    const response = await request<ListResponse<RepositoryCommitDto>>(
      `/api/projects/${projectId}/pull-requests/${pullRequestId}/commits`
    );
    return response.items;
  },

  async getMergeConflicts(projectId: string, sourceBranch: string, targetBranch: string): Promise<MergeConflictDto> {
    const params = new URLSearchParams({ sourceBranch, targetBranch });
    return request<MergeConflictDto>(`/api/projects/${projectId}/repository/merge-conflicts?${params.toString()}`);
  },

  async getPullRequestMergeConflicts(projectId: string, pullRequestId: number): Promise<MergeConflictDto> {
    return request<MergeConflictDto>(`/api/projects/${projectId}/pull-requests/${pullRequestId}/conflicts`);
  },

  async resolvePullRequestConflicts(projectId: string, pullRequestId: number): Promise<number | null> {
    const response = await request<{ jobId: number | null }>(
      `/api/projects/${projectId}/pull-requests/${pullRequestId}/resolve-conflicts`,
      {
        method: "POST"
      }
    );
    return response.jobId;
  },

  async mergePullRequest(projectId: string, pullRequestId: number): Promise<PullRequestMergeResponse> {
    return request<PullRequestMergeResponse>(`/api/projects/${projectId}/pull-requests/${pullRequestId}/merge`, {
      method: "POST"
    });
  },

  async getRepositoryStatus(projectId: string): Promise<RepositoryStatusDto> {
    return request<RepositoryStatusDto>(`/api/projects/${projectId}/repository/status`);
  },

  async listLoops(projectId: string): Promise<LoopDto[]> {
    const response = await request<ListResponse<LoopDto>>(`/api/projects/${projectId}/loops`);
    return response.items;
  },

  async createLoop(
    projectId: string,
    input: {
      name: string;
      purpose?: string;
      triggerType?: string;
      cadence?: string | null;
      targetScope?: string;
      status?: LoopDto["status"];
      maxRounds?: number;
      timeBudgetMinutes?: number | null;
      costBudget?: number | null;
      stopCondition?: Record<string, unknown> | null;
      riskPolicy?: Record<string, unknown> | null;
    }
  ): Promise<LoopDto> {
    const response = await request<{ loop: LoopDto }>(`/api/projects/${projectId}/loops`, {
      method: "POST",
      body: JSON.stringify(input)
    });
    return response.loop;
  },

  async getLoop(projectId: string, loopId: number): Promise<LoopDetailResponse> {
    return request<LoopDetailResponse>(`/api/projects/${projectId}/loops/${loopId}`);
  },

  async startLoopRun(
    projectId: string,
    loopId: number,
    input: {
      agentType: AgentJobDto["agentType"];
      targetType: AgentJobDto["targetType"];
      targetId: number;
      triggerType?: string;
      input?: Record<string, unknown>;
    }
  ): Promise<{ run: LoopRunDto; job: AgentJobDto; step: LoopStepDto }> {
    return request<{ run: LoopRunDto; job: AgentJobDto; step: LoopStepDto }>(
      `/api/projects/${projectId}/loops/${loopId}/runs`,
      {
        method: "POST",
        body: JSON.stringify(input)
      }
    );
  },

  async listLoopRuns(projectId: string, loopId?: number): Promise<LoopRunDto[]> {
    const params = new URLSearchParams();
    if (typeof loopId === "number") {
      params.set("loopId", String(loopId));
    }
    const response = await request<ListResponse<LoopRunDto>>(
      `/api/projects/${projectId}/loop-runs${params.toString() ? `?${params.toString()}` : ""}`
    );
    return response.items;
  },

  async getLoopRun(projectId: string, loopRunId: number): Promise<LoopRunDetailResponse> {
    return request<LoopRunDetailResponse>(`/api/projects/${projectId}/loop-runs/${loopRunId}`);
  },

  async listLoopMemory(projectId: string): Promise<LoopMemoryEntryDto[]> {
    const response = await request<ListResponse<LoopMemoryEntryDto>>(`/api/projects/${projectId}/loop-memory`);
    return response.items;
  },

  async createLoopMemory(
    projectId: string,
    input: {
      loopId?: number | null;
      loopRunId?: number | null;
      sourceType?: LoopMemoryEntryDto["sourceType"];
      sourceId?: number | null;
      title: string;
      body?: string;
      tags?: string[];
    }
  ): Promise<LoopMemoryEntryDto> {
    const response = await request<{ entry: LoopMemoryEntryDto }>(`/api/projects/${projectId}/loop-memory`, {
      method: "POST",
      body: JSON.stringify(input)
    });
    return response.entry;
  },

  async listTriageItems(projectId: string, status?: TriageItemDto["status"]): Promise<TriageItemDto[]> {
    const params = new URLSearchParams();
    if (status) {
      params.set("status", status);
    }
    const response = await request<ListResponse<TriageItemDto>>(
      `/api/projects/${projectId}/triage-items${params.toString() ? `?${params.toString()}` : ""}`
    );
    return response.items;
  },

  async createTriageItem(
    projectId: string,
    input: {
      sourceType: string;
      sourceId?: number | null;
      title: string;
      body?: string;
      priority?: string;
      metadata?: Record<string, unknown> | null;
    }
  ): Promise<TriageItemDto> {
    const response = await request<{ item: TriageItemDto }>(`/api/projects/${projectId}/triage-items`, {
      method: "POST",
      body: JSON.stringify(input)
    });
    return response.item;
  },

  async updateTriageItem(
    projectId: string,
    triageItemId: number,
    input: { status?: TriageItemDto["status"]; issueId?: number | null }
  ): Promise<TriageItemDto> {
    const response = await request<{ item: TriageItemDto }>(
      `/api/projects/${projectId}/triage-items/${triageItemId}`,
      {
        method: "PATCH",
        body: JSON.stringify(input)
      }
    );
    return response.item;
  },

  async convertTriageItemToIssue(projectId: string, triageItemId: number): Promise<IssueDto> {
    const response = await request<{ issue: IssueDto }>(
      `/api/projects/${projectId}/triage-items/${triageItemId}/convert-to-issue`,
      { method: "POST" }
    );
    return response.issue;
  },

  async listKnowledgeFiles(projectId: string): Promise<SkillFileDto[]> {
    const response = await request<ListResponse<SkillFileDto>>(`/api/projects/${projectId}/knowledge`);
    return response.items;
  },

  async updateKnowledgeFile(projectId: string, path: string, body: string): Promise<SkillFileDto> {
    const response = await request<{ item: SkillFileDto }>(
      `/api/projects/${projectId}/knowledge/${encodeURI(path)}`,
      {
        method: "PUT",
        body: JSON.stringify({ body })
      }
    );
    return response.item;
  },

  async listAgentJobs(
    projectId: string,
    filters: {
      targetType?: AgentJobDto["targetType"];
      targetId?: number;
      status?: AgentJobDto["status"];
    } = {}
  ): Promise<AgentJobDto[]> {
    const params = new URLSearchParams();
    if (filters.targetType) {
      params.set("targetType", filters.targetType);
    }
    if (typeof filters.targetId === "number") {
      params.set("targetId", String(filters.targetId));
    }
    if (filters.status) {
      params.set("status", filters.status);
    }
    const query = params.toString();
    const response = await request<ListResponse<AgentJobDto>>(
      `/api/projects/${projectId}/agent-jobs${query ? `?${query}` : ""}`
    );
    return response.items;
  },

  async getAgentJob(projectId: string, jobId: number): Promise<AgentJobDto> {
    const response = await request<{ job: AgentJobDto }>(`/api/projects/${projectId}/agent-jobs/${jobId}`);
    return response.job;
  },

  async listAgentJobActivities(projectId: string, jobId: number): Promise<ActivityDto[]> {
    const response = await request<ListResponse<ActivityDto>>(
      `/api/projects/${projectId}/agent-jobs/${jobId}/activities`
    );
    return response.items;
  },

  async createAgentJob(
    projectId: string,
    input: {
      agentType: AgentJobDto["agentType"];
      targetType: AgentJobDto["targetType"];
      targetId: number;
      triggerType?: string;
    }
  ): Promise<AgentJobDto> {
    const response = await request<{ job: AgentJobDto }>(`/api/projects/${projectId}/agent-jobs`, {
      method: "POST",
      body: JSON.stringify(input)
    });
    return response.job;
  },

  async cancelAgentJob(projectId: string, jobId: number): Promise<AgentJobDto> {
    const response = await request<{ job: AgentJobDto }>(`/api/projects/${projectId}/agent-jobs/${jobId}/cancel`, {
      method: "POST"
    });
    return response.job;
  },

  async retryAgentJob(projectId: string, jobId: number): Promise<number> {
    const response = await request<{ jobId: number }>(`/api/projects/${projectId}/agent-jobs/${jobId}/retry`, {
      method: "POST"
    });
    return response.jobId;
  },

  async resumeAgentJob(projectId: string, jobId: number, aiProvider?: AiProvider): Promise<AgentJobDto> {
    const response = await request<{ job: AgentJobDto }>(`/api/projects/${projectId}/agent-jobs/${jobId}/resume`, {
      method: "POST",
      body: JSON.stringify({ aiProvider })
    });
    return response.job;
  }
};
