import type { AgentJobDto, PullRequestFindingDto } from "../../shared/types";

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function findingsValue(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(recordValue).filter((item): item is Record<string, unknown> => item !== null)
    : [];
}

function severityValue(value: unknown): PullRequestFindingDto["severity"] {
  const severity = stringValue(value)?.toLowerCase();
  return severity && ["critical", "high", "medium", "low", "info"].includes(severity)
    ? (severity as PullRequestFindingDto["severity"])
    : "medium";
}

function lineValue(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isInteger(number) && number > 0 ? number : null;
}

function sideValue(value: unknown): "L" | "R" {
  const side = stringValue(value)?.toLowerCase();
  return side === "left" || side === "old" || side === "deletion" || side === "l" ? "L" : "R";
}

function jobTime(job: AgentJobDto): number {
  return Date.parse(job.finishedAt ?? job.startedAt ?? job.createdAt) || 0;
}

function normalizeFinding(
  job: AgentJobDto,
  source: PullRequestFindingDto["source"],
  value: Record<string, unknown>,
  index: number
): PullRequestFindingDto | null {
  const path = stringValue(value.path) ?? stringValue(value.file);
  const title = stringValue(value.title) ?? stringValue(value.message);
  if (!path || !title) {
    return null;
  }
  return {
    id: `${job.id}:${source}:${index}`,
    agentJobId: job.id,
    source,
    severity: severityValue(value.severity),
    path,
    line: lineValue(value.line ?? value.lineNumber),
    side: sideValue(value.side),
    title,
    body: stringValue(value.body) ?? stringValue(value.description) ?? "",
    status: "open",
    resolvedByJobId: null,
    createdAt: job.finishedAt ?? job.startedAt ?? job.createdAt
  };
}

function resolutionKeys(finding: PullRequestFindingDto): string[] {
  return [finding.id, finding.title, finding.body, `${finding.path}:${finding.line ?? "file"}`]
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function resolvedItems(job: AgentJobDto): string[] {
  const metadata = recordValue(job.output?.metadata);
  const fix = recordValue(metadata?.fix);
  return Array.isArray(fix?.resolvedFindings)
    ? fix.resolvedFindings.map(stringValue).filter((item): item is string => item !== null)
    : [];
}

export function collectPullRequestFindings(jobs: AgentJobDto[]): PullRequestFindingDto[] {
  const orderedJobs = [...jobs].sort((left, right) => jobTime(left) - jobTime(right));
  const findings: PullRequestFindingDto[] = [];

  for (const job of orderedJobs) {
    if (job.status !== "succeeded" || !job.output) {
      continue;
    }
    const metadata = recordValue(job.output.metadata);
    if (job.agentType === "review") {
      const review = recordValue(metadata?.review);
      const verdict = stringValue(review?.verdict);
      if (verdict === "approved") {
        for (const finding of findings) {
          if (finding.source === "review" && finding.status === "open") {
            finding.status = "resolved";
            finding.resolvedByJobId = job.id;
          }
        }
      }
      for (const [index, value] of findingsValue(review?.findings).entries()) {
        const finding = normalizeFinding(job, "review", value, index);
        if (finding) findings.push(finding);
      }
    }

    if (job.agentType === "qa") {
      const qa = recordValue(metadata?.qa);
      const verdict = stringValue(qa?.verdict);
      if (verdict === "passed") {
        for (const finding of findings) {
          if (finding.source === "qa" && finding.status === "open") {
            finding.status = "resolved";
            finding.resolvedByJobId = job.id;
          }
        }
      }
      for (const [index, value] of findingsValue(qa?.defects).entries()) {
        const finding = normalizeFinding(job, "qa", value, index);
        if (finding) findings.push(finding);
      }
    }

    if (job.agentType === "fix") {
      const resolved = new Set(resolvedItems(job).map((item) => item.toLowerCase()));
      if (!resolved.size) {
        continue;
      }
      for (const finding of findings) {
        if (finding.status === "open" && resolutionKeys(finding).some((key) => resolved.has(key))) {
          finding.status = "resolved";
          finding.resolvedByJobId = job.id;
        }
      }
    }
  }

  return findings.sort((left, right) => {
    if (left.status !== right.status) return left.status === "open" ? -1 : 1;
    if (left.path !== right.path) return left.path.localeCompare(right.path);
    return (left.line ?? Number.MAX_SAFE_INTEGER) - (right.line ?? Number.MAX_SAFE_INTEGER);
  });
}
