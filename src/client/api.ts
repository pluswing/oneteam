import type { IssueDto, LabelDto, ProjectCommandDto, ProjectDto } from "../shared/types";

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
  }
};
