import type { Client } from "@libsql/client";

type Migration = {
  id: string;
  statements: string[];
};

const legacyWorkflowLabelRenames = [
  { oldName: "要件定義中", newName: "requirements" },
  { oldName: "確認待ち", newName: "needs-input" },
  { oldName: "実装待ち", newName: "ready-for-implementation" },
  { oldName: "実装中", newName: "implementing" },
  { oldName: "PR作成済み", newName: "pull-request-created" },
  { oldName: "レビュー中", newName: "reviewing" },
  { oldName: "修正中", newName: "fixing" },
  { oldName: "コンフリクト修正中", newName: "resolving-conflicts" },
  { oldName: "テスト中", newName: "testing" },
  { oldName: "完了", newName: "done" }
] as const;

const migrationTimestamp = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function renameWorkflowLabelStatements(): string[] {
  return legacyWorkflowLabelRenames.flatMap(({ oldName, newName }) => {
    const oldNameSql = sqlString(oldName);
    const newNameSql = sqlString(newName);
    const duplicateLabelIds = `(select legacy.id
          from labels legacy
          inner join labels replacement
            on replacement.project_id = legacy.project_id
            and replacement.name = ${newNameSql}
            and replacement.deleted_at is null
            and replacement.id <> legacy.id
          where legacy.name = ${oldNameSql}
            and legacy.deleted_at is null)`;

    return [
      `insert or ignore into issue_labels (issue_id, label_id, created_at)
        select issue_labels.issue_id, replacement.id, issue_labels.created_at
        from issue_labels
        inner join labels legacy on legacy.id = issue_labels.label_id
        inner join labels replacement
          on replacement.project_id = legacy.project_id
          and replacement.name = ${newNameSql}
          and replacement.deleted_at is null
        where legacy.name = ${oldNameSql}
          and legacy.deleted_at is null`,
      `delete from issue_labels
        where label_id in ${duplicateLabelIds}`,
      `insert or ignore into pull_request_labels (pull_request_id, label_id, created_at)
        select pull_request_labels.pull_request_id, replacement.id, pull_request_labels.created_at
        from pull_request_labels
        inner join labels legacy on legacy.id = pull_request_labels.label_id
        inner join labels replacement
          on replacement.project_id = legacy.project_id
          and replacement.name = ${newNameSql}
          and replacement.deleted_at is null
        where legacy.name = ${oldNameSql}
          and legacy.deleted_at is null`,
      `delete from pull_request_labels
        where label_id in ${duplicateLabelIds}`,
      `update labels
        set deleted_at = coalesce(deleted_at, ${migrationTimestamp}),
            updated_at = ${migrationTimestamp}
        where name = ${oldNameSql}
          and deleted_at is null
          and exists (
            select 1
            from labels replacement
            where replacement.project_id = labels.project_id
              and replacement.name = ${newNameSql}
              and replacement.id <> labels.id
          )`,
      `update labels
        set name = ${newNameSql},
            updated_at = ${migrationTimestamp}
        where name = ${oldNameSql}
          and deleted_at is null
          and not exists (
            select 1
            from labels replacement
            where replacement.project_id = labels.project_id
              and replacement.name = ${newNameSql}
              and replacement.id <> labels.id
          )`
    ];
  });
}

const migrations: Migration[] = [
  {
    id: "0001_initial_schema",
    statements: [
      "pragma foreign_keys = on",
      `create table if not exists schema_migrations (
        id text primary key,
        applied_at text not null
      )`,
      `create table if not exists projects (
        id text primary key,
        name text not null,
        repo_path text not null unique,
        default_branch text not null default 'main',
        locale text not null default 'en',
        created_at text not null,
        updated_at text not null
      )`,
      `create table if not exists app_settings (
        key text primary key,
        value_json text not null,
        created_at text not null,
        updated_at text not null
      )`,
      `create table if not exists project_commands (
        id integer primary key autoincrement,
        project_id text not null references projects(id) on delete cascade,
        command_type text not null,
        command text,
        detection_source text not null,
        detection_details_json text,
        is_required integer not null default 1,
        is_available integer not null default 0,
        last_detected_at text,
        created_at text not null,
        updated_at text not null,
        unique(project_id, command_type)
      )`,
      `create table if not exists issues (
        id integer primary key autoincrement,
        project_id text not null references projects(id) on delete cascade,
        title text not null,
        body text not null default '',
        status text not null default 'open',
        created_at text not null,
        updated_at text not null,
        closed_at text,
        deleted_at text
      )`,
      `create table if not exists pull_requests (
        id integer primary key autoincrement,
        project_id text not null references projects(id) on delete cascade,
        issue_id integer references issues(id) on delete set null,
        title text not null,
        body text not null default '',
        status text not null default 'open',
        source_branch text not null,
        target_branch text not null,
        created_at text not null,
        updated_at text not null,
        closed_at text,
        deleted_at text
      )`,
      `create table if not exists labels (
        id integer primary key autoincrement,
        project_id text not null references projects(id) on delete cascade,
        name text not null,
        color text not null,
        kind text not null default 'custom',
        description text not null default '',
        created_at text not null,
        updated_at text not null,
        deleted_at text,
        unique(project_id, name)
      )`,
      `create table if not exists issue_labels (
        issue_id integer not null references issues(id) on delete cascade,
        label_id integer not null references labels(id) on delete cascade,
        created_at text not null,
        primary key(issue_id, label_id)
      )`,
      `create table if not exists pull_request_labels (
        pull_request_id integer not null references pull_requests(id) on delete cascade,
        label_id integer not null references labels(id) on delete cascade,
        created_at text not null,
        primary key(pull_request_id, label_id)
      )`,
      `create table if not exists comments (
        id integer primary key autoincrement,
        project_id text not null references projects(id) on delete cascade,
        target_type text not null,
        target_id integer not null,
        author_type text not null,
        agent_type text,
        body text not null,
        metadata_json text,
        created_at text not null,
        updated_at text not null
      )`,
      `create table if not exists agent_jobs (
        id integer primary key autoincrement,
        project_id text not null references projects(id) on delete cascade,
        agent_type text not null,
        target_type text not null,
        target_id integer not null,
        status text not null default 'queued',
        trigger_type text not null default 'manual',
        parent_job_id integer references agent_jobs(id) on delete set null,
        input_json text not null,
        output_json text,
        error text,
        attempt integer not null default 1,
        lock_key text,
        created_at text not null,
        started_at text,
        finished_at text
      )`,
      `create table if not exists agent_activities (
        id integer primary key autoincrement,
        project_id text not null references projects(id) on delete cascade,
        agent_job_id integer references agent_jobs(id) on delete set null,
        target_type text not null,
        target_id integer not null,
        activity_type text not null,
        title text not null,
        body text not null default '',
        payload_json text,
        created_at text not null
      )`,
      `create table if not exists repository_events (
        id integer primary key autoincrement,
        project_id text not null references projects(id) on delete cascade,
        event_type text not null,
        source_branch text,
        target_branch text,
        payload_json text,
        created_at text not null
      )`,
      "create index if not exists idx_issues_project_status_updated on issues(project_id, status, updated_at desc) where deleted_at is null",
      "create index if not exists idx_pull_requests_project_status_updated on pull_requests(project_id, status, updated_at desc) where deleted_at is null",
      "create index if not exists idx_comments_target_created on comments(project_id, target_type, target_id, created_at asc)",
      "create index if not exists idx_agent_jobs_target_status on agent_jobs(project_id, target_type, target_id, status, created_at desc)",
      "create index if not exists idx_agent_jobs_lock_status on agent_jobs(project_id, lock_key, status, created_at asc)",
      "create index if not exists idx_agent_activities_target_created on agent_activities(project_id, target_type, target_id, created_at asc)",
      "create index if not exists idx_agent_activities_job_created on agent_activities(agent_job_id, created_at asc)",
      "create index if not exists idx_repository_events_project_created on repository_events(project_id, created_at desc)"
    ]
  },
  {
    id: "0002_agent_job_lock_index",
    statements: [
      "create index if not exists idx_agent_jobs_lock_status on agent_jobs(project_id, lock_key, status, created_at asc)"
    ]
  },
  {
    id: "0003_english_system_labels",
    statements: renameWorkflowLabelStatements()
  },
  {
    id: "0004_loop_engineering_tables",
    statements: [
      `create table if not exists loops (
        id integer primary key autoincrement,
        project_id text not null references projects(id) on delete cascade,
        name text not null,
        purpose text not null default '',
        trigger_type text not null default 'manual',
        cadence text,
        target_scope text not null default 'project',
        status text not null default 'enabled',
        max_rounds integer not null default 3,
        time_budget_minutes integer,
        cost_budget integer,
        stop_condition_json text,
        risk_policy_json text,
        created_at text not null,
        updated_at text not null
      )`,
      `create table if not exists loop_runs (
        id integer primary key autoincrement,
        project_id text not null references projects(id) on delete cascade,
        loop_id integer not null references loops(id) on delete cascade,
        status text not null default 'queued',
        trigger_type text not null default 'manual',
        target_type text,
        target_id integer,
        worktree_path text,
        summary text not null default '',
        stop_reason text,
        evidence_json text,
        created_at text not null,
        started_at text,
        finished_at text
      )`,
      `create table if not exists loop_steps (
        id integer primary key autoincrement,
        project_id text not null references projects(id) on delete cascade,
        loop_run_id integer not null references loop_runs(id) on delete cascade,
        agent_job_id integer references agent_jobs(id) on delete set null,
        agent_type text not null,
        target_type text not null,
        target_id integer not null,
        status text not null default 'queued',
        input_json text,
        output_json text,
        evidence_json text,
        created_at text not null,
        updated_at text not null
      )`,
      `create table if not exists loop_memory_entries (
        id integer primary key autoincrement,
        project_id text not null references projects(id) on delete cascade,
        loop_id integer references loops(id) on delete set null,
        loop_run_id integer references loop_runs(id) on delete set null,
        source_type text not null,
        source_id integer,
        title text not null,
        body text not null default '',
        tags_json text not null default '[]',
        created_at text not null,
        updated_at text not null
      )`,
      `create table if not exists triage_items (
        id integer primary key autoincrement,
        project_id text not null references projects(id) on delete cascade,
        source_type text not null,
        source_id integer,
        title text not null,
        body text not null default '',
        status text not null default 'open',
        priority text not null default 'normal',
        metadata_json text,
        issue_id integer references issues(id) on delete set null,
        created_at text not null,
        updated_at text not null
      )`,
      "create index if not exists idx_loops_project_status on loops(project_id, status, updated_at desc)",
      "create index if not exists idx_loop_runs_project_status on loop_runs(project_id, status, created_at desc)",
      "create index if not exists idx_loop_steps_run_created on loop_steps(loop_run_id, created_at asc)",
      "create index if not exists idx_loop_memory_project_created on loop_memory_entries(project_id, created_at desc)",
      "create index if not exists idx_triage_items_project_status on triage_items(project_id, status, created_at desc)"
    ]
  },
  {
    id: "0005_agent_job_ai_provider",
    statements: ["alter table agent_jobs add column ai_provider text not null default 'codex'"]
  },
  {
    id: "0006_ready_to_merge_label",
    statements: [
      `insert or ignore into labels (project_id, name, color, kind, description, created_at, updated_at)
        select id,
               'ready-to-merge',
               '#1a7f37',
               'system',
               'Pull request is verified and ready to merge.',
               ${migrationTimestamp},
               ${migrationTimestamp}
        from projects`
    ]
  },
  {
    id: "0007_objective_runs_and_comment_format",
    statements: [
      "alter table comments add column body_format text not null default 'markdown'",
      `create table if not exists objective_runs (
        id integer primary key autoincrement,
        project_id text not null references projects(id) on delete cascade,
        issue_id integer references issues(id) on delete set null,
        pull_request_id integer references pull_requests(id) on delete set null,
        status text not null default 'open',
        title text not null,
        goal text not null default '',
        round_count integer not null default 0,
        max_rounds integer not null default 12,
        last_agent_job_id integer references agent_jobs(id) on delete set null,
        judge_agent_job_id integer references agent_jobs(id) on delete set null,
        generator_ai_provider text,
        judge_ai_provider text,
        last_failure_signature text,
        repeated_failure_count integer not null default 0,
        stop_reason text,
        evidence_json text,
        summary text not null default '',
        created_at text not null,
        updated_at text not null,
        finished_at text
      )`,
      "create index if not exists idx_objective_runs_issue on objective_runs(project_id, issue_id, updated_at desc)",
      "create index if not exists idx_objective_runs_pull_request on objective_runs(project_id, pull_request_id, updated_at desc)",
      "create index if not exists idx_objective_runs_project_status on objective_runs(project_id, status, updated_at desc)"
    ]
  },
  {
    id: "0008_provider_wait_state",
    statements: [
      "alter table agent_jobs add column wait_reason text",
      "alter table agent_jobs add column wait_metadata_json text",
      "alter table agent_jobs add column next_retry_at text",
      "create index if not exists idx_agent_jobs_provider_wait on agent_jobs(status, next_retry_at)"
    ]
  },
  {
    id: "0009_objective_workflow_stage",
    statements: [
      "alter table objective_runs add column workflow_stage text not null default 'requirements'",
      `update objective_runs
        set workflow_stage = case
          when status = 'ready_to_merge' then 'ready_to_merge'
          when status = 'succeeded' then 'merged'
          when pull_request_id is not null then 'review'
          else 'requirements'
        end`
    ]
  },
  {
    id: "0010_work_item_author_type",
    statements: [
      "alter table issues add column created_by_type text not null default 'user'",
      "alter table pull_requests add column created_by_type text not null default 'user'"
    ]
  },
  {
    id: "0011_comment_revisions",
    statements: [
      `create table if not exists comment_revisions (
        id integer primary key autoincrement,
        project_id text not null references projects(id) on delete cascade,
        comment_id integer not null references comments(id) on delete cascade,
        editor_type text not null,
        body text not null,
        body_format text not null default 'markdown',
        created_at text not null
      )`,
      "create index if not exists idx_comment_revisions_comment_created on comment_revisions(project_id, comment_id, created_at desc)"
    ]
  },
  {
    id: "0012_activity_occurrences",
    statements: [
      "alter table agent_activities add column occurrence_count integer not null default 1",
      "alter table agent_activities add column last_occurred_at text",
      "update agent_activities set last_occurred_at = created_at where last_occurred_at is null"
    ]
  },
  {
    id: "0013_objective_evidence_requirements",
    statements: [
      "alter table objective_runs add column evidence_requirements_json text not null default '[]'"
    ]
  },
  {
    id: "0014_agent_job_ai_model",
    statements: [
      "alter table agent_jobs add column ai_model text",
      `update agent_jobs
        set ai_model = case ai_provider
          when 'claude_code' then json_extract((select value_json from app_settings where key = 'ai'), '$.claudeCode.model')
          when 'lm_studio' then json_extract((select value_json from app_settings where key = 'ai'), '$.lmStudio.model')
          else json_extract((select value_json from app_settings where key = 'ai'), '$.codex.model')
        end
        where exists (select 1 from app_settings where key = 'ai' and json_valid(value_json))`
    ]
  },
  {
    id: "0015_objective_provider_usage",
    statements: [
      "alter table objective_runs add column token_budget integer",
      "alter table objective_runs add column cost_budget_usd real",
      "alter table objective_runs add column provider_usage_json text not null default '{}'"
    ]
  },
  {
    id: "0016_development_loops",
    statements: [
      `create table development_loops (
        id integer primary key autoincrement, project_id text not null references projects(id), issue_id integer not null references issues(id),
        pull_request_id integer references pull_requests(id), objective_id integer references objective_runs(id),
        phase text not null, status text not null, current_job_id integer references agent_jobs(id),
        merge_commit text, source_commit text, target_commit text, next_agent text not null default 'requirements', failures integer not null default 0, summary text not null default '', rounds integer not null default 0,
        created_at text not null, updated_at text not null, finished_at text
      )`,
      `create unique index development_loop_active_issue on development_loops(project_id, issue_id)
        where status not in ('succeeded', 'canceled')`,
      `create unique index development_loop_pr on development_loops(project_id, pull_request_id) where pull_request_id is not null`,
      `create table agent_executions (
        id integer primary key autoincrement, project_id text not null references projects(id), job_id integer not null references agent_jobs(id),
        selected_model text not null, resolved_model text, effort text, selection_reason text not null, policy_version text not null,
        thread_id text, turn_id text, status text not null, usage_json text, started_at text not null, finished_at text
      )`,
      `create index agent_executions_job on agent_executions(project_id, job_id)`,
      `create table retrospectives (
        id integer primary key autoincrement, project_id text not null references projects(id), loop_id integer not null references development_loops(id),
        merge_commit text not null, summary text not null, body text not null, changes_json text not null,
        status text not null, error text, created_at text not null, applied_at text, unique(project_id, loop_id)
      )`,
      `create table knowledge_revisions (
        id integer primary key autoincrement, project_id text not null references projects(id), loop_id integer not null references development_loops(id),
        path text not null, before_body text, after_body text, reason text not null, status text not null, created_at text not null,
        unique(project_id, loop_id, path)
      )`
    ]
  }
];

export async function runMigrations(client: Client): Promise<void> {
  await client.execute("pragma busy_timeout = 5000");
  await client.execute("pragma journal_mode = WAL");
  await client.execute("pragma foreign_keys = on");
  await client.execute(`create table if not exists schema_migrations (
    id text primary key,
    applied_at text not null
  )`);

  for (const migration of migrations) {
    const existing = await client.execute({
      sql: "select id from schema_migrations where id = ?",
      args: [migration.id]
    });

    if (existing.rows.length > 0) {
      continue;
    }

    await client.batch([
      ...migration.statements.map((sql) => ({ sql, args: [] })),
      { sql: "insert into schema_migrations (id, applied_at) values (?, ?)", args: [migration.id, new Date().toISOString()] }
    ], "write");
  }
}
