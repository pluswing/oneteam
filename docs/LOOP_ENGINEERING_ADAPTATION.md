# OneTeam の Loop Engineering / 自動完遂型開発方針

作成日: 2026-06-17
最終更新日: 2026-08-27

## 2026-08-27 方針更新

OneTeam の目標を、「Issue から検証可能な AI 開発 Loop を開始するツール」から、次の工程を原則として自動完遂するローカル開発アプリへ広げる。

```text
Issue
  -> requirements / planning
  -> implementation
  -> verification
  -> local pull request creation
  -> review
  -> fix / re-review / QA
  -> final verification
  -> automatic merge
  -> issue update / close
  -> memory update
```

ユーザーは Issue に目的と制約を書く。OneTeam は Issue を standing objective として保持し、Goal Contract、Evidence Gate、Stop Condition、Worktree isolation、Verifier、Memory など既存の Loop Engineering の仕組みを使って、停止条件を満たすまで工程を進める。

通常経路では、工程間のラベル変更、Agent Job の開始、PR 作成、レビュー、修正、再検証、merge、Issue 更新をユーザー操作なしで接続する。Human Gate は通常の承認ステップではなく、要件が安全に推定できない場合、危険な変更、保護対象への変更、回復不能な失敗などの例外経路として残す。

implementation、review、QA、verifierはproject標準とは別のprovider / modelを選択できる。設定値は実行時に読み直すのではなくAgent Jobのqueue時にsnapshotとして固定し、retryとusage回復後の自動再開でも同じ実行条件を再現する。ユーザーがProvider Gateから明示的にproviderを切り替えた場合だけ、切替先providerの標準modelを解決し直す。

### 自動 merge の条件

`ready-to-merge` はユーザー操作待ちの終点ではなく、「自動 merge の直前条件を満たした検証済み状態」とする。OneTeam は次をすべて再確認してから source branch を target branch へ merge する。

- Goal Contract と Stop Condition を満たしている
- 必須 Evidence が揃い、必須の lint / test / build / QA が成功している
- Review Agent と Verifier Agent が承認している
- unresolved finding、merge conflict、Human Gate、Risk Signal がない
- Evidence 取得時点から source HEAD / target HEAD が不意に変わっていない
- protected branch / protected path / diff budget / command policy に違反していない
- project の auto-merge policy が有効である

merge 直前には conflict、HEAD、必須 verification を再評価する。target branch が進んだ場合は再レビューまたは再検証へ戻し、検証済みでない差分を merge しない。merge 成功後は PR を `merged`、Objective を `succeeded` にし、関連 Issue を更新または close して、最終 Evidence と Decision Summary を Memory に保存する。

### Issue の自動更新

Issue は依頼の入口であると同時に、後から経緯を追跡するための永続的な記録とする。

- ユーザーが書いた本文は原則として破壊的に上書きしない
- 要件確定、実装開始、PR 作成、レビュー結果、QA、Provider 待機、merge 完了などの節目を system comment として残す
- label、status、関連 PR、Objective summary は system-managed state として更新する
- 要件変更が必要な場合は、変更理由と旧条件との差分をコメントに残してから Goal Contract を更新する
- merge 完了時は、実装内容、検証結果、残リスク、主要 diff、commit、PR、次回への Memory をまとめ、Issue を close できる

### Codex usage remaining の待機と再開

Codex の usage remaining が尽きたことは実装失敗や Human Gate として扱わず、Provider capacity の一時的な待機として扱う。

- Agent Job / Objective に `waiting_provider` 状態を追加する
- Stop / Wait Reason は `provider_quota_exhausted` とする
- provider、検出メッセージ、検出時刻、usage snapshot、reset time、`next_retry_at`、retry count を保存する
- Codex が reset time を返す場合はその時刻まで待ち、返さない場合は上限付き exponential backoff で再確認する
- 待機中は worktree、branch、Agent Job input、Objective、可能なら Codex thread/session identifier を保持する
- アプリ再起動後も永続化した `next_retry_at` から待機を復元する
- quota が回復したら同じ工程を自動的に `queued` へ戻し、Evidence を再取得して再開する
- quota 待機では objective round count と repeated failure count を増やさない
- UI には待機理由、推定再開時刻、最終確認時刻、Resume now、Cancel を表示する
- polling ごとにコメントを増やさず、待機開始と再開の節目だけを Issue / PR timeline に記録する

### UI の新しい重点

UI は GitHub 相当の情報設計と操作感を目標にする。Loop の内部構造を前面に出すのではなく、Issues、Pull Requests、Agent runs / checks、Repository、Settings を中心にし、Objective、Evidence、Provider 待機、Human Gate は対象ページの文脈内に表示する。

特に Pull Request の diff を最重要画面として扱う。

- file tree / file list と sticky file header
- unified / split diff 切り替え
- old / new line number、syntax highlighting、word-level diff
- 変更行数、rename、binary、追加 / 削除状態の明確な表示
- context 展開、折りたたみ、全文表示、ファイル内検索
- whitespace 無視、viewed 状態、reviewed progress
- file / line deep link と system comment からの参照
- 行単位コメントと review finding の該当行表示
- 大規模 diff の遅延読み込み、virtualization、表示上限
- keyboard navigation と、色だけに依存しない accessibility

### 後から読める system comment

Agent / system comment は、その場の進捗通知だけでなく、数週間後に Issue / PR を開いても判断経緯を復元できる成果物として作る。

- 通常は Markdown、表、callout、check summary、比較表示が有効な場合は sanitized HTML を使う
- 結論と現在状態を先頭に置き、その後に変更内容、Evidence、判断理由、リスク、次の工程を並べる
- 実行コマンド、exit code、変更ファイル、review finding、該当 diff、commit hash、Agent / Provider、時刻を構造化して表示する
- 同じ内容の細かな進捗コメントを連投せず、節目ごとに圧縮した summary を投稿する
- 詳細な逐次ログは Activity に残し、Comment は読み返す価値のある decision / handoff artifact にする
- HTML は allowlist sanitizer を通し、script、event handler、unsafe URL / CSS、iframe などを禁止する
- 色だけで状態を表さず、見出し、テキスト、アイコン、表のラベルを併用する

## 目的

OneTeam は現在、「Issue-driven development with AI for solo developers」を掲げ、Issue から要件定義、実装、Pull Request、レビュー、QA までを AI Agent Job で進めるローカル開発支援ツールとして設計されている。

最近の Loop Engineering の文脈に合わせるなら、OneTeam の主語を「Issue を AI に渡すツール」から「単独開発者がローカルで検証可能な AI 開発ループを設計・実行・改善するツール」へ広げる必要がある。

Issue は捨てない。Issue は Loop の入力、記憶、成果物、Human Gate の場として残す。ただし、プロダクトの中心概念は Issue 単体ではなく、起動条件、実行環境、Agent 編成、証拠、停止条件、記憶まで含む `Loop` に引き上げる。

## 参照した Loop Engineering の要点

参考:

- Zenn: [もうプロンプトを書くな--「Loop Engineering」という新しいパラダイムの正体](https://zenn.dev/acrosstudioblog/articles/38509c0473683a) (2026-06-11)
- Addy Osmani: [Loop Engineering](https://addyosmani.com/blog/loop-engineering/) (2026-06-07)

Loop Engineering では、人間が都度プロンプトを書くのではなく、AI Agent を起動し、仕事を拾い、検証し、状態を記録し、次の実行へつなぐ仕組みそのものを設計する。

主要部品は次の通り。

| 要素 | 意味 | OneTeam での位置づけ |
| --- | --- | --- |
| Automations | 時刻、イベント、条件で自律起動する仕組み | Label Automation を拡張し、Loop Trigger / Scheduler / Triage Inbox にする |
| Worktrees | 複数 Agent の作業領域を分離する仕組み | 現在の branch 運用を per-loop-run worktree に拡張する |
| Skills | プロジェクト知識、手順、制約、過去の罠を外部化する仕組み | Repository ごとの `skills` / `rules` / `playbooks` として管理する |
| Sub-agents | 実装者と検証者を分ける仕組み | 要件定義、実装、レビュー、修正、QA を明示的な Agent Team として再編する |
| Connectors | issue tracker、Git、CI、Slack など外部ツールとつなぐ仕組み | MVP はローカル完結、将来は GitHub / Linear / Slack / CI を Connector 化する |
| Memory | 会話外に残る進捗、判断、結果、次アクション | DB、Activity Log、Markdown state file、Loop Memory を統合する |

重要なのは、Loop は「何度も回ること」ではなく「検証可能な停止条件まで進むこと」である。したがって OneTeam でも、完了判定、証拠、タイムアウト、コスト上限、人間への引き渡しを第一級の概念として扱う。

## 現状の OneTeam がすでに持っている強み

OneTeam は Loop Engineering に近い土台をすでに持っている。

- Issue / Pull Request / Label / Comment / Activity Log をローカルに保持している。
- `requirements`、`implementation`、`review`、`fix`、`qa` の Agent Job がある。
- Label によって次の Agent Job を起動できる。
- AI の進捗、実行コマンド、変更ファイル、テスト結果、エラーを Activity Log に保存する設計がある。
- Human Gate により、人間の回答が必要な時点で停止できる。
- install / dev / build / test / lint コマンドを検出し、検証に使う設計がある。
- 現行実装では Pull Request の最終 merge をユーザーが行うため、人間の判断を残す土台がある。新方針では、この判断を明示的な自動 merge policy、Evidence Gate、Risk Signal、Human Gate に置き換える。

このため、全面刷新ではなく「Issue-driven workflow の上に Loop control plane を足す」方向が適している。

## 変更後のポジショニング

### 現在

```text
Issue-driven development with AI for solo developers
```

### 推奨

```text
Autonomous local AI development from Issue to merge
```

または:

```text
Run verifiable local development loops that implement, review, and merge
```

日本語では次の表現が合う。

```text
Issueから検証・レビュー・mergeまで自動完遂するローカル開発アプリ
```

補足コピー:

```text
Issueを起点に、要件定義、実装、検証、Pull Request、レビュー、修正、merge、記録までを、証拠付きのAI開発ループとしてローカルで自動完遂します。
```

## 対応するべき内容

### 1. `Loop` を新しい中心概念として追加する

現在の中心は Issue と Agent Job だが、Loop Engineering ではそれらを束ねる制御単位が必要になる。

追加したい概念:

- Loop Definition
- Loop Run
- Loop Step
- Trigger
- Goal Contract
- Stop Condition
- Evidence
- Loop Memory

最小データ項目:

| Entity | 主な項目 |
| --- | --- |
| `loops` | name, purpose, trigger_type, cadence, target_scope, enabled, owner, max_rounds, time_budget_minutes, cost_budget, stop_condition_json |
| `loop_runs` | loop_id, status, started_at, finished_at, stop_reason, worktree_path, summary, evidence_json |
| `loop_steps` | loop_run_id, agent_type, target_type, target_id, status, input_json, output_json, evidence_json |
| `objective_runs` | issue_id, pull_request_id, status, workflow_stage, round_count, max_rounds, token_budget, cost_budget_usd, provider_usage_json, evidence_requirements_json, evidence_json |
| `loop_memory_entries` | loop_id, source_type, source_id, title, body, tags, created_at |

既存の `agent_jobs` は `loop_steps` から参照される実行単位として残すのがよい。

### 2. Automation を Label 起動から Trigger / Scheduler 起動へ広げる

現在は Label による起動が主だが、Loop では定期実行やイベント起動が必要になる。

追加する起動条件:

- 毎朝、未処理 Issue を triage する
- CI / test / lint 失敗を検知して修復候補を作る
- Repository import 後に不足コマンドを検出して Issue 化する
- `main` との差分や直近 commit からリグレッション候補を探す
- `needs-input` の回答投稿で停止中 Loop を再開する

内部Schedulerはopen IssueのObjective補完とmissing command検出に加え、7日以上更新のないactive Objective、Agent Jobのfailed verification / `ci_status` Evidence、同じ対象で以前成功したQA / Verifierが後に失敗したregression候補、tracked source fileのTODO / FIXMEをTriageへ集約する。incident固有のscheduler keyまたはsource snapshotのfingerprintを保存し、同じ状態を繰り返し通知しない。外部CIからstatusを取得する処理はConnector runtimeの責務とし、Schedulerは取得済みEvidenceの失敗を他の検証失敗と同じcontractで扱う。

UI には `Loops` または `Automations` ページを追加する。

外部向けprimary UXはIssue-firstとし、Schedulerが作成したTriageはIssues一覧の通知セクションに表示する。ユーザーはLoops tabへ移動せず、発見理由とMarkdown Evidenceを確認してIssue化または無視できる。Loop Definition / Run / Memoryの詳細UIはinternal control planeとして残す。

必要な表示:

- 有効 / 無効
- 起動条件
- 次回実行予定
- 前回実行結果
- 生成された Issue / PR
- 停止理由
- 必要な人間判断

### 3. Triage Inbox を追加する

Loop が自律的に仕事を拾うと、すべてを即実装に流すのは危険になる。

そこで、Loop が見つけた候補を一度 `Triage Inbox` に集約する。

Triage Item の例:

- CI 失敗
- test / lint の失敗
- 不足コマンド
- 古い依存関係
- 未完了 Issue
- ドキュメントと実装の不一致
- 最近の変更から疑われるバグ

ユーザー操作:

- Issue に変換する
- 既存 Issue に紐づける
- 今回は無視する
- Loop に自動対応させる
- Human Gate として質問に回答する

### 4. Goal Contract を明示化する

Loop は受け入れ基準が曖昧だと危険になるため、Issue の要件定義コメントを `Goal Contract` として扱う。

Goal Contract に必須化する項目:

- 目的
- 対象範囲
- 対象外
- 入力
- 期待される成果物
- 定量的な受け入れ条件
- 実行する検証
- 禁止事項
- 予算上限
- 最大ラウンド数
- 人間へ引き渡す条件
- rollback / revert 方針

既存の要件定義エージェントの出力項目に、次を追加する。

- Stop Condition
- Evidence Required
- Risk Signals
- Human Handoff Conditions
- Loop Memory Update

`Evidence Required`は自由文だけでなく、次の型付きruleとしてObjectiveに保存する。

- `type`: `test`、`lint`、`build`、`screenshot`、`file_change`、`review`、`qa`など、照合するEvidence種別
- `required`: Gateを通過するために必須か
- `commitScope`: `source`、`target`、`both`、`none`のどのcommit snapshotへ紐づけるか
- `maxAgeHours`: Evidenceを有効とみなす最大経過時間。鮮度を問わない場合は`null`

Verifierとautomatic merge gateは各ruleを機械照合し、`missing`、`stale`、`commit_mismatch`、`unavailable`を区別して記録する。required ruleが1件でも不成立なら、Agentの自己申告がpassでも完了・mergeへ進めない。

### 5. Evidence Gate を追加する

Loop の完了は Agent の自己申告ではなく、証拠で判断する必要がある。

Evidence として保存するもの:

- 実行コマンド
- exit code
- test / lint / build 結果
- Playwright のスクリーンショット
- UI snapshot
- 変更ファイル
- diff summary
- performance 指標
- error stack
- CI status

UI では Pull Request / Loop Run / Agent Job に `Evidence` タブを追加する。

完了条件:

- 必須 Evidence が揃っている
- Stop Condition を満たしている
- Review Agent または Verifier が承認している
- Human Gate が必要な場合はユーザーが承認している

### 6. Stop Condition と Stop Reason を第一級にする

現在の Agent Job Status に加えて、Loop Run の停止理由を明確化する。

Stop Reason の例:

- `passed`: 受け入れ条件を満たした
- `failed`: 検証失敗
- `waiting_human`: 人間判断が必要
- `provider_quota_exhausted`: AI provider の利用枠回復待ち
- `timeout`: 時間上限
- `max_rounds_exceeded`: 最大ラウンド数超過
- `budget_exceeded`: コスト上限超過
- `risk_detected`: 危険な変更を検出
- `rollback_required`: 差し戻しが必要
- `canceled`: ユーザーが停止

UI 上では「成功 / 失敗」だけでなく「なぜ止まったか」を目立つ位置に出す。

Provider usageのbudget制御では、providerごとに異なるtelemetryを共通形式へ正規化し、input / cached input / output / reasoning / total token、request count、USD costをObjectiveへ累積する。token budgetとcost budgetは独立して判定する。

- costはproviderが明示的に返したUSD値だけを記録し、モデル名や公開価格表から推定しない
- costを返さないproviderでもtoken集計は失わない
- Loop固有の`cost_budget`がある場合はproject既定のObjective cost budgetより優先する
- budget到達後の次のjobはdequeue時に`budget_exceeded`へ移し、`running`にせずprovider adapterも呼ばない
- budget gate自体はObjectiveのroundを消費しない
- 使用量、適用上限、provider / modelをEvidenceへ残し、Issue / PRを後から見返した際に根拠を追跡できるようにする

時間制御はAgent Job全体と検証commandを分離する。Loop固有の`time_budget_minutes`を優先し、未指定時はProject既定のAgent time budgetを使用する。deadlineはprovider adapterへ渡し、CLI process、LM Studio request、tool commandを中断可能にする。lint / test / buildには別のcommand timeoutを適用し、Agentの残り時間がそれより短い場合だけ残り時間を上限にする。Agent deadline到達時はpartial resultとprovider telemetryを破棄せず、`timeout` EvidenceとしてHuman Gateへ残す。

Provider adapterの終了境界では共通Stop validatorを実行し、未構造化応答、成功statusとstop reasonの矛盾、成功したtestと非0 exit codeの矛盾、repository外を指すchanged fileを自動成功させない。判定結果は`adapterValidation` metadataとEvidenceへ保存する。OneTeam自身がtool loopを制御するLM Studioでは各tool実行後にもPostToolUse判定を行い、Activityと次のmodel requestへ渡すtool responseの両方へ記録する。Codex / Claude Codeの内部toolはCLI外部から直接interceptせず、stream activityの監査記録とStop validator、WorkerのEvidence / diff gateで検証する。

### 7. Worktree isolation を導入する

現在の実装は branch 作成が中心だが、複数 Loop / Agent を並列に走らせるには作業ディレクトリの分離が必要になる。

対応内容:

- Loop Run ごとに git worktree を作成する
- Agent Job は割り当てられた worktree 内でのみ編集する
- 完了後に worktree を cleanup する
- main workspace に未コミット変更があっても、分離 worktree で安全に実行できるようにする
- 同じ Issue / PR に対する破壊的 Job は引き続き lock する

ブランチ命名例:

```text
oneteam/loop-{loopRunId}/issue-{issueId}-{slug}
```

worktree path 例:

```text
~/.oneteam/worktrees/{projectId}/loop-{loopRunId}
```

### 8. Skills / Project Knowledge を管理する

Loop は毎回ゼロから推論すると品質が安定しない。プロジェクト知識を外部化し、各 Loop Run が読み込めるようにする。

管理したいファイル:

- project overview
- build / test / lint 手順
- coding conventions
- UI design rules
- architecture decisions
- known pitfalls
- review checklist
- QA checklist
- release / merge policy

OneTeam 内の配置例:

```text
.oneteam/skills/project.md
.oneteam/skills/build.md
.oneteam/skills/review.md
.oneteam/skills/qa.md
.oneteam/memory/loop-notes.md
```

UI では `Knowledge` または `Skills` ページを追加し、Loop ごとに読み込む Skill を選べるようにする。

### 9. Sub-agent 編成を明示する

OneTeam にはすでに複数 Agent があるが、Loop Engineering に合わせるなら「実装する Agent」と「検証する Agent」を明確に分離する必要がある。

推奨編成:

| Role | 役割 |
| --- | --- |
| Explorer | コードベース、Issue、過去ログを調査する |
| Planner | Goal Contract と実行計画を作る |
| Implementer | ファイル変更とテスト追加を行う |
| Reviewer | 仕様、設計、保守性、リスクを見る |
| Verifier | Stop Condition と Evidence を機械的に確認する |
| QA | UI / E2E / 操作確認を行う |

既存 Agent との対応:

- 要件定義エージェント: Explorer + Planner
- 実装エージェント: Implementer
- レビューエージェント: Reviewer
- QA エージェント: QA + Verifier の一部
- 新規追加: Verifier Agent

Verifier Agent は、コードを書いた Agent と別の観点で完了判定を行う。

### 10. Memory を DB と Markdown の両方で残す

Activity Log は実行履歴として有用だが、Loop が次回参照する「圧縮された記憶」も必要になる。

追加する Memory:

- 前回 Loop Run の結果
- 成功した検証手順
- 失敗した試行
- 繰り返し発生するエラー
- 人間が下した判断
- 今後の改善候補
- 次回起動時に見るべき対象

保存先:

- DB: 検索、UI 表示、関連付け用
- Markdown: AI が読み込みやすい state file 用

Loop Run の最後に `Experience Return` ステップを追加し、Skill / Memory / checklist を更新する。

### 11. Connector 方針を定義する

MVP はローカル完結が強みなので、すぐに外部連携を必須化しない。ただし Loop Engineering の文脈では Connector が重要になるため、将来拡張点として明示する。

優先度:

1. Local Git / local command / local filesystem
2. GitHub Issues / Pull Requests
3. GitHub Actions / CI status
4. Linear
5. Slack / Discord notification
6. Staging API / database

設計方針:

- Connector は optional plugin として扱う
- ローカルだけでも Loop が成立する
- 外部サービスの権限操作は Human Gate を必須にする
- 本番環境に影響する操作は初期状態では禁止する

### 12. Cost / Budget / Risk 管理を追加する

Loop は便利な一方、放置するとコストや変更範囲が膨らむ。

追加したい制御:

- 最大実行時間
- 最大ラウンド数
- 最大 Agent Job 数
- 最大変更ファイル数
- 最大 diff 行数
- token / cost の概算
- 実行可能コマンド allowlist / denylist
- 変更禁止パス
- protected branch
- destructive command 検出

Risk Signal:

- テスト失敗が連続する
- diff が想定範囲を超える
- lock file など影響の大きいファイルが変わる
- セキュリティ関連ファイルが変わる
- migration が追加される
- performance が悪化する
- Agent が Goal Contract 外の作業を始める

Risk Signal を検出したら Loop は停止し、人間へ引き渡す。

### 13. Comprehension Debt 対策を入れる

Loop がうまく回るほど、ユーザーが自分のコードから疎遠になるリスクがある。

OneTeam では次の対策を UI / workflow に入れる。

- PR 完了前に `Automated Merge Checklist` を表示する
- AI が作った変更の「読むべき順序」を提示する
- 重要な設計判断を `Decision Summary` として残す
- merge 前に system が確認した Gate と Evidence を記録する
- 大きな変更や高リスク変更は自動 merge 対象外とし、Human Gate に送る
- 自動 merge 後も理解可能性を保てるよう、Issue / PR に Decision Summary、主要 diff、検証結果、残リスクを残す

### 14. Landing page / README の訴求を変更する

現在のコピーは Issue-driven に寄っているため、Loop Engineering の要素を前面に出す。

変更候補:

| 対象 | 現在 | 変更案 |
| --- | --- | --- |
| README H1 | `Issue-driven development with AI for solo developers` | `Local Loop Engineering for solo developers` |
| hero eyebrow | `Issue-driven development with AI for solo developers` | `Local Loop Engineering for solo developers` |
| hero copy | Issue から PR / QA まで進める | Issue を起点に、AI 開発ループを設計・実行・検証・記録する |
| overview heading | GitHub-like AI workflow | Verifiable AI development loops that stay local |
| workflow heading | How It Works | From Issue to Loop |

日本語 hero copy 案:

```text
Issueを起点に、要件定義、実装、レビュー、QA、証拠記録、停止条件までをローカルで回す、単独開発者向けのAI開発ループ設計ツールです。
```

英語 hero copy 案:

```text
Design local AI development loops that start from issues, run through requirements, implementation, review, QA, evidence, and clear stopping conditions.
```

## 推奨ロードマップ

### Phase 1: Loop と Evidence を仕様に追加する

- `docs/REQUIREMENTS.md` に Loop / Loop Run / Stop Condition / Evidence を追加する
- `docs/03-agent-prompt-templates.md` に Goal Contract と Evidence Required を追加する
- README / docs/index.html / docs/ja.html のコピーを Loop Engineering 寄りに変更する
- Agent Job の出力に `stopReason` と `evidence` を追加する

### Phase 2: UI に Loops / Triage / Evidence を追加する

- `Loops` ページを追加する
- `Triage Inbox` を追加する
- Loop Run detail を追加する
- Agent Job / PR detail に Evidence タブを追加する
- Stop Reason を一覧と詳細で表示する

### Phase 3: Scheduler と Worktree isolation を実装する

- Loop Trigger / Scheduler を実装する
- Loop Run ごとの git worktree 作成と cleanup を実装する
- 並列実行時の lock 戦略を更新する
- main workspace の dirty state と worktree 実行を分離する

### Phase 4: Skills / Memory / Verifier Agent を追加する

- `.oneteam/skills` と `.oneteam/memory` を導入する
- Skills 管理 UI を追加する
- Loop Run 終了時に Memory を更新する
- Verifier Agent を追加し、Stop Condition を別 Agent が判定する

### Phase 5: 自動完遂と Provider capacity recovery

- requirements から final verification までの workflow controller を接続する
- Evidence Gate 通過後の automatic merge と merge 直前再検証を追加する
- merge 後の Issue update / close、Memory update、worktree cleanup を追加する
- Codex usage remaining 枯渇を `waiting_provider` として検出・永続化する
- reset time / backoff による自動再開とアプリ再起動後の復元を追加する

### Phase 6: GitHub-quality UI / Diff / Timeline

- GitHub 相当の Issues / Pull Requests / Checks 情報設計へ揃える
- diff viewer を split / unified、syntax highlight、line number、word diff、deep link に対応させる
- 大規模 diff の lazy loading / virtualization を実装する
- system comment の Markdown / sanitized HTML template と timeline 表示を洗練する

### Phase 7: Connector / Plugin 拡張

- GitHub Connector
- GitHub Actions / CI status Connector
- Linear Connector
- Slack notification Connector
- optional plugin packaging

## MVP からの差分優先度

| 優先度 | 対応 | 理由 |
| --- | --- | --- |
| P0 | コピー変更、Goal Contract、Evidence、Stop Reason | Loop Engineering と名乗るための最小条件 |
| P1 | Loop entity、Loops UI、Triage Inbox | Issue-driven から Loop-driven へ体験を変える中核 |
| P1 | Worktree isolation | 複数 Loop / Agent 実行の安全性に必要 |
| P2 | Skills / Memory | 継続実行の品質を上げる |
| P2 | Verifier Agent | 自己申告完了を避ける |
| P0 | 自動完遂、automatic merge、Provider 待機 / 自動再開 | ユーザー操作なしで安全に成果へ到達する中核 |
| P1 | GitHub-quality UI、diff、system comment | 自動化の結果を理解・検証・再利用できる体験に必要 |
| P3 | 外部 Connector | ローカル完結の価値を維持しつつ将来拡張 |

## やらない方がよいこと

- 受け入れ基準がない Issue を自動実装に流す
- 証拠がないまま `done` にする
- 広範囲リファクタリングを無人 Loop に任せる
- 本番環境、認証、課金、秘密情報に関わる操作を自動実行する
- Gate 未通過、stale Evidence、未解決 Risk Signal、merge conflict がある状態で自動 merge する
- provider quota 枯渇を通常の実装失敗として round count や repeated failure に加算する
- Activity Log だけを Memory とみなし、次回 Loop 用の要約を残さない

## まとめ

OneTeam は、Issue、PR、Agent Job、Activity Log、Human Gate をすでに持っているため、Loop Engineering への適合性は高い。

最も重要な変更は、Issue を中心にした一連の処理を、検証可能で自動完遂可能な `Loop` として再定義することである。Trigger、Goal Contract、Evidence、Stop Condition、Worktree isolation、Skills、Memory、Verifier に加え、Provider capacity recovery、automatic merge、Issue lifecycle update を制御面の中核にする。

これにより OneTeam は、「Issue を AI に渡すローカルツール」から「Issue を起点に、AI 開発ループを証拠付きで自動完遂し、読み返せる形で経験を蓄積するローカル開発アプリ」へ進化できる。
