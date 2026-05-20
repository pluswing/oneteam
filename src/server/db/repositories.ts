import { randomUUID } from "node:crypto";
import { and, count, desc, eq, inArray, isNull, like, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type {
  ActivityDto,
  CommandType,
  CommentDto,
  IssueDto,
  IssueStatus,
  LabelDto,
  ProjectCommandDto,
  ProjectDto
} from "../../shared/types";
import { systemLabels } from "./system-labels";
import { agentActivities, comments, issueLabels, issues, labels, projectCommands, projects } from "./schema";
import type { Database } from "./client";
import { parseJsonObject, stringifyJson } from "./json";

type ProjectRow = typeof projects.$inferSelect;
type LabelRow = typeof labels.$inferSelect;
type ProjectCommandRow = typeof projectCommands.$inferSelect;
type IssueRow = typeof issues.$inferSelect;
type CommentRow = typeof comments.$inferSelect;
type ActivityRow = typeof agentActivities.$inferSelect;

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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    closedAt: row.closedAt
  };
}

export function createRepositories(db: Database) {
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
        body: string;
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
            body: input.body,
            metadataJson: stringifyJson(input.metadata),
            createdAt: timestamp,
            updatedAt: timestamp
          })
          .returning();
        return mapComment(rows[0]);
      }
    },

    activities: {
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

    raw: {
      async countTables(): Promise<number> {
        const result = await db.select({ value: sql<number>`count(*)` }).from(projects);
        return result[0]?.value ?? 0;
      }
    }
  };
}

export type Repositories = ReturnType<typeof createRepositories>;
