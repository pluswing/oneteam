import type { AgentJobDto, CommentDto, IssueDto, ProjectDto, PullRequestDto } from "../../shared/types";
import type { Repositories } from "../db/repositories";
import { buildAgentPrompt } from "./prompts";

export async function buildPromptForJob(repos: Repositories, job: AgentJobDto): Promise<{
  project: ProjectDto;
  prompt: string;
}> {
  const project = await repos.projects.get(job.projectId);
  if (!project) {
    throw new Error(`Project was not found: ${job.projectId}`);
  }

  const commands = await repos.commands.list(project.id);
  let target: IssueDto | PullRequestDto | ProjectDto = project;
  let comments: CommentDto[] = [];

  if (job.targetType === "issue") {
    const issue = await repos.issues.get(project.id, job.targetId);
    if (!issue) {
      throw new Error(`Issue was not found: ${job.targetId}`);
    }
    target = issue;
    comments = await repos.comments.list(project.id, "issue", issue.id);
  }

  if (job.targetType === "pull_request") {
    const pullRequest = await repos.pullRequests.get(project.id, job.targetId);
    if (!pullRequest) {
      throw new Error(`Pull request was not found: ${job.targetId}`);
    }
    target = pullRequest;
    comments = await repos.comments.list(project.id, "pull_request", pullRequest.id);
  }

  return {
    project,
    prompt: buildAgentPrompt(job, {
      project,
      target,
      comments,
      commands
    })
  };
}
