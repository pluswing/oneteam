# MVP タスク分解

Status: MVP 実装は完了済み。現在の完了状況は `docs/10-mvp-remaining-tasks.md`、手動確認手順は `docs/11-manual-e2e-checklist.md` を参照する。

## 1. 目的

one team MVP を実装するための順序、タスク、依存関係、受け入れ条件を定義する。

## 2. Definition of Done

各タスクは次を満たしたら完了とする。

- TypeScript の型チェックが通る。
- 関連 unit test が通る。
- UI 変更は Playwright または手動確認手順がある。
- 主要 API は error response を含む validation がある。
- DB migration が再実行可能。
- 固定 UI 文言は i18n resource key から参照される。

## 3. Milestones

すべての milestone は MVP 実装で完了済み。

### M0. Project Foundation

目的: 開発基盤を作る。

Tasks:

1. package manager と workspace 構成を決める。
2. TypeScript 設定を追加する。
3. React + Vite UI を作成する。
4. API server を作成する。
5. shared types を置く場所を決める。
6. lint / test / build command を用意する。

Acceptance:

- `install`、`dev`、`build`、`test`、`lint` 相当の command が実行できる。
- browser で空の AppShell が表示される。

### M1. DB / Migration

目的: libSQL schema と repository layer を作る。

Tasks:

1. libSQL client を導入する。
2. migration runner を実装する。
3. `projects`、`app_settings`、`project_commands` を作る。
4. `issues`、`pull_requests`、`labels`、junction tables を作る。
5. `comments`、`agent_jobs`、`agent_activities` を作る。
6. seed system labels を実装する。
7. repository layer の unit test を追加する。

Acceptance:

- 初回起動時に DB が作成される。
- migration を複数回実行しても壊れない。
- project 作成時に system labels が投入される。

### M2. Setup Wizard

目的: 初回起動で one team を設定できるようにする。

Tasks:

1. `/setup` route を作る。
2. repository import / create form を作る。
3. Codex CLI command path / model / full access 設定を作る。
4. locale と port 設定 UI を作る。
5. setup 完了時に project を作成する。
6. command auto-detection を起動する。

Acceptance:

- project がない場合 `/setup` に遷移する。
- setup 完了後 `/issues` に遷移する。
- Codex CLI 設定が保存される。

### M3. Command Auto-Detection

目的: repository import 時に command を検出し、不足 issue を作る。

Tasks:

1. package manager detection を実装する。
2. `package.json` scripts detection を実装する。
3. build/test/lint tool config detection を実装する。
4. `project_commands` 保存を実装する。
5. missing command issue generation を実装する。
6. Repository 画面に検出結果を表示する。

Acceptance:

- `package.json` から script を検出できる。
- missing command がある場合 issue が自動作成される。
- 検出結果を Repository 画面で確認できる。

### M4. Issue

目的: issue CRUD、comments、labels、Activity 表示を実装する。

Tasks:

1. issue list API / UI を作る。
2. issue create / edit API / UI を作る。
3. issue logical delete を実装する。
4. label attach / detach を実装する。
5. comments API / UI を作る。
6. Activity Log tab を作る。
7. `waiting_human` comment 投稿時の auto resume hook を作る。

Acceptance:

- issue を作成、編集、論理削除できる。
- comments と Activity Log が別 tab で見える。
- user comment により waiting job が再開される。

### M5. Pull Request

目的: ローカル PR 概念、diff、commits、comments、Activity を実装する。

Tasks:

1. pull request CRUD API / UI を作る。
2. source / target branch を保存する。
3. commit list API を作る。
4. changed files API を作る。
5. diff viewer を作る。
6. PR comments と Activity Log を作る。
7. logical delete を実装する。

Acceptance:

- local PR を作成できる。
- source branch と target branch の diff を確認できる。
- comments と Activity Log が見える。

### M6. Git Service

目的: repository 状態と PR 差分を取得する。

Tasks:

1. safe git command wrapper を作る。
2. status / branch / commits / files を実装する。
3. branch creation を実装する。
4. diff generation を実装する。
5. merge conflict detection を実装する。
6. command execution result を Activity に保存する hook を作る。

Acceptance:

- Repository 画面で clean / dirty state が見える。
- PR detail で commits / files / diff が見える。
- conflict を検出できる。

### M7. Agent Job Queue

目的: Agent を非同期に実行できるようにする。

Tasks:

1. `agent_jobs` enqueue API を作る。
2. worker loop を作る。
3. lock key による同時実行制御を作る。
4. cancel / retry を実装する。
5. Activity writer を実装する。
6. label change trigger を実装する。

Acceptance:

- job を enqueue して `queued -> running -> succeeded` にできる。
- Activity が時系列保存される。
- 同じ対象の write job が同時実行されない。

### M8. Codex CLI Adapter

目的: Codex CLI で Agent を実行する。

Tasks:

1. Codex CLI command path validation を作る。
2. prompt template renderer を作る。
3. context builder を作る。
4. Codex CLI process runner を作る。
5. output parser を作る。
6. Activity streaming / collection を実装する。
7. failure handling を実装する。

Acceptance:

- Codex CLI を設定から起動できる。
- Agent output を job output と comments / Activity に保存できる。
- 失敗時に error と Activity が残る。

### M9. Requirements Agent

目的: issue から要件定義を作成する。

Tasks:

1. requirements prompt を実装する。
2. issue context builder を実装する。
3. question comment と `waiting_human` を実装する。
4. requirements complete comment を実装する。
5. label automation を実装する。

Acceptance:

- `要件定義中` label から agent が起動する。
- 不明点があれば質問して停止する。
- 回答後に自動再開する。
- 要件確定後 `実装待ち` になる。

### M10. Implementation Agent

目的: 要件に沿って実装し、ローカル PR を作る。

Tasks:

1. implementation prompt を実装する。
2. branch creation を連携する。
3. file change / command activity を保存する。
4. test result collection を実装する。
5. PR creation を実装する。

Acceptance:

- `実装待ち` label から branch 作成と実装が始まる。
- 実装後に PR が作成される。
- 変更ファイルとテスト結果が Activity に残る。

### M11. Review / Fix / QA Agents

目的: PR の自動レビュー、修正、QA を回す。

Tasks:

1. review prompt を実装する。
2. fix prompt を実装する。
3. QA prompt を実装する。
4. conflict fix flow を実装する。
5. Playwright QA helper を作る。
6. label automation を実装する。

Acceptance:

- PR 作成後 `レビュー中` になる。
- 指摘があれば `修正中` になる。
- 修正後 `レビュー中` に戻る。
- QA が通れば `完了` になる。
- conflict があれば `コンフリクト修正中` から修正できる。

## 4. 実装済み Issue 分割

MVP では以下に相当する作業を完了済み。

- [x] Scaffold TypeScript React + API app
- [x] Add libSQL migrations and repository layer
- [x] Implement setup wizard
- [x] Implement command auto-detection
- [x] Implement issue CRUD
- [x] Implement pull request CRUD and diff viewer
- [x] Implement agent job queue and activity log
- [x] Implement Codex CLI adapter
- [x] Implement requirements agent
- [x] Implement implementation agent
- [x] Implement review/fix/QA agents
- [x] Add Playwright smoke coverage

## 5. MVP 外に送るもの

- 複数 repository 管理
- 外部 GitHub PR 作成
- multi-user authentication
- Electron desktop app
- remote CI integration
