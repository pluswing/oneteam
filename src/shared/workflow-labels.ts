export const workflowLabelNames = {
  requirements: "requirements",
  needsInput: "needs-input",
  readyForImplementation: "ready-for-implementation",
  implementing: "implementing",
  pullRequestCreated: "pull-request-created",
  reviewing: "reviewing",
  fixing: "fixing",
  resolvingConflicts: "resolving-conflicts",
  testing: "testing",
  done: "done"
} as const;

export type WorkflowLabelName = (typeof workflowLabelNames)[keyof typeof workflowLabelNames];

export const issueWorkflowLabelNames = [
  workflowLabelNames.requirements,
  workflowLabelNames.needsInput,
  workflowLabelNames.readyForImplementation,
  workflowLabelNames.implementing,
  workflowLabelNames.pullRequestCreated,
  workflowLabelNames.done
] as const;

export const pullRequestWorkflowLabelNames = [
  workflowLabelNames.reviewing,
  workflowLabelNames.fixing,
  workflowLabelNames.resolvingConflicts,
  workflowLabelNames.testing,
  workflowLabelNames.needsInput,
  workflowLabelNames.done
] as const;
