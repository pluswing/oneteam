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
- package manager は npm を使用する。
- API framework は Hono を使用する。
- ORM / query builder は Drizzle ORM を使用する。
- Docker は使用しない。
- Node.js と git がインストールされていれば起動できる構成にする。
- AI 実行基盤は Codex CLI を主想定とする。
- AI 実行基盤は将来的に差し替え可能な adapter として設計する。
- Codex CLI は full access で実行する。AI のコマンド実行時に個別のユーザー承認は必須にしない。
- AI による作業対象は管理対象 repository を主とし、実行コマンドと変更内容は Activity Log に記録する。
- AI が質問して `waiting_human` になった場合、ユーザー回答コメントの投稿を契機に自動再開する。
- 実装完了後の merge 操作はユーザーが行う。ただし merge conflict の検出と修正は one team が支援する。
- issue / pull request の削除は論理削除とする。
- UI は browser で開く Web アプリケーションとする。
- UI は多言語対応可能な設計にし、初期実装は英語 UI とする。

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
- Electron などの desktop app 化

## 5. 用語

| 用語 | 意味 |
| --- | --- |
| Project | one team に登録された管理対象 repository |
| Issue | 実装したい内容、バグ、改善などを記録する単位 |
| Pull Request | 実装ブランチとベースブランチの差分を確認・レビューする単位 |
| Comment | issue / pull request に紐づく会話、AI の質問、ユーザー回答、状態報告 |
| Label | issue / pull request の状態や AI の次作業を表すタグ |
| Agent Job | AI エージェントに実行させる 1 回分の処理 |
| Activity | コメントとは別に記録する AI の作業ログ、進捗、判断要約、コマンド実行履歴 |
| Human Gate | AI が人間の回答や承認を待って停止している状態 |

## 6. 全体ワークフロー

### 6.1 Issue から Pull Request まで

1. ユーザーが issue を作成する。
2. ユーザー、または自動ルールにより `requirements` label が付与される。
3. 要件定義エージェントが起動する。
4. 要件定義エージェントは issue 本文、コメント、repository の現状を確認する。
5. 不明点がある場合、issue コメントに質問を書き、Agent Job を `waiting_human` にする。
6. ユーザーが回答すると、要件定義エージェントが自動再開する。
7. 不明点が解消されたら、要件定義エージェントが要件定義コメントを投稿する。
8. issue の label を `ready-for-implementation` に変更する。
9. 実装エージェントが起動し、実装ブランチを作成する。
10. 実装エージェントはファイル変更、テスト追加、テスト実行を行う。
11. 実装中に不明点が出た場合、issue コメントで質問し、Human Gate に入る。
12. 実装完了後、one team 内に pull request を作成する。
13. pull request に `reviewing` label を付与する。
14. レビューエージェントがレビューする。
15. 指摘があれば pull request コメントに記録し、`fixing` label に変更する。
16. 修正エージェントが指摘を修正し、テスト後に `reviewing` に戻す。
17. レビュー指摘がなくなったら `testing` label に変更する。
18. QA エージェントが UI を含む動作確認を実施する。
19. 不具合があれば pull request コメントに記録し、`fixing` に戻す。
20. 問題がなければ検証結果をコメントし、pull request と issue に `done` label を付与する。
21. merge はユーザーが実行する。
22. merge conflict が発生、または事前検出された場合、one team は修正エージェントで conflict 解消を支援する。

### 6.2 手動操作

ユーザーはいつでも次の操作を行える。

- issue / pull request の作成、編集、削除
- Open / Closed の変更
- label の付け外し
- コメント投稿
- AI ジョブの開始、停止、再実行
- Human Gate への回答
- Activity Log の確認
- pull request 差分の確認
- pull request の完了、または差し戻し
- merge conflict 修正の依頼

## 7. UI 要件

### 7.1 共通

- GitHub の issue / pull request 体験に近い情報設計にする。
- 左または上部に主要ナビゲーションを置く。
- 主要ページは Issues、Pull Requests、Repository、Settings とする。
- issue / pull request の一覧では、状態、label、更新日時、コメント数を確認できる。
- 詳細ページでは本文、コメント timeline、label、状態、関連 pull request / issue を確認できる。
- AI のコメントとユーザーのコメントは視覚的に区別できるようにする。
- AI ジョブの実行中、待機中、失敗、完了が分かる表示を用意する。
- issue / pull request 詳細では、コメントとは別に Activity Log を時系列で確認できる。
- Activity Log には AI の進捗、判断要約、実行コマンド、テスト結果、エラー、ファイル変更の要約を表示する。
- UI ポートは設定ファイルで指定できる。
- UI は i18n を前提に実装し、表示文字列を翻訳リソースから参照する。
- 初期実装の標準 locale は `en` とする。

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
- Activity Log を時系列で表示する。
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
- Activity Log を時系列で表示する。
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
| `requirements` | 要件定義エージェントが確認中 | 要件定義エージェント |
| `needs-input` | 人間の回答待ち | ユーザー |
| `ready-for-implementation` | 要件確定済み、実装開始待ち | 実装エージェント |
| `implementing` | 実装中 | 実装エージェント |
| `pull-request-created` | pull request が作成された | 実装エージェント |
| `done` | 対応完了 | QA エージェント / ユーザー |

### 8.3 Pull Request Status

- `Open`
- `Closed`

### 8.4 Pull Request System Labels

| Label | 意味 | 主な担当 |
| --- | --- | --- |
| `reviewing` | レビューエージェントが確認中 | レビューエージェント |
| `fixing` | 指摘修正中 | 修正エージェント |
| `resolving-conflicts` | merge conflict 修正中 | 修正エージェント |
| `testing` | QA 実施中 | QA エージェント |
| `needs-input` | 人間の回答・承認待ち | ユーザー |
| `done` | 検証完了 | QA エージェント / ユーザー |

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
- 各エージェントはコメントとは別に Activity Log を保存する。
- Activity Log には、AI の作業中の thinking summary、進捗、判断理由、実行コマンド、主要なコマンド出力、ファイル変更、テスト結果を時系列で記録する。
- 同じ issue / pull request に対して同時に複数の破壊的 Agent Job が走らないよう lock する。
- エージェントは作業開始、質問、完了、失敗をコメントに投稿する。
- エージェントは不明点がある場合、人間に質問して `waiting_human` で停止する。
- 人間の回答コメントが投稿されたら、同じ Agent Job を自動再開、または後続 Job を自動作成する。
- エージェントの出力は Markdown で保存し、UI で読みやすく表示する。
- AI 実行 adapter は設定で切り替え可能にする。

### 9.2 要件定義エージェント

#### 起動条件

- issue に `requirements` label が付与されたとき。
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
- 新規 repository の要件定義では、install / dev / build / test / lint コマンドを必須要件として追加する。
- 全ての確認事項が解消されたら、要件定義コメントを投稿する。

#### 出力

要件定義コメントには次を含める。

- 背景・目的
- 実装対象
- 実装対象外
- UI / API / データ変更
- install / dev / build / test / lint コマンド要件
- 状態遷移
- 受け入れ条件
- テスト観点
- 未解決リスク
- 実装エージェントへの指示

### 9.3 実装エージェント

#### 起動条件

- issue に `ready-for-implementation` label が付与されたとき。
- ユーザーが手動実行したとき。

#### 入力

- issue
- 要件定義コメント
- repository の現状
- 検出または設定された install / dev / build / test / lint コマンド

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

- pull request に `reviewing` label が付与されたとき。
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
- 問題がある場合、指摘を pull request コメントに投稿し `fixing` label に変更する。
- 問題がない場合、`testing` label に変更して QA エージェントへ渡す。

#### 出力

レビューコメントには次を含める。

- 判定: `修正必要` または `問題なし`
- 指摘一覧
- 影響範囲
- 推奨修正方針
- 確認済み観点

### 9.5 修正エージェント

#### 起動条件

- pull request に `fixing` label が付与されたとき。
- pull request に `resolving-conflicts` label が付与されたとき。
- レビューまたは QA で指摘が投稿されたとき。
- merge conflict が検出されたとき。

#### 入力

- pull request
- 指摘コメント
- conflict 情報
- 変更差分
- repository の現状

#### 処理

- 指摘内容を理解する。
- merge conflict がある場合、source branch 上で conflict を解消する。
- 必要な修正を行う。
- テストを追加・更新する。
- build / test / lint を実行する。
- 修正完了コメントを投稿する。
- `reviewing` label に戻す。

#### 出力

- 修正概要
- 対応した指摘一覧
- conflict 解消内容
- 変更ファイル一覧
- 実行したテストと結果

### 9.6 QA エージェント

#### 起動条件

- pull request に `testing` label が付与されたとき。
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
- 不具合があれば pull request コメントに詳細を投稿し `fixing` label に変更する。
- 問題がなければ QA 結果を投稿し `done` label を付与する。

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

#### 既存 Repository インポート

- インポート時に build / test / lint / dev server / install コマンドを自動検出する。
- 自動検出では `package.json`、lock file、workspace 設定、test framework 設定、build tool 設定を確認する。
- npm / pnpm / yarn / bun のうち、lock file と package manager 設定から優先候補を決める。
- 該当コマンドが存在する場合、検出結果を project commands として保存する。
- 必須コマンドまたは推奨コマンドが不足している場合、one team は不足機能を実装するための issue を即座に自動作成する。
- 自動作成された issue には不足している機能、検出結果、推奨される実装方針を本文に記録する。
- 自動作成された issue は `requirements` または `ready-for-implementation` に遷移し、AI が必要機能の実装を開始できるようにする。

#### 新規 Repository 作成

- 新規 repository の要件定義では、build / test / lint / dev server / install コマンドを必須要件として扱う。
- 要件定義エージェントは、新規 project の技術選定時に必要なコマンド体系を要件定義へ含める。
- 実装エージェントは、新規 project 作成時にこれらのコマンドが動作する状態まで実装する。

### 10.2 Git 操作

- 現在の branch、変更状態、commit 一覧を取得できる。
- issue 実装時に作業 branch を作成できる。
- pull request 詳細で source branch と target branch の差分を表示できる。
- 変更ファイル一覧を表示できる。
- ファイル単位の diff を表示できる。
- commit 一覧を表示できる。
- source branch と target branch の merge conflict を検出できる。
- merge conflict が検出された場合、修正エージェントが source branch 上で conflict 解消を行える。
- merge の最終実行はユーザーが行う。

### 10.3 Safety

- Codex CLI は full access で実行する。
- AI がコマンドや Git 操作を行う前に対象 repository と作業 branch を Activity Log に記録する。
- 未コミット変更がある場合、実装開始前に検出して扱いを決める。
- MVP では、ユーザーの未コミット変更がある場合は原則として実装エージェントを停止し、コメントで確認する。
- AI のコマンド実行時に個別承認は必須にしない。
- 実行コマンド、終了コード、主要な出力、変更ファイルを Activity Log に保存する。

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
    "provider": "codex-cli",
    "codexCommand": "node_modules/.bin/codex",
    "model": "model-name",
    "fullAccess": true
  },
  "i18n": {
    "defaultLocale": "en",
    "fallbackLocale": "en"
  },
  "commandDetection": {
    "mode": "auto",
    "requiredCommands": ["install", "dev", "build", "test", "lint"],
    "createIssueForMissingCommands": true
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

### 11.2 Initial Setup

初回起動時は setup wizard を表示し、次を設定できるようにする。

- 管理対象 repository の作成またはインポート
- UI port
- workspace root
- libSQL database path
- Codex CLI command path
- Codex CLI の実行設定
- default locale
- command auto-detection の結果確認

Codex CLI の認証情報は、原則として Codex CLI が管理する認証状態を利用する。one team 側では CLI command path、model、実行オプションなど、one team から起動するために必要な設定を保存する。

### 11.3 Tables

MVP で必要な主な table は次の通り。

#### projects

| Column | Type | 備考 |
| --- | --- | --- |
| id | text | primary key |
| name | text | 表示名 |
| repo_path | text | ローカル repository path |
| default_branch | text | 例: `main` |
| locale | text | default locale |
| created_at | datetime | 作成日時 |
| updated_at | datetime | 更新日時 |

#### project_commands

| Column | Type | 備考 |
| --- | --- | --- |
| id | integer | primary key |
| project_id | text | projects.id |
| command_type | text | `install` / `dev` / `build` / `test` / `lint` |
| command | text | 実行コマンド |
| detection_source | text | `package_json` / `config` / `manual` / `agent` |
| is_available | boolean | 利用可能か |
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
| deleted_at | datetime | 論理削除日時、nullable |

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
| deleted_at | datetime | 論理削除日時、nullable |

#### labels

| Column | Type | 備考 |
| --- | --- | --- |
| id | integer | primary key |
| project_id | text | projects.id |
| name | text | label 名 |
| color | text | 表示色 |
| kind | text | `system` / `custom` |
| deleted_at | datetime | 論理削除日時、nullable |

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

#### agent_activities

| Column | Type | 備考 |
| --- | --- | --- |
| id | integer | primary key |
| project_id | text | projects.id |
| agent_job_id | integer | agent_jobs.id |
| target_type | text | `issue` / `pull_request` |
| target_id | integer | 対象 id |
| activity_type | text | `thinking` / `progress` / `command` / `file_change` / `test` / `error` / `system` |
| title | text | 短い表示名 |
| body | text | Markdown。thinking summary や作業詳細 |
| payload_json | text | コマンド、終了コード、ファイル一覧など |
| created_at | datetime | 作成日時 |

## 12. API 要件

API は UI と同一 Node.js アプリケーションで提供する。

### 12.1 Projects

- `GET /api/projects`
- `POST /api/projects`
- `GET /api/projects/:projectId`
- `PATCH /api/projects/:projectId`
- `GET /api/projects/:projectId/commands`
- `POST /api/projects/:projectId/commands/detect`
- `PATCH /api/projects/:projectId/commands/:commandId`

### 12.2 Issues

- `GET /api/projects/:projectId/issues`
- `POST /api/projects/:projectId/issues`
- `GET /api/projects/:projectId/issues/:issueId`
- `PATCH /api/projects/:projectId/issues/:issueId`
- `DELETE /api/projects/:projectId/issues/:issueId`
- `POST /api/projects/:projectId/issues/:issueId/comments`
- `GET /api/projects/:projectId/issues/:issueId/comments`
- `GET /api/projects/:projectId/issues/:issueId/activities`

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
- `GET /api/projects/:projectId/pull-requests/:pullRequestId/activities`
- `POST /api/projects/:projectId/pull-requests/:pullRequestId/resolve-conflicts`

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
- `GET /api/projects/:projectId/agent-jobs/:jobId/activities`

### 12.6 Repository

- `GET /api/projects/:projectId/repository/status`
- `GET /api/projects/:projectId/repository/branches`
- `GET /api/projects/:projectId/repository/commits`
- `GET /api/projects/:projectId/repository/files`
- `GET /api/projects/:projectId/repository/merge-conflicts`

`DELETE` endpoints は物理削除ではなく、対象 record の `deleted_at` を更新する論理削除として扱う。

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

type AgentActivity = {
  type: "thinking" | "progress" | "command" | "file_change" | "test" | "error" | "system";
  title: string;
  body: string;
  payload?: Record<string, unknown>;
};
```

### 13.1 Adapter に求めること

- prompt と context を受け取り、結果を返す。
- 実装・修正系 agent は repository 配下のファイルを編集できる。
- 実行ログを取得できる。
- 実行中の activity を逐次保存できる。
- 失敗時に error message を返せる。
- MVP では Codex CLI adapter を実装する。
- Codex CLI adapter は初回起動時に command path、model、実行オプションを設定できる。
- Codex CLI adapter は full access 実行を前提にする。
- 将来的に他の CLI 型、API 型、ローカルモデル型を差し替えられる。

## 14. 実装アーキテクチャ

MVP 実装では、過度な monorepo 化を避け、1 repository / 1 app 構成で server、UI、DB、agents を同居させる。

現在の主要な配置は次の通り。

```text
src/client      React + Vite UI
src/server      Hono API / agent orchestration / git integration
src/server/db   libSQL schema and repository layer
src/server/agents
                agent prompts and adapter interface
src/server/services
                git / command detection / label automation services
src/shared      shared DTO and utility types
docs            requirements, API, prompt, workflow, and QA documents
e2e             Playwright smoke tests
```

将来、複数 package 化が必要になった場合は、この境界を基準に分割する。

### 14.1 採用技術

- Language: TypeScript
- Package manager: npm
- Runtime: Node.js
- UI: React + Vite
- API: Hono
- DB: libSQL
- ORM / query builder: Drizzle ORM
- Git: child_process 経由の git command wrapper
- E2E: Playwright
- Unit test: Vitest

## 15. 受け入れ条件

### 15.1 基本起動

- Node.js と git がある環境でセットアップできる。
- Docker なしで起動できる。
- 設定ファイルで UI ポートを変更できる。
- 初回起動時に Codex CLI の実行設定を行える。
- libSQL database が初回起動時に作成される。
- UI は初期表示を英語にでき、表示文字列は i18n リソースで管理される。
- repository インポート時に install / dev / build / test / lint コマンドを自動検出できる。
- 不足コマンドがある場合、不足機能実装用の issue が自動作成される。

### 15.2 Issue

- issue を作成、編集、論理削除できる。
- issue を Open / Closed に変更できる。
- issue に label を付け外しできる。
- issue にコメントできる。
- issue 一覧で状態、label、コメント数、更新日時を確認できる。

### 15.3 Pull Request

- pull request を作成、編集、論理削除できる。
- pull request を Open / Closed に変更できる。
- pull request に label を付け外しできる。
- pull request にコメントできる。
- source branch と target branch の commit / file diff を確認できる。

### 15.4 AI Workflow

- `requirements` label から要件定義エージェントを起動できる。
- 要件定義エージェントは不明点をコメントし、人間の回答待ちにできる。
- 人間の回答後、要件定義を再開できる。
- 要件定義完了後、`ready-for-implementation` に遷移できる。
- 実装エージェントは branch 作成、実装、テスト実行、pull request 作成を行える。
- レビューエージェントは pull request をレビューし、指摘または QA への遷移を行える。
- 修正エージェントは指摘を修正し、再レビューへ戻せる。
- 修正エージェントは merge conflict を修正できる。
- QA エージェントはテスト結果をコメントし、`done` または `fixing` へ遷移できる。
- Agent Job の Activity Log を issue / pull request から時系列で確認できる。

## 16. 非機能要件

### 16.1 Portable

- ユーザーのローカルマシンで完結して動作する。
- Docker なしで動作する。
- 外部サービスへの依存は AI provider を除き最小化する。

### 16.2 Observability

- Agent Job の実行状態を UI で確認できる。
- 失敗時にエラー内容を UI で確認できる。
- agent の出力、実行コマンド、テスト結果を履歴として確認できる。
- issue / pull request のコメントとは別に Activity Log を確認できる。
- Activity Log は AI の thinking summary、進捗、判断理由、コマンド実行、ファイル変更、テスト結果、エラーを時系列で表示できる。

### 16.3 Safety

- Codex CLI は full access で実行する。
- AI の作業対象 repository と branch を Activity Log に記録する。
- 未コミット変更を検出する。
- AI のコマンド実行時に個別承認は必須にしない。
- 実行コマンド、終了コード、主要な出力、変更ファイルを Activity Log に保存する。
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
- Codex CLI は full access で実行し、コマンド実行時の個別承認は必須にしない。
- merge 操作はユーザーが行い、merge conflict の修正は one team が支援する。
- issue / pull request の削除は論理削除とする。
- UI は browser で開く Web アプリケーションとする。
- build / test / lint / dev server / install コマンドは repository インポート時に自動検出する。
- 自動検出で不足コマンドが見つかった場合、one team は必要機能実装用の issue を作成し、AI が実装を開始できるようにする。
- 新規 repository では、要件定義時に build / test / lint / dev server / install コマンドを必須要件へ追加する。
- Agent Job の Activity Log をコメントとは別に時系列で保存する。
- Codex CLI の command path、model、実行オプションは one team 初回起動時に設定できるようにする。
- UI は多言語対応可能な設計とし、初期実装は英語 UI とする。
- package manager は npm とする。
- API framework は Hono とする。
- ORM / query builder は Drizzle ORM とする。

### 17.2 未確認事項

現時点で MVP 実装開始を妨げる未確認事項はない。

## 18. MVP 実装順

以下は MVP で完了済みの実装順である。

1. Node.js アプリケーションの土台作成
2. libSQL schema / migration
3. 初回 setup wizard
4. Codex CLI adapter 設定
5. Project 登録
6. repository command auto-detection
7. Issue CRUD / comments / labels / logical delete
8. Pull Request CRUD / comments / labels / logical delete
9. Git status / branch / commits / diff / conflict detection 表示
10. Agent Job queue と状態管理
11. Activity Log
12. 要件定義エージェント
13. 実装エージェント
14. レビューエージェント
15. 修正エージェント
16. QA エージェント
17. Playwright による UI smoke coverage

## 19. 詳細資料

- [画面一覧・ワイヤーフレーム](./docs/01-screens-wireframes.md)
- [DB schema 詳細](./docs/02-db-schema.md)
- [Agent prompt template](./docs/03-agent-prompt-templates.md)
- [Agent Job state machine](./docs/04-agent-job-state-machine.md)
- [API request / response schema](./docs/05-api-schemas.md)
- [MVP タスク分解](./docs/06-mvp-task-breakdown.md)
- [command auto-detection 仕様](./docs/07-command-auto-detection.md)
- [MVP 完了状況](./docs/10-mvp-remaining-tasks.md)
- [Manual E2E checklist](./docs/11-manual-e2e-checklist.md)
- [i18n リソース設計](./docs/08-i18n-resource-design.md)
- [Local Codex CLI setup](./docs/09-local-codex-setup.md)
