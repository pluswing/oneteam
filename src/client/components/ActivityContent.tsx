import { CheckCircle2, Circle, CircleAlert, Clock3, FileCode2 } from "lucide-react";
import { activityStatusTone, parseActivityBody } from "../activity-presentation";
import { formatDisplayValue } from "../formatters";
import { t } from "../i18n";
import { isRecord, numberValue, stringValue } from "../value-parsers";
import { diffFileAnchor } from "../../shared/diff-anchors";
import type { ActivityDto } from "../../shared/types";
import { MarkdownContent } from "./MarkdownContent";

const fieldKeys: Record<string, string> = {
  changedFiles: "agents.changedFiles", changed_files: "agents.changedFiles", changes: "agents.changedFiles",
  testResults: "agents.tests", test_results: "agents.tests", tests: "agents.tests", evidence: "agents.evidence",
  questions: "agents.questions", stopReason: "agents.stopReason", stop_reason: "agents.stopReason",
  message: "activity.message", status: "activity.status", summary: "activity.summary", command: "activity.command",
  output: "agents.output", aggregatedOutput: "agents.output", aggregated_output: "agents.output",
  stdout: "activity.stdout", stderr: "activity.stderr", exitCode: "activity.exitCode", exit_code: "activity.exitCode",
  durationMs: "activity.duration", duration_ms: "activity.duration", cwd: "activity.cwd", path: "activity.path",
  metadata: "activity.details", payload: "activity.details", result: "agents.result", comment: "issues.comments",
  body: "activity.message", title: "issues.titleField", name: "activity.name", type: "activity.type",
  model: "agents.model", selectedModel: "development.selectedModel", resolvedModel: "agents.model", effort: "development.effort",
  reason: "activity.reason", selectionReason: "activity.reason", policyVersion: "activity.policy",
  executionId: "activity.executionId", threadId: "activity.threadId", turnId: "activity.turnId", usage: "activity.usage",
  input_tokens: "activity.inputTokens", output_tokens: "activity.outputTokens", total_tokens: "activity.totalTokens",
  cached_input_tokens: "activity.cachedTokens", reasoning_output_tokens: "activity.reasoningTokens",
  review: "activity.review", qa: "activity.qa", verifier: "activity.verifier", verdict: "activity.verdict",
  findings: "activity.findings", defects: "activity.defects", notes: "activity.notes", checked: "activity.checked",
  stopConditionMet: "activity.goalMet", missingEvidence: "activity.missingEvidence", signal: "activity.signal", timedOut: "activity.timedOut",
  kind: "activity.changeType", changeType: "activity.changeType", source: "repository.source"
};
const statuses = new Set(["status", "verdict"]);
const fileFields = new Set(["changedFiles", "changed_files", "changes"]);
const outputFields = new Set(["output", "stdout", "stderr", "aggregatedOutput", "aggregated_output", "diff", "patch"]);
const visible = (value: unknown) => value !== null && value !== undefined && value !== "" && (!Array.isArray(value) || value.length > 0);

function fieldLabel(key: string): string {
  return fieldKeys[key] ? t(fieldKeys[key]) : key.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ");
}

export function ActivityStatusBadge({ status }: { status: string }) {
  const tone = activityStatusTone(status);
  const Icon = tone === "succeeded" ? CheckCircle2 : tone === "failed" ? CircleAlert : tone === "waiting" || tone === "running" ? Clock3 : Circle;
  return <span className={`status-pill activity-status status-${tone}`} aria-label={`${t("activity.status")}: ${formatDisplayValue(status)}`}>
    <Icon size={13} aria-hidden="true" />{formatDisplayValue(status)}
  </span>;
}

function OutputText({ text }: { text: string }) {
  const output = <pre className="activity-output"><code>{text}</code></pre>;
  return text.length > 600 || text.split("\n").length > 10
    ? <details className="activity-more"><summary>{t("activity.showOutput")}</summary>{output}</details> : output;
}

function Files({ files, pullRequestId }: { files: unknown[]; pullRequestId?: number }) {
  return <ul className="activity-files">{files.map((file, index) => {
    const record = isRecord(file) ? file : null;
    const path = typeof file === "string" ? file : stringValue(record?.path) ?? stringValue(record?.file);
    if (!path) return <li key={index}><DataValue value={file} depth={1} /></li>;
    const kind = typeof record?.kind === "string" ? record.kind : isRecord(record?.kind) ? stringValue(record.kind.type) : stringValue(record?.type);
    return <li key={`${path}-${index}`}><FileCode2 size={16} aria-hidden="true" /><span className="activity-file-path">
      {pullRequestId ? <a href={`/pulls/${pullRequestId}#${diffFileAnchor(path)}`}><code>{path}</code></a> : <code>{path}</code>}
      {kind ? <span className="activity-change-kind">{formatDisplayValue(kind)}</span> : null}
      {record ? <DataFields value={Object.fromEntries(Object.entries(record).filter(([key]) => !["path", "file", "kind", "type"].includes(key)))} depth={1} /> : null}
    </span></li>;
  })}</ul>;
}

function DataValue({ value, field = "", depth = 0 }: { value: unknown; field?: string; depth?: number }) {
  if (value === null || value === undefined) return <span className="muted-text">—</span>;
  if (depth > 8) return <span className="muted-text">{t("activity.nestedLimit")}</span>;
  if (typeof value === "boolean") return <span>{t(value ? "activity.yes" : "activity.no")}</span>;
  if (typeof value === "number") return <span>{["durationMs", "duration_ms"].includes(field) ? `${(value / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${t("agents.secondsShort")}` : value.toLocaleString()}</span>;
  if (typeof value === "string") {
    if (statuses.has(field)) return <ActivityStatusBadge status={value} />;
    if (outputFields.has(field)) return <OutputText text={value} />;
    if (field === "command" || field === "path") return <code className="activity-code">{value}</code>;
    if (["message", "summary", "body"].includes(field)) return <MarkdownContent content={value} />;
    return <span className="activity-text">{formatDisplayValue(value)}</span>;
  }
  if (Array.isArray(value)) return <ul className="activity-data-list">{value.map((item, index) => <li key={index}><DataValue value={item} depth={depth + 1} /></li>)}</ul>;
  if (isRecord(value)) return <DataFields value={value} depth={depth + 1} />;
  return null;
}

function DataFields({ value, depth = 0 }: { value: Record<string, unknown>; depth?: number }) {
  const entries = Object.entries(value).filter(([, item]) => visible(item));
  return entries.length ? <dl className="activity-data-fields">{entries.map(([key, item]) => <div key={key}><dt>{fieldLabel(key)}</dt><dd><DataValue value={item} field={key} depth={depth} /></dd></div>)}</dl> : null;
}

function Records({ records }: { records: unknown[] }) {
  return <ul className="activity-records">{records.map((item, index) => {
    if (!isRecord(item)) return <li key={index}><DataValue value={item} /></li>;
    const titleKey = ["command", "title", "name"].find((key) => typeof item[key] === "string");
    const statusKey = ["status", "verdict"].find((key) => typeof item[key] === "string");
    const title = titleKey ? String(item[titleKey]) : null;
    const status = statusKey ? String(item[statusKey]) : null;
    const fields = Object.fromEntries(Object.entries(item).filter(([key]) => key !== titleKey && key !== statusKey));
    return <li key={index}>{title || status ? <div className="activity-record-heading">{title ? <strong>{title}</strong> : null}{status ? <ActivityStatusBadge status={status} /> : null}</div> : null}<DataFields value={fields} /></li>;
  })}</ul>;
}

function StructuredResult({ value, pullRequestId }: { value: Record<string, unknown> | unknown[]; pullRequestId?: number }) {
  if (Array.isArray(value)) return value.length && value.every((item) => isRecord(item) && typeof item.path === "string")
    ? <Files files={value} pullRequestId={pullRequestId} /> : <Records records={value} />;
  const status = stringValue(value.status);
  const message = stringValue(value.message);
  const rest = Object.entries(value).filter(([key, item]) => (key !== "status" || !status) && (key !== "message" || !message) && visible(item));
  return <div className="activity-structured">
    {status ? <div><ActivityStatusBadge status={status} /></div> : null}
    {message ? <MarkdownContent className="activity-message" content={message} /> : null}
    {rest.map(([key, item]) => key === "metadata" || key === "payload"
      ? <details className="activity-more" key={key}><summary>{fieldLabel(key)}</summary><DataValue value={item} /></details>
      : <section className="activity-result-section" key={key} aria-label={fieldLabel(key)}>
        <h4>{fieldLabel(key)}{Array.isArray(item) ? <span className="activity-count">{item.length}</span> : null}</h4>
        {fileFields.has(key) && Array.isArray(item) ? <Files files={item} pullRequestId={pullRequestId} />
          : Array.isArray(item) && item.some(isRecord) ? <Records records={item} /> : <DataValue value={item} field={key} />}
      </section>)}
  </div>;
}

export function ActivityContent({ activity, pullRequestId }: { activity: Pick<ActivityDto, "body" | "payload" | "activityType">; pullRequestId?: number }) {
  const structured = parseActivityBody(activity.body);
  if (structured) return <StructuredResult value={structured} pullRequestId={pullRequestId} />;
  const payload = activity.payload;
  const command = stringValue(payload?.command) ?? stringValue(payload?.cmd);
  if (command) {
    const status = stringValue(payload?.status);
    const exitCode = numberValue(payload?.exitCode) ?? numberValue(payload?.exit_code);
    const output = stringValue(payload?.aggregatedOutput) ?? stringValue(payload?.aggregated_output) ?? stringValue(payload?.output)
      ?? (activity.body.startsWith(`${command}\n`) ? activity.body.slice(command.length + 1) : activity.body === command ? "" : activity.body);
    return <div className="activity-command"><div className="activity-command-heading"><code>{command}</code>{status ? <ActivityStatusBadge status={status} /> : exitCode !== null ? <ActivityStatusBadge status={exitCode === 0 ? "passed" : "failed"} /> : null}</div>
      <DataFields value={{ exitCode, durationMs: payload?.durationMs ?? payload?.duration_ms, cwd: payload?.cwd }} />
      {output ? <OutputText text={output} /> : null}
    </div>;
  }
  // Some event bodies are prose while their result fields live in the payload.
  const result = payload && (isRecord(payload.result) ? payload.result : payload);
  const hasResult = result && ["message", "status", "changedFiles", "testResults", "evidence", "changes"].some((key) => visible(result[key]));
  if (/^(?:```json\s*)?(?:\{\s*"|\[\s*\{)/i.test(activity.body.trim())) return <div className="activity-content">
    {hasResult ? <StructuredResult value={result} pullRequestId={pullRequestId} /> : <p className="muted-text">{t("activity.unreadable")}</p>}
    <details className="activity-more"><summary>{t("activity.original")}</summary><OutputText text={activity.body} /></details>
  </div>;
  return <div className="activity-content">
    {activity.body && activity.body !== result?.message ? activity.activityType === "command" ? <OutputText text={activity.body} /> : <MarkdownContent content={activity.body} /> : null}
    {hasResult ? <StructuredResult value={result} pullRequestId={pullRequestId} /> : null}
  </div>;
}
