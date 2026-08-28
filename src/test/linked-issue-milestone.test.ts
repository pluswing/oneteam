import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRunResult } from "../server/agents/types";
import { createDatabaseContext } from "../server/db/client";
import { runMigrations } from "../server/db/migrations";
import { createRepositories } from "../server/db/repositories";
import { recordLinkedIssueAgentMilestone } from "../server/services/linked-issue-milestone";

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
});
