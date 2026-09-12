import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { expect, it } from "vitest";
import { developmentFixture } from "./development-fixture";
import { backupBeforeLoopMigration } from "../server/services/workspace";
import { runMigrations } from "../server/db/migrations";
import { migrateActiveDevelopmentLoops, queueDevelopmentJob } from "../server/services/development-loop";

it("backs up and migrates a version 15 database once, preserving prior IDs, provider history and knowledge", async () => {
  const fixture = await developmentFixture();
  try {
    const { context, repos, project, dir } = fixture;
    const issue = await repos.issues.create({ projectId: project.id, title: "In-progress implementation" });
    const objective = await repos.objectives.createForIssue({ projectId: project.id, issueId: issue.id, title: issue.title, goal: issue.body });
    await repos.objectives.update(project.id, objective.id, { status: "running", workflowStage: "implementation" });
    const job = await repos.agentJobs.create({ projectId: project.id, aiProvider: "claude_code", aiModel: "historical-model", agentType: "implementation", targetType: "issue", targetId: issue.id, input: { objectiveRunId: objective.id }, triggerType: "legacy" });
    await repos.agentJobs.updateStatus(project.id, job.id, "running");
    const completeIssue = await repos.issues.create({ projectId: project.id, title: "Already delivered" });
    const completeObjective = await repos.objectives.createForIssue({ projectId: project.id, issueId: completeIssue.id, title: completeIssue.title, goal: "Delivered" });
    await repos.objectives.update(project.id, completeObjective.id, { status: "succeeded", workflowStage: "merged" });
    const comment = await repos.comments.create({ projectId: project.id, targetType: "issue", targetId: issue.id, authorType: "user", body: "Preserve this comment." });
    await mkdir(join(dir, ".oneteam/skills")); await writeFile(join(dir, ".oneteam/skills/project.md"), "User-authored legacy knowledge.\n");
    // Remove only the newly introduced empty schema to reproduce a v15 fixture.
    await context.client.batch(["drop table knowledge_revisions", "drop table retrospectives", "drop table agent_executions", "drop table development_loops", "delete from schema_migrations where id = '0016_development_loops'"], "write");
    await backupBeforeLoopMigration(context.client, `file:${dir}/.oneteam/data/oneteam.db`);
    const backups = await readdir(join(dir, ".oneteam/backups")); expect(backups).toHaveLength(1);
    const snapshot = createClient({ url: `file:${join(dir, ".oneteam/backups", backups[0], "oneteam.db")}` });
    expect((await snapshot.execute("select id from issues")).rows.map((row) => Number(row.id))).toContain(issue.id);
    expect((await snapshot.execute("select name from sqlite_master where name = 'development_loops'")).rows).toHaveLength(0); snapshot.close();
    await runMigrations(context.client); await migrateActiveDevelopmentLoops(repos, project.id);
    await runMigrations(context.client); await migrateActiveDevelopmentLoops(repos, project.id);
    await backupBeforeLoopMigration(context.client, `file:${dir}/.oneteam/data/oneteam.db`);
    expect(await readdir(join(dir, ".oneteam/backups"))).toHaveLength(1);
    const loops = await repos.development.list(project.id); expect(loops).toHaveLength(1);
    expect(loops[0]).toMatchObject({ status: "paused", nextAgent: "implementation", currentJobId: null, objectiveId: objective.id });
    expect(await repos.agentJobs.get(project.id, job.id)).toMatchObject({ status: "paused", aiProvider: "claude_code", aiModel: "historical-model", input: { imported: true, developmentLoopId: loops[0].id } });
    expect(await queueDevelopmentJob(repos, loops[0])).toMatchObject({ aiProvider: "codex", aiModel: null, agentType: "implementation" });
    expect((await repos.comments.list(project.id, "issue", issue.id)).find((item) => item.id === comment.id)?.body).toBe("Preserve this comment.");
    expect(await readFile(join(dir, ".oneteam/skills/project.md"), "utf8")).toBe("User-authored legacy knowledge.\n");
    expect(await readFile(join(dir, ".oneteam/backups", backups[0], "skills/project.md"), "utf8")).toBe("User-authored legacy knowledge.\n");
  } finally { await fixture.cleanup(); }
});
