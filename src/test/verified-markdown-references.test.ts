import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { diffFileAnchor, diffLineAnchor } from "../shared/diff-anchors";
import { repositoryCommitPath } from "../shared/repository-anchors";
import { createDatabaseContext } from "../server/db/client";
import { runMigrations } from "../server/db/migrations";
import { createRepositories } from "../server/db/repositories";
import { verifyMarkdownReferences } from "../server/services/verified-markdown-references";

const execFileAsync = promisify(execFile);

describe("verified Markdown references", () => {
  it("links only existing PRs, visible commits, changed files, and lines outside protected Markdown", async () => {
    const repository = await mkdtemp(join(tmpdir(), "oneteam-markdown-references-repo-"));
    await execFileAsync("git", ["init", "-b", "main"], { cwd: repository });
    await execFileAsync("git", ["config", "user.name", "Reference Test"], { cwd: repository });
    await execFileAsync("git", ["config", "user.email", "reference@example.com"], { cwd: repository });
    await mkdir(join(repository, "src"));
    await writeFile(join(repository, "src", "example.ts"), "one\nold\nthree\n", "utf8");
    await execFileAsync("git", ["add", "."], { cwd: repository });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repository });
    await execFileAsync("git", ["checkout", "-b", "feature/references"], { cwd: repository });
    await writeFile(join(repository, "src", "example.ts"), "one\nnew\nthree\n", "utf8");
    await writeFile(join(repository, "src", "new.ts"), "export const added = true;\n", "utf8");
    await execFileAsync("git", ["add", "."], { cwd: repository });
    await execFileAsync("git", ["commit", "-m", "change referenced files"], { cwd: repository });
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository });
    const commit = stdout.trim();
    const shortCommit = commit.slice(0, 12);

    const database = await mkdtemp(join(tmpdir(), "oneteam-markdown-references-db-"));
    const context = createDatabaseContext(`file:${join(database, "test.db")}`);
    await runMigrations(context.client);
    const repos = createRepositories(context.db);
    const project = await repos.projects.create({ name: "References", repoPath: repository, defaultBranch: "main" });
    const issue = await repos.issues.create({ projectId: project.id, title: "Verify references" });
    const pullRequest = await repos.pullRequests.create({
      projectId: project.id,
      issueId: issue.id,
      title: "Reference links",
      sourceBranch: "feature/references",
      targetBranch: "main"
    });
    const body = [
      `PR #${pullRequest.id} updated \`src/example.ts:2\` and src/new.ts in commit \`${shortCommit}\`.`,
      `Invalid PR #999, \`src/example.ts:99\`, \`src/missing.ts:1\`, and deadbeef stay as text.`,
      `Existing [PR #${pullRequest.id}](/pulls/${pullRequest.id}#conversation) stays unchanged.`,
      "```text",
      `PR #${pullRequest.id} src/example.ts:2 ${shortCommit}`,
      "```"
    ].join("\n\n");

    const result = await verifyMarkdownReferences(repos, {
      projectId: project.id,
      targetType: "issue",
      targetId: issue.id,
      body
    });

    expect(result.body).toContain(`[PR #${pullRequest.id}](/pulls/${pullRequest.id})`);
    expect(result.body).toContain(
      `[\`src/example.ts:2\`](/pulls/${pullRequest.id}#${diffLineAnchor("src/example.ts", "R", 2)})`
    );
    expect(result.body).toContain(
      `[\`src/new.ts\`](/pulls/${pullRequest.id}#${diffFileAnchor("src/new.ts")})`
    );
    expect(result.body).toContain(`[\`${shortCommit}\`](${repositoryCommitPath(commit)})`);
    expect(result.body).toContain("Invalid PR #999, `src/example.ts:99`, `src/missing.ts:1`, and deadbeef");
    expect(result.body).toContain(`[PR #${pullRequest.id}](/pulls/${pullRequest.id}#conversation)`);
    expect(result.body).toContain(`PR #${pullRequest.id} src/example.ts:2 ${shortCommit}\n\n\`\`\``);
    expect(result.references.map((reference) => reference.kind)).toEqual([
      "pull_request",
      "diff_line",
      "diff_file",
      "commit"
    ]);
    expect(result.references.find((reference) => reference.kind === "commit")?.resolvedValue).toBe(commit);
    context.client.close();
  });

  it("returns the original body when repository validation is unavailable", async () => {
    const database = await mkdtemp(join(tmpdir(), "oneteam-markdown-references-missing-"));
    const context = createDatabaseContext(`file:${join(database, "test.db")}`);
    await runMigrations(context.client);
    const repos = createRepositories(context.db);
    const project = await repos.projects.create({
      name: "Missing repository",
      repoPath: join(database, "does-not-exist"),
      defaultBranch: "main"
    });
    const issue = await repos.issues.create({ projectId: project.id, title: "Keep body" });

    await expect(verifyMarkdownReferences(repos, {
      projectId: project.id,
      targetType: "issue",
      targetId: issue.id,
      body: "PR #1 references abcdef1."
    })).resolves.toEqual({ body: "PR #1 references abcdef1.", references: [] });
    context.client.close();
  });
});
