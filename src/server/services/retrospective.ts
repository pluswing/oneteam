import { z } from "zod";
import type { DevelopmentLoopDto, KnowledgeChange } from "../../shared/development-loop";
import type { AgentJobDto, ProjectDto } from "../../shared/types";
import type { Repositories } from "../db/repositories";
import { knowledgeHash, readKnowledgeBody, replaceKnowledgeBody, validateKnowledgePath } from "./knowledge-files";

const proposalSchema = z.object({
  body: z.string().min(1).max(24_000),
  changes: z.array(z.object({ path: z.string(), beforeHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), body: z.string().max(16_000).nullable(), reason: z.string().min(1).max(2_000) })).max(12)
});

export async function finalizeRetrospective(repos: Repositories, project: ProjectDto, loop: DevelopmentLoopDto, job?: AgentJobDto): Promise<void> {
  if (!loop.mergeCommit) throw new Error("A verified merge commit is required for retrospective.");
  let retrospective = await repos.development.retrospectives.get(project.id, loop.id);
  if (!retrospective) {
    const output = job?.output;
    const metadata = output?.metadata as { retrospective?: unknown } | undefined;
    const proposal = proposalSchema.parse(metadata?.retrospective);
    if (new Set(proposal.changes.map((change) => change.path)).size !== proposal.changes.length) throw new Error("Retrospective contains duplicate knowledge paths.");
    for (const change of proposal.changes) {
      validateKnowledgePath(change.path);
      if (change.path === "AGENTS.md" && change.body === null) throw new Error("The common knowledge index cannot be deleted.");
    }
    if (proposal.changes.reduce((sum, change) => sum + (change.body?.length ?? 0), 0) > 64_000) throw new Error("Knowledge proposal is too large.");
    await repos.development.retrospectives.create({ projectId: project.id, loopId: loop.id, mergeCommit: loop.mergeCommit, summary: String(output?.message ?? "Loop retrospective"), body: proposal.body, changes: proposal.changes });
    retrospective = (await repos.development.retrospectives.get(project.id, loop.id))!;
  }
  if (retrospective.mergeCommit !== loop.mergeCommit) throw new Error("Retrospective merge commit does not match this Loop.");
  try {
    if (retrospective.status !== "applied") {
      const reportPath = `retrospectives/loop-${loop.id}.md`;
      const reportBody = `# Loop #${loop.id}\n\nIssue #${loop.issueId} · PR #${loop.pullRequestId}\n\nMerge: ${loop.mergeCommit}\n\n${retrospective.body}\n`;
      const changes: KnowledgeChange[] = [...retrospective.changes, { path: reportPath, beforeHash: null, body: reportBody, reason: "Record this Loop's retrospective." }];
      let revisions = await repos.development.revisions.list(project.id, loop.id);
      // Preflight all files before any writes. A saved journal survives partial application.
      for (const change of changes) {
        const current = await readKnowledgeBody(project.repoPath, change.path, change.path === reportPath);
        const revision = revisions.find((item) => item.path === change.path);
        if (revision) {
          if (current !== revision.beforeBody && current !== revision.afterBody) throw new Error(`Knowledge changed outside this retrospective: ${change.path}`);
        } else if (knowledgeHash(current) !== change.beforeHash) throw new Error(`Knowledge changed since the task read it: ${change.path}`);
      }
      for (const change of changes) {
        if (!revisions.some((item) => item.path === change.path)) await repos.development.revisions.create({
          projectId: project.id, loopId: loop.id, path: change.path,
          beforeBody: await readKnowledgeBody(project.repoPath, change.path, change.path === reportPath), afterBody: change.body, reason: change.reason, status: "pending"
        });
      }
      await repos.development.retrospectives.update(project.id, loop.id, "applying");
      revisions = await repos.development.revisions.list(project.id, loop.id);
      for (const revision of revisions) {
        const current = await readKnowledgeBody(project.repoPath, revision.path, revision.path === reportPath);
        if (current !== revision.afterBody) {
          if (current !== revision.beforeBody) throw new Error(`Knowledge changed during application: ${revision.path}`);
          await replaceKnowledgeBody(project.repoPath, revision.path, revision.afterBody, revision.path === reportPath);
        }
        await repos.development.revisions.applied(project.id, revision.id);
      }
      await repos.development.retrospectives.update(project.id, loop.id, "applied");
    }
    await repos.development.update(project.id, loop.id, { phase: "completed", status: "succeeded", summary: retrospective.summary, finishedAt: new Date().toISOString() });
  } catch (error) {
    await repos.development.retrospectives.update(project.id, loop.id, "failed", error instanceof Error ? error.message : "Knowledge update failed.");
    throw error;
  }
}

export async function restoreKnowledgeRevision(repos: Repositories, project: ProjectDto, revisionId: number): Promise<void> {
  const revision = (await repos.development.revisions.list(project.id)).find((item) => item.id === revisionId);
  if (!revision) throw new Error("Knowledge revision was not found.");
  validateKnowledgePath(revision.path);
  if (revision.status === "restored") return;
  if (!["applied", "restoring"].includes(revision.status)) throw new Error("Only an applied knowledge change can be restored.");
  const loops = await repos.development.list(project.id);
  if (loops.some((loop) => ["running", "queued", "waiting_capacity"].includes(loop.status))) throw new Error("Pause the active Loop before restoring knowledge.");
  const current = await readKnowledgeBody(project.repoPath, revision.path);
  if (current !== revision.afterBody && !(revision.status === "restoring" && current === revision.beforeBody)) throw new Error("Knowledge was edited after this revision. Restore newer changes first or edit the file manually.");
  await repos.development.revisions.setStatus(project.id, revision.id, "restoring");
  if (current !== revision.beforeBody) await replaceKnowledgeBody(project.repoPath, revision.path, revision.beforeBody);
  await repos.development.revisions.setStatus(project.id, revision.id, "restored");
  const loop = loops.find((item) => item.id === revision.loopId);
  if (loop) await repos.activities.create({ projectId: project.id, targetType: "issue", targetId: loop.issueId, activityType: "system", title: "Knowledge revision restored", body: revision.path, payload: { revisionId: revision.id, loopId: loop.id } });
}
