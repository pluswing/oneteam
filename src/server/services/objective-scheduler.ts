import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Repositories } from "../db/repositories";
import type { AgentJobDto, TriageItemDto } from "../../shared/types";
import { ensureObjectiveForTarget } from "./objective-runs";

export type ObjectiveSchedulerOptions = {
  intervalMs: number;
  staleObjectiveAfterMs?: number;
  maxTodoFindings?: number;
  now?: () => Date;
};

const execFileAsync = promisify(execFile);
const defaultStaleObjectiveAfterMs = 7 * 24 * 60 * 60 * 1000;

export class ObjectiveScheduler {
  private timer: NodeJS.Timeout | null = null;
  private isTicking = false;

  constructor(
    private readonly repos: Repositories,
    private readonly options: ObjectiveSchedulerOptions
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.intervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    if (this.isTicking) {
      return;
    }
    this.isTicking = true;
    try {
      const projects = await this.repos.projects.list();
      for (const project of projects) {
        await this.ensureOpenIssueObjectives(project.id);
        await this.discoverMissingCommandTriage(project.id);
        await this.discoverStaleObjectives(project.id);
        await this.discoverFailedVerificationAndRegressions(project.id);
        await this.discoverTodoMarkers(project.id, project.repoPath);
      }
    } finally {
      this.isTicking = false;
    }
  }

  private async ensureOpenIssueObjectives(projectId: string): Promise<void> {
    const issues = await this.repos.issues.list({
      projectId,
      status: "open",
      limit: 100,
      offset: 0
    });
    for (const issue of issues.items) {
      await ensureObjectiveForTarget(this.repos, {
        projectId,
        targetType: "issue",
        targetId: issue.id
      });
    }
  }

  private async discoverMissingCommandTriage(projectId: string): Promise<void> {
    const [commands, triageItems] = await Promise.all([
      this.repos.commands.list(projectId),
      this.repos.triage.list(projectId, "open")
    ]);
    const existingKeys = new Set(
      triageItems
        .map((item) => item.metadata?.schedulerKey)
        .filter((value): value is string => typeof value === "string")
    );

    for (const command of commands) {
      if (!command.isRequired || command.isAvailable) {
        continue;
      }
      const schedulerKey = `missing-command:${command.commandType}`;
      if (existingKeys.has(schedulerKey)) {
        continue;
      }
      await this.repos.triage.create({
        projectId,
        sourceType: "scheduler",
        title: `Add ${command.commandType} command`,
        body: [
          `OneTeam could not find an available ${command.commandType} command.`,
          "",
          "Add or fix the command so automated loop verification can run without manual prompting."
        ].join("\n"),
        priority: command.commandType === "test" || command.commandType === "build" ? "high" : "normal",
        metadata: {
          schedulerKey,
          commandType: command.commandType,
          discovery: "missing_command"
        }
      });
      existingKeys.add(schedulerKey);
    }
  }

  private async discoverStaleObjectives(projectId: string): Promise<void> {
    const [objectives, triageItems] = await Promise.all([
      this.repos.objectives.list({ projectId }),
      this.repos.triage.list(projectId)
    ]);
    const existingKeys = schedulerKeys(triageItems);
    const now = (this.options.now?.() ?? new Date()).getTime();
    const staleAfterMs = this.options.staleObjectiveAfterMs ?? defaultStaleObjectiveAfterMs;
    for (const objective of objectives) {
      if (!["open", "running", "waiting_provider", "failed", "ready_to_merge"].includes(objective.status)) continue;
      const staleForMs = now - Date.parse(objective.updatedAt);
      if (!Number.isFinite(staleForMs) || staleForMs < staleAfterMs) continue;
      const schedulerKey = `stale-objective:${objective.id}`;
      if (existingKeys.has(schedulerKey)) continue;
      await this.repos.triage.create({
        projectId,
        sourceType: "scheduler",
        sourceId: objective.id,
        title: `Review stale Objective #${objective.id}`,
        body: [
          `Objective #${objective.id} (${objective.title}) has not changed for ${formatDuration(staleForMs)}.`,
          "",
          `Status: ${objective.status}`,
          `Workflow stage: ${objective.workflowStage}`,
          `Stop reason: ${objective.stopReason ?? "none"}`,
          "",
          "Review whether the Objective should resume, be canceled, or have its acceptance contract updated."
        ].join("\n"),
        priority: objective.status === "ready_to_merge" || objective.status === "failed" ? "high" : "normal",
        metadata: {
          schedulerKey,
          discovery: "stale_objective",
          objectiveRunId: objective.id,
          objectiveStatus: objective.status,
          staleForMs,
          lastUpdatedAt: objective.updatedAt
        }
      });
      existingKeys.add(schedulerKey);
    }
  }

  private async discoverFailedVerificationAndRegressions(projectId: string): Promise<void> {
    const [jobs, triageItems] = await Promise.all([
      this.repos.agentJobs.list({ projectId }),
      this.repos.triage.list(projectId)
    ]);
    const existingKeys = schedulerKeys(triageItems);
    const successfulQualityJobs = jobs.filter((job) =>
      job.status === "succeeded" && ["qa", "verifier"].includes(job.agentType)
    );
    for (const job of jobs.filter((item) => item.status === "failed")) {
      const failures = failedVerificationRecords(job);
      if (failures.length) {
        const schedulerKey = `verification-failure:${job.id}`;
        if (!existingKeys.has(schedulerKey)) {
          await this.repos.triage.create({
            projectId,
            sourceType: "scheduler",
            sourceId: job.id,
            title: `Investigate failed verification in Agent Job #${job.id}`,
            body: verificationFailureBody(job, failures),
            priority: "high",
            metadata: {
              schedulerKey,
              discovery: "verification_failure",
              agentJobId: job.id,
              agentType: job.agentType,
              targetType: job.targetType,
              targetId: job.targetId,
              failures
            }
          });
          existingKeys.add(schedulerKey);
        }
      }

      const priorSuccess = successfulQualityJobs.find((candidate) =>
        candidate.id < job.id &&
        candidate.agentType === job.agentType &&
        candidate.targetType === job.targetType &&
        candidate.targetId === job.targetId
      );
      if (!priorSuccess || !["qa", "verifier"].includes(job.agentType)) continue;
      const schedulerKey = `regression:${priorSuccess.id}:${job.id}`;
      if (existingKeys.has(schedulerKey)) continue;
      await this.repos.triage.create({
        projectId,
        sourceType: "scheduler",
        sourceId: job.id,
        title: `Possible regression after ${job.agentType} Job #${priorSuccess.id}`,
        body: [
          `A previously successful ${job.agentType} check for ${job.targetType} #${job.targetId} is now failing.`,
          "",
          `Previous successful job: #${priorSuccess.id}`,
          `Current failed job: #${job.id}`,
          `Failure: ${job.error ?? stringValue(job.output?.message) ?? "No failure message was recorded."}`,
          "",
          "Compare the two evidence snapshots and decide whether to create a regression-fix Issue."
        ].join("\n"),
        priority: "high",
        metadata: {
          schedulerKey,
          discovery: "regression",
          previousAgentJobId: priorSuccess.id,
          failedAgentJobId: job.id,
          targetType: job.targetType,
          targetId: job.targetId
        }
      });
      existingKeys.add(schedulerKey);
    }
  }

  private async discoverTodoMarkers(projectId: string, repoPath: string): Promise<void> {
    const findings = await trackedTodoFindings(repoPath, this.options.maxTodoFindings ?? 50);
    if (!findings.length) return;
    const triageItems = await this.repos.triage.list(projectId);
    const fingerprint = createHash("sha256").update(findings.join("\n")).digest("hex").slice(0, 16);
    const schedulerKey = `todo-fixme:${fingerprint}`;
    if (schedulerKeys(triageItems).has(schedulerKey)) return;
    await this.repos.triage.create({
      projectId,
      sourceType: "scheduler",
      title: `Review ${findings.length} tracked TODO / FIXME marker(s)`,
      body: [
        "OneTeam found actionable TODO / FIXME markers in tracked source files.",
        "",
        ...findings.slice(0, 25).map((finding) => `- \`${finding}\``),
        ...(findings.length > 25 ? [`- …and ${findings.length - 25} more`] : []),
        "",
        "Convert relevant findings to Issues and ignore markers that are intentionally long-lived."
      ].join("\n"),
      priority: "normal",
      metadata: {
        schedulerKey,
        discovery: "todo_fixme",
        fingerprint,
        findingCount: findings.length,
        findings: findings.slice(0, 50)
      }
    });
  }
}

function schedulerKeys(items: TriageItemDto[]): Set<string> {
  return new Set(
    items.map((item) => item.metadata?.schedulerKey).filter((value): value is string => typeof value === "string")
  );
}

function failedVerificationRecords(job: AgentJobDto): Array<Record<string, unknown>> {
  const records = Array.isArray(job.output?.testResults) ? job.output.testResults : [];
  const commandFailures = records
    .filter((record): record is Record<string, unknown> => typeof record === "object" && record !== null)
    .filter((record) => {
      const status = stringValue(record.status)?.toLowerCase();
      return status === "failed" || status === "error" ||
        (typeof record.exitCode === "number" && record.exitCode !== 0);
    });
  const evidence = Array.isArray(job.output?.evidence) ? job.output.evidence : [];
  const ciFailures = evidence
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .filter((item) => item.type === "ci_status")
    .map((item) => ({ item, payload: recordValue(item.payload) }))
    .filter(({ payload }) => {
      const status = stringValue(payload?.status)?.toLowerCase() ?? stringValue(payload?.conclusion)?.toLowerCase();
      return ["failed", "failure", "error", "timed_out", "cancelled"].includes(status ?? "");
    })
    .map(({ item, payload }) => ({
      command: `CI: ${stringValue(payload?.name) ?? stringValue(item.title) ?? "status check"}`,
      status: stringValue(payload?.status) ?? stringValue(payload?.conclusion) ?? "failed",
      exitCode: null,
      evidenceType: "ci_status"
    }));
  return [...commandFailures, ...ciFailures].slice(0, 20);
}

function verificationFailureBody(job: AgentJobDto, failures: Array<Record<string, unknown>>): string {
  return [
    `Agent Job #${job.id} recorded ${failures.length} failed verification command(s).`,
    "",
    ...failures.map((failure) => {
      const command = stringValue(failure.command) ?? "unknown command";
      const exitCode = typeof failure.exitCode === "number" ? failure.exitCode : "unknown";
      return `- \`${command}\` — exit ${exitCode}`;
    }),
    "",
    `Agent summary: ${stringValue(job.output?.message) ?? job.error ?? "No summary was recorded."}`,
    "",
    "Inspect the preserved command Evidence before retrying or converting this finding to an Issue."
  ].join("\n");
}

async function trackedTodoFindings(repoPath: string, maxFindings: number): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", [
      "grep", "-n", "-I", "-w", "-E", "TODO|FIXME", "--", ".",
      ":(exclude)docs/**", ":(exclude)**/*.md", ":(exclude)**/*.lock", ":(exclude)dist/**",
      ":(exclude)node_modules/**", ":(exclude).oneteam/**"
    ], { cwd: repoPath, maxBuffer: 2_000_000 });
    return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, maxFindings);
  } catch (error) {
    const result = error as { code?: number | string; stdout?: string };
    if (result.code === 1) {
      return (result.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, maxFindings);
    }
    return [];
  }
}

function formatDuration(durationMs: number): string {
  const hours = Math.max(1, Math.floor(durationMs / (60 * 60 * 1000)));
  return hours >= 48 ? `${Math.floor(hours / 24)} days` : `${hours} hours`;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
