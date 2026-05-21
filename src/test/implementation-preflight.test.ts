import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  implementationBranchName,
  prepareImplementationBranch
} from "../server/services/implementation-preflight";

const execFileAsync = promisify(execFile);

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: repo });
  return stdout.trim();
}

async function createRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "oneteam-preflight-"));
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "Test User"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await writeFile(join(repo, "README.md"), "# Example\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
  return repo;
}

describe("implementation preflight", () => {
  it("creates and checks out the issue implementation branch", async () => {
    const repo = await createRepo();
    const issue = { id: 12, title: "Add setup wizard" };
    const branchName = implementationBranchName(issue);

    const result = await prepareImplementationBranch({ repoPath: repo, defaultBranch: "main" }, issue);
    const currentBranch = await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);

    expect(result).toMatchObject({
      status: "ready",
      action: "created",
      branchName
    });
    expect(currentBranch).toBe(branchName);
  });

  it("checks out an existing issue implementation branch", async () => {
    const repo = await createRepo();
    const issue = { id: 14, title: "Add setup wizard" };
    const branchName = implementationBranchName(issue);
    await git(repo, ["checkout", "-b", branchName]);
    await git(repo, ["checkout", "main"]);

    const result = await prepareImplementationBranch({ repoPath: repo, defaultBranch: "main" }, issue);
    const currentBranch = await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);

    expect(result).toMatchObject({
      status: "ready",
      action: "checked_out",
      branchName
    });
    expect(currentBranch).toBe(branchName);
  });

  it("blocks branch changes when another branch has uncommitted changes", async () => {
    const repo = await createRepo();
    const issue = { id: 13, title: "Add setup wizard" };
    await writeFile(join(repo, "README.md"), "# Example\n\nDirty change\n");

    const result = await prepareImplementationBranch({ repoPath: repo, defaultBranch: "main" }, issue);
    const currentBranch = await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);

    expect(result).toMatchObject({
      status: "blocked",
      reason: "dirty_worktree",
      branchName: implementationBranchName(issue)
    });
    expect(result.repositoryStatus.changedFiles).toContain("README.md");
    expect(currentBranch).toBe("main");
  });
});
