import type { IssueDto, ObjectiveRunDto } from "../../shared/types";
import { workflowLabelNames } from "../../shared/workflow-labels";
import type { Repositories } from "../db/repositories";
import { buildSystemComment } from "./system-comment";

const terminalObjectiveStatuses = new Set(["succeeded", "canceled"]);

export function reopenedIssueWorkflowLabel(objective: ObjectiveRunDto | null): string {
  if (!objective || terminalObjectiveStatuses.has(objective.status) || objective.workflowStage === "merged") {
    return workflowLabelNames.requirements;
  }
  if (objective.workflowStage === "requirements") return workflowLabelNames.requirements;
  if (objective.workflowStage === "implementation") return workflowLabelNames.implementing;
  return workflowLabelNames.pullRequestCreated;
}

export async function recordIssueReopened(
  repos: Repositories,
  input: {
    projectId: string;
    issue: IssueDto;
    previousObjective: ObjectiveRunDto | null;
  }
): Promise<{ objective: ObjectiveRunDto; created: boolean }> {
  const shouldCreate =
    !input.previousObjective ||
    terminalObjectiveStatuses.has(input.previousObjective.status) ||
    input.previousObjective.workflowStage === "merged";
  const objective = shouldCreate
    ? await repos.objectives.createForIssue({
        projectId: input.projectId,
        issueId: input.issue.id,
        title: input.issue.title,
        goal: input.issue.body,
        maxRounds: input.previousObjective?.maxRounds,
        summary: input.previousObjective
          ? `Follow-up Objective created after reopening Issue #${input.issue.id}; previous Objective #${input.previousObjective.id} remains ${input.previousObjective.status}.`
          : `Objective created after reopening Issue #${input.issue.id}.`,
        evidence: {
          items: [
            {
              type: "issue_reopened",
              title: "Issue reopened",
              summary: input.previousObjective
                ? `Continues after Objective #${input.previousObjective.id}.`
                : "No previous Objective was linked.",
              payload: {
                previousObjectiveRunId: input.previousObjective?.id ?? null,
                previousStatus: input.previousObjective?.status ?? null,
                previousWorkflowStage: input.previousObjective?.workflowStage ?? null,
                reopenedAt: input.issue.updatedAt
              }
            }
          ]
        }
      })
    : input.previousObjective!;
  const eventKey = `issue-reopened:${input.issue.id}:${input.issue.updatedAt}:objective:${objective.id}`;
  const body = buildSystemComment({
    title: shouldCreate ? "Follow-up Objective created" : "Existing Objective selected after reopen",
    outcome: "info",
    summary: shouldCreate
      ? "The completed Objective remains immutable. OneTeam created a new requirements-stage Objective for follow-up work."
      : "The Issue was reopened while its Objective was still active. OneTeam kept that Objective and its accumulated evidence.",
    fields: [
      { label: "Issue", value: `#${input.issue.id}`, code: true },
      { label: "Selected Objective", value: `#${objective.id}`, code: true },
      { label: "Workflow stage", value: objective.workflowStage, code: true },
      { label: "Objective status", value: objective.status, code: true },
      input.previousObjective
        ? { label: "Previous Objective", value: `#${input.previousObjective.id}`, code: true }
        : null,
      input.previousObjective
        ? { label: "Previous status", value: input.previousObjective.status, code: true }
        : null
    ],
    sections: [
      {
        title: "Lifecycle decision",
        items: shouldCreate
          ? [
              "The previous Objective, Pull Request relation, and merge evidence were not modified.",
              "The new Objective starts with the current Issue title and body as its Goal Contract source.",
              "System workflow labels were reset to requirements; user-managed labels were preserved."
            ]
          : [
              "No duplicate Objective was created.",
              "The current workflow stage and evidence remain selected for continuation."
            ]
      }
    ],
    nextStep: shouldCreate
      ? "OneTeam will run requirements for the follow-up Objective and continue through the normal delivery workflow."
      : "Resume or inspect the selected Objective using the controls on this Issue.",
    recordedBy: "OneTeam workflow"
  });
  await repos.comments.create({
    projectId: input.projectId,
    targetType: "issue",
    targetId: input.issue.id,
    authorType: "system",
    body,
    metadata: {
      issueLifecycleEventKey: eventKey,
      issueLifecycleEvent: "reopened",
      objectiveRunId: objective.id,
      previousObjectiveRunId: input.previousObjective?.id ?? null,
      createdFollowUpObjective: shouldCreate
    }
  });
  await repos.activities.create({
    projectId: input.projectId,
    targetType: "issue",
    targetId: input.issue.id,
    activityType: "system",
    title: shouldCreate ? "Follow-up Objective created" : "Existing Objective selected after reopen",
    body,
    payload: {
      issueLifecycleEventKey: eventKey,
      objectiveRunId: objective.id,
      previousObjectiveRunId: input.previousObjective?.id ?? null
    }
  });
  await repos.loopMemory.create({
    projectId: input.projectId,
    sourceType: "manual",
    sourceId: input.issue.id,
    title: `Issue #${input.issue.id} reopened with Objective #${objective.id}`,
    body: input.previousObjective
      ? `Previous Objective: #${input.previousObjective.id} (${input.previousObjective.status}).`
      : "No previous Objective was linked.",
    tags: ["issue", "objective", "reopened", shouldCreate ? "follow_up" : "resume"]
  });
  return { objective, created: shouldCreate };
}
