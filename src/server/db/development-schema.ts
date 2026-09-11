import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { DevelopmentPhase, DevelopmentStatus } from "../../shared/development-loop";

export const developmentLoops = sqliteTable("development_loops", {
  id: integer("id").primaryKey({ autoIncrement: true }), projectId: text("project_id").notNull(), issueId: integer("issue_id").notNull(),
  pullRequestId: integer("pull_request_id"), objectiveId: integer("objective_id"),
  phase: text("phase").notNull().$type<DevelopmentPhase>(), status: text("status").notNull().$type<DevelopmentStatus>(),
  currentJobId: integer("current_job_id"), mergeCommit: text("merge_commit"), sourceCommit: text("source_commit"), targetCommit: text("target_commit"),
  nextAgent: text("next_agent").notNull().default("requirements"), failures: integer("failures").notNull().default(0),
  summary: text("summary").notNull().default(""), rounds: integer("rounds").notNull().default(0),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(), finishedAt: text("finished_at")
});

export const agentExecutions = sqliteTable("agent_executions", {
  id: integer("id").primaryKey({ autoIncrement: true }), projectId: text("project_id").notNull(), jobId: integer("job_id").notNull(),
  selectedModel: text("selected_model").notNull(), resolvedModel: text("resolved_model"), effort: text("effort"),
  selectionReason: text("selection_reason").notNull(), policyVersion: text("policy_version").notNull(),
  threadId: text("thread_id"), turnId: text("turn_id"), status: text("status").notNull(), usageJson: text("usage_json"),
  startedAt: text("started_at").notNull(), finishedAt: text("finished_at")
});

export const retrospectives = sqliteTable("retrospectives", {
  id: integer("id").primaryKey({ autoIncrement: true }), projectId: text("project_id").notNull(), loopId: integer("loop_id").notNull(),
  mergeCommit: text("merge_commit").notNull(), summary: text("summary").notNull(), body: text("body").notNull(),
  changesJson: text("changes_json").notNull(), status: text("status").notNull(), error: text("error"),
  createdAt: text("created_at").notNull(), appliedAt: text("applied_at")
});

export const knowledgeRevisions = sqliteTable("knowledge_revisions", {
  id: integer("id").primaryKey({ autoIncrement: true }), projectId: text("project_id").notNull(), loopId: integer("loop_id").notNull(),
  path: text("path").notNull(), beforeBody: text("before_body"), afterBody: text("after_body"), reason: text("reason").notNull(),
  status: text("status").notNull(), createdAt: text("created_at").notNull()
});
