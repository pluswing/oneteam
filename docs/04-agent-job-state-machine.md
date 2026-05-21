# Agent Job state machine

## 1. 目的

Agent Job、issue label、pull request label の状態遷移を定義する。実装ではこの資料を基準に job queue、auto resume、label automation、UI status 表示を作る。

## 2. Agent Job Status

| Status | 意味 |
| --- | --- |
| `queued` | 実行待ち |
| `running` | 実行中 |
| `waiting_human` | 人間の入力待ち |
| `succeeded` | 正常終了 |
| `failed` | 失敗 |
| `canceled` | キャンセル済み |

## 3. Agent Job State Machine

```mermaid
stateDiagram-v2
  [*] --> queued
  queued --> running: worker starts
  queued --> canceled: user cancels
  running --> succeeded: agent completed
  running --> waiting_human: agent asked questions
  running --> failed: agent failed
  running --> canceled: user cancels
  waiting_human --> queued: user comments answer / auto resume
  waiting_human --> canceled: user cancels
  failed --> queued: retry
  failed --> canceled: user cancels
  succeeded --> [*]
  canceled --> [*]
```

## 4. Job Creation Events

| Event | 作成される Job | Target |
| --- | --- | --- |
| issue に `要件定義中` label が付与 | `requirements` | issue |
| `waiting_human` issue に user comment | previous agent または next job | issue |
| issue に `実装待ち` label が付与 | `implementation` | issue |
| PR に `レビュー中` label が付与 | `review` | pull request |
| PR に `修正中` label が付与 | `fix` | pull request |
| PR に `コンフリクト修正中` label が付与 | `fix` | pull request |
| PR に `テスト中` label が付与 | `qa` | pull request |
| repository import 完了 | `command_detection` | project |
| merge conflict 検出 | `fix` | pull request |

Label automation is edge-triggered: a job is queued when a trigger label is newly
applied. If an active job of the same agent type already exists for the same
target, no duplicate job is created. Agent `metadata.nextLabel` transitions use
the same automation rules as user/API label updates.

## 5. Issue Workflow

```mermaid
stateDiagram-v2
  [*] --> Open
  Open --> Requirements: label 要件定義中
  Requirements --> WaitingHuman: questions posted
  WaitingHuman --> Requirements: user answers
  Requirements --> ImplementationWaiting: requirements completed
  ImplementationWaiting --> Implementing: implementation job starts
  Implementing --> WaitingHuman: implementation question
  WaitingHuman --> Implementing: user answers
  Implementing --> PullRequestCreated: PR created
  PullRequestCreated --> Completed: linked PR completed
  Completed --> Closed: user closes issue
```

## 6. Issue Label Rules

| Current | Event | Next |
| --- | --- | --- |
| none | user starts requirements | `要件定義中` |
| `要件定義中` | agent asks question | `確認待ち` |
| `確認待ち` | user answers | `要件定義中` |
| `要件定義中` | requirements complete | `実装待ち` |
| `実装待ち` | implementation starts | `実装中` |
| `実装中` | implementation asks question | `確認待ち` |
| `確認待ち` | user answers implementation question | `実装中` |
| `実装中` | PR created | `PR作成済み` |
| `PR作成済み` | PR completed | `完了` |

## 7. Pull Request Workflow

```mermaid
stateDiagram-v2
  [*] --> Open
  Open --> Reviewing: label レビュー中
  Reviewing --> Fixing: review findings
  Fixing --> Reviewing: fixes completed
  Reviewing --> Testing: review approved
  Testing --> Fixing: QA defect
  Testing --> Completed: QA passed
  Open --> ConflictFixing: conflict detected
  ConflictFixing --> Reviewing: conflict resolved
  Completed --> Closed: user closes PR
```

## 8. Pull Request Label Rules

| Current | Event | Next |
| --- | --- | --- |
| none | PR created | `レビュー中` |
| `レビュー中` | review findings | `修正中` |
| `修正中` | fix complete | `レビュー中` |
| `レビュー中` | review approved | `テスト中` |
| `テスト中` | QA defect | `修正中` |
| `テスト中` | QA passed | `完了` |
| any open PR | merge conflict detected | `コンフリクト修正中` |
| `コンフリクト修正中` | conflict resolved | `レビュー中` |

## 9. Human Gate

Human Gate は Agent が自力で決めるべきではない判断をユーザーに戻す状態。

### 9.1 Enter

1. Agent が質問コメントを投稿する。
2. Job status を `waiting_human` にする。
3. 対象 issue / PR に `確認待ち` label を付与する。

### 9.2 Exit

1. ユーザーが comment を投稿する。
2. system が未解決の `waiting_human` job を探す。
3. `確認待ち` label を外し、元の作業 label を戻す。
4. previous job を `queued` に戻す、または後続 job を作成する。

## 10. Activity State Rules

| Job Status | Activity |
| --- | --- |
| `queued` | `system`: job queued |
| `running` | `progress`: job started |
| `running` | `thinking`: safe reasoning summary |
| `running` | `command`: command executed |
| `running` | `file_change`: files changed |
| `running` | `test`: test/build/lint result |
| `waiting_human` | `progress`: waiting for user answer |
| `failed` | `error`: failure summary |
| `succeeded` | `progress`: job completed |
| `canceled` | `system`: job canceled |

## 11. Locking

同じ対象に対して複数の write job を同時実行しない。

| Target | Lock Key |
| --- | --- |
| issue implementation | `project:{projectId}:issue:{issueId}:write` |
| pull request fix | `project:{projectId}:pull_request:{pullRequestId}:write` |
| repository command detection | `project:{projectId}:repository:commands` |

Read-only review は原則 lock 不要。ただし review 結果で label を変更するため、label update 時は短い transaction lock を使う。

## 12. Retry

Retry は新しい attempt として扱う。

- `agent_jobs.attempt` を increment する。
- previous job の `parent_job_id` を参照する新 job を作成してもよい。
- Activity Log には retry 開始を `system` として記録する。

## 13. Cancel

Cancel は job status を `canceled` にする。

実行中 process がある場合:

- Codex CLI process を停止する。
- Activity Log に canceled を記録する。
- 部分的な file change が残る可能性があるため、Repository 画面に dirty state を表示する。

自動 rollback は MVP では行わない。

## 14. Merge Conflict Flow

```mermaid
sequenceDiagram
  participant U as User
  participant UI as one team UI
  participant G as Git Service
  participant A as Fix Agent

  U->>UI: Open PR
  UI->>G: Check source branch against target branch
  G-->>UI: Conflict detected
  UI->>UI: Add コンフリクト修正中 label
  UI->>A: Queue fix job
  A->>G: Resolve conflicts on source branch
  A->>G: Run tests
  A-->>UI: Conflict resolved
  UI->>UI: Add レビュー中 label
```
