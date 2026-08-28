import { createHash } from "node:crypto";
import type { IssueDto, ObjectiveRunDto } from "../../shared/types";
import type { Repositories } from "../db/repositories";
import { appendObjectiveEvidence } from "./objective-runs";
import { buildSystemComment } from "./system-comment";

function contractHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function goalContractDiff(previousGoal: string, nextGoal: string): string {
  const before = previousGoal.split("\n");
  const after = nextGoal.split("\n");
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const contextStart = Math.max(0, prefix - 2);
  const beforeEnd = before.length - suffix;
  const afterEnd = after.length - suffix;
  const lines = [
    ...(contextStart > 0 ? ["  ..."] : []),
    ...before.slice(contextStart, prefix).map((line) => `  ${line}`),
    ...before.slice(prefix, beforeEnd).map((line) => `- ${line}`),
    ...after.slice(prefix, afterEnd).map((line) => `+ ${line}`),
    ...after.slice(afterEnd, Math.min(after.length, afterEnd + 2)).map((line) => `  ${line}`),
    ...(afterEnd + 2 < after.length ? ["  ..."] : [])
  ];
  const bounded = lines.slice(0, 240);
  if (bounded.length < lines.length) bounded.push(`  ... ${lines.length - bounded.length} more diff lines omitted`);
  return bounded.join("\n");
}

export async function recordGoalContractChange(
  repos: Repositories,
  input: {
    projectId: string;
    issue: IssueDto;
    objective: ObjectiveRunDto;
    previousGoal: string;
    reason: string;
  }
): Promise<ObjectiveRunDto> {
  const previousHash = contractHash(input.previousGoal);
  const nextHash = contractHash(input.issue.body);
  const diff = goalContractDiff(input.previousGoal, input.issue.body);
  let objective =
    (await repos.objectives.update(input.projectId, input.objective.id, {
      goal: input.issue.body,
      summary: `Goal Contract changed: ${input.reason}`
    })) ?? input.objective;
  objective =
    (await appendObjectiveEvidence(repos, objective, [
      {
        type: "goal_contract_change",
        title: "Goal Contract changed",
        summary: input.reason,
        payload: {
          issueId: input.issue.id,
          previousHash,
          nextHash,
          previousGoal: input.previousGoal,
          nextGoal: input.issue.body,
          diff,
          changedAt: input.issue.updatedAt
        }
      }
    ])) ?? objective;
  const eventKey = `objective:${objective.id}:goal-contract:${nextHash}`;
  const body = buildSystemComment({
    title: "Goal Contract changed",
    outcome: "info",
    summary: "The Issue description changed while this Objective was active. OneTeam updated the Objective goal and preserved the previous contract for audit.",
    fields: [
      { label: "Issue", value: `#${input.issue.id}`, code: true },
      { label: "Objective", value: `#${objective.id}`, code: true },
      { label: "Workflow stage", value: objective.workflowStage, code: true },
      { label: "Previous contract", value: previousHash, code: true },
      { label: "Current contract", value: nextHash, code: true }
    ],
    sections: [
      { title: "Change reason", body: input.reason },
      { title: "Contract diff", body: `\`\`\`diff\n${diff}\n\`\`\`` },
      {
        title: "Workflow impact",
        items: [
          "The current workflow stage and prior evidence remain available.",
          "Subsequent Agents and final verification must evaluate the updated contract.",
          "The previous contract, current contract, hashes, and diff are stored as Objective evidence."
        ]
      }
    ],
    nextStep: "OneTeam will continue the selected Objective. Review or pause it if the changed acceptance criteria require a different implementation approach.",
    recordedBy: "OneTeam workflow"
  });
  const targets: Array<{ targetType: "issue" | "pull_request"; targetId: number }> = [
    { targetType: "issue", targetId: input.issue.id },
    ...(objective.pullRequestId ? [{ targetType: "pull_request" as const, targetId: objective.pullRequestId }] : [])
  ];
  for (const target of targets) {
    const comments = await repos.comments.list(input.projectId, target.targetType, target.targetId);
    if (comments.some((comment) => comment.metadata?.goalContractEventKey === eventKey)) continue;
    await repos.comments.create({
      projectId: input.projectId,
      targetType: target.targetType,
      targetId: target.targetId,
      authorType: "system",
      body,
      metadata: {
        goalContractEventKey: eventKey,
        objectiveRunId: objective.id,
        issueId: input.issue.id,
        pullRequestId: objective.pullRequestId,
        previousHash,
        nextHash,
        reason: input.reason
      }
    });
    await repos.activities.create({
      projectId: input.projectId,
      targetType: target.targetType,
      targetId: target.targetId,
      activityType: "system",
      title: "Goal Contract changed",
      body,
      payload: { goalContractEventKey: eventKey, objectiveRunId: objective.id, previousHash, nextHash }
    });
  }
  await repos.loopMemory.create({
    projectId: input.projectId,
    sourceType: "manual",
    sourceId: input.issue.id,
    title: `Goal Contract changed for Objective #${objective.id}`,
    body: `Reason: ${input.reason}\n\n\`\`\`diff\n${diff}\n\`\`\``,
    tags: ["objective", "goal_contract", "change", `issue:${input.issue.id}`]
  });
  return objective;
}
