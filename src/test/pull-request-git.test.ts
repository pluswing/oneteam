import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import { createDatabaseContext } from "../server/db/client";
import { runMigrations } from "../server/db/migrations";
import { createRepositories } from "../server/db/repositories";
import type { PullRequestDto, RepositoryCommitDto } from "../shared/types";

const execFileAsync = promisify(execFile);

async function git(repo: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: repo });
}

async function createRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "oneteam-pr-git-"));
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "Test User"]);
  await git(repo, ["config", "user.email", "test@example.com"]);
  await writeFile(join(repo, "README.md"), "# Example\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
  await git(repo, ["checkout", "-b", "feature"]);
  await writeFile(join(repo, "README.md"), "# Example\n\nFeature\n");
  await git(repo, ["commit", "-am", "change readme"]);
  return repo;
}

describe("pull request git API", () => {
  it("populates pull request git counts and commits", async () => {
    const dbDir = await mkdtemp(join(tmpdir(), "oneteam-pr-git-db-"));
    const repoPath = await createRepo();
    const context = createDatabaseContext(`file:${join(dbDir, "test.db")}`);
    await runMigrations(context.client);

    const repos = createRepositories(context.db);
    const app = createApp({ repos });
    const project = await repos.projects.create({
      name: "Example",
      repoPath,
      defaultBranch: "main",
      locale: "en"
    });
    const pullRequest = await repos.pullRequests.create({
      projectId: project.id,
      title: "Feature",
      sourceBranch: "feature",
      targetBranch: "main"
    });

    const detailResponse = await app.request(`/api/projects/${project.id}/pull-requests/${pullRequest.id}`);
    const listResponse = await app.request(`/api/projects/${project.id}/pull-requests`);
    const commitsResponse = await app.request(`/api/projects/${project.id}/pull-requests/${pullRequest.id}/commits`);
    const detail = (await detailResponse.json()) as { pullRequest: PullRequestDto };
    const list = (await listResponse.json()) as { items: PullRequestDto[] };
    const commits = (await commitsResponse.json()) as { items: RepositoryCommitDto[] };

    expect(detail.pullRequest.changedFileCount).toBe(1);
    expect(detail.pullRequest.commitCount).toBe(1);
    expect(list.items[0].changedFileCount).toBe(1);
    expect(list.items[0].commitCount).toBe(1);
    expect(commits.items[0].subject).toBe("change readme");

    context.client.close();
  });
});
