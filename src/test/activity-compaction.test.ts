import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDatabaseContext } from "../server/db/client";
import { runMigrations } from "../server/db/migrations";
import { createRepositories } from "../server/db/repositories";

describe("activity compaction", () => {
  it("compacts only consecutive identical Agent activity bursts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oneteam-activity-compaction-"));
    const context = createDatabaseContext(`file:${join(directory, "test.db")}`);
    await runMigrations(context.client);
    const repos = createRepositories(context.db);
    const project = await repos.projects.create({ name: "Activity", repoPath: directory, defaultBranch: "main", locale: "en" });
    const issue = await repos.issues.create({ projectId: project.id, title: "Compact activity" });
    const job = await repos.agentJobs.create({
      projectId: project.id,
      agentType: "implementation",
      targetType: "issue",
      targetId: issue.id
    });
    const event = {
      projectId: project.id,
      agentJobId: job.id,
      targetType: "issue" as const,
      targetId: issue.id,
      activityType: "progress" as const,
      title: "Inspected workspace",
      body: "Read the repository structure.",
      payload: { phase: "inspect" }
    };

    const first = await repos.activities.create(event);
    const second = await repos.activities.create(event);
    expect(second.id).toBe(first.id);
    expect(second.occurrenceCount).toBe(2);
    expect(second.lastOccurredAt >= first.lastOccurredAt).toBe(true);

    const distinct = await repos.activities.create({ ...event, body: "Read the test structure." });
    const repeatedAfterDistinct = await repos.activities.create(event);
    const activities = await repos.activities.list(project.id, "issue", issue.id);
    expect(distinct.id).not.toBe(first.id);
    expect(repeatedAfterDistinct.id).not.toBe(first.id);
    expect(activities).toHaveLength(3);
    expect(activities.map((activity) => activity.occurrenceCount)).toEqual([2, 1, 1]);
    context.client.close();
  });
});
