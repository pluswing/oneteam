import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import { createDatabaseContext } from "../server/db/client";
import { runMigrations } from "../server/db/migrations";
import { createRepositories } from "../server/db/repositories";
import { ensureObjectiveForTarget } from "../server/services/objective-runs";
import { goalContractDiff } from "../server/services/goal-contract-change";

describe("Goal Contract changes", () => {
  it("requires a reason and records the old and new contract across Issue, PR, Evidence, and Memory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneteam-goal-contract-"));
    const context = createDatabaseContext(`file:${join(dir, "test.db")}`);
    await runMigrations(context.client);
    const repos = createRepositories(context.db);
    const project = await repos.projects.create({
      name: "Example",
      repoPath: dir,
      defaultBranch: "main",
      locale: "en"
    });
    const issue = await repos.issues.create({
      projectId: project.id,
      title: "Validate input",
      body: "Reject empty input.\nKeep existing error messages."
    });
    const pullRequest = await repos.pullRequests.create({
      projectId: project.id,
      issueId: issue.id,
      title: "Validate input",
      sourceBranch: "feature/validation",
      targetBranch: "main"
    });
    const objective = await ensureObjectiveForTarget(repos, {
      projectId: project.id,
      targetType: "pull_request",
      targetId: pullRequest.id
    });
    if (!objective) throw new Error("Objective was not created.");
    await repos.objectives.update(project.id, objective.id, { status: "running", workflowStage: "review" });
    const app = createApp({ repos });
    const nextGoal = "Reject empty and whitespace-only input.\nKeep existing error messages.";

    const missingReasonResponse = await app.request(`/api/projects/${project.id}/issues/${issue.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: nextGoal })
    });
    expect(missingReasonResponse.status).toBe(400);
    expect((await repos.issues.get(project.id, issue.id))?.body).toBe(issue.body);

    const response = await app.request(`/api/projects/${project.id}/issues/${issue.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: nextGoal,
        goalChangeReason: "Whitespace-only values fail downstream and must be covered by the same delivery."
      })
    });
    const [updatedObjective, issueComments, prComments, issueActivities, memory] = await Promise.all([
      repos.objectives.get(project.id, objective.id),
      repos.comments.list(project.id, "issue", issue.id),
      repos.comments.list(project.id, "pull_request", pullRequest.id),
      repos.activities.list(project.id, "issue", issue.id),
      repos.loopMemory.list(project.id)
    ]);
    const goalEvidence = Array.isArray(updatedObjective?.evidence?.items)
      ? updatedObjective.evidence.items.find(
          (item) => typeof item === "object" && item !== null && "type" in item && item.type === "goal_contract_change"
        )
      : null;

    expect(response.status).toBe(200);
    expect(updatedObjective).toMatchObject({ goal: nextGoal, status: "running", workflowStage: "review" });
    expect(goalEvidence).toMatchObject({
      summary: "Whitespace-only values fail downstream and must be covered by the same delivery.",
      payload: expect.objectContaining({ previousGoal: issue.body, nextGoal })
    });
    expect(issueComments.some((comment) => comment.body.includes("## Goal Contract changed"))).toBe(true);
    expect(issueComments.some((comment) => comment.body.includes("- Reject empty input."))).toBe(true);
    expect(issueComments.some((comment) => comment.body.includes("+ Reject empty and whitespace-only input."))).toBe(true);
    expect(prComments.some((comment) => comment.body.includes("## Goal Contract changed"))).toBe(true);
    expect(issueActivities.map((activity) => activity.title)).toContain("Goal Contract changed");
    expect(memory.some((entry) => entry.tags.includes("goal_contract") && entry.body.includes("```diff"))).toBe(true);

    const unchangedResponse = await app.request(`/api/projects/${project.id}/issues/${issue.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: nextGoal })
    });
    expect(unchangedResponse.status).toBe(200);
    expect((await repos.comments.list(project.id, "issue", issue.id)).filter((comment) =>
      comment.body.includes("## Goal Contract changed")
    )).toHaveLength(1);

    context.client.close();
  });

  it("builds a bounded readable line diff", () => {
    expect(goalContractDiff("alpha\nbeta\nomega", "alpha\ngamma\nomega")).toBe(
      "  alpha\n- beta\n+ gamma\n  omega"
    );
  });
});
