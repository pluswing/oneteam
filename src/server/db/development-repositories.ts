import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "./client";
import { agentExecutions, developmentLoops, knowledgeRevisions, retrospectives } from "./development-schema";
import { agentJobs } from "./schema";
import type { AgentExecutionDto, DevelopmentLoopDto, KnowledgeChange, RetrospectiveDto } from "../../shared/development-loop";

const now = () => new Date().toISOString();
const activeStatuses = ["queued", "running", "waiting_input", "waiting_capacity", "paused", "failed"] as const;

export function createDevelopmentRepositories(db: Database) {
  return {
    async list(projectId: string): Promise<DevelopmentLoopDto[]> {
      return db.select().from(developmentLoops).where(eq(developmentLoops.projectId, projectId)).orderBy(desc(developmentLoops.id));
    },
    async get(projectId: string, id: number): Promise<DevelopmentLoopDto | null> {
      return (await db.select().from(developmentLoops).where(and(eq(developmentLoops.projectId, projectId), eq(developmentLoops.id, id))).limit(1))[0] ?? null;
    },
    async forIssue(projectId: string, issueId: number): Promise<DevelopmentLoopDto | null> {
      return (await db.select().from(developmentLoops).where(and(eq(developmentLoops.projectId, projectId), eq(developmentLoops.issueId, issueId))).orderBy(desc(developmentLoops.id)).limit(1))[0] ?? null;
    },
    async forPullRequest(projectId: string, pullRequestId: number): Promise<DevelopmentLoopDto | null> {
      return (await db.select().from(developmentLoops).where(and(eq(developmentLoops.projectId, projectId), eq(developmentLoops.pullRequestId, pullRequestId))).orderBy(desc(developmentLoops.id)).limit(1))[0] ?? null;
    },
    async create(projectId: string, issueId: number, objectiveId: number | null = null): Promise<DevelopmentLoopDto> {
      await db.insert(developmentLoops).values({ projectId, issueId, objectiveId, phase: "planning", status: "queued", createdAt: now(), updatedAt: now() }).onConflictDoNothing();
      return (await db.select().from(developmentLoops).where(and(eq(developmentLoops.projectId, projectId), eq(developmentLoops.issueId, issueId), inArray(developmentLoops.status, [...activeStatuses]))).orderBy(desc(developmentLoops.id)).limit(1))[0];
    },
    async update(projectId: string, id: number, patch: Partial<Omit<DevelopmentLoopDto, "id" | "projectId" | "issueId" | "createdAt">>): Promise<DevelopmentLoopDto> {
      return (await db.update(developmentLoops).set({ ...patch, updatedAt: now() }).where(and(eq(developmentLoops.projectId, projectId), eq(developmentLoops.id, id))).returning())[0];
    },
    async updateJobInput(projectId: string, id: number, input: Record<string, unknown>): Promise<void> {
      await db.update(agentJobs).set({ inputJson: JSON.stringify(input) }).where(and(eq(agentJobs.projectId, projectId), eq(agentJobs.id, id)));
    },
    async setJobModel(projectId: string, id: number, model: string): Promise<void> {
      await db.update(agentJobs).set({ aiProvider: "codex", aiModel: model }).where(and(eq(agentJobs.projectId, projectId), eq(agentJobs.id, id)));
    },
    async retryJob(projectId: string, id: number): Promise<void> {
      await db.update(agentJobs).set({ status: "queued", error: null, attempt: sql`${agentJobs.attempt} + 1`, startedAt: null, finishedAt: null })
        .where(and(eq(agentJobs.projectId, projectId), eq(agentJobs.id, id), inArray(agentJobs.status, ["waiting_human", "failed", "canceled"])));
    },
    executions: {
      async create(input: { projectId: string; jobId: number; selectedModel: string; effort: string | null; selectionReason: string; policyVersion: string }): Promise<AgentExecutionDto> {
        const row = (await db.insert(agentExecutions).values({ ...input, status: "starting", startedAt: now() }).returning())[0];
        return executionDto(row);
      },
      async update(projectId: string, id: number, patch: Partial<Omit<AgentExecutionDto, "id" | "projectId" | "jobId" | "startedAt">>): Promise<void> {
        const { usage, ...fields } = patch;
        await db.update(agentExecutions).set({ ...fields, usageJson: usage === undefined ? undefined : JSON.stringify(usage) }).where(and(eq(agentExecutions.projectId, projectId), eq(agentExecutions.id, id)));
      },
      async list(projectId: string, jobId: number): Promise<AgentExecutionDto[]> {
        return (await db.select().from(agentExecutions).where(and(eq(agentExecutions.projectId, projectId), eq(agentExecutions.jobId, jobId))).orderBy(asc(agentExecutions.id))).map(executionDto);
      },
      async interrupt(projectId: string): Promise<void> {
        await db.update(agentExecutions).set({ status: "interrupted", finishedAt: now() }).where(and(eq(agentExecutions.projectId, projectId), inArray(agentExecutions.status, ["starting", "running"])));
      }
    },
    retrospectives: {
      async get(projectId: string, loopId: number): Promise<RetrospectiveDto | null> {
        const row = (await db.select().from(retrospectives).where(and(eq(retrospectives.projectId, projectId), eq(retrospectives.loopId, loopId))).limit(1))[0];
        return row ? retrospectiveDto(row) : null;
      },
      async create(input: { projectId: string; loopId: number; mergeCommit: string; summary: string; body: string; changes: KnowledgeChange[] }): Promise<void> {
        const { changes, ...fields } = input;
        await db.insert(retrospectives).values({ ...fields, changesJson: JSON.stringify(changes), status: "pending", createdAt: now() }).onConflictDoNothing();
      },
      async update(projectId: string, loopId: number, status: RetrospectiveDto["status"], error: string | null = null): Promise<void> {
        await db.update(retrospectives).set({ status, error, appliedAt: status === "applied" ? now() : undefined }).where(and(eq(retrospectives.projectId, projectId), eq(retrospectives.loopId, loopId)));
      }
    },
    revisions: {
      async list(projectId: string, loopId?: number) {
        return db.select().from(knowledgeRevisions).where(and(eq(knowledgeRevisions.projectId, projectId), loopId === undefined ? undefined : eq(knowledgeRevisions.loopId, loopId))).orderBy(desc(knowledgeRevisions.id));
      },
      async create(input: Omit<typeof knowledgeRevisions.$inferInsert, "id" | "createdAt">) {
        await db.insert(knowledgeRevisions).values({ ...input, createdAt: now() }).onConflictDoNothing();
      },
      async applied(projectId: string, id: number) {
        await db.update(knowledgeRevisions).set({ status: "applied" }).where(and(eq(knowledgeRevisions.projectId, projectId), eq(knowledgeRevisions.id, id)));
      },
      async setStatus(projectId: string, id: number, status: string) {
        await db.update(knowledgeRevisions).set({ status }).where(and(eq(knowledgeRevisions.projectId, projectId), eq(knowledgeRevisions.id, id)));
      }
    }
  };
}

function executionDto(row: typeof agentExecutions.$inferSelect): AgentExecutionDto {
  const { usageJson, ...rest } = row;
  return { ...rest, usage: usageJson ? JSON.parse(usageJson) as Record<string, unknown> : null };
}
function retrospectiveDto(row: typeof retrospectives.$inferSelect): RetrospectiveDto {
  const { changesJson, status, ...rest } = row;
  return { ...rest, status: status as RetrospectiveDto["status"], changes: JSON.parse(changesJson) as KnowledgeChange[] };
}
