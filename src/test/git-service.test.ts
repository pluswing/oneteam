import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { getBranches, getCommitCount, getCommits, getDiffFiles, getRepositoryStatus } from "../server/services/git-service";

const execFileAsync = promisify(execFile);

async function git(repo: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: repo });
}

describe("git service", () => {
  it("reads status, branches, commits, and diff files", async () => {
    const repo = await mkdtemp(join(tmpdir(), "oneteam-git-"));
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.name", "Test User"]);
    await git(repo, ["config", "user.email", "test@example.com"]);
    await writeFile(join(repo, "README.md"), "# Example\n");
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-m", "initial"]);
    await git(repo, ["checkout", "-b", "feature"]);
    await writeFile(join(repo, "README.md"), "# Example\n\nChanged\n");
    await git(repo, ["commit", "-am", "change readme"]);

    const status = await getRepositoryStatus(repo);
    const branches = await getBranches(repo);
    const commits = await getCommits(repo, "main..feature");
    const commitCount = await getCommitCount(repo, "main..feature");
    const files = await getDiffFiles(repo, "feature", "main");

    expect(status.branch).toBe("feature");
    expect(status.clean).toBe(true);
    expect(branches.map((branch) => branch.name)).toContain("main");
    expect(commits[0].subject).toBe("change readme");
    expect(commitCount).toBe(1);
    expect(files[0]).toMatchObject({ path: "README.md", status: "M" });
  });
});
