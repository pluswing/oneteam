import { mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import { createDatabaseContext } from "../server/db/client";
import { runMigrations } from "../server/db/migrations";
import { createRepositories } from "../server/db/repositories";
import { normalizeEvidenceArtifacts } from "../server/services/evidence-artifacts";
import type { AgentEvidenceResult } from "../server/agents/types";

const pngSignature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

describe("evidence artifacts", () => {
  it("persists workspace screenshots and serves only the normalized image", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oneteam-evidence-artifact-"));
    const repoPath = join(directory, "repo");
    const executionRepoPath = join(repoPath, "worktree");
    await mkdir(join(executionRepoPath, "screenshots"), { recursive: true });
    await writeFile(join(executionRepoPath, "screenshots", "qa home.png"), pngSignature);
    const context = createDatabaseContext(`file:${join(directory, "test.db")}`);
    await runMigrations(context.client);
    const repos = createRepositories(context.db);
    const project = await repos.projects.create({ name: "Artifacts", repoPath, defaultBranch: "main", locale: "en" });
    const job = await repos.agentJobs.create({
      projectId: project.id,
      agentType: "qa",
      targetType: "project",
      targetId: 0
    });
    const evidence: AgentEvidenceResult[] = [
      {
        type: "screenshot",
        title: "Home page",
        summary: "The layout matches the acceptance criteria.",
        payload: {
          artifact: {
            kind: "image",
            path: "screenshots/qa home.png",
            caption: "QA home page"
          }
        }
      }
    ];

    const normalized = await normalizeEvidenceArtifacts({ project, job, executionRepoPath, evidence });
    const artifact = normalized?.[0].payload?.artifact as Record<string, unknown>;
    const storedPath = join(repoPath, ".oneteam", "data", "artifacts", `job-${job.id}`, String(artifact.name));
    expect(artifact).toMatchObject({
      kind: "image",
      status: "available",
      name: "01-qa-home.png",
      caption: "QA home page",
      mediaType: "image/png",
      byteSize: pngSignature.length
    });
    expect(artifact.url).toBe(`/api/projects/${project.id}/agent-jobs/${job.id}/artifacts/01-qa-home.png`);
    expect(await readFile(storedPath)).toEqual(Buffer.from(pngSignature));

    await repos.agentJobs.updateStatus(project.id, job.id, "succeeded", {
      output: { status: "succeeded", evidence: normalized }
    });
    const app = createApp({ repos });
    const response = await app.request(String(artifact.url));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(pngSignature);
    expect(
      (await app.request(`/api/projects/${project.id}/agent-jobs/${job.id}/artifacts/unrecorded.png`)).status
    ).toBe(404);

    const outsideImage = join(directory, "outside.png");
    await writeFile(outsideImage, pngSignature);
    await unlink(storedPath);
    await symlink(outsideImage, storedPath);
    expect((await app.request(String(artifact.url))).status).toBe(404);
    context.client.close();
  });

  it("marks unsafe or invalid screenshot references as unavailable without retaining their path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oneteam-invalid-evidence-artifact-"));
    const repoPath = join(directory, "repo");
    const executionRepoPath = join(repoPath, "worktree");
    await mkdir(executionRepoPath, { recursive: true });
    const outsideImage = join(repoPath, "outside.png");
    await writeFile(outsideImage, pngSignature);
    await writeFile(join(executionRepoPath, "fake.png"), "not an image");
    const timestamp = new Date().toISOString();
    const project = { id: "project_artifacts", name: "Artifacts", repoPath, defaultBranch: "main", locale: "en", createdAt: timestamp, updatedAt: timestamp };
    const job = {
      id: 17,
      projectId: project.id,
      aiProvider: "codex" as const,
      aiModel: null,
      agentType: "qa" as const,
      targetType: "project" as const,
      targetId: 0,
      status: "running" as const,
      triggerType: "manual",
      parentJobId: null,
      input: {},
      output: null,
      error: null,
      attempt: 1,
      lockKey: null,
      waitReason: null,
      waitMetadata: null,
      nextRetryAt: null,
      createdAt: timestamp,
      startedAt: timestamp,
      finishedAt: null
    };
    const normalized = await normalizeEvidenceArtifacts({
      project,
      job,
      executionRepoPath,
      evidence: [
        { type: "screenshot", title: "Outside", payload: { artifact: { kind: "image", path: "../outside.png" } } },
        { type: "screenshot", title: "Fake", payload: { artifact: { kind: "image", path: "fake.png" } } },
        { type: "screenshot", title: "SVG", payload: { artifact: { kind: "image", path: "diagram.svg" } } }
      ]
    });
    const artifacts = normalized?.map((item) => item.payload?.artifact as Record<string, unknown>);
    expect(artifacts).toMatchObject([
      { kind: "image", status: "unavailable", name: "outside.png" },
      { kind: "image", status: "unavailable", name: "fake.png" },
      { kind: "image", status: "unavailable", name: "diagram.svg" }
    ]);
    expect(JSON.stringify(artifacts)).not.toContain(directory);
  });
});
