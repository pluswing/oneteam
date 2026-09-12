import { useEffect, useState } from "react";
import type { DevelopmentLoopDto } from "../../shared/development-loop";
import { api } from "../api";
import { t } from "../i18n";
import { MarkdownContent } from "./MarkdownContent";

type LoopDetail = Awaited<ReturnType<typeof api.getDevelopmentLoop>>;
const stages = ["planning", "implementing", "reviewing", "validating", "merging", "reflecting", "completed"];

function LoopCard({ loop, refresh }: { loop: DevelopmentLoopDto; refresh: () => Promise<void> }) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<LoopDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    if (expanded) void api.getDevelopmentLoop(loop.projectId, loop.id).then((value) => { if (!disposed) setDetail(value); }).catch((err: Error) => { if (!disposed) setError(err.message); });
    return () => { disposed = true; };
  }, [expanded, loop.id, loop.projectId, loop.updatedAt]);
  async function control(action: "pause" | "resume" | "cancel") {
    setBusy(true); setError(null);
    try { await api.controlDevelopmentLoop(loop.projectId, loop.id, action); await refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }
  async function restore(revisionId: number) {
    setBusy(true); setError(null);
    try { await api.restoreKnowledgeRevision(loop.projectId, revisionId); setDetail(await api.getDevelopmentLoop(loop.projectId, loop.id)); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }
  const terminal = ["succeeded", "canceled"].includes(loop.status);
  const mergeBusy = loop.phase === "merging" && loop.status === "running";
  const needsResume = ["paused", "failed", "waiting_input"].includes(loop.status);
  const stage = stages.indexOf(loop.phase === "fixing" ? "reviewing" : loop.phase);
  return <article className="development-loop-card">
    <header><strong>Loop #{loop.id} · <a href={`/issues/${loop.issueId}`}>Issue #{loop.issueId}</a></strong><span className={`status-pill status-${loop.status}`}>{t(`development.${loop.status}`)}</span></header>
    <ol className="development-stages" aria-label={t("development.progress")}>
      {stages.map((name, index) => <li key={name} aria-current={index === stage ? "step" : undefined} className={index <= stage ? "reached" : ""}>{t(`development.${index === stage && loop.phase === "fixing" ? "fixing" : name}`)}</li>)}
    </ol>
    {loop.summary ? <p className="loop-summary">{loop.summary}</p> : null}
    <div className="loop-links">
      {loop.pullRequestId ? <a href={`/pulls/${loop.pullRequestId}`}>PR #{loop.pullRequestId}</a> : null}
      {loop.currentJobId ? <a href={`/jobs/${loop.currentJobId}`}>{t("development.agentLog")} #{loop.currentJobId}</a> : null}
      {loop.mergeCommit ? <code title={loop.mergeCommit}>{loop.mergeCommit.slice(0, 10)}</code> : null}
    </div>
    {!terminal ? <div className="action-row">
      <button className="secondary-button" type="button" disabled={busy || mergeBusy} onClick={() => void control(needsResume ? "resume" : "pause")}>{t(`development.${needsResume ? "resume" : "pause"}`)}</button>
      <button className="danger-button" type="button" disabled={busy || mergeBusy} onClick={() => void control("cancel")}>{t("development.cancel")}</button>
    </div> : null}
    {error ? <p role="alert">{error}</p> : null}
    <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>{t("development.retrospectiveAndHistory")}</summary>
      {detail ? <>
        <ol className="loop-job-history">{detail.jobs.map((job) => <li key={job.id}><a href={`/jobs/${job.id}`}>#{job.id} {job.agentType}</a> · {job.aiModel ?? t("development.autoModel")} · {job.status}</li>)}</ol>
        {detail.retrospective ? <>
          <h3>{detail.retrospective.summary}</h3>
          <MarkdownContent content={detail.retrospective.body} />
          {detail.retrospective.error ? <p role="alert">{detail.retrospective.error}</p> : null}
          {detail.revisions.map((revision) => <details key={revision.id} className="knowledge-revision">
            <summary>{revision.path} · {revision.status}</summary><p>{revision.reason}</p>
            <h4>{t("development.before")}</h4><pre>{revision.beforeBody ?? "—"}</pre>
            <h4>{t("development.after")}</h4><pre>{revision.afterBody ?? "—"}</pre>
            {["applied", "restoring"].includes(revision.status) && !revision.path.startsWith("retrospectives/") ? <button className="secondary-button" disabled={busy} type="button" onClick={() => void restore(revision.id)}>{t("development.restore")}</button> : null}
          </details>)}
        </> : <p className="muted-text">{t("development.awaitRetrospective")}</p>}
      </> : <p>{t("status.loading")}</p>}
    </details>
  </article>;
}

export function DevelopmentLoopPanel(props: { projectId: string; issueId?: number; pullRequestId?: number; all?: boolean }) {
  const [loops, setLoops] = useState<DevelopmentLoopDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  async function load() {
    try { setLoops(await api.listDevelopmentLoops(props.projectId)); setError(null); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }
  useEffect(() => {
    let disposed = false;
    async function poll() {
      try { const items = await api.listDevelopmentLoops(props.projectId); if (!disposed) { setLoops(items); setError(null); } }
      catch (err) { if (!disposed) setError(err instanceof Error ? err.message : String(err)); }
    }
    void poll(); const timer = window.setInterval(() => void poll(), 3000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [props.projectId]);
  const visible = loops.filter((loop) => props.all || (props.issueId !== undefined && loop.issueId === props.issueId) || (props.pullRequestId !== undefined && loop.pullRequestId === props.pullRequestId));
  return <section className="development-loops" aria-label="Development Loops">
    <h2>{t("development.title")}</h2>
    {error ? <p role="alert">{error}</p> : null}
    {!visible.length ? <p className="muted-text">{t("development.empty")}</p> : null}
    {visible.map((loop) => <LoopCard key={loop.id} loop={loop} refresh={load} />)}
  </section>;
}
