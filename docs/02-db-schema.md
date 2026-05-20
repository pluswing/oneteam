# DB schema 詳細

## 1. 目的

libSQL に保存するデータ構造を定義する。MVP 実装では、この schema を基準に migration、repository layer、API response を実装する。

## 2. 基本方針

- database は one team instance ごとに 1 つ。
- one team instance は 1 repository を管理するが、将来の拡張余地として `project_id` を各 table に持つ。
- datetime は ISO 8601 text として保存する。
- boolean は `0` / `1` integer として保存する。
- issue / pull request / label は論理削除し、`deleted_at is null` を通常 query の条件に含める。
- user-generated content は Markdown text として保存する。
- JSON は text column に JSON string として保存する。

## 3. Enum

### 3.1 Issue Status

- `open`
- `closed`

### 3.2 Pull Request Status

- `open`
- `closed`

### 3.3 Label Kind

- `system`
- `custom`

### 3.4 Agent Type

- `requirements`
- `implementation`
- `review`
- `fix`
- `qa`
- `command_detection`

### 3.5 Agent Job Status

- `queued`
- `running`
- `waiting_human`
- `succeeded`
- `failed`
- `canceled`

### 3.6 Activity Type

- `thinking`
- `progress`
- `command`
- `file_change`
- `test`
- `error`
- `system`

## 4. Tables

### 4.1 projects

管理対象 repository。

```sql
create table projects (
  id text primary key,
  name text not null,
  repo_path text not null unique,
  default_branch text not null default 'main',
  locale text not null default 'en',
  created_at text not null,
  updated_at text not null
);
```

### 4.2 app_settings

one team 自体の設定。設定ファイルを正としつつ、UI から参照しやすい値を DB にも保存する。

```sql
create table app_settings (
  key text primary key,
  value_json text not null,
  created_at text not null,
  updated_at text not null
);
```

保存例:

- `server`
- `database`
- `ai`
- `i18n`
- `commandDetection`

### 4.3 project_commands

repository で利用する install / dev / build / test / lint command。

```sql
create table project_commands (
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
);
```

`command_type`:

- `install`
- `dev`
- `build`
- `test`
- `lint`

`detection_source`:

- `package_json`
- `lock_file`
- `config`
- `manual`
- `agent`
- `missing`

### 4.4 issues

```sql
create table issues (
  id integer primary key autoincrement,
  project_id text not null references projects(id) on delete cascade,
  title text not null,
  body text not null default '',
  status text not null default 'open',
  created_at text not null,
  updated_at text not null,
  closed_at text,
  deleted_at text
);
```

### 4.5 pull_requests

one team 内のローカル PR。

```sql
create table pull_requests (
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
);
```

### 4.6 labels

```sql
create table labels (
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
);
```

### 4.7 issue_labels

```sql
create table issue_labels (
  issue_id integer not null references issues(id) on delete cascade,
  label_id integer not null references labels(id) on delete cascade,
  created_at text not null,
  primary key(issue_id, label_id)
);
```

### 4.8 pull_request_labels

```sql
create table pull_request_labels (
  pull_request_id integer not null references pull_requests(id) on delete cascade,
  label_id integer not null references labels(id) on delete cascade,
  created_at text not null,
  primary key(pull_request_id, label_id)
);
```

### 4.9 comments

issue / pull request の conversation。

```sql
create table comments (
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
);
```

`target_type`:

- `issue`
- `pull_request`

`author_type`:

- `user`
- `agent`
- `system`

### 4.10 agent_jobs

AI agent の実行単位。

```sql
create table agent_jobs (
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
);
```

`trigger_type`:

- `manual`
- `label_changed`
- `comment_created`
- `job_completed`
- `repository_imported`
- `conflict_detected`

### 4.11 agent_activities

コメントとは別に保存する作業ログ。

```sql
create table agent_activities (
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
);
```

注意:

- `thinking` は raw chain-of-thought ではなく、表示可能な作業メモ・判断要約を保存する。
- `command` は command、cwd、exitCode、durationMs、stdout excerpt、stderr excerpt を `payload_json` に保存する。
- `file_change` は changed files と summary を保存する。

### 4.12 repository_events

repository に対する重要イベント。merge conflict 検出などを記録する。

```sql
create table repository_events (
  id integer primary key autoincrement,
  project_id text not null references projects(id) on delete cascade,
  event_type text not null,
  source_branch text,
  target_branch text,
  payload_json text,
  created_at text not null
);
```

`event_type` 例:

- `imported`
- `command_detected`
- `command_missing`
- `branch_created`
- `conflict_detected`
- `conflict_resolved`

## 5. Indexes

```sql
create index idx_issues_project_status_updated
  on issues(project_id, status, updated_at desc)
  where deleted_at is null;

create index idx_pull_requests_project_status_updated
  on pull_requests(project_id, status, updated_at desc)
  where deleted_at is null;

create index idx_comments_target_created
  on comments(project_id, target_type, target_id, created_at asc);

create index idx_agent_jobs_target_status
  on agent_jobs(project_id, target_type, target_id, status, created_at desc);

create index idx_agent_activities_target_created
  on agent_activities(project_id, target_type, target_id, created_at asc);

create index idx_agent_activities_job_created
  on agent_activities(agent_job_id, created_at asc);

create index idx_repository_events_project_created
  on repository_events(project_id, created_at desc);
```

## 6. Seed Data

project 作成時に system labels を投入する。

### 6.1 Issue Labels

| name | color |
| --- | --- |
| `要件定義中` | `#0969da` |
| `確認待ち` | `#bf8700` |
| `実装待ち` | `#1a7f37` |
| `実装中` | `#8250df` |
| `PR作成済み` | `#0969da` |
| `完了` | `#1a7f37` |

### 6.2 Pull Request Labels

| name | color |
| --- | --- |
| `レビュー中` | `#0969da` |
| `修正中` | `#cf222e` |
| `コンフリクト修正中` | `#cf222e` |
| `テスト中` | `#8250df` |
| `確認待ち` | `#bf8700` |
| `完了` | `#1a7f37` |

MVP では labels table は issue / PR 共通で扱う。必要であれば `description` に intended target を保存する。

## 7. Query Rules

### 7.1 論理削除

通常 list / detail query は以下を条件に含める。

```sql
where deleted_at is null
```

削除操作は次の更新を行う。

```sql
update issues
set deleted_at = :now, updated_at = :now
where id = :issueId and project_id = :projectId;
```

### 7.2 Comment と Activity の違い

| 種別 | 保存先 | ユーザーへの意味 |
| --- | --- | --- |
| Comment | `comments` | 会話、質問、回答、レビュー結果、QA 結果 |
| Activity | `agent_activities` | AI の作業進捗、判断要約、コマンド、テスト、ファイル変更 |

### 7.3 Agent Lock

同じ対象に対する破壊的 job は同時実行しない。

`lock_key` 例:

```text
project:{projectId}:issue:{issueId}:write
project:{projectId}:pull_request:{pullRequestId}:write
```

実装では DB transaction で `running` job の存在を確認してから job を開始する。
