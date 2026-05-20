# one team 要件定義

## 1. 目的

one team は、単独開発者がローカル環境で AI と協調しながら開発を進めるための開発支援ツールである。

GitHub の issue / pull request に近い UI とワークフローを持ち、issue に書かれた要望から AI が要件定義、実装、テスト、pull request 作成、レビュー、修正、QA までを半自動で進める。

## 2. 現時点の実装前提

この要件定義では、`CONCEPT.md` だけでは未確定な部分について、実装可能にするため次の前提を置く。

- one team はローカルで起動する Web アプリケーションとする。
- 利用者は単独開発者 1 名であり、MVP ではユーザー認証・権限管理は実装しない。
- GitHub 連携ではなく、GitHub ライクな issue / pull request 体験をローカルに実装する。
- pull request は実 GitHub PR ではなく、ローカル Git ブランチ間の差分・レビュー対象を表す one team 内の概念とする。
- one team は 1 インスタンスにつき 1 つの Git repository を管理する。複数 repository を扱う場合は one team を別インスタンスとして起動する。
- データベースは libSQL を使用する。
- Docker は使用しない。
- Node.js と git がインストールされていれば起動できる構成にする。
- AI 実行基盤は Codex CLI を主想定とする。
- AI 実行基盤は将来的に差し替え可能な adapter として設計する。
- AI によるファイル変更やコマンド実行は対象 repository 配下に限定する。
- 破壊的操作、外部送信、長時間実行コマンドはユーザー確認を挟める設計にする。
- AI が質問して `waiting_human` になった場合、ユーザー回答コメントの投稿を契機に自動再開する。

## 3. MVP のゴール

MVP では、単独開発者が次の一連の流れをローカル UI から実行できる状態を目標とする。

1. repository を one team に登録する。
2. issue を作成する。
3. 要件定義エージェントが issue を読み、不明点をコメントする。
4. ユーザーがコメントで回答する。
5. 要件が確定したら、AI が要件定義コメントを作成する。
6. 実装エージェントがブランチを作成し、要件に沿って実装する。
7. 実装完了後、one team 内に pull request を作成する。
8. レビューエージェントが pull request をレビューする。
9. 指摘があれば修正エージェントが対応し、再レビューする。
10. QA エージェントがテスト・UI 確認を行う。
11. 問題がなければ pull request を完了状態にする。

## 4. MVP で扱わない範囲

- 複数ユーザー・チーム機能
- 実 GitHub / GitLab への issue / pull request 同期
- リモート CI 連携
- 複数 repository 管理
- クラウドホスティング前提の運用
- Docker 前提の実行環境
- 高度な権限管理
- スマートフォン向けの専用 UI

## 5. 用語

| 用語 | 意味 |
| --- | --- |
| Project | one team に登録された管理対象 repository |
| Issue | 実装したい内容、バグ、改善などを記録する単位 |
| Pull Request | 実装ブランチとベースブランチの差分を確認・レビューする単位 |
| Comment | issue / pull request に紐づく会話、AI の質問、ユーザー回答、状態報告 |
| Label | issue / pull request の状態や AI の次作業を表すタグ |
| Agent Job | AI エージェントに実行させる 1 回分の処理 |
| Human Gate | AI が人間の回答や承認を待って停止している状態 |

## 6. 全体ワークフロー

### 6.1 Issue から Pull Request まで

1. ユーザーが issue を作成する。
2. ユーザー、または自動ルールにより `要件定義中` label が付与される。
3. 要件定義エージェントが起動する。
4. 要件定義エージェントは issue 本文、コメント、repository の現状を確認する。
5. 不明点がある場合、issue コメントに質問を書き、Agent Job を `waiting_human` にする。
6. ユーザーが回答すると、要件定義エージェントが自動再開する。
7. 不明点が解消されたら、要件定義エージェントが要件定義コメントを投稿する。
8. issue の label を `実装待ち` に変更する。
9. 実装エージェントが起動し、実装ブランチを作成する。
10. 実装エージェントはファイル変更、テスト追加、テスト実行を行う。
11. 実装中に不明点が出た場合、issue コメントで質問し、Human Gate に入る。
12. 実装完了後、one team 内に pull request を作成する。
13. pull request に `レビュー中` label を付与する。
14. レビューエージェントがレビューする。
15. 指摘があれば pull request コメントに記録し、`修正中` label に変更する。
16. 修正エージェントが指摘を修正し、テスト後に `レビュー中` に戻す。
17. レビュー指摘がなくなったら `テスト中` label に変更する。
18. QA エージェントが UI を含む動作確認を実施する。
19. 不具合があれば pull request コメントに記録し、`修正中` に戻す。
20. 問題がなければ検証結果をコメントし、pull request と issue に `完了` label を付与する。

### 6.2 手動操作

ユーザーはいつでも次の操作を行える。

- issue / pull request の作成、編集、削除
- Open / Closed の変更
- label の付け外し
- コメント投稿
- AI ジョブの開始、停止、再実行
- Human Gate への回答
- pull request 差分の確認
- pull request の完了、または差し戻し

## 7. UI 要件

### 7.1 共通

- GitHub の issue / pull request 体験に近い情報設計にする。
- 左または上部に主要ナビゲーションを置く。
- 主要ページは Issues、Pull Requests、Repository、Settings とする。
- issue / pull request の一覧では、状態、label、更新日時、コメント数を確認できる。
- 詳細ページでは本文、コメント timeline、label、状態、関連 pull request / issue を確認できる。
- AI のコメントとユーザーのコメントは視覚的に区別できるようにする。
- AI ジョブの実行中、待機中、失敗、完了が分かる表示を用意する。
- UI ポートは設定ファイルで指定できる。

### 7.2 Issues

#### 一覧

- Open / Closed の切り替えができる。
- label で絞り込みできる。
- キーワード検索ができる。
- 作成日時、更新日時で並び替えできる。
- 新規 issue 作成ボタンを表示する。

#### 詳細

- title、body、status、labels を表示する。
- title、body、status、labels を編集できる。
- コメントを時系列で表示する。
- コメントを投稿できる。
- 関連する pull request があれば表示する。
- AI による次アクションを実行できる。

#### 作成・編集

- title は必須。
- body は任意だが、AI が要件定義しやすいよう Markdown 入力にする。
- label は複数選択可能にする。

### 7.3 Pull Requests

#### 一覧

- Open / Closed の切り替えができる。
- label で絞り込みできる。
- source branch、target branch を表示する。
- 関連 issue を表示する。
- コメント数、変更ファイル数、コミット数を表示する。

#### 詳細

- title、body、status、labels を表示する。
- source branch、target branch を表示する。
- 関連 issue を表示する。
- コメント timeline を表示する。
- コミット一覧を表示する。
- 変更ファイル一覧を表示する。
- ファイルごとの差分を表示する。
- レビュー結果、QA 結果をコメントとして確認できる。

## 8. Label / Status 要件

### 8.1 Issue Status

- `Open`
- `Closed`

### 8.2 Issue System Labels

| Label | 意味 | 主な担当 |
| --- | --- | --- |
| `要件定義中` | 要件定義エージェントが確認中 | 要件定義エージェント |
| `確認待ち` | 人間の回答待ち | ユーザー |
| `実装待ち` | 要件確定済み、実装開始待ち | 実装エージェント |
| `実装中` | 実装中 | 実装エージェント |
| `PR作成済み` | pull request が作成された | 実装エージェント |
| `完了` | 対応完了 | QA エージェント / ユーザー |

### 8.3 Pull Request Status

- `Open`
- `Closed`

### 8.4 Pull Request System Labels

| Label | 意味 | 主な担当 |
| --- | --- | --- |
| `レビュー中` | レビューエージェントが確認中 | レビューエージェント |
| `修正中` | 指摘修正中 | 修正エージェント |
| `テスト中` | QA 実施中 | QA エージェント |
| `確認待ち` | 人間の回答・承認待ち | ユーザー |
| `完了` | 検証完了 | QA エージェント / ユーザー |

### 8.5 Agent Job Status

| Status | 意味 |
| --- | --- |
| `queued` | 実行待ち |
| `running` | 実行中 |
| `waiting_human` | 人間の入力待ち |
| `succeeded` | 正常終了 |
| `failed` | 失敗 |
| `canceled` | キャンセル済み |

## 9. AI エージェント要件

### 9.1 共通要件

- 各エージェントは Agent Job として実行履歴を残す。
- 各エージェントは入力、実行ログ、出力、失敗理由を保存する。
- 同じ issue / pull request に対して同時に複数の破壊的 Agent Job が走らないよう lock する。
- エージェントは作業開始、質問、完了、失敗をコメントに投稿する。
- エージェントは不明点がある場合、人間に質問して `waiting_human` で停止する。
- 人間の回答後、同じ Agent Job を再開、または後続 Job を作成する。
- エージェントの出力は Markdown で保存し、UI で読みやすく表示する。
- AI 実行 adapter は設定で切り替え可能にする。

### 9.2 要件定義エージェント

#### 起動条件

- issue に `要件定義中` label が付与されたとき。
- ユーザーが issue 詳細から手動実行したとき。
- `waiting_human` の質問にユーザーが回答したとき。

#### 入力

- issue title
- issue body
- issue comments
- issue labels
- repository のファイル構成
- 必要に応じた関連ファイルの内容

#### 処理

- issue の実現したい内容を読み取る。
- 曖昧な要件、矛盾、既存コードとの不整合、テスト観点の不足を洗い出す。
- ユーザー確認が必要な点を質問としてコメントする。
- 確認が不要な軽微な不明点は、合理的な前提として要件定義に明記する。
- 全ての確認事項が解消されたら、要件定義コメントを投稿する。

#### 出力

要件定義コメントには次を含める。

- 背景・目的
- 実装対象
- 実装対象外
- UI / API / データ変更
- 状態遷移
- 受け入れ条件
- テスト観点
- 未解決リスク
- 実装エージェントへの指示

### 9.3 実装エージェント

#### 起動条件

- issue に `実装待ち` label が付与されたとき。
- ユーザーが手動実行したとき。

#### 入力

- issue
- 要件定義コメント
- repository の現状
- 設定された build / test / lint コマンド

#### 処理

- 作業ブランチを作成する。
- 既存コードを確認する。
- 要件に沿って実装する。
- 必要なテストを追加・更新する。
- build / test / lint を実行する。
- 不明点が出た場合、issue コメントで質問し Human Gate に入る。
- 実装完了後、pull request を作成する。

#### ブランチ命名

MVP では次の形式を標準とする。

```text
oneteam/issue-{issueId}-{slug}
```

#### 出力

- 実装概要コメント
- 変更ファイル一覧
- 実行したテストと結果
- 作成した pull request

### 9.4 レビューエージェント

#### 起動条件

- pull request に `レビュー中` label が付与されたとき。
- 修正エージェント完了後に再レビューが必要なとき。
- ユーザーが手動実行したとき。

#### 入力

- pull request title / body
- 関連 issue
- 要件定義コメント
- commit 一覧
- 変更差分
- テスト結果

#### 処理

- 要件を満たしているか確認する。
- 既存コードの設計・規約に反していないか確認する。
- バグ、仕様漏れ、テスト不足、保守性の問題を指摘する。
- 問題がある場合、指摘を pull request コメントに投稿し `修正中` label に変更する。
- 問題がない場合、`テスト中` label に変更して QA エージェントへ渡す。

#### 出力

レビューコメントには次を含める。

- 判定: `修正必要` または `問題なし`
- 指摘一覧
- 影響範囲
- 推奨修正方針
- 確認済み観点

### 9.5 修正エージェント

#### 起動条件

- pull request に `修正中` label が付与されたとき。
- レビューまたは QA で指摘が投稿されたとき。

#### 入力

- pull request
- 指摘コメント
- 変更差分
- repository の現状

#### 処理

- 指摘内容を理解する。
- 必要な修正を行う。
- テストを追加・更新する。
- build / test / lint を実行する。
- 修正完了コメントを投稿する。
- `レビュー中` label に戻す。

#### 出力

- 修正概要
- 対応した指摘一覧
- 変更ファイル一覧
- 実行したテストと結果

### 9.6 QA エージェント

#### 起動条件

- pull request に `テスト中` label が付与されたとき。
- ユーザーが手動実行したとき。

#### 入力

- pull request
- 関連 issue
- 要件定義コメント
- build / test / dev server コマンド
- 変更差分

#### 処理

- 実行環境を用意する。
- 必要に応じて dev server を起動する。
- unit / integration / e2e のうち、変更内容に応じた確認を実行する。
- UI 変更がある場合、Playwright などで画面確認を行う。
- 不具合があれば pull request コメントに詳細を投稿し `修正中` label に変更する。
- 問題がなければ QA 結果を投稿し `完了` label を付与する。

#### 出力

- QA 判定
- 実行した確認内容
- 実行コマンド
- UI 確認結果
- 不具合一覧
- 残リスク

## 10. Git / Repository 要件

### 10.1 Repository 登録

MVP では次のどちらかで repository を登録できる。

- 既存 repository のパスを指定してインポートする。
- one team 管理ディレクトリ内に新規 repository を作成する。

### 10.2 Git 操作

- 現在の branch、変更状態、commit 一覧を取得できる。
- issue 実装時に作業 branch を作成できる。
- pull request 詳細で source branch と target branch の差分を表示できる。
- 変更ファイル一覧を表示できる。
- ファイル単位の diff を表示できる。
- commit 一覧を表示できる。

### 10.3 Safety

- AI が Git 操作を行う前に対象 repository を明示する。
- 未コミット変更がある場合、実装開始前に検出して扱いを決める。
- MVP では、ユーザーの未コミット変更がある場合は原則として実装エージェントを停止し、コメントで確認する。
- `git reset --hard`、`git clean`、force push 相当の破壊的操作は標準では実行しない。

## 11. データ要件

### 11.1 Config File

設定ファイルは repository 外、または one team 管理ディレクトリに保存する。

例:

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 3579
  },
  "workspace": {
    "rootDir": "~/.oneteam/workspaces"
  },
  "database": {
    "url": "file:~/.oneteam/oneteam.db"
  },
  "ai": {
    "provider": "adapter-name",
    "model": "model-name"
  },
  "commands": {
    "install": "npm install",
    "dev": "npm run dev",
    "build": "npm run build",
    "test": "npm test",
    "lint": "npm run lint"
  }
}
```

### 11.2 Tables

MVP で必要な主な table は次の通り。

#### projects

| Column | Type | 備考 |
| --- | --- | --- |
| id | text | primary key |
| name | text | 表示名 |
| repo_path | text | ローカル repository path |
| default_branch | text | 例: `main` |
| created_at | datetime | 作成日時 |
| updated_at | datetime | 更新日時 |

#### issues

| Column | Type | 備考 |
| --- | --- | --- |
| id | integer | primary key |
| project_id | text | projects.id |
| title | text | 必須 |
| body | text | Markdown |
| status | text | `open` / `closed` |
| created_at | datetime | 作成日時 |
| updated_at | datetime | 更新日時 |
| closed_at | datetime | nullable |

#### pull_requests

| Column | Type | 備考 |
| --- | --- | --- |
| id | integer | primary key |
| project_id | text | projects.id |
| issue_id | integer | nullable |
| title | text | 必須 |
| body | text | Markdown |
| status | text | `open` / `closed` |
| source_branch | text | 実装 branch |
| target_branch | text | base branch |
| created_at | datetime | 作成日時 |
| updated_at | datetime | 更新日時 |
| closed_at | datetime | nullable |

#### labels

| Column | Type | 備考 |
| --- | --- | --- |
| id | integer | primary key |
| project_id | text | projects.id |
| name | text | label 名 |
| color | text | 表示色 |
| kind | text | `system` / `custom` |

#### issue_labels

| Column | Type | 備考 |
| --- | --- | --- |
| issue_id | integer | issues.id |
| label_id | integer | labels.id |

#### pull_request_labels

| Column | Type | 備考 |
| --- | --- | --- |
| pull_request_id | integer | pull_requests.id |
| label_id | integer | labels.id |

#### comments

| Column | Type | 備考 |
| --- | --- | --- |
| id | integer | primary key |
| project_id | text | projects.id |
| target_type | text | `issue` / `pull_request` |
| target_id | integer | issue または pull request id |
| author_type | text | `user` / `agent` / `system` |
| agent_type | text | nullable |
| body | text | Markdown |
| metadata_json | text | 任意の補足情報 |
| created_at | datetime | 作成日時 |
| updated_at | datetime | 更新日時 |

#### agent_jobs

| Column | Type | 備考 |
| --- | --- | --- |
| id | integer | primary key |
| project_id | text | projects.id |
| agent_type | text | `requirements` / `implementation` / `review` / `fix` / `qa` |
| target_type | text | `issue` / `pull_request` |
| target_id | integer | 対象 id |
| status | text | Agent Job Status |
| input_json | text | 実行入力 |
| output_json | text | 実行結果 |
| error | text | 失敗理由 |
| created_at | datetime | 作成日時 |
| started_at | datetime | nullable |
| finished_at | datetime | nullable |

## 12. API 要件

API は UI と同一 Node.js アプリケーションで提供する。

### 12.1 Projects

- `GET /api/projects`
- `POST /api/projects`
- `GET /api/projects/:projectId`
- `PATCH /api/projects/:projectId`

### 12.2 Issues

- `GET /api/projects/:projectId/issues`
- `POST /api/projects/:projectId/issues`
- `GET /api/projects/:projectId/issues/:issueId`
- `PATCH /api/projects/:projectId/issues/:issueId`
- `DELETE /api/projects/:projectId/issues/:issueId`
- `POST /api/projects/:projectId/issues/:issueId/comments`
- `GET /api/projects/:projectId/issues/:issueId/comments`

### 12.3 Pull Requests

- `GET /api/projects/:projectId/pull-requests`
- `POST /api/projects/:projectId/pull-requests`
- `GET /api/projects/:projectId/pull-requests/:pullRequestId`
- `PATCH /api/projects/:projectId/pull-requests/:pullRequestId`
- `DELETE /api/projects/:projectId/pull-requests/:pullRequestId`
- `POST /api/projects/:projectId/pull-requests/:pullRequestId/comments`
- `GET /api/projects/:projectId/pull-requests/:pullRequestId/comments`
- `GET /api/projects/:projectId/pull-requests/:pullRequestId/commits`
- `GET /api/projects/:projectId/pull-requests/:pullRequestId/files`
- `GET /api/projects/:projectId/pull-requests/:pullRequestId/diff`

### 12.4 Labels

- `GET /api/projects/:projectId/labels`
- `POST /api/projects/:projectId/labels`
- `PATCH /api/projects/:projectId/labels/:labelId`
- `DELETE /api/projects/:projectId/labels/:labelId`

### 12.5 Agent Jobs

- `GET /api/projects/:projectId/agent-jobs`
- `POST /api/projects/:projectId/agent-jobs`
- `GET /api/projects/:projectId/agent-jobs/:jobId`
- `POST /api/projects/:projectId/agent-jobs/:jobId/cancel`
- `POST /api/projects/:projectId/agent-jobs/:jobId/retry`

### 12.6 Repository

- `GET /api/projects/:projectId/repository/status`
- `GET /api/projects/:projectId/repository/branches`
- `GET /api/projects/:projectId/repository/commits`
- `GET /api/projects/:projectId/repository/files`

## 13. AI Adapter 要件

AI 実行基盤は Codex CLI を主想定とし、次の interface を満たす adapter として扱う。

```ts
type AgentRunInput = {
  projectId: string;
  agentType: "requirements" | "implementation" | "review" | "fix" | "qa";
  targetType: "issue" | "pull_request";
  targetId: number;
  prompt: string;
  context: AgentContext;
};

type AgentRunResult = {
  status: "succeeded" | "waiting_human" | "failed";
  message: string;
  questions?: string[];
  changedFiles?: string[];
  testResults?: AgentTestResult[];
  metadata?: Record<string, unknown>;
};
```

### 13.1 Adapter に求めること

- prompt と context を受け取り、結果を返す。
- 実装・修正系 agent は repository 配下のファイルを編集できる。
- 実行ログを取得できる。
- 失敗時に error message を返せる。
- MVP では Codex CLI adapter を実装する。
- 将来的に他の CLI 型、API 型、ローカルモデル型を差し替えられる。

## 14. 実装候補アーキテクチャ

実装時は次の構成を推奨する。

```text
apps/web        UI
apps/server     API / agent orchestration / git integration
packages/db     libSQL schema and repository layer
packages/agents agent prompts and adapter interface
packages/git    git operation wrapper
```

ただし MVP の初期実装では、過度な monorepo 化を避け、1 アプリ内に server / UI / db / agents を置いてもよい。

### 14.1 推奨技術

- Language: TypeScript
- Runtime: Node.js
- UI: React + Vite
- API: Fastify または Hono
- DB: libSQL
- ORM / query builder: Drizzle ORM または Kysely
- Git: child_process 経由の git command wrapper
- E2E: Playwright
- Unit test: Vitest

## 15. 受け入れ条件

### 15.1 基本起動

- Node.js と git がある環境でセットアップできる。
- Docker なしで起動できる。
- 設定ファイルで UI ポートを変更できる。
- libSQL database が初回起動時に作成される。

### 15.2 Issue

- issue を作成、編集、削除できる。
- issue を Open / Closed に変更できる。
- issue に label を付け外しできる。
- issue にコメントできる。
- issue 一覧で状態、label、コメント数、更新日時を確認できる。

### 15.3 Pull Request

- pull request を作成、編集、削除できる。
- pull request を Open / Closed に変更できる。
- pull request に label を付け外しできる。
- pull request にコメントできる。
- source branch と target branch の commit / file diff を確認できる。

### 15.4 AI Workflow

- `要件定義中` label から要件定義エージェントを起動できる。
- 要件定義エージェントは不明点をコメントし、人間の回答待ちにできる。
- 人間の回答後、要件定義を再開できる。
- 要件定義完了後、実装待ちに遷移できる。
- 実装エージェントは branch 作成、実装、テスト実行、pull request 作成を行える。
- レビューエージェントは pull request をレビューし、指摘または QA への遷移を行える。
- 修正エージェントは指摘を修正し、再レビューへ戻せる。
- QA エージェントはテスト結果をコメントし、完了または修正へ遷移できる。

## 16. 非機能要件

### 16.1 Portable

- ユーザーのローカルマシンで完結して動作する。
- Docker なしで動作する。
- 外部サービスへの依存は AI provider を除き最小化する。

### 16.2 Observability

- Agent Job の実行状態を UI で確認できる。
- 失敗時にエラー内容を UI で確認できる。
- agent の出力、実行コマンド、テスト結果を履歴として確認できる。

### 16.3 Safety

- AI が操作できる path を repository 配下に限定する。
- 未コミット変更を検出する。
- 危険な Git 操作はデフォルトで禁止する。
- ユーザー確認待ちの状態を明確に表示する。

### 16.4 Performance

- issue / pull request 一覧は 1000 件程度まで実用的に表示できる。
- 大きな diff はファイル単位で遅延読み込みできる設計にする。
- Agent Job の長時間実行中も UI がブロックされない。

## 17. 確定事項と未確認事項

### 17.1 確定事項

- AI 実行基盤は Codex CLI を主想定とする。
- pull request は one team 内だけのローカル概念とする。
- one team は 1 インスタンスにつき 1 repository を管理する。
- 複数 repository を扱いたい場合は one team を別に立ち上げる。
- AI の質問にユーザーが回答した場合、回答コメント投稿時に自動再開する。

### 17.2 未確認事項

実装前に優先して確認したい事項は次の通り。

1. AI がコマンド実行する際、どの操作にユーザー承認を必須にするか。
2. 実装完了後の merge 操作まで one team で扱うか。
3. issue / pull request の削除は物理削除でよいか、論理削除にするか。
4. UI は browser で開く Web アプリでよいか、将来的に Electron 等の desktop app 化を想定するか。
5. build / test / lint / dev server コマンドは設定ファイルで手動指定する形でよいか、自動検出も必要か。
6. Agent Job の実行ログはどの程度詳細に保存するか。
7. Codex CLI の認証情報や実行設定を one team 側でどこまで管理するか。
8. 日本語 UI を標準とするか、英語 UI / 多言語対応を最初から考慮するか。

## 18. 推奨する初期実装順

1. Node.js アプリケーションの土台作成
2. libSQL schema / migration
3. Project 登録
4. Issue CRUD / comments / labels
5. Pull Request CRUD / comments / labels
6. Git status / branch / commits / diff 表示
7. Agent Job queue と状態管理
8. 要件定義エージェント
9. 実装エージェント
10. レビューエージェント
11. 修正エージェント
12. QA エージェント
13. Playwright による UI QA

## 19. 次に作るとよい資料

- 画面一覧・ワイヤーフレーム
- DB schema 詳細
- Agent prompt template
- Agent Job state machine 図
- API request / response schema
- MVP タスク分解
