import type { LabelKind } from "../../shared/types";

export type SystemLabelSeed = {
  name: string;
  color: string;
  kind: LabelKind;
  description: string;
};

export const systemLabels: SystemLabelSeed[] = [
  {
    name: "要件定義中",
    color: "#0969da",
    kind: "system",
    description: "Requirements agent is clarifying the issue."
  },
  {
    name: "確認待ち",
    color: "#bf8700",
    kind: "system",
    description: "Waiting for a human reply."
  },
  {
    name: "実装待ち",
    color: "#1a7f37",
    kind: "system",
    description: "Requirements are ready for implementation."
  },
  {
    name: "実装中",
    color: "#8250df",
    kind: "system",
    description: "Implementation agent is working."
  },
  {
    name: "PR作成済み",
    color: "#0969da",
    kind: "system",
    description: "A local pull request has been created."
  },
  {
    name: "レビュー中",
    color: "#0969da",
    kind: "system",
    description: "Review agent is checking the pull request."
  },
  {
    name: "修正中",
    color: "#cf222e",
    kind: "system",
    description: "Fix agent is addressing findings."
  },
  {
    name: "コンフリクト修正中",
    color: "#cf222e",
    kind: "system",
    description: "Fix agent is resolving merge conflicts."
  },
  {
    name: "テスト中",
    color: "#8250df",
    kind: "system",
    description: "QA agent is validating the pull request."
  },
  {
    name: "完了",
    color: "#1a7f37",
    kind: "system",
    description: "Work is complete."
  }
];
