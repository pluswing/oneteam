import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabaseContext } from "../server/db/client";
import { runMigrations } from "../server/db/migrations";
import { createRepositories } from "../server/db/repositories";
import { createApp } from "../server/app";
import { ensureDevelopmentLoop } from "../server/services/development-loop";
import type { IssueDto } from "../shared/types";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "oneteam-internal-issues-"));
  const context = createDatabaseContext(`file:${join(dir, "test.db")}`);
  cleanups.push(async () => { context.client.close(); await rm(dir, { recursive: true, force: true }); });
  await runMigrations(context.client);
  const repos = createRepositories(context.db);
  const project = await repos.projects.create({ name: "Internal issues", repoPath: dir, defaultBranch: "main" });
  return { context, repos, project };
}

describe("internal issues", () => {
  it("lists existing internal loop issues through the public API with filtering, pagination and project isolation", async () => {
    const { context, repos, project } = await setup();
    const repair = await repos.issues.create({ projectId: project.id, title: "Security repair", internal: true, createdByType: "system" });
    const loop = await ensureDevelopmentLoop(repos, project.id, repair.id);
    const ordinary = await repos.issues.create({ projectId: project.id, title: "Visible feature" });
    const closed = await repos.issues.create({ projectId: project.id, title: "Closed repair", internal: true });
    await repos.issues.update(project.id, closed.id, { status: "closed" });
    const deleted = await repos.issues.create({ projectId: project.id, title: "Deleted repair", internal: true });
    await repos.issues.softDelete(project.id, deleted.id);
    const otherProject = await repos.projects.create({ name: "Other", repoPath: "/other", defaultBranch: "main" });
    await repos.issues.create({ projectId: otherProject.id, title: "Other repair", internal: true });
    for (const [id, updatedAt] of [[repair.id, "2026-01-02T00:00:00Z"], [ordinary.id, "2026-01-01T00:00:00Z"]] as const) {
      await context.client.execute({ sql: "update issues set updated_at = ? where id = ?", args: [updatedAt, id] });
    }

    const app = createApp({ repos });
    const list = async (query: string) => {
      const response = await app.request(`/api/projects/${project.id}/issues?${query}`);
      expect(response.status).toBe(200);
      return response.json() as Promise<{ items: IssueDto[]; page: { total: number } }>;
    };
    const firstPage = await list("status=open&limit=1");
    expect(firstPage.page.total).toBe(2);
    expect(firstPage.items).toEqual([expect.objectContaining({ id: loop.issueId, createdByType: "system" })]);
    expect((await list("status=open&limit=1&offset=1")).items.map((issue) => issue.id)).toEqual([ordinary.id]);
    expect((await list("status=open&q=Security")).items.map((issue) => issue.id)).toEqual([repair.id]);
    expect((await list("status=closed")).items.map((issue) => issue.id)).toEqual([closed.id]);
    expect((await list("")).page.total).toBe(3);
    const detail = await app.request(`/api/projects/${project.id}/issues/${loop.issueId}`);
    expect(await detail.json()).toMatchObject({ issue: { id: repair.id, title: repair.title } });
    expect((await context.client.execute({ sql: "select internal from issues where id = ?", args: [repair.id] })).rows[0].internal).toBe(1);
  });

  it("excludes internal issues from the ordinary list before pagination and counting", async () => {
    const { context, repos, project } = await setup();
    const first = await repos.issues.create({ projectId: project.id, title: "Visible first" });
    const internal = await repos.issues.create({ projectId: project.id, title: "Security task", internal: true, createdByType: "system" });
    const second = await repos.issues.create({ projectId: project.id, title: "Visible second" });
    for (const [id, updatedAt] of [[first.id, "2026-01-01T00:00:00Z"], [internal.id, "2026-01-02T00:00:00Z"], [second.id, "2026-01-03T00:00:00Z"]] as const) {
      await context.client.execute({ sql: "update issues set updated_at = ? where id = ?", args: [updatedAt, id] });
    }

    const firstPage = await repos.issues.list({ projectId: project.id, limit: 1, offset: 0 });
    const secondPage = await repos.issues.list({ projectId: project.id, limit: 1, offset: 1 });
    expect(firstPage.total).toBe(2);
    expect(firstPage.items.map((issue) => issue.id)).toEqual([second.id]);
    expect(secondPage.total).toBe(2);
    expect(secondPage.items.map((issue) => issue.id)).toEqual([first.id]);
    expect(await repos.issues.list({ projectId: project.id, q: "Security", limit: 10, offset: 0 })).toEqual({ items: [], total: 0 });
  });

  it("keeps internal issues addressable by ID and allows explicit internal listings", async () => {
    const { context, repos, project } = await setup();
    const visible = await repos.issues.create({ projectId: project.id, title: "Visible task" });
    const internal = await repos.issues.create({ projectId: project.id, title: "Internal task", internal: true });
    expect(await repos.issues.get(project.id, internal.id)).toMatchObject({ id: internal.id, title: "Internal task" });
    const all = await repos.issues.list({ projectId: project.id, includeInternal: true, limit: 10, offset: 0 });
    expect(all.total).toBe(2);
    expect(all.items.map((issue) => issue.id).sort()).toEqual([visible.id, internal.id].sort());

    await runMigrations(context.client);
    const values = await context.client.execute("select internal from issues order by id");
    expect(values.rows.map((row) => row.internal)).toEqual([0, 1]);
    await repos.issues.softDelete(project.id, internal.id);
    expect(await repos.issues.get(project.id, internal.id)).toBeNull();
    expect((await repos.issues.list({ projectId: project.id, includeInternal: true, limit: 10, offset: 0 })).total).toBe(1);
  });
});
