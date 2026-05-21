# 画面一覧・ワイヤーフレーム

## 1. 目的

one team の MVP UI を実装できるよう、画面構成、主要コンポーネント、ワイヤーフレーム、状態表示を定義する。

UI は GitHub の issue / pull request 体験に寄せる。初期表示は英語 UI とし、すべての固定文言は i18n resource key から参照する。

## 2. 画面一覧

| Route | 画面 | 目的 |
| --- | --- | --- |
| `/setup` | Setup Wizard | 初回設定、repository 登録、Codex CLI 設定 |
| `/issues` | Issue List | issue の一覧、検索、絞り込み |
| `/issues/new` | New Issue | issue 作成 |
| `/issues/:issueId` | Issue Detail | issue 本文、コメント、Activity Log、AI 操作 |
| `/pull-requests` | Pull Request List | pull request の一覧、検索、絞り込み |
| `/pull-requests/:pullRequestId` | Pull Request Detail | PR 本文、diff、commits、comments、Activity Log |
| `/repository` | Repository | repository 状態、branch、command 検出結果 |
| `/settings` | Settings | port、locale、Codex CLI、commands 設定 |

## 3. 共通レイアウト

```text
+--------------------------------------------------------------------------------+
| one team                          Issues  Pull Requests  Repository  Settings   |
+--------------------------------------------------------------------------------+
| Project: example-app        Branch: main        Agent: idle / running / waiting |
+--------------------------------------------------------------------------------+
| Page content                                                                  |
|                                                                                |
|                                                                                |
+--------------------------------------------------------------------------------+
```

### 3.1 Header

- 左: product name `one team`
- 中央: primary navigation
- 右: 現在の Agent 状態、Settings shortcut
- Agent 状態は `idle`、`running`、`waiting`、`failed` を表示する。

### 3.2 共通 UI States

| State | 表示 |
| --- | --- |
| Loading | skeleton または compact spinner |
| Empty | 次に行う操作が分かる empty state |
| Error | エラー内容、retry button |
| Running Agent | header と detail page に実行中 badge |
| Waiting Human | issue / PR detail 上部に回答待ち banner |

## 4. Setup Wizard

初回起動時、project が存在しない場合は `/setup` を表示する。

```text
+--------------------------------------------------------------------------------+
| one team setup                                                                 |
+--------------------------------------------------------------------------------+
| Step 1  Repository                                                             |
|   ( ) Import existing repository                                                |
|       Path [ /path/to/repo                                      ] [Browse]      |
|   ( ) Create new repository                                                     |
|       Name [ example-app ]                                                      |
|                                                                                |
| Step 2  Codex CLI                                                              |
|   Command [ node_modules/.bin/codex                            ] [Test]         |
|   Model   [ model-name                                         ]                |
|   Access  [x] Full access                                                       |
|                                                                                |
| Step 3  Commands                                                               |
|   [Detect commands]                                                             |
|   install  npm install      detected                                            |
|   dev      npm run dev      detected                                            |
|   build    missing          issue will be created                               |
|   test     npm test         detected                                            |
|   lint     missing          issue will be created                               |
|                                                                                |
| Step 4  Preferences                                                            |
|   Locale [ English ]                                                            |
|   Port   [ 3579 ]                                                               |
|                                                                                |
|                                                    [Back] [Create project]      |
+--------------------------------------------------------------------------------+
```

### 4.1 完了時の挙動

- project を作成する。
- Codex CLI 設定を保存する。
- command auto-detection を実行する。
- 不足コマンドがある場合、issue を自動作成する。
- 自動作成 issue に `requirements` agent job を enqueue する。

## 5. Issue List

```text
+--------------------------------------------------------------------------------+
| Issues                                                        [New issue]       |
+--------------------------------------------------------------------------------+
| [Open 12] [Closed 3]   Search [                               ]  Label [All]    |
+--------------------------------------------------------------------------------+
| #24 Add build command                                  requirements  Open       |
|     Missing build command was detected.                 2 comments  updated 5m  |
|                                                                                |
| #23 Improve editor keyboard behavior                    in progress  Open       |
|     Cursor jumps when editing long Markdown text.       5 comments  updated 1h  |
|                                                                                |
| #22 Add Playwright QA flow                              completed    Closed     |
|     QA agent should verify UI changes.                  8 comments  updated 1d  |
+--------------------------------------------------------------------------------+
```

### 5.1 操作

- Open / Closed tab
- keyword search
- label filter
- sort: updated desc / created desc / created asc
- New issue
- 行 click で detail へ遷移

## 6. New / Edit Issue

```text
+--------------------------------------------------------------------------------+
| New issue                                                                      |
+--------------------------------------------------------------------------------+
| Title                                                                          |
| [ Add settings screen for Codex CLI                                           ] |
|                                                                                |
| Description                                                                    |
| [ Markdown editor                                                            ] |
|                                                                                |
| Labels                                                                         |
| [requirements] [implementation waiting]                                        |
|                                                                                |
|                                                    [Cancel] [Create issue]     |
+--------------------------------------------------------------------------------+
```

### 6.1 Validation

- title は必須。
- body は任意。
- label は複数選択可。

## 7. Issue Detail

```text
+--------------------------------------------------------------------------------+
| #24 Add build command                                          Open            |
| Labels: requirements, waiting-human                                             |
+--------------------------------------------------------------------------------+
| [Start requirements] [Cancel agent job]                                         |
+--------------------------------------------------------------------------------+
| Main                                                                           |
| +----------------------------------------------------------------------------+ |
| | Add build command                                                           | |
| |                                                                            | |
| | Missing build command was detected during import.                           | |
| +----------------------------------------------------------------------------+ |
|                                                                                |
| Tabs: [Conversation] [Activity] [Linked pull requests]                         |
|                                                                                |
| Conversation                                                                   |
| +----------------------------------------------------------------------------+ |
| | Agent asked: Which build tool should be used?                               | |
| +----------------------------------------------------------------------------+ |
| | User replied: Use Vite.                                                     | |
| +----------------------------------------------------------------------------+ |
| | [ Write a comment...                                      ] [Comment]       | |
| +----------------------------------------------------------------------------+ |
|                                                                                |
| Sidebar                                                                        |
|   Status: Open                                                                 |
|   Labels: requirements, waiting-human                                          |
|   Agent job: waiting for human                                                 |
+--------------------------------------------------------------------------------+
```

### 7.1 Activity Tab

```text
Activity
  10:03:12 progress   Requirements agent started
  10:03:18 thinking   Reviewed package.json and detected missing build script
  10:03:21 command    rg --files
  10:03:24 progress   Asked user for build tool preference
```

Activity には raw chain-of-thought ではなく、AI の作業メモとして安全に要約された thinking summary を表示する。

## 8. Pull Request List

```text
+--------------------------------------------------------------------------------+
| Pull Requests                                             [New pull request]    |
+--------------------------------------------------------------------------------+
| [Open 4] [Closed 8]   Search [                               ]  Label [All]    |
+--------------------------------------------------------------------------------+
| #8 Add build command implementation                     review       Open       |
|    oneteam/issue-24-add-build-command -> main            3 files     updated 3m |
|                                                                                |
| #7 Fix QA startup issue                                  testing      Open       |
|    oneteam/issue-18-fix-qa-startup -> main               2 files     updated 1h |
+--------------------------------------------------------------------------------+
```

## 9. Pull Request Detail

```text
+--------------------------------------------------------------------------------+
| #8 Add build command implementation                            Open            |
| oneteam/issue-24-add-build-command -> main                                      |
| Labels: review                                                                  |
+--------------------------------------------------------------------------------+
| [Start review] [Run QA] [Resolve conflicts]                                     |
+--------------------------------------------------------------------------------+
| Tabs: [Conversation] [Activity] [Commits] [Files changed]                       |
|                                                                                |
| Conversation                                                                   |
|   Agent reviewed: no blocking issues                                            |
|                                                                                |
| Files changed                                                                  |
|   package.json                                        +3 -1                     |
|   vite.config.ts                                      +12 -0                    |
|                                                                                |
| Diff                                                                           |
|   package.json                                                                 |
|   @@                                                                           |
|    "scripts": {                                                                |
|   +  "build": "vite build"                                                     |
|    }                                                                           |
+--------------------------------------------------------------------------------+
```

### 9.1 Conflict 表示

merge conflict が検出された場合は、PR detail 上部に banner を表示する。

```text
Merge conflict detected between source branch and main.
[Ask one team to resolve conflicts]
```

## 10. Repository

```text
+--------------------------------------------------------------------------------+
| Repository                                                                     |
+--------------------------------------------------------------------------------+
| Path        /Users/me/project                                                  |
| Default     main                                                               |
| Current     oneteam/issue-24-add-build-command                                 |
| Status      clean                                                              |
|                                                                                |
| Commands                                                                       |
|   install  npm install      detected from lock file                             |
|   dev      npm run dev      detected from package.json                          |
|   build    npm run build    implemented by issue #24                            |
|   test     npm test         detected from package.json                          |
|   lint     missing          issue #25                                           |
|                                                                                |
| [Detect again]                                                                 |
+--------------------------------------------------------------------------------+
```

## 11. Settings

```text
+--------------------------------------------------------------------------------+
| Settings                                                                       |
+--------------------------------------------------------------------------------+
| Server                                                                         |
|   Host [ 127.0.0.1 ]                                                           |
|   Port [ 3579      ]                                                           |
|                                                                                |
| Codex CLI                                                                      |
|   Command [ node_modules/.bin/codex ] [Test]                                   |
|   Model   [ model-name ]                                                       |
|   [x] Full access                                                              |
|                                                                                |
| Locale                                                                         |
|   Default locale [ English ]                                                   |
|                                                                                |
| Commands                                                                       |
|   install [ npm install   ]                                                    |
|   dev     [ npm run dev   ]                                                    |
|   build   [ npm run build ]                                                    |
|   test    [ npm test      ]                                                    |
|   lint    [ npm run lint  ]                                                    |
|                                                                                |
|                                                            [Save settings]     |
+--------------------------------------------------------------------------------+
```

## 12. コンポーネント一覧

| Component | 用途 |
| --- | --- |
| `AppShell` | header、navigation、project status |
| `StatusBadge` | Open / Closed / Agent Job status |
| `LabelPill` | issue / PR label |
| `MarkdownEditor` | issue、PR、comment 入力 |
| `MarkdownViewer` | Markdown 表示 |
| `Timeline` | comments 表示 |
| `ActivityLog` | agent activities 表示 |
| `AgentActionBar` | agent start / cancel / retry |
| `DiffViewer` | file diff 表示 |
| `CommandTable` | command detection 結果 |
| `SetupWizard` | 初回設定 |

## 13. 受け入れ条件

- Setup Wizard から project を登録できる。
- issue list / detail / create / edit が操作できる。
- pull request list / detail が操作できる。
- PR detail で commits / files changed / diff を確認できる。
- issue / PR detail で comments と Activity Log を別 tab として確認できる。
- Repository 画面で command detection 結果を確認できる。
- Settings で Codex CLI と locale を確認・変更できる。
- 固定文言は i18n resource key 経由で表示される。
