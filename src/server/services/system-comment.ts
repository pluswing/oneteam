export type SystemCommentOutcome = "success" | "ready" | "waiting" | "blocked" | "failed" | "info";

export type SystemCommentField = {
  label: string;
  value: string | number;
  code?: boolean;
};

export type SystemCommentSection = {
  title: string;
  body?: string;
  items?: string[];
};

export type SystemCommentInput = {
  title: string;
  outcome: SystemCommentOutcome;
  summary: string;
  fields?: Array<SystemCommentField | null>;
  sections?: Array<SystemCommentSection | null>;
  nextStep?: string;
  recordedAt?: Date;
  recordedBy?: string;
};

const outcomeLabels: Record<SystemCommentOutcome, string> = {
  success: "SUCCESS",
  ready: "READY",
  waiting: "WAITING",
  blocked: "BLOCKED",
  failed: "FAILED",
  info: "INFO"
};

export function markdownCode(value: string | number): string {
  const text = String(value);
  const longestFence = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(longestFence + 1);
  return `${fence}${text}${fence}`;
}

function tableCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\r\n", "<br>").replaceAll("\n", "<br>");
}

export function buildSystemComment(input: SystemCommentInput): string {
  const fields = (input.fields ?? []).filter((field): field is SystemCommentField => field !== null);
  const sections = (input.sections ?? []).filter((section): section is SystemCommentSection => section !== null);
  const lines = [
    `## ${input.title}`,
    "",
    `> **Outcome · ${outcomeLabels[input.outcome]}**`,
    ...input.summary.trim().split("\n").map((line) => `> ${line}`)
  ];

  if (fields.length) {
    lines.push("", "### Record", "", "| Field | Value |", "| --- | --- |");
    for (const field of fields) {
      const value = field.code ? markdownCode(field.value) : tableCell(String(field.value));
      lines.push(`| ${tableCell(field.label)} | ${value} |`);
    }
  }

  for (const section of sections) {
    if (!section.body?.trim() && !section.items?.length) {
      continue;
    }
    lines.push("", `### ${section.title}`, "");
    if (section.body?.trim()) {
      lines.push(section.body.trim());
    }
    for (const item of section.items ?? []) {
      lines.push(`- ${item}`);
    }
  }

  if (input.nextStep?.trim()) {
    lines.push("", "### Next step", "", input.nextStep.trim());
  }

  lines.push(
    "",
    "---",
    "",
    `_Recorded by ${input.recordedBy ?? "OneTeam"} at ${markdownCode((input.recordedAt ?? new Date()).toISOString())}._`
  );
  return lines.join("\n");
}
