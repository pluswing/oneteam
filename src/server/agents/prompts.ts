import type {
  AgentJobDto,
  CommentDto,
  IssueDto,
  ProjectCommandDto,
  ProjectDto,
  PullRequestDto,
  SkillFileDto
} from "../../shared/types";
import { workflowLabelNames } from "../../shared/workflow-labels";

export type AgentPromptContext = {
  project: ProjectDto;
  target: IssueDto | PullRequestDto | ProjectDto;
  comments: CommentDto[];
  commands: ProjectCommandDto[];
  knowledge: SkillFileDto[];
};

const outputSchema = `Return only JSON with this shape:
{
  "status": "succeeded" | "waiting_human" | "failed",
  "message": "short user-visible summary",
  "comment": { "targetType": "issue" | "pull_request", "targetId": number, "body": "markdown" } | null,
  "questions": ["question"] | null,
  "activities": [{ "type": "progress", "title": "short title", "body": "markdown", "payload": {} }],
  "changedFiles": ["path"] | null,
  "testResults": [] | null,
  "stopReason": "passed" | "failed" | "waiting_human" | "timeout" | "max_rounds_exceeded" | "budget_exceeded" | "risk_detected" | "rollback_required" | "canceled" | null,
  "evidence": [{ "type": "test", "title": "short title", "summary": "what this proves", "payload": {} }] | null,
  "metadata": {
    "nextLabel": "optional system label" | null,
    "pullRequest": {
      "title": "optional PR title",
      "body": "optional markdown" | null,
      "sourceBranch": "branch",
      "targetBranch": "branch",
      "issueId": 1 | null
    } | null,
    "review": { "verdict": "approved | changes_requested", "findings": [], "checked": [] } | null,
    "fix": { "resolvedFindings": [], "conflictVerification": {} } | null,
    "qa": { "verdict": "passed | defects_found", "defects": [], "observations": [] } | null,
    "verifier": { "verdict": "passed | missing_evidence | failed", "stopConditionMet": true, "missingEvidence": [], "notes": [] } | null
  } | null
}
Use null or empty arrays for fields that are not relevant.`;

const commonPrompt = `You are an autonomous development agent for OneTeam.

You work inside a single local git repository. Follow the requirements,
existing code style, and repository conventions.

Use the tools available in the selected AI provider to inspect files, edit code,
and run commands when the job requires it. Record important commands, file
changes, test results, errors, and user-visible reasoning summaries as
activities.

Do not expose raw hidden chain-of-thought. When an activity needs reasoning,
write a concise thinking summary that is safe and useful for the user.

If you need human input to proceed safely, stop and return waiting_human with
clear questions. Otherwise continue until the assigned job is complete.

Treat each job as one step in a local AI development loop. Return explicit
stopReason and evidence so the user can verify why the job stopped.`;

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
7. Infer loop scope, risk policy, evidence, and stop conditions from the issue
   and repository. Ask the user only when those choices change the acceptance
   criteria, safety boundary, or implementation feasibility.

The requirements definition must include a Goal Contract, Stop Condition,
Evidence Required, and Human Handoff Conditions.

Do not ask the user to configure Loops directly. Treat loop settings as internal
workflow policy derived from the issue and the repository.

Set metadata.nextLabel to "${workflowLabelNames.readyForImplementation}" when requirements are complete.`,

  implementation: `You are the Implementation Agent.

Goal:
Implement the accepted requirements for the issue and prepare a local pull request.

Tasks:
1. Ensure repository state is safe to work on.
2. Use the prepared branch if already checked out; otherwise create or use branch: oneteam/issue-{issueId}-{slug}.
3. Make focused code changes that satisfy the requirements.
4. Add or update tests when appropriate.
5. Run available lint/test/build commands.
6. Return implementation summary, changed files, test results, evidence, stopReason, and metadata.pullRequest.`,

  review: `You are the Review Agent.

Goal:
Review the local pull request for correctness, requirement coverage,
maintainability, and test adequacy.

If fixes are required, set metadata.nextLabel to "${workflowLabelNames.fixing}".
If no blocking issues exist, set metadata.nextLabel to "${workflowLabelNames.testing}".
Verify the Goal Contract, Evidence Required, and Stop Condition when available.
Return metadata.review with verdict, findings, and checked items.
Each finding should include severity, path, line, title, and body when available.`,

  fix: `You are the Fix Agent.

Goal:
Resolve review findings, QA findings, or merge conflicts for the pull request.

After fixes are complete, set metadata.nextLabel to "${workflowLabelNames.reviewing}".
Return metadata.fix with resolvedFindings and conflictVerification when relevant.`,

  qa: `You are the QA Agent.

Goal:
Validate the pull request from the user's perspective.

If a defect is found, set metadata.nextLabel to "${workflowLabelNames.fixing}".
If no defect is found, set metadata.nextLabel to "${workflowLabelNames.done}".
Return metadata.qa with verdict, defects, observations, evidence, and stopReason.`,

  verifier: `You are the Verifier Agent.

Goal:
Decide whether the loop's Stop Condition is satisfied by the collected Evidence.

Tasks:
1. Inspect the target, comments, agent job context, and available command results.
2. Compare the work against the Goal Contract, Stop Condition, and Evidence Required.
3. If the Stop Condition is met, return succeeded with stopReason "passed".
4. If required evidence is missing or ambiguous, return waiting_human with stopReason "waiting_human" and concise questions.
5. If evidence proves the result failed, return failed with stopReason "failed".
6. Return metadata.verifier with verdict, stopConditionMet, missingEvidence, and notes.
7. For a pull request whose Stop Condition is met, set metadata.nextLabel to "${workflowLabelNames.readyToMerge}".

Do not modify files. Focus on whether the loop can stop safely.`,

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
      commands: context.commands,
      knowledge: context.knowledge.map((item) => ({
        path: `.oneteam/${item.path}`,
        title: item.title,
        body: item.body
      }))
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
