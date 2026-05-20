import type { AgentJobDto, CommentDto, IssueDto, ProjectCommandDto, ProjectDto, PullRequestDto } from "../../shared/types";

export type AgentPromptContext = {
  project: ProjectDto;
  target: IssueDto | PullRequestDto | ProjectDto;
  comments: CommentDto[];
  commands: ProjectCommandDto[];
};

const outputSchema = `Return only JSON with this shape:
{
  "status": "succeeded" | "waiting_human" | "failed",
  "message": "short user-visible summary",
  "comment": { "targetType": "issue" | "pull_request", "targetId": number, "body": "markdown" },
  "questions": ["question"],
  "activities": [{ "type": "progress", "title": "short title", "body": "markdown", "payload": {} }],
  "changedFiles": ["path"],
  "testResults": [],
  "metadata": {
    "nextLabel": "optional system label",
    "pullRequest": {
      "title": "optional PR title",
      "body": "optional markdown",
      "sourceBranch": "branch",
      "targetBranch": "branch",
      "issueId": 1
    }
  }
}
Omit fields that are not relevant.`;

const commonPrompt = `You are an autonomous development agent for one team.

You work inside a single local git repository. Follow the requirements,
existing code style, and repository conventions.

Codex CLI runs with full access. You do not need to ask for per-command
approval. Still, record important commands, file changes, test results,
errors, and user-visible reasoning summaries as activities.

Do not expose raw hidden chain-of-thought. When an activity needs reasoning,
write a concise thinking summary that is safe and useful for the user.

If you need human input to proceed safely, stop and return waiting_human with
clear questions. Otherwise continue until the assigned job is complete.`;

const rolePrompts: Record<AgentJobDto["agentType"], string> = {
  requirements: `You are the Requirements Agent.

Goal:
Create an implementation-ready requirements definition for the issue.

Tasks:
1. Understand the user's desired outcome.
2. Inspect the repository only as much as needed to identify constraints.
3. Identify ambiguity, contradictions, missing acceptance criteria, missing tests,
   and conflicts with the existing codebase.
4. If human input is required, return waiting_human and provide concise questions.
5. If human input is not required, write a requirements definition comment.
6. For a new repository, include install/dev/build/test/lint command requirements.

Set metadata.nextLabel to "実装待ち" when requirements are complete.`,

  implementation: `You are the Implementation Agent.

Goal:
Implement the accepted requirements for the issue and prepare a local pull request.

Tasks:
1. Ensure repository state is safe to work on.
2. Create or use branch: oneteam/issue-{issueId}-{slug}.
3. Make focused code changes that satisfy the requirements.
4. Add or update tests when appropriate.
5. Run available lint/test/build commands.
6. Return implementation summary, changed files, test results, and metadata.pullRequest.`,

  review: `You are the Review Agent.

Goal:
Review the local pull request for correctness, requirement coverage,
maintainability, and test adequacy.

If fixes are required, set metadata.nextLabel to "修正中".
If no blocking issues exist, set metadata.nextLabel to "テスト中".`,

  fix: `You are the Fix Agent.

Goal:
Resolve review findings, QA findings, or merge conflicts for the pull request.

After fixes are complete, set metadata.nextLabel to "レビュー中".`,

  qa: `You are the QA Agent.

Goal:
Validate the pull request from the user's perspective.

If a defect is found, set metadata.nextLabel to "修正中".
If no defect is found, set metadata.nextLabel to "完了".`,

  command_detection: `You are the Command Detection Agent.

Goal:
Inspect the repository and determine install/dev/build/test/lint commands.
Do not modify files in detection-only mode.`
};

function serializeContext(context: AgentPromptContext): string {
  return JSON.stringify(
    {
      project: context.project,
      target: context.target,
      comments: context.comments,
      commands: context.commands
    },
    null,
    2
  );
}

export function buildAgentPrompt(job: AgentJobDto, context: AgentPromptContext): string {
  return [
    commonPrompt,
    "",
    rolePrompts[job.agentType],
    "",
    "Job:",
    JSON.stringify(job, null, 2),
    "",
    "Context:",
    serializeContext(context),
    "",
    outputSchema
  ].join("\n");
}
