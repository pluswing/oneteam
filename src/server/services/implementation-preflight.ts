import type { IssueDto, ProjectDto, RepositoryStatusDto } from "../../shared/types";
import { branchExists, checkoutBranch, createAndCheckoutBranch, getRepositoryStatus } from "./git-service";

type ImplementationBranchAction = "already_on_branch" | "checked_out" | "created";

export type ImplementationBranchPreflightResult =
  | {
      status: "ready";
      branchName: string;
      action: ImplementationBranchAction;
      repositoryStatus: RepositoryStatusDto;
    }
  | {
      status: "blocked";
      branchName: string;
      reason: "dirty_worktree";
      repositoryStatus: RepositoryStatusDto;
    };

const MAX_SLUG_LENGTH = 48;

export function implementationBranchName(issue: Pick<IssueDto, "id" | "title">): string {
  const slug = issue.title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/^-|-$/g, "");

  return `oneteam/issue-${issue.id}-${slug || "work"}`;
}

export async function prepareImplementationBranch(
  project: Pick<ProjectDto, "repoPath" | "defaultBranch">,
  issue: Pick<IssueDto, "id" | "title">
): Promise<ImplementationBranchPreflightResult> {
  const branchName = implementationBranchName(issue);
  const repositoryStatus = await getRepositoryStatus(project.repoPath);

  if (!repositoryStatus.clean && repositoryStatus.branch !== branchName) {
    return {
      status: "blocked",
      branchName,
      reason: "dirty_worktree",
      repositoryStatus
    };
  }

  if (repositoryStatus.branch === branchName) {
    return {
      status: "ready",
      branchName,
      action: "already_on_branch",
      repositoryStatus
    };
  }

  if (await branchExists(project.repoPath, branchName)) {
    await checkoutBranch(project.repoPath, branchName);
    return {
      status: "ready",
      branchName,
      action: "checked_out",
      repositoryStatus
    };
  }

  await checkoutBranch(project.repoPath, project.defaultBranch);
  await createAndCheckoutBranch(project.repoPath, branchName, project.defaultBranch);
  return {
    status: "ready",
    branchName,
    action: "created",
    repositoryStatus
  };
}
