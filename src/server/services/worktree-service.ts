import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { IssueDto, ProjectDto, PullRequestDto } from "../../shared/types";
import { branchExists } from "./git-service";
import { implementationBranchName } from "./implementation-preflight";

const execFileAsync = promisify(execFile);

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repoPath,
    maxBuffer: 1024 * 1024 * 20
  });
  return stdout.trimEnd();
}

function worktreeRoot(projectId: string): string {
  return join(homedir(), ".oneteam", "worktrees", projectId);
}

async function createWorktree(project: Pick<ProjectDto, "id" | "repoPath" | "defaultBranch">, branchName: string): Promise<string> {
  await mkdir(worktreeRoot(project.id), { recursive: true });
  const path = await mkdtemp(join(worktreeRoot(project.id), "run-"));
  try {
    if (await branchExists(project.repoPath, branchName)) {
      await git(project.repoPath, ["worktree", "add", path, branchName]);
    } else {
      await git(project.repoPath, ["worktree", "add", "-b", branchName, path, project.defaultBranch]);
    }
    return path;
  } catch (error) {
    await rm(path, { recursive: true, force: true });
    throw error;
  }
}

export async function prepareIssueWorktree(
  project: Pick<ProjectDto, "id" | "repoPath" | "defaultBranch">,
  issue: Pick<IssueDto, "id" | "title">
): Promise<{ repoPath: string; branchName: string; worktreePath: string }> {
  const branchName = implementationBranchName(issue);
  const worktreePath = await createWorktree(project, branchName);
  return {
    repoPath: worktreePath,
    branchName,
    worktreePath
  };
}

export async function preparePullRequestWorktree(
  project: Pick<ProjectDto, "id" | "repoPath" | "defaultBranch">,
  pullRequest: Pick<PullRequestDto, "sourceBranch">
): Promise<{ repoPath: string; branchName: string; worktreePath: string }> {
  const branchName = pullRequest.sourceBranch;
  const worktreePath = await createWorktree(project, branchName);
  return {
    repoPath: worktreePath,
    branchName,
    worktreePath
  };
}

export async function cleanupWorktree(project: Pick<ProjectDto, "repoPath">, worktreePath: string): Promise<void> {
  await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], { cwd: project.repoPath }).catch(async () => {
    await rm(worktreePath, { recursive: true, force: true });
  });
  await execFileAsync("git", ["worktree", "prune"], { cwd: project.repoPath }).catch(() => undefined);
}
