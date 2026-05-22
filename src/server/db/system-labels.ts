import type { LabelKind } from "../../shared/types";
import { workflowLabelNames } from "../../shared/workflow-labels";

export type SystemLabelSeed = {
  name: string;
  color: string;
  kind: LabelKind;
  description: string;
};

export const systemLabels: SystemLabelSeed[] = [
  {
    name: workflowLabelNames.requirements,
    color: "#0969da",
    kind: "system",
    description: "Requirements agent is clarifying the issue."
  },
  {
    name: workflowLabelNames.needsInput,
    color: "#bf8700",
    kind: "system",
    description: "Waiting for a human reply."
  },
  {
    name: workflowLabelNames.readyForImplementation,
    color: "#1a7f37",
    kind: "system",
    description: "Requirements are ready for implementation."
  },
  {
    name: workflowLabelNames.implementing,
    color: "#8250df",
    kind: "system",
    description: "Implementation agent is working."
  },
  {
    name: workflowLabelNames.pullRequestCreated,
    color: "#0969da",
    kind: "system",
    description: "A local pull request has been created."
  },
  {
    name: workflowLabelNames.reviewing,
    color: "#0969da",
    kind: "system",
    description: "Review agent is checking the pull request."
  },
  {
    name: workflowLabelNames.fixing,
    color: "#cf222e",
    kind: "system",
    description: "Fix agent is addressing findings."
  },
  {
    name: workflowLabelNames.resolvingConflicts,
    color: "#cf222e",
    kind: "system",
    description: "Fix agent is resolving merge conflicts."
  },
  {
    name: workflowLabelNames.testing,
    color: "#8250df",
    kind: "system",
    description: "QA agent is validating the pull request."
  },
  {
    name: workflowLabelNames.done,
    color: "#1a7f37",
    kind: "system",
    description: "Work is complete."
  }
];
