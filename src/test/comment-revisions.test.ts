import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import { createDatabaseContext } from "../server/db/client";
import { runMigrations } from "../server/db/migrations";
import { createRepositories } from "../server/db/repositories";
import type { CommentDto, CommentRevisionDto } from "../shared/types";

describe("comment revisions", () => {
  it("edits user comments with optimistic concurrency and retains every previous body", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oneteam-comment-revisions-"));
    const context = createDatabaseContext(`file:${join(directory, "test.db")}`);
    await runMigrations(context.client);
    const repos = createRepositories(context.db);
    const app = createApp({ repos });
    const project = await repos.projects.create({ name: "Comments", repoPath: directory, defaultBranch: "main", locale: "en" });
    const issue = await repos.issues.create({ projectId: project.id, title: "Editable discussion" });
    const comment = await repos.comments.create({
      projectId: project.id,
      targetType: "issue",
      targetId: issue.id,
      authorType: "user",
      body: "Original **decision**"
    });

    const firstResponse = await app.request(`/api/projects/${project.id}/comments/${comment.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Clarified **decision**", expectedUpdatedAt: comment.updatedAt })
    });
    const first = (await firstResponse.json()) as { comment: CommentDto; revision: CommentRevisionDto };
    expect(firstResponse.status).toBe(200);
    expect(first.comment.body).toBe("Clarified **decision**");
    expect(first.comment.updatedAt).not.toBe(comment.updatedAt);
    expect(first.revision).toMatchObject({ body: "Original **decision**", bodyFormat: "markdown", editorType: "user" });

    const staleResponse = await app.request(`/api/projects/${project.id}/comments/${comment.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Overwrite from stale editor", expectedUpdatedAt: comment.updatedAt })
    });
    expect(staleResponse.status).toBe(409);

    const secondResponse = await app.request(`/api/projects/${project.id}/comments/${comment.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Final **decision**", expectedUpdatedAt: first.comment.updatedAt })
    });
    const second = (await secondResponse.json()) as { comment: CommentDto };
    expect(secondResponse.status).toBe(200);
    expect(second.comment.body).toBe("Final **decision**");

    const historyResponse = await app.request(`/api/projects/${project.id}/comments/${comment.id}/revisions`);
    const history = (await historyResponse.json()) as { items: CommentRevisionDto[] };
    expect(historyResponse.status).toBe(200);
    expect(history.items.map((revision) => revision.body)).toEqual([
      "Clarified **decision**",
      "Original **decision**"
    ]);
    context.client.close();
  });

  it("keeps Agent and system comments immutable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oneteam-immutable-comments-"));
    const context = createDatabaseContext(`file:${join(directory, "test.db")}`);
    await runMigrations(context.client);
    const repos = createRepositories(context.db);
    const app = createApp({ repos });
    const project = await repos.projects.create({ name: "Comments", repoPath: directory, defaultBranch: "main", locale: "en" });
    const issue = await repos.issues.create({ projectId: project.id, title: "Audit record" });
    const comment = await repos.comments.create({
      projectId: project.id,
      targetType: "issue",
      targetId: issue.id,
      authorType: "system",
      body: "Immutable merge decision"
    });

    const response = await app.request(`/api/projects/${project.id}/comments/${comment.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Tampered decision", expectedUpdatedAt: comment.updatedAt })
    });
    expect(response.status).toBe(403);
    expect((await repos.comments.get(project.id, comment.id))?.body).toBe("Immutable merge decision");
    expect(await repos.comments.listRevisions(project.id, comment.id)).toEqual([]);
    context.client.close();
  });
});
