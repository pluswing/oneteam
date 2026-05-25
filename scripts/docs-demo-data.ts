import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defaultCodexCommand } from "../src/shared/codex";
import { workflowLabelNames } from "../src/shared/workflow-labels";
import { createDatabaseContext } from "../src/server/db/client";
import { runMigrations } from "../src/server/db/migrations";
import { createRepositories } from "../src/server/db/repositories";

const root = resolve(".tmp/docs-demo");
const repoPath = resolve(root, "repo");
const databasePath = resolve(root, "oneteam.db");
const fakeCodexPath = resolve(root, "fake-codex.mjs");

const timestamps = {
  project: "2026-05-25T00:00:00.000Z",
  issueSetup: "2026-05-25T00:20:00.000Z",
  issueEmptyState: "2026-05-25T00:40:00.000Z",
  issueReview: "2026-05-25T01:00:00.000Z",
  commentStart: "2026-05-25T01:20:00.000Z",
  requirementsQuestion: "2026-05-25T01:32:00.000Z",
  implementationStarted: "2026-05-25T02:05:00.000Z",
  implementationFinished: "2026-05-25T02:28:00.000Z",
  reviewFinished: "2026-05-25T02:52:00.000Z",
  qaFinished: "2026-05-25T03:15:00.000Z",
  latest: "2026-05-25T03:30:00.000Z"
};

function git(args: string[], options: { env?: NodeJS.ProcessEnv } = {}) {
  execFileSync("git", args, {
    cwd: repoPath,
    stdio: "ignore",
    env: { ...process.env, ...options.env }
  });
}

function commit(message: string, isoDate: string) {
  git(["add", "."]);
  git(["commit", "-m", message], {
    env: {
      GIT_AUTHOR_DATE: isoDate,
      GIT_COMMITTER_DATE: isoDate
    }
  });
}

function writeRepoFile(path: string, contents: string) {
  writeFileSync(resolve(repoPath, path), contents);
}

async function updateRow(
  client: ReturnType<typeof createDatabaseContext>["client"],
  table: string,
  idColumn: string,
  id: string | number,
  patch: Record<string, string | number | null>
) {
  const entries = Object.entries(patch);
  await client.execute({
    sql: `update ${table} set ${entries.map(([column]) => `${column} = ?`).join(", ")} where ${idColumn} = ?`,
    args: [...entries.map(([, value]) => value), id]
  });
}

async function createDemoRepository() {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(resolve(repoPath, "src"), { recursive: true });
  mkdirSync(resolve(repoPath, "tests"), { recursive: true });

  writeRepoFile(
    "package.json",
    JSON.stringify(
      {
        name: "one-team-demo-product",
        private: true,
        type: "module",
        scripts: {
          dev: "vite --host 127.0.0.1",
          build: "vite build",
          test: "vitest run",
          lint: "eslint ."
        },
        dependencies: {
          "@vitejs/plugin-react": "latest",
          vite: "latest",
          vitest: "latest",
          eslint: "latest"
        }
      },
      null,
      2
    )
  );
  writeRepoFile(
    "README.md",
    `# One Team Demo Product

This small repository exists only for the One Team GitHub Pages screenshots.
`
  );
  writeRepoFile(
    "src/issues.ts",
    `export type IssueSummary = {
  id: number;
  title: string;
  commentCount: number;
};

export function issueSummary(issue: IssueSummary): string {
  return \`#\${issue.id} \${issue.title} - \${issue.commentCount} comments\`;
}
`
  );
  writeRepoFile(
    "src/workflow.ts",
    `export function nextWorkflowLabel(hasRequirements: boolean): string {
  return hasRequirements ? "ready-for-implementation" : "requirements";
}
`
  );
  writeRepoFile(
    "tests/issues.test.ts",
    `import { expect, test } from "vitest";
import { issueSummary } from "../src/issues";

test("formats issue summaries", () => {
  expect(issueSummary({ id: 2, title: "Empty state", commentCount: 3 })).toContain("#2");
});
`
  );

  git(["init", "-b", "main"]);
  git(["config", "user.name", "One Team Demo"]);
  git(["config", "user.email", "demo@example.com"]);
  commit("Initial demo project", "2026-05-25T00:00:00.000Z");

  git(["checkout", "-b", "oneteam/issue-2-empty-state"]);
  writeRepoFile(
    "src/issues.ts",
    `export type IssueSummary = {
  id: number;
  title: string;
  commentCount: number;
};

export type EmptyIssueState = {
  title: string;
  description: string;
  primaryAction: string;
};

export function issueSummary(issue: IssueSummary): string {
  return \`#\${issue.id} \${issue.title} - \${issue.commentCount} comments\`;
}

export function emptyIssueState(): EmptyIssueState {
  return {
    title: "Create your first issue",
    description: "Write the work you want done, and One Team can carry it from requirements to a local pull request.",
    primaryAction: "New issue"
  };
}
`
  );
  commit("Add guided empty issue state", "2026-05-25T02:12:00.000Z");

  writeRepoFile(
    "tests/issues-empty-state.test.ts",
    `import { expect, test } from "vitest";
import { emptyIssueState } from "../src/issues";

test("guides users to create their first issue", () => {
  expect(emptyIssueState().primaryAction).toBe("New issue");
  expect(emptyIssueState().description).toContain("One Team");
});
`
  );
  commit("Cover empty issue state copy", "2026-05-25T02:25:00.000Z");
  git(["checkout", "main"]);

  writeFileSync(
    fakeCodexPath,
    `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("fake-codex 1.0.0\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({ ok: true }) + "\\n");
process.exit(0);
`
  );
  chmodSync(fakeCodexPath, 0o755);
}

async function createDemoDatabase() {
  const database = createDatabaseContext(`file:${databasePath}`);
  await runMigrations(database.client);
  const repos = createRepositories(database.db);

  const project = await repos.projects.create({
    name: "One Team Demo",
    repoPath,
    defaultBranch: "main",
    locale: "en"
  });
  await updateRow(database.client, "projects", "id", project.id, {
    created_at: timestamps.project,
    updated_at: timestamps.latest
  });

  await repos.settings.set("ai", {
    codexCommand: defaultCodexCommand,
    model: "gpt-5-codex",
    fullAccess: true
  });

  await repos.commands.upsertMany(project.id, [
    {
      commandType: "build",
      command: "npm run build",
      detectionSource: "package.json scripts",
      detectionDetails: { packageManager: "npm", script: "build" },
      isRequired: true,
      isAvailable: true,
      lastDetectedAt: timestamps.project
    },
    {
      commandType: "dev",
      command: "npm run dev",
      detectionSource: "package.json scripts",
      detectionDetails: { packageManager: "npm", script: "dev" },
      isRequired: true,
      isAvailable: true,
      lastDetectedAt: timestamps.project
    },
    {
      commandType: "install",
      command: "npm install",
      detectionSource: "lockfile",
      detectionDetails: { packageManager: "npm", lockfile: "package-lock.json" },
      isRequired: true,
      isAvailable: true,
      lastDetectedAt: timestamps.project
    },
    {
      commandType: "lint",
      command: "npm run lint",
      detectionSource: "package.json scripts",
      detectionDetails: { packageManager: "npm", script: "lint" },
      isRequired: true,
      isAvailable: true,
      lastDetectedAt: timestamps.project
    },
    {
      commandType: "test",
      command: "npm run test",
      detectionSource: "package.json scripts",
      detectionDetails: { packageManager: "npm", script: "test" },
      isRequired: true,
      isAvailable: true,
      lastDetectedAt: timestamps.project
    }
  ]);

  const labels = await repos.labels.list(project.id);
  const labelByName = new Map(labels.map((label) => [label.name, label]));
  const labelId = (name: string) => {
    const label = labelByName.get(name);
    if (!label) {
      throw new Error(`Missing label: ${name}`);
    }
    return label.id;
  };

  const issueSetup = await repos.issues.create({
    projectId: project.id,
    title: "Guide missing commands during first setup",
    body: `## Background
After importing a repository, I want to see missing build, test, and lint commands immediately.

## Expected behavior
- Detect npm commands from package.json and the lockfile
- Create an issue for every missing required command
- Show Codex CLI settings from the Repository screen`,
    labelIds: [labelId(workflowLabelNames.needsInput)]
  });
  await updateRow(database.client, "issues", "id", issueSetup.id, {
    created_at: timestamps.issueSetup,
    updated_at: timestamps.latest
  });

  const issueEmptyState = await repos.issues.create({
    projectId: project.id,
    title: "Show the next action in the empty issue list",
    body: `## Goal
When there are no issues yet, make the first action obvious.

## Acceptance criteria
- Show short empty-state copy
- Present New issue as the primary action
- Keep the copy ready for i18n replacement`,
    labelIds: [labelId(workflowLabelNames.pullRequestCreated)]
  });
  await updateRow(database.client, "issues", "id", issueEmptyState.id, {
    created_at: timestamps.issueEmptyState,
    updated_at: timestamps.implementationFinished
  });

  const issueReview = await repos.issues.create({
    projectId: project.id,
    title: "Make PR review status easy to scan",
    body: `I want the Pull Request list to show whether work is in review, fixing, or QA.`,
    labelIds: [labelId(workflowLabelNames.implementing)]
  });
  await updateRow(database.client, "issues", "id", issueReview.id, {
    created_at: timestamps.issueReview,
    updated_at: timestamps.issueReview
  });

  const pullRequest = await repos.pullRequests.create({
    projectId: project.id,
    issueId: issueEmptyState.id,
    title: "Add a guided empty state to the issue list",
    body: `Add an empty state that explains the purpose of the screen and the next action when there are no issues.

Review checklist:
- Keep the copy short and helpful for first-time users
- Cover the copy and primary action with tests
- Preserve the existing list layout`,
    sourceBranch: "oneteam/issue-2-empty-state",
    targetBranch: "main",
    labelIds: [labelId(workflowLabelNames.testing)]
  });
  await updateRow(database.client, "pull_requests", "id", pullRequest.id, {
    created_at: timestamps.implementationFinished,
    updated_at: timestamps.qaFinished
  });

  const initialComment = await repos.comments.create({
    projectId: project.id,
    targetType: "issue",
    targetId: issueSetup.id,
    authorType: "user",
    body: "After importing a small Node.js app, I want One Team to find missing project commands automatically."
  });
  await updateRow(database.client, "comments", "id", initialComment.id, {
    created_at: timestamps.commentStart,
    updated_at: timestamps.commentStart
  });

  const requirementsJob = await repos.agentJobs.create({
    projectId: project.id,
    agentType: "requirements",
    targetType: "issue",
    targetId: issueSetup.id,
    triggerType: "label_applied",
    input: { label: workflowLabelNames.needsInput }
  });
  await repos.agentJobs.updateStatus(project.id, requirementsJob.id, "waiting_human", {
    output: {
      message: "I need one decision about missing commands before finalizing the requirements.",
      questions: ["Which commands should be required for the MVP: build, test, lint, or all three?"]
    }
  });
  await updateRow(database.client, "agent_jobs", "id", requirementsJob.id, {
    created_at: timestamps.requirementsQuestion,
    started_at: timestamps.requirementsQuestion,
    finished_at: null
  });

  const agentQuestion = await repos.comments.create({
    projectId: project.id,
    targetType: "issue",
    targetId: issueSetup.id,
    authorType: "agent",
    agentType: "requirements",
    body: `I have one question before I finalize the requirements.

For the MVP, should \`build\`, \`test\`, and \`lint\` all be required and automatically turned into issues when missing?`,
    metadata: { agentJobId: requirementsJob.id }
  });
  await updateRow(database.client, "comments", "id", agentQuestion.id, {
    created_at: timestamps.requirementsQuestion,
    updated_at: timestamps.requirementsQuestion
  });

  const implementationJob = await repos.agentJobs.create({
    projectId: project.id,
    agentType: "implementation",
    targetType: "issue",
    targetId: issueEmptyState.id,
    triggerType: "label_applied",
    input: { branch: "oneteam/issue-2-empty-state" }
  });
  await repos.agentJobs.updateStatus(project.id, implementationJob.id, "running");
  await repos.agentJobs.updateStatus(project.id, implementationJob.id, "succeeded", {
    output: {
      message: "Added empty-state copy, the primary action, and regression tests.",
      changedFiles: ["src/issues.ts", "tests/issues-empty-state.test.ts"],
      testResults: [
        {
          command: "npm run test",
          status: "succeeded",
          exitCode: 0,
          output: "2 test files passed. Empty issue state behavior is covered."
        },
        {
          command: "npm run lint",
          status: "succeeded",
          exitCode: 0,
          output: "No lint errors."
        }
      ]
    }
  });
  await updateRow(database.client, "agent_jobs", "id", implementationJob.id, {
    created_at: timestamps.implementationStarted,
    started_at: timestamps.implementationStarted,
    finished_at: timestamps.implementationFinished
  });

  const implementationComment = await repos.comments.create({
    projectId: project.id,
    targetType: "issue",
    targetId: issueEmptyState.id,
    authorType: "agent",
    agentType: "implementation",
    body: `Implementation is complete.

- Added empty-state display data in \`src/issues.ts\`
- Covered the copy and primary action in \`tests/issues-empty-state.test.ts\`
- Created Pull Request #${pullRequest.id}`,
    metadata: { agentJobId: implementationJob.id }
  });
  await updateRow(database.client, "comments", "id", implementationComment.id, {
    created_at: timestamps.implementationFinished,
    updated_at: timestamps.implementationFinished
  });

  await repos.activities.create({
    projectId: project.id,
    agentJobId: implementationJob.id,
    targetType: "issue",
    targetId: issueEmptyState.id,
    activityType: "progress",
    title: "Implementation branch prepared",
    body: "Created `oneteam/issue-2-empty-state` and checked the diff against main."
  });
  await repos.activities.create({
    projectId: project.id,
    agentJobId: implementationJob.id,
    targetType: "issue",
    targetId: issueEmptyState.id,
    activityType: "file_change",
    title: "Changed files summarized",
    body: "Updated `src/issues.ts` and `tests/issues-empty-state.test.ts`."
  });
  await repos.activities.create({
    projectId: project.id,
    agentJobId: implementationJob.id,
    targetType: "issue",
    targetId: issueEmptyState.id,
    activityType: "test",
    title: "Verification passed",
    body: "`npm run test` and `npm run lint` passed."
  });
  await database.client.execute({
    sql: `update agent_activities set created_at = ? where agent_job_id = ?`,
    args: [timestamps.implementationFinished, implementationJob.id]
  });

  const reviewJob = await repos.agentJobs.create({
    projectId: project.id,
    agentType: "review",
    targetType: "pull_request",
    targetId: pullRequest.id,
    triggerType: "label_applied",
    input: { label: workflowLabelNames.testing }
  });
  await repos.agentJobs.updateStatus(project.id, reviewJob.id, "running");
  await repos.agentJobs.updateStatus(project.id, reviewJob.id, "succeeded", {
    output: {
      message: "Review found no blockers. This can move to QA."
    }
  });
  await updateRow(database.client, "agent_jobs", "id", reviewJob.id, {
    created_at: timestamps.reviewFinished,
    started_at: timestamps.reviewFinished,
    finished_at: timestamps.reviewFinished
  });

  const reviewComment = await repos.comments.create({
    projectId: project.id,
    targetType: "pull_request",
    targetId: pullRequest.id,
    authorType: "agent",
    agentType: "review",
    body: `Review result: no blocking issues.

The existing list layout is preserved, and the empty state stays focused. Ready for QA.`,
    metadata: { agentJobId: reviewJob.id }
  });
  await updateRow(database.client, "comments", "id", reviewComment.id, {
    created_at: timestamps.reviewFinished,
    updated_at: timestamps.reviewFinished
  });

  const qaJob = await repos.agentJobs.create({
    projectId: project.id,
    agentType: "qa",
    targetType: "pull_request",
    targetId: pullRequest.id,
    triggerType: "label_applied",
    input: { viewport: "desktop" }
  });
  await repos.agentJobs.updateStatus(project.id, qaJob.id, "running");
  await repos.agentJobs.updateStatus(project.id, qaJob.id, "succeeded", {
    output: {
      message: "QA verified the empty-state copy, primary action, and existing issue list display.",
      testResults: [
        {
          command: "playwright smoke: issues empty state",
          status: "succeeded",
          exitCode: 0,
          output: "Desktop viewport passed."
        }
      ]
    }
  });
  await updateRow(database.client, "agent_jobs", "id", qaJob.id, {
    created_at: timestamps.qaFinished,
    started_at: timestamps.qaFinished,
    finished_at: timestamps.qaFinished
  });

  const qaComment = await repos.comments.create({
    projectId: project.id,
    targetType: "pull_request",
    targetId: pullRequest.id,
    authorType: "agent",
    agentType: "qa",
    body: `QA complete:

- Empty issue list shows explanatory copy and the New issue action
- Existing issue list rendering is preserved
- \`npm run test\` passed`,
    metadata: { agentJobId: qaJob.id }
  });
  await updateRow(database.client, "comments", "id", qaComment.id, {
    created_at: timestamps.qaFinished,
    updated_at: timestamps.qaFinished
  });

  database.client.close();
}

await createDemoRepository();
await createDemoDatabase();

console.log(`Demo data created at ${root}`);
