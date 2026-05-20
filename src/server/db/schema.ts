import { integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { ActivityType, AgentJobStatus, AgentType, CommandType, IssueStatus, LabelKind, PullRequestStatus } from "../../shared/types";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  repoPath: text("repo_path").notNull().unique(),
  defaultBranch: text("default_branch").notNull().default("main"),
  locale: text("locale").notNull().default("en"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const projectCommands = sqliteTable(
  "project_commands",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    commandType: text("command_type").notNull().$type<CommandType>(),
    command: text("command"),
    detectionSource: text("detection_source").notNull(),
    detectionDetailsJson: text("detection_details_json"),
    isRequired: integer("is_required", { mode: "boolean" }).notNull().default(true),
    isAvailable: integer("is_available", { mode: "boolean" }).notNull().default(false),
    lastDetectedAt: text("last_detected_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => ({
    projectCommandUnique: uniqueIndex("project_commands_project_command_unique").on(table.projectId, table.commandType)
  })
);

export const issues = sqliteTable("issues", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  status: text("status").notNull().default("open").$type<IssueStatus>(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  closedAt: text("closed_at"),
  deletedAt: text("deleted_at")
});

export const pullRequests = sqliteTable("pull_requests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  issueId: integer("issue_id").references(() => issues.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  status: text("status").notNull().default("open").$type<PullRequestStatus>(),
  sourceBranch: text("source_branch").notNull(),
  targetBranch: text("target_branch").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  closedAt: text("closed_at"),
  deletedAt: text("deleted_at")
});

export const labels = sqliteTable(
  "labels",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull(),
    kind: text("kind").notNull().default("custom").$type<LabelKind>(),
    description: text("description").notNull().default(""),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at")
  },
  (table) => ({
    projectLabelUnique: uniqueIndex("labels_project_name_unique").on(table.projectId, table.name)
  })
);

export const issueLabels = sqliteTable(
  "issue_labels",
  {
    issueId: integer("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    labelId: integer("label_id").notNull().references(() => labels.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.issueId, table.labelId] })
  })
);

export const pullRequestLabels = sqliteTable(
  "pull_request_labels",
  {
    pullRequestId: integer("pull_request_id").notNull().references(() => pullRequests.id, { onDelete: "cascade" }),
    labelId: integer("label_id").notNull().references(() => labels.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.pullRequestId, table.labelId] })
  })
);

export const comments = sqliteTable("comments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  targetType: text("target_type").notNull().$type<"issue" | "pull_request">(),
  targetId: integer("target_id").notNull(),
  authorType: text("author_type").notNull().$type<"user" | "agent" | "system">(),
  agentType: text("agent_type").$type<AgentType>(),
  body: text("body").notNull(),
  metadataJson: text("metadata_json"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

export const agentJobs = sqliteTable("agent_jobs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  agentType: text("agent_type").notNull().$type<AgentType>(),
  targetType: text("target_type").notNull().$type<"issue" | "pull_request" | "project">(),
  targetId: integer("target_id").notNull(),
  status: text("status").notNull().default("queued").$type<AgentJobStatus>(),
  triggerType: text("trigger_type").notNull().default("manual"),
  parentJobId: integer("parent_job_id"),
  inputJson: text("input_json").notNull(),
  outputJson: text("output_json"),
  error: text("error"),
  attempt: integer("attempt").notNull().default(1),
  lockKey: text("lock_key"),
  createdAt: text("created_at").notNull(),
  startedAt: text("started_at"),
  finishedAt: text("finished_at")
});

export const agentActivities = sqliteTable("agent_activities", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  agentJobId: integer("agent_job_id").references(() => agentJobs.id, { onDelete: "set null" }),
  targetType: text("target_type").notNull().$type<"issue" | "pull_request">(),
  targetId: integer("target_id").notNull(),
  activityType: text("activity_type").notNull().$type<ActivityType>(),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  payloadJson: text("payload_json"),
  createdAt: text("created_at").notNull()
});

export const repositoryEvents = sqliteTable("repository_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  sourceBranch: text("source_branch"),
  targetBranch: text("target_branch"),
  payloadJson: text("payload_json"),
  createdAt: text("created_at").notNull()
});
