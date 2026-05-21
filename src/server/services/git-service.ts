import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  MergeConflictDto,
  RepositoryBranchDto,
  RepositoryCommitDto,
  RepositoryFileChangeDto,
  RepositoryStatusDto
} from "../../shared/types";

const execFileAsync = promisify(execFile);

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repoPath,
    maxBuffer: 1024 * 1024 * 20
  });
  return stdout.trimEnd();
}

function parseAheadBehind(branchLine: string): { ahead: number; behind: number } {
  const aheadMatch = branchLine.match(/ahead (\d+)/);
  const behindMatch = branchLine.match(/behind (\d+)/);
  return {
    ahead: aheadMatch ? Number(aheadMatch[1]) : 0,
    behind: behindMatch ? Number(behindMatch[1]) : 0
  };
}

function parseBranch(branchLine: string): string {
  return branchLine.replace(/^##\s*/, "").split(/[.\s]/)[0] || "unknown";
}

export async function getRepositoryStatus(repoPath: string): Promise<RepositoryStatusDto> {
  const output = await git(repoPath, ["status", "--short", "--branch"]);
  const lines = output.split("\n").filter(Boolean);
  const branchLine = lines[0] ?? "## unknown";
  const changedFiles = lines.slice(1).map((line) => line.slice(3));
  const aheadBehind = parseAheadBehind(branchLine);

  return {
    branch: parseBranch(branchLine),
    clean: changedFiles.length === 0,
    changedFiles,
    ahead: aheadBehind.ahead,
    behind: aheadBehind.behind
  };
}

export async function getBranches(repoPath: string): Promise<RepositoryBranchDto[]> {
  const output = await git(repoPath, ["branch", "--format=%(HEAD)%09%(refname:short)"]);
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [head, name] = line.split("\t");
      return {
        name,
        current: head === "*"
      };
    });
}

function getGitExitCode(error: unknown): number | null {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "number"
    ? error.code
    : null;
}

export async function branchExists(repoPath: string, branchName: string): Promise<boolean> {
  try {
    await git(repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]);
    return true;
  } catch (error) {
    if (getGitExitCode(error) === 1) {
      return false;
    }
    throw error;
  }
}

export async function checkoutBranch(repoPath: string, branchName: string): Promise<void> {
  await git(repoPath, ["checkout", branchName]);
}

export async function createAndCheckoutBranch(repoPath: string, branchName: string, startPoint: string): Promise<void> {
  await git(repoPath, ["checkout", "-b", branchName, startPoint]);
}

export async function getChangedFilesSince(repoPath: string, baseBranch: string, revision = "HEAD"): Promise<string[]> {
  const [diffOutput, status] = await Promise.all([
    git(repoPath, ["diff", "--name-only", `${baseBranch}...${revision}`]),
    getRepositoryStatus(repoPath)
  ]);
  return Array.from(new Set([...diffOutput.split("\n").filter(Boolean), ...status.changedFiles]));
}

export async function getCommits(repoPath: string, revision = "HEAD", limit = 20): Promise<RepositoryCommitDto[]> {
  const output = await git(repoPath, [
    "log",
    revision,
    `-${limit}`,
    "--format=%H%x1f%s%x1f%an%x1f%ae%x1f%aI"
  ]);

  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, subject, authorName, authorEmail, date] = line.split("\x1f");
      return { hash, subject, authorName, authorEmail, date };
    });
}

export async function getCommitCount(repoPath: string, revision = "HEAD"): Promise<number> {
  const output = await git(repoPath, ["rev-list", "--count", revision]);
  return Number(output) || 0;
}

export async function getDiffFiles(
  repoPath: string,
  sourceBranch: string,
  targetBranch: string
): Promise<RepositoryFileChangeDto[]> {
  const revision = `${targetBranch}...${sourceBranch}`;
  const nameStatus = await git(repoPath, ["diff", "--name-status", revision]);
  const numstat = await git(repoPath, ["diff", "--numstat", revision]);

  const stats = new Map<string, { additions: number; deletions: number }>();
  for (const line of numstat.split("\n").filter(Boolean)) {
    const [additions, deletions, path] = line.split("\t");
    stats.set(path, {
      additions: additions === "-" ? 0 : Number(additions),
      deletions: deletions === "-" ? 0 : Number(deletions)
    });
  }

  return nameStatus
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, path] = line.split("\t");
      const fileStats = stats.get(path) ?? { additions: 0, deletions: 0 };
      return {
        path,
        status,
        additions: fileStats.additions,
        deletions: fileStats.deletions
      };
    });
}

export async function getDiffWithPatches(
  repoPath: string,
  sourceBranch: string,
  targetBranch: string
): Promise<RepositoryFileChangeDto[]> {
  const files = await getDiffFiles(repoPath, sourceBranch, targetBranch);
  return Promise.all(
    files.map(async (file) => ({
      ...file,
      patch: await git(repoPath, ["diff", `${targetBranch}...${sourceBranch}`, "--", file.path])
    }))
  );
}

export async function detectMergeConflicts(
  repoPath: string,
  sourceBranch: string,
  targetBranch: string
): Promise<MergeConflictDto> {
  try {
    await git(repoPath, ["merge-tree", "--write-tree", targetBranch, sourceBranch]);
    return { hasConflicts: false, files: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const files = Array.from(message.matchAll(/CONFLICT.* in (.+)/g)).map((match) => ({
      path: match[1],
      reason: "content"
    }));
    return {
      hasConflicts: true,
      files
    };
  }
}
