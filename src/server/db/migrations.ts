import type { Client } from "@libsql/client";

type Migration = {
  id: string;
  statements: string[];
};

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
      "create index if not exists idx_agent_activities_target_created on agent_activities(project_id, target_type, target_id, created_at asc)",
      "create index if not exists idx_agent_activities_job_created on agent_activities(agent_job_id, created_at asc)",
      "create index if not exists idx_repository_events_project_created on repository_events(project_id, created_at desc)"
    ]
  }
];

export async function runMigrations(client: Client): Promise<void> {
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

    for (const statement of migration.statements) {
      await client.execute(statement);
    }

    await client.execute({
      sql: "insert into schema_migrations (id, applied_at) values (?, ?)",
      args: [migration.id, new Date().toISOString()]
    });
  }
}
