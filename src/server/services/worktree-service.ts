import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { relative, resolve, sep, join } from "node:path";
import { promisify } from "node:util";
import type { IssueDto, ProjectDto, PullRequestDto } from "../../shared/types";
import { branchExists } from "./git-service";
import { implementationBranchName } from "./implementation-preflight";

const execFileAsync = promisify(execFile);

export class RecoverableWorktreeError extends Error {
  readonly code: string;
  readonly payload: Record<string, unknown>;

  constructor(message: string, code: string, payload: Record<string, unknown> = {}) {
    super(message);
    this.name = "RecoverableWorktreeError";
    this.code = code;
    this.payload = payload;
  }
}

export type PreparedWorktree = {
  repoPath: string;
  branchName: string;
  worktreePath: string;
  recovered?: boolean;
  recoveryReason?: string;
};

type GitWorktree = {
  path: string;
  branchName: string | null;
  prunable: boolean;
};

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

async function listWorktrees(repoPath: string): Promise<GitWorktree[]> {
  const output = await git(repoPath, ["worktree", "list", "--porcelain"]);
  const worktrees: GitWorktree[] = [];
  let current: GitWorktree | null = null;

  for (const line of output.split("\n")) {
    if (!line.trim()) {
      if (current) {
        worktrees.push(current);
        current = null;
      }
      continue;
    }

    if (line.startsWith("worktree ")) {
      if (current) {
        worktrees.push(current);
      }
      current = {
        path: line.slice("worktree ".length),
        branchName: null,
        prunable: false
      };
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith("branch refs/heads/")) {
      current.branchName = line.slice("branch refs/heads/".length);
    } else if (line.startsWith("prunable")) {
      current.prunable = true;
    }
  }

  if (current) {
    worktrees.push(current);
  }

  return worktrees;
}

function isManagedWorktreePath(projectId: string, worktreePath: string): boolean {
  const root = resolve(worktreeRoot(projectId));
  const path = resolve(worktreePath);
  const pathFromRoot = relative(root, path);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && pathFromRoot !== ".." && !pathFromRoot.startsWith(sep));
}

function findWorktreeForBranch(worktrees: GitWorktree[], branchName: string): GitWorktree | null {
  return worktrees.find((worktree) => worktree.branchName === branchName) ?? null;
}

function gitErrorOutput(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return "";
  }
  const output = error as { message?: unknown; stdout?: unknown; stderr?: unknown };
  return [output.stderr, output.stdout, output.message]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
}

function isBranchAlreadyUsedError(error: unknown): boolean {
  return /already used by worktree|is already checked out at|is already used by worktree/i.test(gitErrorOutput(error));
}

async function resolveExistingBranchWorktree(
  project: Pick<ProjectDto, "id" | "repoPath" | "defaultBranch">,
  branchName: string,
  existing: GitWorktree,
  options: { allowFork: boolean }
): Promise<PreparedWorktree> {
  if (existing.prunable) {
    await git(project.repoPath, ["worktree", "prune"]);
    const refreshed = findWorktreeForBranch(await listWorktrees(project.repoPath), branchName);
    if (!refreshed) {
      return createWorktree(project, branchName, options);
    }
    return resolveExistingBranchWorktree(project, branchName, refreshed, options);
  }

  if (isManagedWorktreePath(project.id, existing.path)) {
    return {
      repoPath: existing.path,
      branchName,
      worktreePath: existing.path,
      recovered: true,
      recoveryReason: "reused_existing_oneteam_worktree"
    };
  }

  if (options.allowFork) {
    return createForkedWorktree(project, branchName, existing.path);
  }

  throw new RecoverableWorktreeError(
    `Branch "${branchName}" is already checked out at ${existing.path}. The job will retry automatically after the branch becomes available.`,
    "worktree_branch_in_use",
    {
      branchName,
      worktreePath: existing.path
    }
  );
}

async function createForkedWorktree(
  project: Pick<ProjectDto, "id" | "repoPath" | "defaultBranch">,
  branchName: string,
  existingPath: string
): Promise<PreparedWorktree> {
  const forkBranchName = `${branchName}-run-${Date.now().toString(36)}`;
  const path = await mkdtemp(join(worktreeRoot(project.id), "run-"));
  try {
    await git(project.repoPath, ["worktree", "add", "-b", forkBranchName, path, branchName]);
    return {
      repoPath: path,
      branchName: forkBranchName,
      worktreePath: path,
      recovered: true,
      recoveryReason: `created_forked_branch_from_branch_in_use:${existingPath}`
    };
  } catch (error) {
    await rm(path, { recursive: true, force: true });
    throw error;
  }
}

async function createWorktree(
  project: Pick<ProjectDto, "id" | "repoPath" | "defaultBranch">,
  branchName: string,
  options: { allowFork: boolean }
): Promise<PreparedWorktree> {
  await mkdir(worktreeRoot(project.id), { recursive: true });
  await git(project.repoPath, ["worktree", "prune"]).catch(() => undefined);

  const existing = findWorktreeForBranch(await listWorktrees(project.repoPath), branchName);
  if (existing) {
    return resolveExistingBranchWorktree(project, branchName, existing, options);
  }

  const path = await mkdtemp(join(worktreeRoot(project.id), "run-"));
  try {
    if (await branchExists(project.repoPath, branchName)) {
      await git(project.repoPath, ["worktree", "add", path, branchName]);
    } else {
      await git(project.repoPath, ["worktree", "add", "-b", branchName, path, project.defaultBranch]);
    }
    return {
      repoPath: path,
      branchName,
      worktreePath: path
    };
  } catch (error) {
    await rm(path, { recursive: true, force: true });
    if (isBranchAlreadyUsedError(error)) {
      await git(project.repoPath, ["worktree", "prune"]).catch(() => undefined);
      const existingAfterFailure = findWorktreeForBranch(await listWorktrees(project.repoPath), branchName);
      if (existingAfterFailure) {
        return resolveExistingBranchWorktree(project, branchName, existingAfterFailure, options);
      }
    }
    throw error;
  }
}

export async function prepareIssueWorktree(
  project: Pick<ProjectDto, "id" | "repoPath" | "defaultBranch">,
  issue: Pick<IssueDto, "id" | "title">
): Promise<PreparedWorktree> {
  const branchName = implementationBranchName(issue);
  return createWorktree(project, branchName, { allowFork: true });
}

export async function preparePullRequestWorktree(
  project: Pick<ProjectDto, "id" | "repoPath" | "defaultBranch">,
  pullRequest: Pick<PullRequestDto, "sourceBranch">
): Promise<PreparedWorktree> {
  const branchName = pullRequest.sourceBranch;
  return createWorktree(project, branchName, { allowFork: false });
}

export async function cleanupWorktree(project: Pick<ProjectDto, "repoPath">, worktreePath: string): Promise<void> {
  await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], { cwd: project.repoPath }).catch(async () => {
    await rm(worktreePath, { recursive: true, force: true });
  });
  await execFileAsync("git", ["worktree", "prune"], { cwd: project.repoPath }).catch(() => undefined);
}
