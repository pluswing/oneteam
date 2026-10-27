import { ChevronDown, ChevronUp, FilePenLine, History, Lightbulb, MessageSquareText, Terminal, TestTube2, TriangleAlert, Workflow } from "lucide-react";
import { useId, useMemo, useState } from "react";
import type { ActivityDto } from "../../shared/types";
import { newestActivities } from "../activity-presentation";
import { formatDateTime } from "../formatters";
import { getLocale, t } from "../i18n";
import { ActivityContent } from "./ActivityContent";

const icons = { command: Terminal, file_change: FilePenLine, test: TestTube2, thinking: Lightbulb, error: TriangleAlert, progress: MessageSquareText, system: Workflow };
const knownTitles: Record<string, string> = {
  "Codex command completed": "activity.commandCompleted", "Codex command started": "activity.commandStarted",
  "Codex file change completed": "activity.filesUpdated", "Codex file change started": "activity.filesUpdating",
  "Codex thinking summary": "activity.thinking", "Codex progress": "activity.progress",
  "Model selected": "activity.modelSelected", "Codex thread started": "activity.threadStarted", "Codex thread resumed": "activity.threadResumed",
  "Codex turn completed": "activity.turnCompleted", "Agent job failed": "activity.jobFailed", "Agent job completed": "activity.jobCompleted"
};

export function AgentActivityLog({ activities, pullRequestId }: { activities: ActivityDto[]; pullRequestId?: number }) {
  const [showHistory, setShowHistory] = useState(false);
  const historyId = useId();
  const ordered = useMemo(() => newestActivities(activities), [activities]);
  const render = (activity: ActivityDto, latest: boolean) => {
    const Icon = icons[activity.activityType] ?? Workflow;
    return <article className={`activity-item activity-card${latest ? " activity-latest" : ""}`} key={activity.id} data-activity-id={activity.id}>
      <header className="activity-card-header"><span className={`activity-type-icon activity-type-${activity.activityType}`}><Icon aria-hidden="true" size={18} /></span>
        <div className="activity-card-heading"><div><strong>{getLocale() === "ja" && knownTitles[activity.title] ? t(knownTitles[activity.title]) : activity.title}</strong>
          {activity.occurrenceCount > 1 ? <span className="activity-occurrence-count" title={t("activity.occurrences")}>×{activity.occurrenceCount}</span> : null}
          {latest ? <span className="activity-latest-label">{t("activity.latest")}</span> : null}</div>
          <time dateTime={activity.lastOccurredAt}>{formatDateTime(activity.lastOccurredAt)}</time>
        </div>
      </header>
      <ActivityContent activity={activity} pullRequestId={pullRequestId} />
    </article>;
  };
  return <section className="agent-activities" aria-labelledby="job-activities">
    <div className="activity-section-heading"><div><h2 id="job-activities">{t("agents.activities")}</h2><p>{t("activity.latestHint")}</p></div>
      {ordered.length > 1 ? <button className="secondary-button activity-history-toggle" type="button" aria-expanded={showHistory} aria-controls={historyId} onClick={() => setShowHistory((value) => !value)}>
        <History size={15} aria-hidden="true" />{t(showHistory ? "activity.hideHistory" : "activity.showHistory")}<span className="activity-count">{ordered.length - 1}</span>{showHistory ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button> : null}
    </div>
    <div className="activity-list">{ordered[0] ? render(ordered[0], true) : <div className="empty-state">{t("activity.empty")}</div>}</div>
    <div id={historyId} hidden={!showHistory} className="activity-history">{showHistory ? <><h3>{t("activity.previous")}</h3><div className="activity-list">{ordered.slice(1).map((activity) => render(activity, false))}</div></> : null}</div>
  </section>;
}
