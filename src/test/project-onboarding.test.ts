import { mkdtemp, readFile, writeFile, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { createOneTeamRuntime } from "../server/runtime";
import { loadConfig } from "../server/config";
import { inspectWorkspace, prepareWorkspace, acquireWorkspaceLock } from "../server/services/workspace";
import { gitFixture } from "./development-fixture";
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); });

it("initializes only, reopens without extra records, and keeps folder databases isolated", async () => {
  const first = await gitFixture(), second = await gitFixture(); cleanups.push(first.cleanup, second.cleanup);
  vi.stubEnv("ONETEAM_HOME", first.dir); vi.stubEnv("ONETEAM_DATABASE_URL", undefined);
  const config = loadConfig(); config.database.url = ":memory:"; config.agents.workerEnabled = false;
  const runtime = await createOneTeamRuntime(config); cleanups.push(runtime.stop);
  const open = async (repoPath: string) => runtime.app.request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoPath, locale: "ja" }) });
  const opened = await open(first.dir); expect(opened.status).toBe(201);
  const { project } = await opened.json();
  expect((await runtime.repos.issues.list({ projectId: project.id, limit: 20, offset: 0 })).total).toBe(0);
  expect(await runtime.repos.agentJobs.list({ projectId: project.id })).toEqual([]);
  expect(JSON.parse(await readFile(join(first.dir, ".oneteam/workspace.json"), "utf8")).state).toBe("ready");
  await writeFile(join(first.dir, ".oneteam/AGENTS.md"), "# User instruction\nKeep this.\n");
  const issue = await runtime.repos.issues.create({ projectId: project.id, title: "First folder" });
  expect((await open(first.dir)).status).toBe(200);
  expect((await open(second.dir)).status).toBe(201);
  const secondProject = (await runtime.repos.projects.list())[0];
  expect(secondProject.repoPath).toBe(second.dir);
  expect(await runtime.repos.issues.get(secondProject.id, issue.id)).toBeNull();
  expect((await open(first.dir)).status).toBe(201);
  expect((await runtime.repos.issues.get(project.id, issue.id))?.title).toBe("First folder");
  expect(await readFile(join(first.dir, ".oneteam/AGENTS.md"), "utf8")).toBe("# User instruction\nKeep this.\n");
  // Even a second runtime with its worker disabled must not migrate/open a locked DB.
  await expect(createOneTeamRuntime({ ...config, database: { url: runtime.runtime.database.url } })).rejects.toThrow("already open");
  expect(await first.git("status", "--porcelain")).toBe("");
});

it("rejects nonrepositories, nested folders and malformed or linked workspace data", async () => {
  const fixture = await gitFixture(); cleanups.push(fixture.cleanup);
  const empty = await mkdtemp(join(tmpdir(), "oneteam-not-git-"));
  const { rm } = await import("node:fs/promises"); cleanups.push(() => rm(empty, { recursive: true, force: true }));
  await expect(inspectWorkspace(empty)).rejects.toThrow("not a Git repository");
  await mkdir(join(fixture.dir, "nested")); await expect(inspectWorkspace(join(fixture.dir, "nested"))).rejects.toThrow("repository root");
  await mkdir(join(fixture.dir, ".oneteam")); await expect(prepareWorkspace(fixture.dir)).rejects.toThrow("no database");
  await symlink(empty, join(fixture.dir, ".oneteam/data")); await expect(prepareWorkspace(fixture.dir)).rejects.toThrow("must not be a link");
});

it("reclaims a stale runtime lock but never a live one", async () => {
  const fixture = await gitFixture(); cleanups.push(fixture.cleanup);
  await prepareWorkspace(fixture.dir);
  const release = await acquireWorkspaceLock(fixture.dir); cleanups.push(release);
  await expect(acquireWorkspaceLock(fixture.dir)).rejects.toThrow("already open");
  await release();
  await writeFile(join(fixture.dir, ".oneteam/runtime.lock"), JSON.stringify({ pid: 2147483647, token: "stale" }));
  const reclaimed = await acquireWorkspaceLock(fixture.dir); await reclaimed();
});

it("recovers initialization stopped after the database opened but before folder registration", async () => {
  const fixture = await gitFixture(); cleanups.push(fixture.cleanup);
  vi.stubEnv("ONETEAM_HOME", fixture.dir); vi.stubEnv("ONETEAM_DATABASE_URL", undefined);
  const config = loadConfig(); config.database.url = `file:${fixture.dir}/.oneteam/data/oneteam.db`; config.agents.workerEnabled = false;
  const runtime = await createOneTeamRuntime(config); cleanups.push(runtime.stop);
  const response = await runtime.app.request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoPath: fixture.dir }) });
  expect(response.status).toBe(201);
  const project = (await runtime.repos.projects.list())[0];
  expect(project.repoPath).toBe(fixture.dir);
  expect((await runtime.repos.issues.list({ projectId: project.id, limit: 10, offset: 0 })).total).toBe(0);
});
