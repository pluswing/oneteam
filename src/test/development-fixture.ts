import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createDatabaseContext } from "../server/db/client";
import { runMigrations } from "../server/db/migrations";
import { createRepositories } from "../server/db/repositories";
import { ensureKnowledgeFiles } from "../server/services/knowledge-files";
const exec = promisify(execFile);
export async function gitFixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "oneteam-fixture-")));
  const git = async (...args: string[]) => (await exec("git", args, { cwd: dir })).stdout.trim();
  await git("init", "-b", "main"); await git("config", "user.email", "test@example.com"); await git("config", "user.name", "Test");
  await writeFile(join(dir, "README.md"), "Example\n"); await git("add", "."); await git("commit", "-m", "initial");
  return { dir, git, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
export async function developmentFixture() {
  const fixture = await gitFixture();
  const context = createDatabaseContext(`file:${join(fixture.dir, ".oneteam/data/oneteam.db")}`);
  await runMigrations(context.client);
  const repos = createRepositories(context.db);
  const project = await repos.projects.create({ name: "Fixture", repoPath: fixture.dir, defaultBranch: "main" });
  await ensureKnowledgeFiles(fixture.dir);
  return { ...fixture, context, repos, project, cleanup: async () => { context.client.close(); await fixture.cleanup(); } };
}
