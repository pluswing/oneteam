import type {
  AgentJobDto,
  ActivityDto,
  CommentDto,
  IssueDto,
  LabelDto,
  MergeConflictDto,
  ProjectCommandDto,
  ProjectDto,
  PullRequestDto,
  RepositoryCommitDto,
  RepositoryFileChangeDto,
  RepositoryStatusDto
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
    codex: {
      command: string;
      model?: string;
      fullAccess: boolean;
    };
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
    }
  ): Promise<IssueMutationResponse> {
    return request<IssueMutationResponse>(`/api/projects/${projectId}/issues/${issueId}`, {
      method: "PATCH",
      body: JSON.stringify(input)
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

  async listPullRequests(projectId: string): Promise<PullRequestListResponse> {
    return request<PullRequestListResponse>(`/api/projects/${projectId}/pull-requests?status=open`);
  },

  async getPullRequest(projectId: string, pullRequestId: number): Promise<PullRequestDto> {
    const response = await request<{ pullRequest: PullRequestDto }>(
      `/api/projects/${projectId}/pull-requests/${pullRequestId}`
    );
    return response.pullRequest;
  },

  async createPullRequest(
    projectId: string,
    input: {
      issueId?: number | null;
      title: string;
      body: string;
      sourceBranch: string;
      targetBranch: string;
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

  async listPullRequestFiles(projectId: string, pullRequestId: number): Promise<RepositoryFileChangeDto[]> {
    const response = await request<{ files: RepositoryFileChangeDto[] }>(
      `/api/projects/${projectId}/pull-requests/${pullRequestId}/diff`
    );
    return response.files;
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

  async resolvePullRequestConflicts(projectId: string, pullRequestId: number): Promise<number | null> {
    const response = await request<{ jobId: number | null }>(
      `/api/projects/${projectId}/pull-requests/${pullRequestId}/resolve-conflicts`,
      {
        method: "POST"
      }
    );
    return response.jobId;
  },

  async getRepositoryStatus(projectId: string): Promise<RepositoryStatusDto> {
    return request<RepositoryStatusDto>(`/api/projects/${projectId}/repository/status`);
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
  }
};
