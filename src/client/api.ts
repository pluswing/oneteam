import type { AiProvider } from "../shared/ai-providers";
import type { AgentExecutionDto, DevelopmentLoopDto, KnowledgeRevisionDto, RetrospectiveDto } from "../shared/development-loop";
import type { AgentJobDto, ActivityDto, CommentDto, CommentRevisionDto, IssueDto, LabelDto, MergeConflictDto, ObjectiveRunDto, ProjectCommandDto, ProjectDto, PullRequestDto, PullRequestFindingDto, PullRequestLineCommentDto, RepositoryCommitDto, RepositoryDiffSummaryDto, RepositoryFileChangeDto, RepositoryStatusDto, SkillFileDto } from "../shared/types";

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
  mergeCommit: string | null;
  queued?: boolean;
  output: string;
};



type ObjectiveResponse = {
  objective: ObjectiveRunDto | null;
};



export type ProjectOpenResult = {
  project: ProjectDto;
  onboardingIssueId: number | null;
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
  async codexStatus(): Promise<{ status: "connected" | "login_required" }> { return request("/api/codex/status"); },
  async restoreKnowledgeRevision(projectId: string, revisionId: number): Promise<void> {
    await request(`/api/projects/${projectId}/knowledge-revisions/${revisionId}/restore`, { method: "POST" });
  },
  async listDevelopmentLoops(projectId: string): Promise<DevelopmentLoopDto[]> {
    return (await request<ListResponse<DevelopmentLoopDto>>(`/api/projects/${projectId}/development-loops`)).items;
  },
  async getDevelopmentLoop(projectId: string, loopId: number): Promise<{ loop: DevelopmentLoopDto; retrospective: RetrospectiveDto | null; revisions: KnowledgeRevisionDto[]; jobs: AgentJobDto[] }> {
    return request(`/api/projects/${projectId}/development-loops/${loopId}`);
  },
  async controlDevelopmentLoop(projectId: string, loopId: number, action: "pause" | "resume" | "cancel"): Promise<void> {
    await request(`/api/projects/${projectId}/development-loops/${loopId}/${action}`, { method: "POST" });
  },
  async listAgentExecutions(projectId: string, jobId: number): Promise<AgentExecutionDto[]> {
    return (await request<ListResponse<AgentExecutionDto>>(`/api/projects/${projectId}/agent-jobs/${jobId}/executions`)).items;
  },

  async listProjects(): Promise<ProjectDto[]> {
    const response = await request<ListResponse<ProjectDto>>("/api/projects");
    return response.items;
  },

  async createProject(input: {
    repoPath: string;
    locale: string;
  }): Promise<ProjectOpenResult> {
    return request<ProjectOpenResult>("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        mode: "import",
        repoPath: input.repoPath,
        locale: input.locale,
        aiProvider: "codex"
      })
    });
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

  async listRepositoryCommits(projectId: string): Promise<RepositoryCommitDto[]> {
    const response = await request<ListResponse<RepositoryCommitDto>>(
      `/api/projects/${projectId}/repository/commits`
    );
    return response.items;
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
