import type {
  AgentJobDto,
  IssueDto,
  LabelDto,
  ProjectCommandDto,
  ProjectDto,
  PullRequestDto,
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

  async createIssue(projectId: string, input: { title: string; body: string; labelIds: number[] }): Promise<IssueDto> {
    const response = await request<{ issue: IssueDto }>(`/api/projects/${projectId}/issues`, {
      method: "POST",
      body: JSON.stringify(input)
    });
    return response.issue;
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
    const response = await request<{ pullRequest: PullRequestDto }>(`/api/projects/${projectId}/pull-requests`, {
      method: "POST",
      body: JSON.stringify(input)
    });
    return response.pullRequest;
  },

  async getRepositoryStatus(projectId: string): Promise<RepositoryStatusDto> {
    return request<RepositoryStatusDto>(`/api/projects/${projectId}/repository/status`);
  },

  async listAgentJobs(projectId: string): Promise<AgentJobDto[]> {
    const response = await request<ListResponse<AgentJobDto>>(`/api/projects/${projectId}/agent-jobs`);
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
  }
};
