import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  commitAllChanges,
  detectMergeConflicts,
  getBranches,
  getCommitCount,
  getCommits,
  getDiffFilePatch,
  getDiffFiles,
  getRepositoryStatus
} from "../server/services/git-service";

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

  it("reports rename and binary metadata and loads one file patch", async () => {
    const repo = await mkdtemp(join(tmpdir(), "oneteam-git-diff-"));
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.name", "Test User"]);
    await git(repo, ["config", "user.email", "test@example.com"]);
    await writeFile(join(repo, "old-name.txt"), "same content\n");
    await writeFile(join(repo, "image.bin"), Buffer.from([0, 1, 2, 3]));
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "initial"]);
    await git(repo, ["checkout", "-b", "feature"]);
    await git(repo, ["mv", "old-name.txt", "new-name.txt"]);
    await writeFile(join(repo, "image.bin"), Buffer.from([0, 4, 5, 6]));
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "rename and binary"]);

    const files = await getDiffFiles(repo, "feature", "main");
    const renamed = files.find((file) => file.path === "new-name.txt");
    const binary = files.find((file) => file.path === "image.bin");
    const renamePatch = await getDiffFilePatch(repo, "feature", "main", "new-name.txt", {
      previousPath: "old-name.txt"
    });

    expect(renamed).toMatchObject({ previousPath: "old-name.txt", status: "R100" });
    expect(binary).toMatchObject({ binary: true, additions: 0, deletions: 0 });
    expect(renamePatch).toContain("rename from old-name.txt");
    expect(renamePatch).toContain("rename to new-name.txt");
  });

  it("commits dirty worktrees and reads merge conflict contents", async () => {
    const repo = await mkdtemp(join(tmpdir(), "oneteam-git-conflict-"));
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.name", "Test User"]);
    await git(repo, ["config", "user.email", "test@example.com"]);
    await writeFile(join(repo, "README.md"), "base\n");
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-m", "initial"]);
    await git(repo, ["checkout", "-b", "feature"]);
    await writeFile(join(repo, "README.md"), "feature\n");

    const commit = await commitAllChanges(repo, "feature change");
    await git(repo, ["checkout", "main"]);
    await writeFile(join(repo, "README.md"), "main\n");
    await git(repo, ["commit", "-am", "main change"]);

    const conflicts = await detectMergeConflicts(repo, "feature", "main");

    expect(commit.commitHash).toMatch(/[0-9a-f]{40}/);
    expect(conflicts.hasConflicts).toBe(true);
    expect(conflicts.files[0]).toMatchObject({
      path: "README.md",
      baseContent: "base",
      targetContent: "main",
      sourceContent: "feature"
    });
  });
});
