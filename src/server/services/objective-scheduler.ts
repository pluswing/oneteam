import type { Repositories } from "../db/repositories";
import { ensureObjectiveForTarget } from "./objective-runs";

export type ObjectiveSchedulerOptions = {
  intervalMs: number;
};

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
}
