import { diffFileAnchor, diffLineAnchor } from "../../shared/diff-anchors";
import { repositoryCommitPath } from "../../shared/repository-anchors";
import type { AgentJobDto } from "../../shared/types";
import type { AgentRunResult } from "../agents/types";
import { buildSystemComment, markdownCode, type SystemCommentOutcome, type SystemCommentSection } from "./system-comment";

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(recordValue).filter((item): item is Record<string, unknown> => item !== null)
    : [];
}

function outcomeForResult(result: AgentRunResult): SystemCommentOutcome {
  if (result.status === "waiting_human") return "waiting";
  if (result.status === "failed") return "failed";
  if (result.status === "canceled") return "info";
  const review = recordValue(result.metadata?.review);
  const qa = recordValue(result.metadata?.qa);
  const verifier = recordValue(result.metadata?.verifier);
  if (
    review?.verdict === "changes_requested" ||
    qa?.verdict === "defects_found" ||
    verifier?.verdict === "failed" ||
    verifier?.verdict === "missing_evidence"
  ) {
    return "blocked";
  }
  if (verifier?.stopConditionMet === true || verifier?.verdict === "passed") return "ready";
  return "success";
}

function titleForJob(job: AgentJobDto, result: AgentRunResult): string {
  const role = job.agentType.replaceAll("_", " ");
  if (result.status === "waiting_human") return `${role} needs input`;
  if (result.status === "failed") return `${role} failed`;
  if (result.status === "canceled") return `${role} canceled`;
  return `${role} completed`;
}

function markdownLinkLabel(value: string): string {
  return value.replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function commitReference(hash: string): string {
  const path = repositoryCommitPath(hash);
  return path ? `[${markdownCode(hash)}](${path})` : markdownCode(hash);
}

function fileReference(job: AgentJobDto, path: string, line: number | null, side: "L" | "R"): string {
  const label = line ? `${path}:${line}` : path;
  if (job.targetType !== "pull_request") return markdownCode(label);
  const anchor = line ? diffLineAnchor(path, side, line) : diffFileAnchor(path);
  return `[${markdownLinkLabel(label)}](/pulls/${job.targetId}#${anchor})`;
}

function normalizedLine(value: unknown): number | null {
  const line = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isInteger(line) && line > 0 ? line : null;
}

function normalizedSide(value: unknown): "L" | "R" {
  const side = stringValue(value)?.toLowerCase();
  return ["l", "left", "old", "deletion"].includes(side ?? "") ? "L" : "R";
}

function findingItems(job: AgentJobDto, values: Record<string, unknown>[], label: string): string[] {
  return values.map((finding, index) => {
    const path = stringValue(finding.path) ?? stringValue(finding.file);
    const title = stringValue(finding.title) ?? stringValue(finding.message) ?? `${label} ${index + 1}`;
    const body = stringValue(finding.body) ?? stringValue(finding.description);
    const severity = stringValue(finding.severity) ?? "medium";
    const line = normalizedLine(finding.line ?? finding.lineNumber);
    const location = path ? fileReference(job, path, line, normalizedSide(finding.side)) : "location not reported";
    return `[${severity.toUpperCase()}] **${title}** — ${location}${body ? ` — ${body}` : ""}`;
  });
}

function structuredSections(job: AgentJobDto, result: AgentRunResult): SystemCommentSection[] {
  const sections: SystemCommentSection[] = [];
  const report = result.comment?.body?.trim();
  if (report) sections.push({ title: "Agent summary", body: report });

  if (result.changedFiles?.length) {
    sections.push({
      title: "Changed files",
      items: result.changedFiles.map((path) => fileReference(job, path, null, "R"))
    });
  }

  if (result.evidence?.length) {
    sections.push({
      title: "Evidence",
      items: result.evidence.map(
        (evidence) => `[${evidence.type.toUpperCase()}] **${evidence.title}**${evidence.summary ? ` — ${evidence.summary}` : ""}`
      )
    });
  }

  const review = recordValue(result.metadata?.review);
  const reviewFindings = recordArray(review?.findings);
  if (review) {
    sections.push({
      title: "Review decision",
      items: [
        `Verdict: ${markdownCode(stringValue(review.verdict) ?? "not reported")}.`,
        ...findingItems(job, reviewFindings, "Review finding"),
        ...(Array.isArray(review.checked)
          ? review.checked.map(stringValue).filter((item): item is string => item !== null).map((item) => `Checked: ${item}`)
          : [])
      ]
    });
  }

  const qa = recordValue(result.metadata?.qa);
  if (qa) {
    sections.push({
      title: "QA decision",
      items: [
        `Verdict: ${markdownCode(stringValue(qa.verdict) ?? "not reported")}.`,
        ...findingItems(job, recordArray(qa.defects), "QA defect"),
        ...(Array.isArray(qa.observations)
          ? qa.observations.map(stringValue).filter((item): item is string => item !== null)
          : [])
      ]
    });
  }

  const verifier = recordValue(result.metadata?.verifier);
  if (verifier) {
    const missingEvidence = Array.isArray(verifier.missingEvidence)
      ? verifier.missingEvidence.map(stringValue).filter((item): item is string => item !== null)
      : [];
    sections.push({
      title: "Verifier decision",
      items: [
        `Verdict: ${markdownCode(stringValue(verifier.verdict) ?? "not reported")}.`,
        `Stop condition met: ${verifier.stopConditionMet === true ? "yes" : "no"}.`,
        ...missingEvidence.map((item) => `Missing evidence: ${item}`),
        ...(Array.isArray(verifier.notes)
          ? verifier.notes.map(stringValue).filter((item): item is string => item !== null)
          : [])
      ]
    });
  }

  if (result.questions?.length) {
    sections.push({ title: "Questions", items: result.questions });
  }
  return sections;
}

function nextStep(job: AgentJobDto, result: AgentRunResult): string {
  if (result.status === "waiting_human") return "Answer the questions above. OneTeam will preserve this job and resume it after the response is recorded.";
  if (result.status === "failed") return "Inspect the failure and Evidence, correct the underlying condition, then retry this Agent Job.";
  if (result.status === "canceled") return "No automatic continuation is scheduled for this canceled Agent Job.";
  const nextLabel = stringValue(result.metadata?.nextLabel);
  if (nextLabel) return `OneTeam will continue the workflow using the ${markdownCode(nextLabel)} state.`;
  return `The ${job.agentType} result is recorded. OneTeam will evaluate the Objective and workflow policy for the next action.`;
}

export function buildAgentMilestoneComment(job: AgentJobDto, result: AgentRunResult, recordedAt = new Date()): string {
  const providerExecution = recordValue(result.metadata?.providerExecution);
  const implementationCommit = stringValue(result.metadata?.implementationCommit);
  return buildSystemComment({
    title: titleForJob(job, result),
    outcome: outcomeForResult(result),
    summary: result.message,
    fields: [
      { label: "Agent job", value: `#${job.id}`, code: true },
      { label: "Agent role", value: job.agentType, code: true },
      { label: "Provider", value: job.aiProvider, code: true },
      stringValue(providerExecution?.model) ? { label: "Model", value: stringValue(providerExecution?.model)!, code: true } : null,
      stringValue(providerExecution?.sessionId)
        ? { label: "Session", value: stringValue(providerExecution?.sessionId)!, code: true }
        : null,
      implementationCommit ? { label: "Commit", value: commitReference(implementationCommit) } : null,
      { label: "Status", value: result.status, code: true },
      { label: "Stop reason", value: result.stopReason ?? "not reported", code: true }
    ],
    sections: structuredSections(job, result),
    nextStep: nextStep(job, result),
    recordedAt,
    recordedBy: `${job.agentType} Agent via OneTeam`
  });
}
