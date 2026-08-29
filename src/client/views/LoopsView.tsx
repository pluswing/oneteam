import { ArrowLeft, Bot, FilePlus2, Play, Plus, Save } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import type {
  AgentJobDto,
  LoopDto,
  LoopMemoryEntryDto,
  LoopRunDto,
  LoopStepDto,
  ProjectDto,
  SkillFileDto,
  TriageItemDto
} from "../../shared/types";
import { api } from "../api";
import { MarkdownContent } from "../components/MarkdownContent";
import { formatDateTime } from "../formatters";
import { t } from "../i18n";

export type LoopsScreen = { name: "list" } | { name: "detail"; loopId: number } | { name: "run"; loopRunId: number };

function optionalNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const number = Number(trimmed);
  return Number.isFinite(number) ? number : null;
}

function policyList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function LoopCreateForm(props: { project: ProjectDto; onCreated: (loopId: number) => void }) {
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [maxRounds, setMaxRounds] = useState(3);
  const [timeBudgetMinutes, setTimeBudgetMinutes] = useState("30");
  const [maxChangedFiles, setMaxChangedFiles] = useState("20");
  const [maxDiffLines, setMaxDiffLines] = useState("800");
  const [allowedCommands, setAllowedCommands] = useState("");
  const [deniedCommands, setDeniedCommands] = useState("rm -rf\nsudo");
  const [protectedPaths, setProtectedPaths] = useState(".env\nsecrets\n.oneteam/skills");
  const [protectedBranches, setProtectedBranches] = useState("main\nmaster");
  const [humanGateOnRisk, setHumanGateOnRisk] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    try {
      const loop = await api.createLoop(props.project.id, {
        name,
        purpose,
        triggerType: "manual",
        targetScope: "project",
        maxRounds,
        timeBudgetMinutes: optionalNumber(timeBudgetMinutes),
        stopCondition: {
          requiredEvidence: ["tests", "review"],
          stopReasons: ["passed", "failed", "waiting_human", "risk_detected"]
        },
        riskPolicy: {
          maxChangedFiles: optionalNumber(maxChangedFiles),
          maxDiffLines: optionalNumber(maxDiffLines),
          allowedCommands: policyList(allowedCommands),
          deniedCommands: policyList(deniedCommands),
          protectedPaths: policyList(protectedPaths),
          protectedBranches: policyList(protectedBranches),
          humanGateOnRisk
        }
      });
      props.onCreated(loop.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create loop.");
    }
  }

  return (
    <form className="side-panel" onSubmit={handleSubmit}>
      <h2>{t("loops.newLoop")}</h2>
      {error ? <div className="error-banner">{error}</div> : null}
      <label>
        {t("issues.titleField")}
        <input value={name} onChange={(event) => setName(event.target.value)} required />
      </label>
      <label>
        {t("loops.purpose")}
        <textarea value={purpose} onChange={(event) => setPurpose(event.target.value)} rows={4} />
      </label>
      <label>
        {t("loops.maxRounds")}
        <input min={1} value={maxRounds} onChange={(event) => setMaxRounds(Number(event.target.value) || 1)} type="number" />
      </label>
      <label>
        {t("loops.timeBudget")}
        <input min={1} value={timeBudgetMinutes} onChange={(event) => setTimeBudgetMinutes(event.target.value)} type="number" />
      </label>
      <label>
        {t("loops.maxChangedFiles")}
        <input min={0} value={maxChangedFiles} onChange={(event) => setMaxChangedFiles(event.target.value)} type="number" />
      </label>
      <label>
        {t("loops.maxDiffLines")}
        <input min={0} value={maxDiffLines} onChange={(event) => setMaxDiffLines(event.target.value)} type="number" />
      </label>
      <label>
        {t("loops.allowedCommands")}
        <textarea value={allowedCommands} onChange={(event) => setAllowedCommands(event.target.value)} rows={2} />
      </label>
      <label>
        {t("loops.deniedCommands")}
        <textarea value={deniedCommands} onChange={(event) => setDeniedCommands(event.target.value)} rows={2} />
      </label>
      <label>
        {t("loops.protectedPaths")}
        <textarea value={protectedPaths} onChange={(event) => setProtectedPaths(event.target.value)} rows={3} />
      </label>
      <label>
        {t("loops.protectedBranches")}
        <textarea value={protectedBranches} onChange={(event) => setProtectedBranches(event.target.value)} rows={2} />
      </label>
      <label className="inline-field">
        <input checked={humanGateOnRisk} onChange={(event) => setHumanGateOnRisk(event.target.checked)} type="checkbox" />
        {t("loops.humanGateOnRisk")}
      </label>
      <button className="primary-button full-width" type="submit">
        <Plus size={16} />
        {t("actions.create")}
      </button>
    </form>
  );
}

function LoopsListScreen(props: {
  project: ProjectDto;
  onOpenLoop: (loopId: number) => void;
  onOpenRun: (loopRunId: number) => void;
}) {
  const [loops, setLoops] = useState<LoopDto[]>([]);
  const [runs, setRuns] = useState<LoopRunDto[]>([]);
  const [triageItems, setTriageItems] = useState<TriageItemDto[]>([]);
  const [memory, setMemory] = useState<LoopMemoryEntryDto[]>([]);
  const [knowledge, setKnowledge] = useState<SkillFileDto[]>([]);
  const [selectedKnowledgePath, setSelectedKnowledgePath] = useState<string>("");
  const [knowledgeBody, setKnowledgeBody] = useState("");
  const [triageTitle, setTriageTitle] = useState("");
  const [triageBody, setTriageBody] = useState("");
  const [triagePriority, setTriagePriority] = useState("normal");
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const [loopsResponse, runsResponse, triageResponse, memoryResponse, knowledgeResponse] = await Promise.all([
      api.listLoops(props.project.id),
      api.listLoopRuns(props.project.id),
      api.listTriageItems(props.project.id, "open"),
      api.listLoopMemory(props.project.id),
      api.listKnowledgeFiles(props.project.id)
    ]);
    setLoops(loopsResponse);
    setRuns(runsResponse);
    setTriageItems(triageResponse);
    setMemory(memoryResponse);
    setKnowledge(knowledgeResponse);
    if (!selectedKnowledgePath && knowledgeResponse[0]) {
      setSelectedKnowledgePath(knowledgeResponse[0].path);
      setKnowledgeBody(knowledgeResponse[0].body);
    }
  }

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : "Failed to load loops."));
  }, [props.project.id]);

  useEffect(() => {
    const anchor = window.location.hash.slice(1);
    if (!anchor || memory.length === 0) return;
    window.requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView({ block: "center" }));
  }, [memory]);

  async function convertTriageItem(triageItemId: number) {
    await api.convertTriageItemToIssue(props.project.id, triageItemId);
    await load();
  }

  async function ignoreTriageItem(triageItemId: number) {
    await api.updateTriageItem(props.project.id, triageItemId, { status: "ignored" });
    await load();
  }

  async function createTriageItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await api.createTriageItem(props.project.id, {
      sourceType: "manual",
      title: triageTitle,
      body: triageBody,
      priority: triagePriority
    });
    setTriageTitle("");
    setTriageBody("");
    await load();
  }

  function selectKnowledge(path: string) {
    const file = knowledge.find((item) => item.path === path);
    setSelectedKnowledgePath(path);
    setKnowledgeBody(file?.body ?? "");
  }

  async function saveKnowledge() {
    if (!selectedKnowledgePath) {
      return;
    }
    const saved = await api.updateKnowledgeFile(props.project.id, selectedKnowledgePath, knowledgeBody);
    setKnowledge((current) => current.map((item) => (item.path === saved.path ? saved : item)));
  }

  return (
    <div className="page-grid">
      <section className="page-section">
        <div className="section-header">
          <h1>{t("loops.title")}</h1>
        </div>
        {error ? <div className="error-banner">{error}</div> : null}
        <div className="work-item-list">
          {loops.length === 0 ? <div className="empty-state">{t("loops.noLoops")}</div> : null}
          {loops.map((loop) => (
            <button className="work-item-summary" key={loop.id} onClick={() => props.onOpenLoop(loop.id)} type="button">
              <span className="work-item-title">#{loop.id} {loop.name}</span>
              <span className={`status-pill status-${loop.status}`}>{loop.status}</span>
              <span>{loop.triggerType}</span>
              <span>{formatDateTime(loop.updatedAt)}</span>
            </button>
          ))}
        </div>

        <div className="section-divider" />
        <h2>{t("loops.runs")}</h2>
        <div className="work-item-list">
          {runs.length === 0 ? <div className="empty-state">{t("loops.noRuns")}</div> : null}
          {runs.slice(0, 8).map((run) => (
            <button className="work-item-summary" key={run.id} onClick={() => props.onOpenRun(run.id)} type="button">
              <span className="work-item-title">Run #{run.id}</span>
              <span className={`status-pill status-${run.status}`}>{run.status}</span>
              <span>{run.stopReason ?? run.triggerType}</span>
              <span>{formatDateTime(run.createdAt)}</span>
            </button>
          ))}
        </div>

        <div className="section-divider" />
        <h2>{t("loops.triage")}</h2>
        <div className="job-list">
          {triageItems.length === 0 ? <div className="empty-state">{t("loops.noTriage")}</div> : null}
          {triageItems.map((item) => (
            <article className="job-row" key={item.id}>
              <div className="job-row-header">
                <strong>{item.title}</strong>
                <span className="status-pill">{item.priority}</span>
              </div>
              {item.body ? <MarkdownContent content={item.body} /> : null}
              <div className="action-row">
                <button className="secondary-button" onClick={() => convertTriageItem(item.id)} type="button">
                  <FilePlus2 size={16} />
                  {t("loops.convertToIssue")}
                </button>
                <button className="secondary-button" onClick={() => ignoreTriageItem(item.id)} type="button">
                  {t("loops.ignore")}
                </button>
              </div>
            </article>
          ))}
        </div>
        <form className="side-stack section-divider" onSubmit={createTriageItem}>
          <h3>{t("loops.newTriage")}</h3>
          <label>
            {t("issues.titleField")}
            <input value={triageTitle} onChange={(event) => setTriageTitle(event.target.value)} required />
          </label>
          <label>
            {t("issues.description")}
            <textarea value={triageBody} onChange={(event) => setTriageBody(event.target.value)} rows={3} />
          </label>
          <label>
            {t("loops.priority")}
            <select value={triagePriority} onChange={(event) => setTriagePriority(event.target.value)}>
              <option value="low">low</option>
              <option value="normal">normal</option>
              <option value="high">high</option>
            </select>
          </label>
          <button className="secondary-button full-width" type="submit">
            <FilePlus2 size={16} />
            {t("actions.create")}
          </button>
        </form>
      </section>

      <div className="side-stack">
        <LoopCreateForm project={props.project} onCreated={props.onOpenLoop} />
        <section className="side-panel">
          <h2>{t("loops.memory")}</h2>
          <div className="job-list">
            {memory.length === 0 ? <div className="empty-state">{t("loops.noMemory")}</div> : null}
            {memory.slice(0, 6).map((entry) => (
              <article className="job-row" id={`memory-${entry.id}`} key={entry.id}>
                <strong>{entry.title}</strong>
                {entry.body ? <MarkdownContent content={entry.body} /> : null}
                <span className="muted-text">{entry.tags.join(", ") || formatDateTime(entry.createdAt)}</span>
              </article>
            ))}
          </div>
        </section>
        <section className="side-panel">
          <h2>{t("loops.knowledge")}</h2>
          <label>
            {t("loops.source")}
            <select value={selectedKnowledgePath} onChange={(event) => selectKnowledge(event.target.value)}>
              {knowledge.map((file) => (
                <option key={file.path} value={file.path}>{file.path}</option>
              ))}
            </select>
          </label>
          <textarea value={knowledgeBody} onChange={(event) => setKnowledgeBody(event.target.value)} rows={10} />
          <button className="secondary-button full-width" onClick={saveKnowledge} type="button">
            <Save size={16} />
            {t("actions.save")}
          </button>
        </section>
      </div>
    </div>
  );
}

function LoopDetailScreen(props: {
  project: ProjectDto;
  loopId: number;
  onBack: () => void;
  onOpenRun: (loopRunId: number) => void;
  onOpenAgentJob: (jobId: number) => void;
}) {
  const [loop, setLoop] = useState<LoopDto | null>(null);
  const [runs, setRuns] = useState<LoopRunDto[]>([]);
  const [agentType, setAgentType] = useState<AgentJobDto["agentType"]>("requirements");
  const [targetType, setTargetType] = useState<AgentJobDto["targetType"]>("issue");
  const [targetId, setTargetId] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const response = await api.getLoop(props.project.id, props.loopId);
    setLoop(response.loop);
    setRuns(response.runs);
  }

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : "Failed to load loop."));
  }, [props.project.id, props.loopId]);

  async function startRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    try {
      const response = await api.startLoopRun(props.project.id, props.loopId, {
        agentType,
        targetType,
        targetId: Number(targetId),
        triggerType: "manual"
      });
      props.onOpenRun(response.run.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start loop.");
    }
  }

  if (!loop) {
    return <div className="empty-state">{t("status.waiting")}</div>;
  }

  return (
    <div>
      <div className="page-toolbar">
        <button className="secondary-button" onClick={props.onBack} type="button">
          <ArrowLeft size={16} />
          {t("actions.back")}
        </button>
        <h1>{loop.name}</h1>
      </div>
      {error ? <div className="error-banner">{error}</div> : null}
      <div className="detail-layout">
        <section className="page-section">
          <MarkdownContent content={loop.purpose || t("issues.noDescription")} />
          <dl className="definition-list">
            <dt>{t("loops.trigger")}</dt>
            <dd>{loop.triggerType}</dd>
            <dt>{t("loops.targetScope")}</dt>
            <dd>{loop.targetScope}</dd>
            <dt>{t("loops.maxRounds")}</dt>
            <dd>{loop.maxRounds}</dd>
          </dl>
          <div className="section-divider" />
          <h2>{t("loops.runs")}</h2>
          <div className="work-item-list">
            {runs.length === 0 ? <div className="empty-state">{t("loops.noRuns")}</div> : null}
            {runs.map((run) => (
              <button className="work-item-summary" key={run.id} onClick={() => props.onOpenRun(run.id)} type="button">
                <span className="work-item-title">Run #{run.id}</span>
                <span className={`status-pill status-${run.status}`}>{run.status}</span>
                <span>{run.stopReason ?? run.triggerType}</span>
                <span>{formatDateTime(run.createdAt)}</span>
              </button>
            ))}
          </div>
        </section>
        <aside className="side-panel">
          <h2>{t("loops.startRun")}</h2>
          <form onSubmit={startRun}>
            <label>
              {t("loops.agentType")}
              <select value={agentType} onChange={(event) => setAgentType(event.target.value as AgentJobDto["agentType"])}>
                {["requirements", "implementation", "review", "fix", "qa", "verifier", "command_detection"].map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </select>
            </label>
            <label>
              {t("loops.targetType")}
              <select value={targetType} onChange={(event) => setTargetType(event.target.value as AgentJobDto["targetType"])}>
                {["issue", "pull_request", "project"].map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </select>
            </label>
            <label>
              {t("loops.targetId")}
              <input value={targetId} onChange={(event) => setTargetId(event.target.value)} required type="number" />
            </label>
            <button className="primary-button full-width" type="submit">
              <Play size={16} />
              {t("loops.startRun")}
            </button>
          </form>
        </aside>
      </div>
    </div>
  );
}

function LoopRunDetailScreen(props: {
  project: ProjectDto;
  loopRunId: number;
  onBack: () => void;
  onOpenAgentJob: (jobId: number) => void;
}) {
  const [run, setRun] = useState<LoopRunDto | null>(null);
  const [steps, setSteps] = useState<LoopStepDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const response = await api.getLoopRun(props.project.id, props.loopRunId);
    setRun(response.run);
    setSteps(response.steps);
  }

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : "Failed to load loop run."));
    const interval = window.setInterval(() => {
      void load().catch((err) => setError(err instanceof Error ? err.message : "Failed to load loop run."));
    }, 4000);
    return () => window.clearInterval(interval);
  }, [props.project.id, props.loopRunId]);

  if (!run) {
    return <div className="empty-state">{t("status.waiting")}</div>;
  }

  return (
    <div>
      <div className="page-toolbar">
        <button className="secondary-button" onClick={props.onBack} type="button">
          <ArrowLeft size={16} />
          {t("actions.back")}
        </button>
        <h1>Loop run #{run.id}</h1>
      </div>
      {error ? <div className="error-banner">{error}</div> : null}
      <section className="page-section">
        <dl className="definition-list">
          <dt>{t("issues.status")}</dt>
          <dd><span className={`status-pill status-${run.status}`}>{run.status}</span></dd>
          <dt>{t("agents.trigger")}</dt>
          <dd>{run.triggerType}</dd>
          <dt>{t("agents.stopReason")}</dt>
          <dd>{run.stopReason ?? "-"}</dd>
          <dt>{t("repository.workingTree")}</dt>
          <dd>{run.worktreePath ?? "-"}</dd>
        </dl>
        {run.summary ? <MarkdownContent content={run.summary} /> : null}
        <div className="section-divider" />
        <h2>{t("loops.steps")}</h2>
        <div className="job-list">
          {steps.length === 0 ? <div className="empty-state">{t("loops.noSteps")}</div> : null}
          {steps.map((step) => (
            <article className="job-row" key={step.id}>
              <div className="job-row-header">
                <strong>{step.agentType}</strong>
                <span className={`status-pill status-${step.status}`}>{step.status}</span>
              </div>
              <span className="muted-text">{step.targetType} #{step.targetId}</span>
              {step.agentJobId ? (
                <button className="secondary-button" onClick={() => props.onOpenAgentJob(step.agentJobId ?? 0)} type="button">
                  <Bot size={16} />
                  {t("agents.detail")}
                </button>
              ) : null}
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

export function LoopsView(props: {
  project: ProjectDto;
  screen: LoopsScreen;
  onOpenLoop: (loopId: number) => void;
  onOpenRun: (loopRunId: number) => void;
  onOpenAgentJob: (jobId: number) => void;
  onBackToList: () => void;
}) {
  if (props.screen.name === "detail") {
    return (
      <LoopDetailScreen
        loopId={props.screen.loopId}
        onBack={props.onBackToList}
        onOpenAgentJob={props.onOpenAgentJob}
        onOpenRun={props.onOpenRun}
        project={props.project}
      />
    );
  }

  if (props.screen.name === "run") {
    return (
      <LoopRunDetailScreen
        loopRunId={props.screen.loopRunId}
        onBack={props.onBackToList}
        onOpenAgentJob={props.onOpenAgentJob}
        project={props.project}
      />
    );
  }

  return (
    <LoopsListScreen
      onOpenLoop={props.onOpenLoop}
      onOpenRun={props.onOpenRun}
      project={props.project}
    />
  );
}
