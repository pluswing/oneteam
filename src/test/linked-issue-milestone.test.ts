import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRunResult } from "../server/agents/types";
import { createDatabaseContext } from "../server/db/client";
import { runMigrations } from "../server/db/migrations";
import { createRepositories } from "../server/db/repositories";
import {
  recordIssueImplementationStarted,
  recordLinkedIssueAgentMilestone
} from "../server/services/linked-issue-milestone";

describe("linked Issue workflow milestones", () => {
  it("records a structured PR milestone only once for the same Agent Job event", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneteam-linked-milestone-"));
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
      body: "Reject empty input."
    });
    const pullRequest = await repos.pullRequests.create({
      projectId: project.id,
      issueId: issue.id,
      title: "Add validation",
      sourceBranch: "feature/validation",
      targetBranch: "main"
    });
    const job = await repos.agentJobs.create({
      projectId: project.id,
      agentType: "review",
      targetType: "pull_request",
      targetId: pullRequest.id
    });
    const result: AgentRunResult = {
      status: "succeeded",
      message: "The review found one blocking issue.",
      metadata: {
        review: {
          verdict: "changes_requested",
          findings: [{ path: "src/input.ts", line: 12, title: "Empty input is accepted" }],
          checked: ["requirements", "tests"]
        }
      }
    };

    await recordLinkedIssueAgentMilestone(repos, job, result);
    await recordLinkedIssueAgentMilestone(repos, job, result);

    const comments = await repos.comments.list(project.id, "issue", issue.id);
    const activities = await repos.activities.list(project.id, "issue", issue.id);
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("## Review requested changes");
    expect(comments[0].body).toContain(`[#${pullRequest.id} — Add validation](/pulls/${pullRequest.id})`);
    expect(comments[0].metadata).toMatchObject({
      workflowMilestoneEvent: "review-changes-requested",
      pullRequestId: pullRequest.id,
      agentJobId: job.id
    });
    expect(activities).toHaveLength(1);

    context.client.close();
  });

  it("records implementation start once when an interrupted job reuses its worktree", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oneteam-implementation-milestone-"));
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
      title: "Implement safely",
      body: "Keep the start milestone durable."
    });
    const job = await repos.agentJobs.create({
      projectId: project.id,
      agentType: "implementation",
      targetType: "issue",
      targetId: issue.id
    });
    const worktree = {
      repoPath: join(dir, "worktree"),
      worktreePath: join(dir, "worktree"),
      branchName: "oneteam/issue-1-implement-safely",
      recovered: true
    };

    await recordIssueImplementationStarted(repos, job, worktree);
    await recordIssueImplementationStarted(repos, job, worktree);

    const comments = await repos.comments.list(project.id, "issue", issue.id);
    const activities = await repos.activities.list(project.id, "issue", issue.id);
    const objective = await repos.objectives.findByIssue(project.id, issue.id);
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("## Implementation started");
    expect(comments[0].body).toContain("An existing OneTeam worktree was recovered");
    expect(comments[0].metadata?.workflowMilestoneEvent).toBe("implementation-started");
    expect(activities).toHaveLength(1);
    expect(objective).toMatchObject({ status: "running", workflowStage: "implementation", lastAgentJobId: job.id });

    context.client.close();
  });
});
