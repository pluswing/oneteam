import { randomUUID } from "node:crypto";
import { and, count, desc, eq, inArray, isNotNull, isNull, like, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { AiProvider } from "../../shared/ai-providers";
import { normalizeAiSettings } from "../../shared/ai-providers";
import type {
  ActivityDto,
  AgentJobDto,
  AgentJobStatus,
  AgentType,
  CommentBodyFormat,
  CommandType,
  CommentDto,
  IssueDto,
  IssueStatus,
  LabelDto,
  LoopDto,
  LoopMemoryEntryDto,
  LoopRunDto,
  LoopRunStatus,
  LoopStepDto,
  LoopStepStatus,
  LoopStatus,
  ObjectiveRunDto,
  ObjectiveRunStatus,
  ProjectCommandDto,
  ProjectDto,
  PullRequestDto,
  PullRequestStatus,
  TriageItemDto,
  TriageItemStatus
} from "../../shared/types";
import { systemLabels } from "./system-labels";
import {
  agentActivities,
  agentJobs,
  appSettings,
  comments,
  issueLabels,
  issues,
  labels,
  loopMemoryEntries,
  loopRuns,
  loopSteps,
  loops,
  objectiveRuns,
  projectCommands,
  projects,
  pullRequestLabels,
  pullRequests,
  triageItems
} from "./schema";
import type { Database } from "./client";
import { parseJsonObject, stringifyJson } from "./json";

type ProjectRow = typeof projects.$inferSelect;
type LabelRow = typeof labels.$inferSelect;
type ProjectCommandRow = typeof projectCommands.$inferSelect;
type IssueRow = typeof issues.$inferSelect;
type PullRequestRow = typeof pullRequests.$inferSelect;
type CommentRow = typeof comments.$inferSelect;
type ActivityRow = typeof agentActivities.$inferSelect;
type AgentJobRow = typeof agentJobs.$inferSelect;
type LoopRow = typeof loops.$inferSelect;
type LoopRunRow = typeof loopRuns.$inferSelect;
type LoopStepRow = typeof loopSteps.$inferSelect;
type LoopMemoryEntryRow = typeof loopMemoryEntries.$inferSelect;
type ObjectiveRunRow = typeof objectiveRuns.$inferSelect;
type TriageItemRow = typeof triageItems.$inferSelect;

function now(): string {
  return new Date().toISOString();
}

function mapProject(row: ProjectRow): ProjectDto {
  return {
    id: row.id,
    name: row.name,
    repoPath: row.repoPath,
    defaultBranch: row.defaultBranch,
    locale: row.locale,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function mapLabel(row: LabelRow): LabelDto {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    kind: row.kind,
    description: row.description,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function mapCommand(row: ProjectCommandRow): ProjectCommandDto {
  return {
    id: row.id,
    commandType: row.commandType,
    command: row.command,
    detectionSource: row.detectionSource,
    detectionDetails: parseJsonObject(row.detectionDetailsJson),
    isRequired: row.isRequired,
    isAvailable: row.isAvailable,
    lastDetectedAt: row.lastDetectedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function mapComment(row: CommentRow): CommentDto {
  return {
    id: row.id,
    targetType: row.targetType,
    targetId: row.targetId,
    authorType: row.authorType,
    agentType: row.agentType ?? null,
    body: row.body,
    bodyFormat: row.bodyFormat ?? "markdown",
    metadata: parseJsonObject(row.metadataJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function mapActivity(row: ActivityRow): ActivityDto {
  return {
    id: row.id,
    agentJobId: row.agentJobId,
    targetType: row.targetType,
    targetId: row.targetId,
    activityType: row.activityType,
    title: row.title,
    body: row.body,
    payload: parseJsonObject(row.payloadJson),
    createdAt: row.createdAt
  };
}

function mapAgentJob(row: AgentJobRow): AgentJobDto {
  return {
    id: row.id,
    projectId: row.projectId,
    aiProvider: row.aiProvider,
    agentType: row.agentType,
    targetType: row.targetType,
    targetId: row.targetId,
    status: row.status,
    triggerType: row.triggerType,
    parentJobId: row.parentJobId,
    input: parseJsonObject(row.inputJson) ?? {},
    output: parseJsonObject(row.outputJson),
    error: row.error,
    attempt: row.attempt,
    lockKey: row.lockKey,
    waitReason: row.waitReason,
    waitMetadata: parseJsonObject(row.waitMetadataJson),
    nextRetryAt: row.nextRetryAt,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt
  };
}

function parseStringArray(value: string | null): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function stringifyStringArray(value: string[] | null | undefined): string {
  return JSON.stringify(value ?? []);
}

function mapLoop(row: LoopRow): LoopDto {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    purpose: row.purpose,
    triggerType: row.triggerType,
    cadence: row.cadence,
    targetScope: row.targetScope,
    status: row.status,
    maxRounds: row.maxRounds,
    timeBudgetMinutes: row.timeBudgetMinutes,
    costBudget: row.costBudget,
    stopCondition: parseJsonObject(row.stopConditionJson),
    riskPolicy: parseJsonObject(row.riskPolicyJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function mapLoopRun(row: LoopRunRow): LoopRunDto {
  return {
    id: row.id,
    projectId: row.projectId,
    loopId: row.loopId,
    status: row.status,
    triggerType: row.triggerType,
    targetType: row.targetType ?? null,
    targetId: row.targetId,
    worktreePath: row.worktreePath,
    summary: row.summary,
    stopReason: row.stopReason,
    evidence: parseJsonObject(row.evidenceJson),
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt
  };
}

function mapLoopStep(row: LoopStepRow): LoopStepDto {
  return {
    id: row.id,
    projectId: row.projectId,
    loopRunId: row.loopRunId,
    agentJobId: row.agentJobId,
    agentType: row.agentType,
    targetType: row.targetType,
    targetId: row.targetId,
    status: row.status,
    input: parseJsonObject(row.inputJson),
    output: parseJsonObject(row.outputJson),
    evidence: parseJsonObject(row.evidenceJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function mapLoopMemoryEntry(row: LoopMemoryEntryRow): LoopMemoryEntryDto {
  return {
    id: row.id,
    projectId: row.projectId,
    loopId: row.loopId,
    loopRunId: row.loopRunId,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    title: row.title,
    body: row.body,
    tags: parseStringArray(row.tagsJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function mapObjectiveRun(row: ObjectiveRunRow): ObjectiveRunDto {
  return {
    id: row.id,
    projectId: row.projectId,
    issueId: row.issueId,
    pullRequestId: row.pullRequestId,
    status: row.status,
    workflowStage: row.workflowStage,
    title: row.title,
    goal: row.goal,
    roundCount: row.roundCount,
    maxRounds: row.maxRounds,
    lastAgentJobId: row.lastAgentJobId,
    judgeAgentJobId: row.judgeAgentJobId,
    generatorAiProvider: row.generatorAiProvider,
    judgeAiProvider: row.judgeAiProvider,
    lastFailureSignature: row.lastFailureSignature,
    repeatedFailureCount: row.repeatedFailureCount,
    stopReason: row.stopReason,
    evidence: parseJsonObject(row.evidenceJson),
    summary: row.summary,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finishedAt: row.finishedAt
  };
}

function mapTriageItem(row: TriageItemRow): TriageItemDto {
  return {
    id: row.id,
    projectId: row.projectId,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    title: row.title,
    body: row.body,
    status: row.status,
    priority: row.priority,
    metadata: parseJsonObject(row.metadataJson),
    issueId: row.issueId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

async function getIssueLabels(db: Database, issueIds: number[]): Promise<Map<number, LabelDto[]>> {
  const result = new Map<number, LabelDto[]>();
  if (issueIds.length === 0) {
    return result;
  }

  const rows = await db
    .select({
      issueId: issueLabels.issueId,
      label: labels
    })
    .from(issueLabels)
    .innerJoin(labels, eq(issueLabels.labelId, labels.id))
    .where(and(inArray(issueLabels.issueId, issueIds), isNull(labels.deletedAt)));

  for (const row of rows) {
    const current = result.get(row.issueId) ?? [];
    current.push(mapLabel(row.label));
    result.set(row.issueId, current);
  }

  return result;
}

async function getIssueCommentCounts(db: Database, issueIds: number[]): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  if (issueIds.length === 0) {
    return result;
  }

  const rows = await db
    .select({
      targetId: comments.targetId,
      value: count()
    })
    .from(comments)
    .where(and(eq(comments.targetType, "issue"), inArray(comments.targetId, issueIds)))
    .groupBy(comments.targetId);

  for (const row of rows) {
    result.set(row.targetId, row.value);
  }

  return result;
}

function mapIssue(row: IssueRow, labelMap: Map<number, LabelDto[]>, commentCounts: Map<number, number>): IssueDto {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    status: row.status,
    labels: labelMap.get(row.id) ?? [],
    commentCount: commentCounts.get(row.id) ?? 0,
    lastAgentStatus: null,
    lastAgentStopReason: null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    closedAt: row.closedAt
  };
}

async function getPullRequestLabels(db: Database, pullRequestIds: number[]): Promise<Map<number, LabelDto[]>> {
  const result = new Map<number, LabelDto[]>();
  if (pullRequestIds.length === 0) {
    return result;
  }

  const rows = await db
    .select({
      pullRequestId: pullRequestLabels.pullRequestId,
      label: labels
    })
    .from(pullRequestLabels)
    .innerJoin(labels, eq(pullRequestLabels.labelId, labels.id))
    .where(and(inArray(pullRequestLabels.pullRequestId, pullRequestIds), isNull(labels.deletedAt)));

  for (const row of rows) {
    const current = result.get(row.pullRequestId) ?? [];
    current.push(mapLabel(row.label));
    result.set(row.pullRequestId, current);
  }

  return result;
}

async function getPullRequestCommentCounts(db: Database, pullRequestIds: number[]): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  if (pullRequestIds.length === 0) {
    return result;
  }

  const rows = await db
    .select({
      targetId: comments.targetId,
      value: count()
    })
    .from(comments)
    .where(and(eq(comments.targetType, "pull_request"), inArray(comments.targetId, pullRequestIds)))
    .groupBy(comments.targetId);

  for (const row of rows) {
    result.set(row.targetId, row.value);
  }

  return result;
}

function mapPullRequest(
  row: PullRequestRow,
  labelMap: Map<number, LabelDto[]>,
  commentCounts: Map<number, number>,
  stats?: { changedFileCount?: number; commitCount?: number }
): PullRequestDto {
  return {
    id: row.id,
    issueId: row.issueId,
    title: row.title,
    body: row.body,
    status: row.status,
    sourceBranch: row.sourceBranch,
    targetBranch: row.targetBranch,
    labels: labelMap.get(row.id) ?? [],
    commentCount: commentCounts.get(row.id) ?? 0,
    changedFileCount: stats?.changedFileCount ?? 0,
    commitCount: stats?.commitCount ?? 0,
    lastAgentStatus: null,
    lastAgentStopReason: null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    closedAt: row.closedAt
  };
}

export function createRepositories(db: Database) {
  async function activeAiProvider(): Promise<AiProvider> {
    const rows = await db.select().from(appSettings).where(eq(appSettings.key, "ai")).limit(1);
    return normalizeAiSettings(rows[0] ? parseJsonObject(rows[0].valueJson) : null).provider;
  }

  return {
    projects: {
      async list(): Promise<ProjectDto[]> {
        const rows = await db.select().from(projects).orderBy(desc(projects.updatedAt));
        return rows.map(mapProject);
      },

      async get(projectId: string): Promise<ProjectDto | null> {
        const rows = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
        return rows[0] ? mapProject(rows[0]) : null;
      },

      async create(input: {
        name: string;
        repoPath: string;
        defaultBranch?: string;
        locale?: string;
      }): Promise<ProjectDto> {
        const timestamp = now();
        const id = `project_${randomUUID()}`;

        const rows = await db
          .insert(projects)
          .values({
            id,
            name: input.name,
            repoPath: input.repoPath,
            defaultBranch: input.defaultBranch ?? "main",
            locale: input.locale ?? "en",
            createdAt: timestamp,
            updatedAt: timestamp
          })
          .returning();

        await this.seedLabels(id);
        return mapProject(rows[0]);
      },

      async update(projectId: string, input: Partial<Pick<ProjectDto, "name" | "defaultBranch" | "locale">>) {
        const rows = await db
          .update(projects)
          .set({
            ...input,
            updatedAt: now()
          })
          .where(eq(projects.id, projectId))
          .returning();
        return rows[0] ? mapProject(rows[0]) : null;
      },

      async seedLabels(projectId: string): Promise<void> {
        const timestamp = now();
        for (const label of systemLabels) {
          await db
            .insert(labels)
            .values({
              projectId,
              name: label.name,
              color: label.color,
              kind: label.kind,
              description: label.description,
              createdAt: timestamp,
              updatedAt: timestamp
            })
            .onConflictDoNothing();
        }
      }
    },

    labels: {
      async list(projectId: string): Promise<LabelDto[]> {
        const rows = await db
          .select()
          .from(labels)
          .where(and(eq(labels.projectId, projectId), isNull(labels.deletedAt)))
          .orderBy(labels.name);
        return rows.map(mapLabel);
      },

      async findByName(projectId: string, name: string): Promise<LabelDto | null> {
        const rows = await db
          .select()
          .from(labels)
          .where(and(eq(labels.projectId, projectId), eq(labels.name, name), isNull(labels.deletedAt)))
          .limit(1);
        return rows[0] ? mapLabel(rows[0]) : null;
      }
    },

    settings: {
      async get(key: string): Promise<Record<string, unknown> | null> {
        const rows = await db.select().from(appSettings).where(eq(appSettings.key, key)).limit(1);
        return rows[0] ? parseJsonObject(rows[0].valueJson) : null;
      },

      async set(key: string, value: Record<string, unknown>): Promise<Record<string, unknown>> {
        const timestamp = now();
        await db
          .insert(appSettings)
          .values({
            key,
            valueJson: JSON.stringify(value),
            createdAt: timestamp,
            updatedAt: timestamp
          })
          .onConflictDoUpdate({
            target: appSettings.key,
            set: {
              valueJson: JSON.stringify(value),
              updatedAt: timestamp
            }
          });
        return value;
      }
    },

    commands: {
      async list(projectId: string): Promise<ProjectCommandDto[]> {
        const rows = await db
          .select()
          .from(projectCommands)
          .where(eq(projectCommands.projectId, projectId))
          .orderBy(projectCommands.commandType);
        return rows.map(mapCommand);
      },

      async upsertMany(
        projectId: string,
        commandsInput: Array<{
          commandType: CommandType;
          command: string | null;
          detectionSource: string;
          detectionDetails?: Record<string, unknown>;
          isRequired: boolean;
          isAvailable: boolean;
          lastDetectedAt?: string;
        }>
      ): Promise<ProjectCommandDto[]> {
        const timestamp = now();
        for (const command of commandsInput) {
          await db
            .insert(projectCommands)
            .values({
              projectId,
              commandType: command.commandType,
              command: command.command,
              detectionSource: command.detectionSource,
              detectionDetailsJson: stringifyJson(command.detectionDetails),
              isRequired: command.isRequired,
              isAvailable: command.isAvailable,
              lastDetectedAt: command.lastDetectedAt ?? timestamp,
              createdAt: timestamp,
              updatedAt: timestamp
            })
            .onConflictDoUpdate({
              target: [projectCommands.projectId, projectCommands.commandType],
              set: {
                command: command.command,
                detectionSource: command.detectionSource,
                detectionDetailsJson: stringifyJson(command.detectionDetails),
                isRequired: command.isRequired,
                isAvailable: command.isAvailable,
                lastDetectedAt: command.lastDetectedAt ?? timestamp,
                updatedAt: timestamp
              }
            });
        }

        return this.list(projectId);
      }
    },

    issues: {
      async list(input: {
        projectId: string;
        status?: IssueStatus;
        q?: string;
        limit: number;
        offset: number;
      }): Promise<{ items: IssueDto[]; total: number }> {
        const filters: SQL[] = [eq(issues.projectId, input.projectId), isNull(issues.deletedAt)];
        if (input.status) {
          filters.push(eq(issues.status, input.status));
        }
        if (input.q) {
          filters.push(like(issues.title, `%${input.q}%`));
        }

        const where = and(...filters);
        const rows = await db
          .select()
          .from(issues)
          .where(where)
          .orderBy(desc(issues.updatedAt))
          .limit(input.limit)
          .offset(input.offset);

        const totalRows = await db.select({ value: count() }).from(issues).where(where);
        const ids = rows.map((row) => row.id);
        const labelMap = await getIssueLabels(db, ids);
        const commentCounts = await getIssueCommentCounts(db, ids);

        return {
          items: rows.map((row) => mapIssue(row, labelMap, commentCounts)),
          total: totalRows[0]?.value ?? 0
        };
      },

      async get(projectId: string, issueId: number): Promise<IssueDto | null> {
        const rows = await db
          .select()
          .from(issues)
          .where(and(eq(issues.projectId, projectId), eq(issues.id, issueId), isNull(issues.deletedAt)))
          .limit(1);

        if (!rows[0]) {
          return null;
        }

        const labelMap = await getIssueLabels(db, [issueId]);
        const commentCounts = await getIssueCommentCounts(db, [issueId]);
        return mapIssue(rows[0], labelMap, commentCounts);
      },

      async create(input: {
        projectId: string;
        title: string;
        body?: string;
        labelIds?: number[];
      }): Promise<IssueDto> {
        const timestamp = now();
        const rows = await db
          .insert(issues)
          .values({
            projectId: input.projectId,
            title: input.title,
            body: input.body ?? "",
            status: "open",
            createdAt: timestamp,
            updatedAt: timestamp
          })
          .returning();

        const issue = rows[0];
        if (input.labelIds?.length) {
          await db.insert(issueLabels).values(
            input.labelIds.map((labelId) => ({
              issueId: issue.id,
              labelId,
              createdAt: timestamp
            }))
          );
        }

        const labelMap = await getIssueLabels(db, [issue.id]);
        const commentCounts = await getIssueCommentCounts(db, [issue.id]);
        return mapIssue(issue, labelMap, commentCounts);
      },

      async update(
        projectId: string,
        issueId: number,
        input: Partial<Pick<IssueDto, "title" | "body" | "status">> & { labelIds?: number[] }
      ): Promise<IssueDto | null> {
        const timestamp = now();
        const rows = await db
          .update(issues)
          .set({
            title: input.title,
            body: input.body,
            status: input.status,
            closedAt: input.status === "closed" ? timestamp : input.status === "open" ? null : undefined,
            updatedAt: timestamp
          })
          .where(and(eq(issues.projectId, projectId), eq(issues.id, issueId), isNull(issues.deletedAt)))
          .returning();

        if (!rows[0]) {
          return null;
        }

        if (input.labelIds) {
          await db.delete(issueLabels).where(eq(issueLabels.issueId, issueId));
          if (input.labelIds.length > 0) {
            await db.insert(issueLabels).values(
              input.labelIds.map((labelId) => ({
                issueId,
                labelId,
                createdAt: timestamp
              }))
            );
          }
        }

        return this.get(projectId, issueId);
      },

      async softDelete(projectId: string, issueId: number): Promise<boolean> {
        const rows = await db
          .update(issues)
          .set({ deletedAt: now(), updatedAt: now() })
          .where(and(eq(issues.projectId, projectId), eq(issues.id, issueId), isNull(issues.deletedAt)))
          .returning({ id: issues.id });
        return rows.length > 0;
      }
    },

    pullRequests: {
      async list(input: {
        projectId: string;
        status?: PullRequestStatus;
        issueId?: number;
        limit: number;
        offset: number;
      }): Promise<{ items: PullRequestDto[]; total: number }> {
        const filters: SQL[] = [eq(pullRequests.projectId, input.projectId), isNull(pullRequests.deletedAt)];
        if (input.status) {
          filters.push(eq(pullRequests.status, input.status));
        }
        if (typeof input.issueId === "number") {
          filters.push(eq(pullRequests.issueId, input.issueId));
        }

        const where = and(...filters);
        const rows = await db
          .select()
          .from(pullRequests)
          .where(where)
          .orderBy(desc(pullRequests.updatedAt))
          .limit(input.limit)
          .offset(input.offset);

        const totalRows = await db.select({ value: count() }).from(pullRequests).where(where);
        const ids = rows.map((row) => row.id);
        const labelMap = await getPullRequestLabels(db, ids);
        const commentCounts = await getPullRequestCommentCounts(db, ids);

        return {
          items: rows.map((row) => mapPullRequest(row, labelMap, commentCounts)),
          total: totalRows[0]?.value ?? 0
        };
      },

      async get(projectId: string, pullRequestId: number): Promise<PullRequestDto | null> {
        const rows = await db
          .select()
          .from(pullRequests)
          .where(
            and(eq(pullRequests.projectId, projectId), eq(pullRequests.id, pullRequestId), isNull(pullRequests.deletedAt))
          )
          .limit(1);

        if (!rows[0]) {
          return null;
        }

        const labelMap = await getPullRequestLabels(db, [pullRequestId]);
        const commentCounts = await getPullRequestCommentCounts(db, [pullRequestId]);
        return mapPullRequest(rows[0], labelMap, commentCounts);
      },

      async create(input: {
        projectId: string;
        issueId?: number | null;
        title: string;
        body?: string;
        sourceBranch: string;
        targetBranch: string;
        labelIds?: number[];
      }): Promise<PullRequestDto> {
        const timestamp = now();
        const rows = await db
          .insert(pullRequests)
          .values({
            projectId: input.projectId,
            issueId: input.issueId,
            title: input.title,
            body: input.body ?? "",
            status: "open",
            sourceBranch: input.sourceBranch,
            targetBranch: input.targetBranch,
            createdAt: timestamp,
            updatedAt: timestamp
          })
          .returning();

        const pullRequest = rows[0];
        if (input.labelIds?.length) {
          await db.insert(pullRequestLabels).values(
            input.labelIds.map((labelId) => ({
              pullRequestId: pullRequest.id,
              labelId,
              createdAt: timestamp
            }))
          );
        }

        const labelMap = await getPullRequestLabels(db, [pullRequest.id]);
        const commentCounts = await getPullRequestCommentCounts(db, [pullRequest.id]);
        return mapPullRequest(pullRequest, labelMap, commentCounts);
      },

      async update(
        projectId: string,
        pullRequestId: number,
        input: Partial<
          Pick<PullRequestDto, "title" | "body" | "status" | "sourceBranch" | "targetBranch">
        > & { labelIds?: number[]; issueId?: number | null }
      ): Promise<PullRequestDto | null> {
        const timestamp = now();
        const rows = await db
          .update(pullRequests)
          .set({
            issueId: input.issueId,
            title: input.title,
            body: input.body,
            status: input.status,
            sourceBranch: input.sourceBranch,
            targetBranch: input.targetBranch,
            closedAt: input.status && input.status !== "open" ? timestamp : input.status === "open" ? null : undefined,
            updatedAt: timestamp
          })
          .where(
            and(eq(pullRequests.projectId, projectId), eq(pullRequests.id, pullRequestId), isNull(pullRequests.deletedAt))
          )
          .returning();

        if (!rows[0]) {
          return null;
        }

        if (input.labelIds) {
          await db.delete(pullRequestLabels).where(eq(pullRequestLabels.pullRequestId, pullRequestId));
          if (input.labelIds.length > 0) {
            await db.insert(pullRequestLabels).values(
              input.labelIds.map((labelId) => ({
                pullRequestId,
                labelId,
                createdAt: timestamp
              }))
            );
          }
        }

        return this.get(projectId, pullRequestId);
      },

      async softDelete(projectId: string, pullRequestId: number): Promise<boolean> {
        const rows = await db
          .update(pullRequests)
          .set({ deletedAt: now(), updatedAt: now() })
          .where(
            and(eq(pullRequests.projectId, projectId), eq(pullRequests.id, pullRequestId), isNull(pullRequests.deletedAt))
          )
          .returning({ id: pullRequests.id });
        return rows.length > 0;
      }
    },

    comments: {
      async list(projectId: string, targetType: "issue" | "pull_request", targetId: number): Promise<CommentDto[]> {
        const rows = await db
          .select()
          .from(comments)
          .where(and(eq(comments.projectId, projectId), eq(comments.targetType, targetType), eq(comments.targetId, targetId)))
          .orderBy(comments.createdAt);
        return rows.map(mapComment);
      },

      async create(input: {
        projectId: string;
        targetType: "issue" | "pull_request";
        targetId: number;
        authorType: "user" | "agent" | "system";
        agentType?: AgentType | null;
        body: string;
        bodyFormat?: CommentBodyFormat;
        metadata?: Record<string, unknown>;
      }): Promise<CommentDto> {
        const timestamp = now();
        const rows = await db
          .insert(comments)
          .values({
            projectId: input.projectId,
            targetType: input.targetType,
            targetId: input.targetId,
            authorType: input.authorType,
            agentType: input.agentType,
            body: input.body,
            bodyFormat: input.bodyFormat ?? "markdown",
            metadataJson: stringifyJson(input.metadata),
            createdAt: timestamp,
            updatedAt: timestamp
          })
          .returning();
        return mapComment(rows[0]);
      }
    },

    activities: {
      async create(input: {
        projectId: string;
        agentJobId?: number | null;
        targetType: "issue" | "pull_request";
        targetId: number;
        activityType: ActivityDto["activityType"];
        title: string;
        body?: string;
        payload?: Record<string, unknown>;
      }): Promise<ActivityDto> {
        const rows = await db
          .insert(agentActivities)
          .values({
            projectId: input.projectId,
            agentJobId: input.agentJobId,
            targetType: input.targetType,
            targetId: input.targetId,
            activityType: input.activityType,
            title: input.title,
            body: input.body ?? "",
            payloadJson: stringifyJson(input.payload),
            createdAt: now()
          })
          .returning();
        return mapActivity(rows[0]);
      },

      async list(projectId: string, targetType: "issue" | "pull_request", targetId: number): Promise<ActivityDto[]> {
        const rows = await db
          .select()
          .from(agentActivities)
          .where(
            and(
              eq(agentActivities.projectId, projectId),
              eq(agentActivities.targetType, targetType),
              eq(agentActivities.targetId, targetId)
            )
          )
          .orderBy(agentActivities.createdAt);
        return rows.map(mapActivity);
      }
    },

    agentJobs: {
      async nextQueued(projectId?: string): Promise<AgentJobDto | null> {
        const filters: SQL[] = [eq(agentJobs.status, "queued")];
        if (projectId) {
          filters.push(eq(agentJobs.projectId, projectId));
        }

        const runningLockFilters: SQL[] = [eq(agentJobs.status, "running"), isNotNull(agentJobs.lockKey)];
        if (projectId) {
          runningLockFilters.push(eq(agentJobs.projectId, projectId));
        }

        const runningLockRows = await db
          .select({ lockKey: agentJobs.lockKey })
          .from(agentJobs)
          .where(and(...runningLockFilters));
        const runningLocks = new Set(runningLockRows.map((row) => row.lockKey).filter((lockKey): lockKey is string => Boolean(lockKey)));

        const rows = await db.select().from(agentJobs).where(and(...filters)).orderBy(agentJobs.createdAt).limit(50);
        const nextJob = rows.find((row) => !row.lockKey || !runningLocks.has(row.lockKey));
        return nextJob ? mapAgentJob(nextJob) : null;
      },

      async list(input: {
        projectId: string;
        targetType?: "issue" | "pull_request" | "project";
        targetId?: number;
        status?: AgentJobStatus;
      }): Promise<AgentJobDto[]> {
        const filters: SQL[] = [eq(agentJobs.projectId, input.projectId)];
        if (input.targetType) {
          filters.push(eq(agentJobs.targetType, input.targetType));
        }
        if (typeof input.targetId === "number") {
          filters.push(eq(agentJobs.targetId, input.targetId));
        }
        if (input.status) {
          filters.push(eq(agentJobs.status, input.status));
        }

        const rows = await db.select().from(agentJobs).where(and(...filters)).orderBy(desc(agentJobs.createdAt));
        return rows.map(mapAgentJob);
      },

      async get(projectId: string, jobId: number): Promise<AgentJobDto | null> {
        const rows = await db
          .select()
          .from(agentJobs)
          .where(and(eq(agentJobs.projectId, projectId), eq(agentJobs.id, jobId)))
          .limit(1);
        return rows[0] ? mapAgentJob(rows[0]) : null;
      },

      async create(input: {
        projectId: string;
        aiProvider?: AiProvider;
        agentType: AgentType;
        targetType: "issue" | "pull_request" | "project";
        targetId: number;
        triggerType?: string;
        parentJobId?: number | null;
        input?: Record<string, unknown>;
        lockKey?: string | null;
      }): Promise<AgentJobDto> {
        const timestamp = now();
        const aiProvider = input.aiProvider ?? (await activeAiProvider());
        const rows = await db
          .insert(agentJobs)
          .values({
            projectId: input.projectId,
            aiProvider,
            agentType: input.agentType,
            targetType: input.targetType,
            targetId: input.targetId,
            status: "queued",
            triggerType: input.triggerType ?? "manual",
            parentJobId: input.parentJobId,
            inputJson: JSON.stringify(input.input ?? {}),
            lockKey: input.lockKey,
            createdAt: timestamp
          })
          .returning();
        return mapAgentJob(rows[0]);
      },

      async updateStatus(
        projectId: string,
        jobId: number,
        status: AgentJobStatus,
        patch?: { output?: Record<string, unknown> | null; error?: string | null }
      ): Promise<AgentJobDto | null> {
        const timestamp = now();
        const filters = [eq(agentJobs.projectId, projectId), eq(agentJobs.id, jobId)];
        if (status === "running") {
          filters.push(eq(agentJobs.status, "queued"));
        }
        const rows = await db
          .update(agentJobs)
          .set({
            status,
            outputJson: patch?.output === undefined ? undefined : stringifyJson(patch.output ?? undefined),
            error: patch?.error,
            startedAt: status === "running" ? timestamp : undefined,
            finishedAt: ["succeeded", "failed", "canceled"].includes(status) ? timestamp : undefined,
            waitReason: ["succeeded", "failed", "canceled"].includes(status) ? null : undefined,
            waitMetadataJson: ["succeeded", "failed", "canceled"].includes(status) ? null : undefined,
            nextRetryAt: ["succeeded", "failed", "canceled"].includes(status) ? null : undefined
          })
          .where(and(...filters))
          .returning();
        return rows[0] ? mapAgentJob(rows[0]) : null;
      },

      async pause(projectId: string, jobId: number): Promise<AgentJobDto | null> {
        const rows = await db
          .update(agentJobs)
          .set({ status: "paused", error: null, finishedAt: null })
          .where(
            and(
              eq(agentJobs.projectId, projectId),
              eq(agentJobs.id, jobId),
              inArray(agentJobs.status, ["queued", "running", "waiting_provider", "waiting_human"])
            )
          )
          .returning();
        return rows[0] ? mapAgentJob(rows[0]) : null;
      },

      async resumePaused(projectId: string, jobId: number): Promise<AgentJobDto | null> {
        const rows = await db
          .update(agentJobs)
          .set({
            status: "queued",
            error: null,
            attempt: sql`${agentJobs.attempt} + 1`,
            waitReason: null,
            waitMetadataJson: null,
            nextRetryAt: null,
            startedAt: null,
            finishedAt: null
          })
          .where(and(eq(agentJobs.projectId, projectId), eq(agentJobs.id, jobId), eq(agentJobs.status, "paused")))
          .returning();
        return rows[0] ? mapAgentJob(rows[0]) : null;
      },

      async requeueAfterRecovery(
        projectId: string,
        jobId: number,
        patch?: { output?: Record<string, unknown> | null; error?: string | null }
      ): Promise<AgentJobDto | null> {
        const rows = await db
          .update(agentJobs)
          .set({
            status: "queued",
            outputJson: patch?.output === undefined ? undefined : stringifyJson(patch.output ?? undefined),
            error: patch?.error ?? null,
            attempt: sql`${agentJobs.attempt} + 1`,
            startedAt: null,
            finishedAt: null
          })
          .where(and(eq(agentJobs.projectId, projectId), eq(agentJobs.id, jobId), eq(agentJobs.status, "running")))
          .returning();
        return rows[0] ? mapAgentJob(rows[0]) : null;
      },

      async requeueInterrupted(projectId?: string): Promise<AgentJobDto[]> {
        const filters: SQL[] = [eq(agentJobs.status, "running")];
        if (projectId) {
          filters.push(eq(agentJobs.projectId, projectId));
        }

        const rows = await db
          .update(agentJobs)
          .set({
            status: "queued",
            error: "Recovered interrupted running job.",
            attempt: sql`${agentJobs.attempt} + 1`,
            startedAt: null,
            finishedAt: null
          })
          .where(and(...filters))
          .returning();
        return rows.map(mapAgentJob);
      },

      async waitForProvider(
        projectId: string,
        jobId: number,
        input: {
          reason: string;
          metadata: Record<string, unknown>;
          nextRetryAt: string;
          output: Record<string, unknown>;
        }
      ): Promise<AgentJobDto | null> {
        const rows = await db
          .update(agentJobs)
          .set({
            status: "waiting_provider",
            outputJson: stringifyJson(input.output),
            error: null,
            waitReason: input.reason,
            waitMetadataJson: stringifyJson(input.metadata),
            nextRetryAt: input.nextRetryAt,
            finishedAt: null
          })
          .where(and(eq(agentJobs.projectId, projectId), eq(agentJobs.id, jobId), eq(agentJobs.status, "running")))
          .returning();
        return rows[0] ? mapAgentJob(rows[0]) : null;
      },

      async listDueProviderWaits(at: string): Promise<AgentJobDto[]> {
        const rows = await db
          .select()
          .from(agentJobs)
          .where(and(eq(agentJobs.status, "waiting_provider"), sql`${agentJobs.nextRetryAt} <= ${at}`))
          .orderBy(agentJobs.nextRetryAt);
        return rows.map(mapAgentJob);
      },

      async resumeProviderWait(projectId: string, jobId: number, aiProvider?: AiProvider): Promise<AgentJobDto | null> {
        const rows = await db
          .update(agentJobs)
          .set({
            status: "queued",
            aiProvider,
            error: null,
            attempt: sql`${agentJobs.attempt} + 1`,
            nextRetryAt: null,
            startedAt: null,
            finishedAt: null
          })
          .where(and(eq(agentJobs.projectId, projectId), eq(agentJobs.id, jobId), eq(agentJobs.status, "waiting_provider")))
          .returning();
        return rows[0] ? mapAgentJob(rows[0]) : null;
      },

      async retry(projectId: string, jobId: number): Promise<AgentJobDto | null> {
        const job = await this.get(projectId, jobId);
        if (!job) {
          return null;
        }

        const timestamp = now();
        const rows = await db
          .insert(agentJobs)
          .values({
            projectId,
            aiProvider: job.aiProvider,
            agentType: job.agentType,
            targetType: job.targetType,
            targetId: job.targetId,
            status: "queued",
            triggerType: "retry",
            parentJobId: job.id,
            inputJson: JSON.stringify(job.input),
            attempt: job.attempt + 1,
            lockKey: job.lockKey,
            createdAt: timestamp
          })
          .returning();
        return mapAgentJob(rows[0]);
      },

      async resume(projectId: string, jobId: number): Promise<AgentJobDto | null> {
        const rows = await db
          .update(agentJobs)
          .set({
            status: "queued",
            error: null,
            attempt: sql`${agentJobs.attempt} + 1`,
            startedAt: null,
            finishedAt: null
          })
          .where(and(eq(agentJobs.projectId, projectId), eq(agentJobs.id, jobId), eq(agentJobs.status, "waiting_human")))
          .returning();
        return rows[0] ? mapAgentJob(rows[0]) : null;
      }
    },

    loops: {
      async list(projectId: string): Promise<LoopDto[]> {
        const rows = await db
          .select()
          .from(loops)
          .where(eq(loops.projectId, projectId))
          .orderBy(desc(loops.updatedAt));
        return rows.map(mapLoop);
      },

      async get(projectId: string, loopId: number): Promise<LoopDto | null> {
        const rows = await db
          .select()
          .from(loops)
          .where(and(eq(loops.projectId, projectId), eq(loops.id, loopId)))
          .limit(1);
        return rows[0] ? mapLoop(rows[0]) : null;
      },

      async create(input: {
        projectId: string;
        name: string;
        purpose?: string;
        triggerType?: string;
        cadence?: string | null;
        targetScope?: string;
        status?: LoopStatus;
        maxRounds?: number;
        timeBudgetMinutes?: number | null;
        costBudget?: number | null;
        stopCondition?: Record<string, unknown> | null;
        riskPolicy?: Record<string, unknown> | null;
      }): Promise<LoopDto> {
        const timestamp = now();
        const rows = await db
          .insert(loops)
          .values({
            projectId: input.projectId,
            name: input.name,
            purpose: input.purpose ?? "",
            triggerType: input.triggerType ?? "manual",
            cadence: input.cadence,
            targetScope: input.targetScope ?? "project",
            status: input.status ?? "enabled",
            maxRounds: input.maxRounds ?? 3,
            timeBudgetMinutes: input.timeBudgetMinutes,
            costBudget: input.costBudget,
            stopConditionJson: stringifyJson(input.stopCondition),
            riskPolicyJson: stringifyJson(input.riskPolicy),
            createdAt: timestamp,
            updatedAt: timestamp
          })
          .returning();
        return mapLoop(rows[0]);
      },

      async update(
        projectId: string,
        loopId: number,
        input: Partial<
          Pick<
            LoopDto,
            "name" | "purpose" | "triggerType" | "cadence" | "targetScope" | "status" | "maxRounds" | "timeBudgetMinutes" | "costBudget"
          >
        > & {
          stopCondition?: Record<string, unknown> | null;
          riskPolicy?: Record<string, unknown> | null;
        }
      ): Promise<LoopDto | null> {
        const rows = await db
          .update(loops)
          .set({
            name: input.name,
            purpose: input.purpose,
            triggerType: input.triggerType,
            cadence: input.cadence,
            targetScope: input.targetScope,
            status: input.status,
            maxRounds: input.maxRounds,
            timeBudgetMinutes: input.timeBudgetMinutes,
            costBudget: input.costBudget,
            stopConditionJson: input.stopCondition === undefined ? undefined : stringifyJson(input.stopCondition),
            riskPolicyJson: input.riskPolicy === undefined ? undefined : stringifyJson(input.riskPolicy),
            updatedAt: now()
          })
          .where(and(eq(loops.projectId, projectId), eq(loops.id, loopId)))
          .returning();
        return rows[0] ? mapLoop(rows[0]) : null;
      }
    },

    loopRuns: {
      async list(projectId: string, loopId?: number): Promise<LoopRunDto[]> {
        const filters: SQL[] = [eq(loopRuns.projectId, projectId)];
        if (typeof loopId === "number") {
          filters.push(eq(loopRuns.loopId, loopId));
        }
        const rows = await db.select().from(loopRuns).where(and(...filters)).orderBy(desc(loopRuns.createdAt));
        return rows.map(mapLoopRun);
      },

      async get(projectId: string, loopRunId: number): Promise<LoopRunDto | null> {
        const rows = await db
          .select()
          .from(loopRuns)
          .where(and(eq(loopRuns.projectId, projectId), eq(loopRuns.id, loopRunId)))
          .limit(1);
        return rows[0] ? mapLoopRun(rows[0]) : null;
      },

      async create(input: {
        projectId: string;
        loopId: number;
        triggerType?: string;
        targetType?: "issue" | "pull_request" | "project" | null;
        targetId?: number | null;
        worktreePath?: string | null;
      }): Promise<LoopRunDto> {
        const timestamp = now();
        const rows = await db
          .insert(loopRuns)
          .values({
            projectId: input.projectId,
            loopId: input.loopId,
            status: "queued",
            triggerType: input.triggerType ?? "manual",
            targetType: input.targetType,
            targetId: input.targetId,
            worktreePath: input.worktreePath,
            createdAt: timestamp
          })
          .returning();
        return mapLoopRun(rows[0]);
      },

      async updateStatus(
        projectId: string,
        loopRunId: number,
        status: LoopRunStatus,
        patch?: {
          summary?: string;
          stopReason?: string | null;
          evidence?: Record<string, unknown> | null;
          worktreePath?: string | null;
        }
      ): Promise<LoopRunDto | null> {
        const timestamp = now();
        const rows = await db
          .update(loopRuns)
          .set({
            status,
            summary: patch?.summary,
            stopReason: patch?.stopReason,
            evidenceJson: patch?.evidence === undefined ? undefined : stringifyJson(patch.evidence),
            worktreePath: patch?.worktreePath,
            startedAt: status === "running" ? timestamp : undefined,
            finishedAt: ["succeeded", "failed", "canceled"].includes(status) ? timestamp : undefined
          })
          .where(and(eq(loopRuns.projectId, projectId), eq(loopRuns.id, loopRunId)))
          .returning();
        return rows[0] ? mapLoopRun(rows[0]) : null;
      }
    },

    loopSteps: {
      async list(projectId: string, loopRunId: number): Promise<LoopStepDto[]> {
        const rows = await db
          .select()
          .from(loopSteps)
          .where(and(eq(loopSteps.projectId, projectId), eq(loopSteps.loopRunId, loopRunId)))
          .orderBy(loopSteps.createdAt);
        return rows.map(mapLoopStep);
      },

      async create(input: {
        projectId: string;
        loopRunId: number;
        agentJobId?: number | null;
        agentType: AgentType;
        targetType: "issue" | "pull_request" | "project";
        targetId: number;
        status?: LoopStepStatus;
        input?: Record<string, unknown> | null;
      }): Promise<LoopStepDto> {
        const timestamp = now();
        const rows = await db
          .insert(loopSteps)
          .values({
            projectId: input.projectId,
            loopRunId: input.loopRunId,
            agentJobId: input.agentJobId,
            agentType: input.agentType,
            targetType: input.targetType,
            targetId: input.targetId,
            status: input.status ?? "queued",
            inputJson: stringifyJson(input.input),
            createdAt: timestamp,
            updatedAt: timestamp
          })
          .returning();
        return mapLoopStep(rows[0]);
      },

      async updateForAgentJob(
        projectId: string,
        agentJobId: number,
        patch: {
          status?: LoopStepStatus;
          output?: Record<string, unknown> | null;
          evidence?: Record<string, unknown> | null;
        }
      ): Promise<LoopStepDto | null> {
        const rows = await db
          .update(loopSteps)
          .set({
            status: patch.status,
            outputJson: patch.output === undefined ? undefined : stringifyJson(patch.output),
            evidenceJson: patch.evidence === undefined ? undefined : stringifyJson(patch.evidence),
            updatedAt: now()
          })
          .where(and(eq(loopSteps.projectId, projectId), eq(loopSteps.agentJobId, agentJobId)))
          .returning();
        return rows[0] ? mapLoopStep(rows[0]) : null;
      },

      async getByAgentJob(projectId: string, agentJobId: number): Promise<LoopStepDto | null> {
        const rows = await db
          .select()
          .from(loopSteps)
          .where(and(eq(loopSteps.projectId, projectId), eq(loopSteps.agentJobId, agentJobId)))
          .limit(1);
        return rows[0] ? mapLoopStep(rows[0]) : null;
      }
    },

    loopMemory: {
      async list(projectId: string): Promise<LoopMemoryEntryDto[]> {
        const rows = await db
          .select()
          .from(loopMemoryEntries)
          .where(eq(loopMemoryEntries.projectId, projectId))
          .orderBy(desc(loopMemoryEntries.createdAt));
        return rows.map(mapLoopMemoryEntry);
      },

      async create(input: {
        projectId: string;
        loopId?: number | null;
        loopRunId?: number | null;
        sourceType?: "manual" | "loop_run" | "agent_job" | "triage";
        sourceId?: number | null;
        title: string;
        body?: string;
        tags?: string[];
      }): Promise<LoopMemoryEntryDto> {
        const timestamp = now();
        const rows = await db
          .insert(loopMemoryEntries)
          .values({
            projectId: input.projectId,
            loopId: input.loopId,
            loopRunId: input.loopRunId,
            sourceType: input.sourceType ?? "manual",
            sourceId: input.sourceId,
            title: input.title,
            body: input.body ?? "",
            tagsJson: stringifyStringArray(input.tags),
            createdAt: timestamp,
            updatedAt: timestamp
          })
          .returning();
        return mapLoopMemoryEntry(rows[0]);
      }
    },

    objectives: {
      async list(input: {
        projectId: string;
        issueId?: number;
        pullRequestId?: number;
        status?: ObjectiveRunStatus;
      }): Promise<ObjectiveRunDto[]> {
        const filters: SQL[] = [eq(objectiveRuns.projectId, input.projectId)];
        if (typeof input.issueId === "number") {
          filters.push(eq(objectiveRuns.issueId, input.issueId));
        }
        if (typeof input.pullRequestId === "number") {
          filters.push(eq(objectiveRuns.pullRequestId, input.pullRequestId));
        }
        if (input.status) {
          filters.push(eq(objectiveRuns.status, input.status));
        }
        const rows = await db
          .select()
          .from(objectiveRuns)
          .where(and(...filters))
          .orderBy(desc(objectiveRuns.updatedAt), desc(objectiveRuns.id));
        return rows.map(mapObjectiveRun);
      },

      async get(projectId: string, objectiveRunId: number): Promise<ObjectiveRunDto | null> {
        const rows = await db
          .select()
          .from(objectiveRuns)
          .where(and(eq(objectiveRuns.projectId, projectId), eq(objectiveRuns.id, objectiveRunId)))
          .limit(1);
        return rows[0] ? mapObjectiveRun(rows[0]) : null;
      },

      async findByIssue(projectId: string, issueId: number): Promise<ObjectiveRunDto | null> {
        const rows = await db
          .select()
          .from(objectiveRuns)
          .where(and(eq(objectiveRuns.projectId, projectId), eq(objectiveRuns.issueId, issueId)))
          .orderBy(desc(objectiveRuns.updatedAt), desc(objectiveRuns.id))
          .limit(1);
        return rows[0] ? mapObjectiveRun(rows[0]) : null;
      },

      async findByPullRequest(projectId: string, pullRequestId: number): Promise<ObjectiveRunDto | null> {
        const rows = await db
          .select()
          .from(objectiveRuns)
          .where(and(eq(objectiveRuns.projectId, projectId), eq(objectiveRuns.pullRequestId, pullRequestId)))
          .orderBy(desc(objectiveRuns.updatedAt))
          .limit(1);
        return rows[0] ? mapObjectiveRun(rows[0]) : null;
      },

      async ensureForIssue(input: {
        projectId: string;
        issueId: number;
        title: string;
        goal?: string;
        maxRounds?: number;
      }): Promise<ObjectiveRunDto> {
        const existing = await this.findByIssue(input.projectId, input.issueId);
        if (existing) {
          return existing;
        }

        const timestamp = now();
        const rows = await db
          .insert(objectiveRuns)
          .values({
            projectId: input.projectId,
            issueId: input.issueId,
            title: input.title,
            goal: input.goal ?? "",
            maxRounds: input.maxRounds ?? 12,
            status: "open",
            workflowStage: "requirements",
            createdAt: timestamp,
            updatedAt: timestamp
          })
          .returning();
        return mapObjectiveRun(rows[0]);
      },

      async createForIssue(input: {
        projectId: string;
        issueId: number;
        title: string;
        goal?: string;
        maxRounds?: number;
        summary?: string;
        evidence?: Record<string, unknown> | null;
      }): Promise<ObjectiveRunDto> {
        const timestamp = now();
        const rows = await db
          .insert(objectiveRuns)
          .values({
            projectId: input.projectId,
            issueId: input.issueId,
            title: input.title,
            goal: input.goal ?? "",
            maxRounds: input.maxRounds ?? 12,
            status: "open",
            workflowStage: "requirements",
            summary: input.summary ?? "",
            evidenceJson: stringifyJson(input.evidence ?? undefined),
            createdAt: timestamp,
            updatedAt: timestamp
          })
          .returning();
        return mapObjectiveRun(rows[0]);
      },

      async ensureForPullRequest(input: {
        projectId: string;
        pullRequestId: number;
        issueId?: number | null;
        title: string;
        goal?: string;
        maxRounds?: number;
      }): Promise<ObjectiveRunDto> {
        const existingByPullRequest = await this.findByPullRequest(input.projectId, input.pullRequestId);
        if (existingByPullRequest) {
          return existingByPullRequest;
        }

        if (typeof input.issueId === "number") {
          const existingByIssue = await this.findByIssue(input.projectId, input.issueId);
          if (existingByIssue) {
            return (
              (await this.update(input.projectId, existingByIssue.id, {
                pullRequestId: input.pullRequestId,
                title: existingByIssue.title || input.title,
                workflowStage: "review"
              })) ?? existingByIssue
            );
          }
        }

        const timestamp = now();
        const rows = await db
          .insert(objectiveRuns)
          .values({
            projectId: input.projectId,
            issueId: input.issueId ?? null,
            pullRequestId: input.pullRequestId,
            title: input.title,
            goal: input.goal ?? "",
            maxRounds: input.maxRounds ?? 12,
            status: "open",
            workflowStage: "review",
            createdAt: timestamp,
            updatedAt: timestamp
          })
          .returning();
        return mapObjectiveRun(rows[0]);
      },

      async update(
        projectId: string,
        objectiveRunId: number,
        input: Partial<
          Pick<
            ObjectiveRunDto,
            | "issueId"
            | "pullRequestId"
            | "status"
            | "workflowStage"
            | "title"
            | "goal"
            | "roundCount"
            | "maxRounds"
            | "lastAgentJobId"
            | "judgeAgentJobId"
            | "generatorAiProvider"
            | "judgeAiProvider"
            | "lastFailureSignature"
            | "repeatedFailureCount"
            | "stopReason"
            | "summary"
            | "finishedAt"
          >
        > & {
          evidence?: Record<string, unknown> | null;
        }
      ): Promise<ObjectiveRunDto | null> {
        const rows = await db
          .update(objectiveRuns)
          .set({
            issueId: input.issueId,
            pullRequestId: input.pullRequestId,
            status: input.status,
            workflowStage: input.workflowStage,
            title: input.title,
            goal: input.goal,
            roundCount: input.roundCount,
            maxRounds: input.maxRounds,
            lastAgentJobId: input.lastAgentJobId,
            judgeAgentJobId: input.judgeAgentJobId,
            generatorAiProvider: input.generatorAiProvider,
            judgeAiProvider: input.judgeAiProvider,
            lastFailureSignature: input.lastFailureSignature,
            repeatedFailureCount: input.repeatedFailureCount,
            stopReason: input.stopReason,
            evidenceJson: input.evidence === undefined ? undefined : stringifyJson(input.evidence),
            summary: input.summary,
            finishedAt: input.finishedAt,
            updatedAt: now()
          })
          .where(and(eq(objectiveRuns.projectId, projectId), eq(objectiveRuns.id, objectiveRunId)))
          .returning();
        return rows[0] ? mapObjectiveRun(rows[0]) : null;
      }
    },

    triage: {
      async list(projectId: string, status?: TriageItemStatus): Promise<TriageItemDto[]> {
        const filters: SQL[] = [eq(triageItems.projectId, projectId)];
        if (status) {
          filters.push(eq(triageItems.status, status));
        }
        const rows = await db.select().from(triageItems).where(and(...filters)).orderBy(desc(triageItems.createdAt));
        return rows.map(mapTriageItem);
      },

      async create(input: {
        projectId: string;
        sourceType: string;
        sourceId?: number | null;
        title: string;
        body?: string;
        priority?: string;
        metadata?: Record<string, unknown> | null;
      }): Promise<TriageItemDto> {
        const timestamp = now();
        const rows = await db
          .insert(triageItems)
          .values({
            projectId: input.projectId,
            sourceType: input.sourceType,
            sourceId: input.sourceId,
            title: input.title,
            body: input.body ?? "",
            priority: input.priority ?? "normal",
            metadataJson: stringifyJson(input.metadata),
            createdAt: timestamp,
            updatedAt: timestamp
          })
          .returning();
        return mapTriageItem(rows[0]);
      },

      async update(
        projectId: string,
        triageItemId: number,
        input: { status?: TriageItemStatus; issueId?: number | null }
      ): Promise<TriageItemDto | null> {
        const rows = await db
          .update(triageItems)
          .set({
            status: input.status,
            issueId: input.issueId,
            updatedAt: now()
          })
          .where(and(eq(triageItems.projectId, projectId), eq(triageItems.id, triageItemId)))
          .returning();
        return rows[0] ? mapTriageItem(rows[0]) : null;
      }
    },

    raw: {
      async countTables(): Promise<number> {
        const result = await db.select({ value: sql<number>`count(*)` }).from(projects);
        return result[0]?.value ?? 0;
      }
    }
  };
}

export type Repositories = ReturnType<typeof createRepositories>;
