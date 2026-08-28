# OneTeam 自動完遂 / Loop Engineering TODO

作成日: 2026-06-17
最終更新日: 2026-08-28

このTODOは、[LOOP_ENGINEERING_ADAPTATION.md](./LOOP_ENGINEERING_ADAPTATION.md) の方針を、現在の実装状況と次の目標に分けて管理する。

目標は、Issue を起点に requirements、implementation、verification、local PR、review、fix、QA、final verification、merge、Issue update / close、Memory update までを原則として自動完遂するローカルアプリである。Loop Engineering の Goal Contract、Evidence、Stop Condition、Risk Signal、Worktree、Verifier、Memory は、自動化を安全かつ検証可能にする制御面として維持する。

## ステータス

| Status | 意味 |
| --- | --- |
| Done | 現在の主要導線から利用でき、実効制御とテストがある |
| Partial | 実装はあるが、対象範囲、制御、UI、テストのいずれかが不足している |
| Internal / Hidden | DB / API / UI はあるが、通常のユーザー導線には出していない |
| Designed | 設計資料または schema のみで、runtime としては未実装 |
| Todo | 新方針として未実装 |

## 現在の実装棚卸し

### Loop / Objective / Evidence

- [x] **Done**: `loops` / `loop_runs` / `loop_steps` / `loop_memory_entries` / `objective_runs` / `triage_items` のDBとRepository
- [x] **Done**: requirements、implementation、review、fix、QA、verifier のAgent Jobとlabel automation
- [x] **Done**: Issue / PRを束ねるstanding objective、round count、Stop Reason、Evidence集約
- [x] **Done**: implementation後のlint / test / build、changed files、command resultのEvidence化
- [x] **Done**: VerifierのStop Condition判定と`ready-to-merge`への遷移
- [x] **Done**: repeated failureと最大round到達時のHuman Gate
- [x] **Done**: score manipulationの基本diff scan（test skip / only、assertion 0、error swallow、test file deletion）
- [ ] **Partial**: Evidenceに取得時刻、source / target branchとcommitを保存し、Verifier Evidenceのcommit / 24時間鮮度をGateで照合する。Goal Contractの`Evidence Required`を種類別に照合する制御は未完了
- [x] **Done**: Verifier pass後のautomatic merge gateでrequired lint / test / buildをsource worktree上で再実行し、local merge、PR / Objective / Issue完了処理へ接続する

### Worktree / Safety / Budget

- [x] **Done**: implementation / fixのgit worktree分離、dirty main workspaceとの分離、job lock
- [x] **Done**: 成功時のworktree cleanupと既存OneTeam worktreeのrecovery
- [ ] **Partial**: 全Loop Runではなく、書き込みを行うimplementation / fixが主なworktree対象
- [x] **Done**: 最大変更ファイル数 / diff行数、command allowlist / denylist、protected path / branch、Risk SignalのHuman Gate
- [ ] **Partial**: time budgetは主にverification command単位で、Agent実行全体のdeadlineではない
- [ ] **Partial**: Objectiveのmax roundsは実効制御されるが、Issue / project policyから安全に変更する公開導線がない
- [ ] **Designed**: `cost_budget`はschemaにあるが、provider usage / token / costの集計と停止制御はない

### Scheduler / Skills / Memory / UI

- [x] **Done**: open IssueのObjective補完とrequired command不足のTriage作成を行う内部Scheduler
- [ ] **Partial**: stale objective、CI failure、regression、TODO / FIXMEなどのdiscoveryは未実装
- [x] **Done**: `.oneteam/skills` / `.oneteam/memory`、prompt contextへの投入、Loop / Objective節目のMemory更新
- [ ] **Internal / Hidden**: Loops、Loop Run detail、Triage Inbox、Skills管理UIは実装されているがroute / navigationから非表示
- [x] **Done**: Issue / PR detailのObjective summary、Agent Job detailのStop Reason / Evidence
- [x] **Done**: Agent commentのMarkdown / sanitized HTML
- [ ] **Partial**: internal system commentと通常Markdown Agent milestoneをOutcome / Record / Agent summary / Evidence or Decision / Findings / Next step / timestampの共通contractへserver-side再構成済み。明示的なsanitized HTML reportは原文を保持
- [ ] **Partial**: diffはファイル一覧と選択ファイルの遅延取得、unified / split、行番号、syntax highlight、word-level diff、Viewed、空白無視、context / 全文切り替え、hunk folding、line anchor、Agent finding / ユーザー行コメントのinline表示まで対応。scroll virtualizationは未実装

### Provider / Connector

- [x] **Done**: Codex / Claude Code / LM Studio provider adapterとjobごとのprovider記録
- [x] **Done**: Codex usage limit / rate limitを`waiting_provider`として永続化し、再開時刻とretry countを保持する
- [x] **Done**: Workerのpersistent pollingで期限到来したProvider Waitを復元・自動queueし、再起動後も継続する
- [ ] **Designed**: GitHub / CI / Linear / Slack / Discord Connectorは設計のみ
- [ ] **Todo**: implementer / reviewer / verifierごとのrole-based provider / model設定

## P0: Issueからmergeまでを自動完遂する

### Workflow controller

- [x] requirements完了後からimplementation、PR creation、review、fix、QA、verifier、mergeまでをstanding objectiveが自動的に駆動する
- [x] `requirements → implementation → review ↔ fix → QA → verification → ready-to-merge → merged`をObjectiveの永続`workflowStage`として管理し、許可されないlabel遷移ではAgentをqueueしない
- [x] retry、fix、re-review、re-QA、re-verifyを同じObjectiveのround、stage、Agent Job履歴として追跡する
- [x] アプリ起動 / リポジトリ切替後にqueuedを継続し、interrupted running Jobをattempt付きで再queueしてLoop Step / Run・Objective・Activityを同期する。waiting_providerは期限を保持して自動再開する
- [x] Issue / PRのObjectiveパネルからPause / Resume / Cancelでき、Job / Loop / Objectiveを永続的に同期し、paused / canceled中のlabel automationと手動queueを止める

### Automatic merge gate

- [x] project settingsで`autoMergeEnabled`、対象branch、merge / squash strategy、diff risk thresholdを管理する
- [x] Verifier pass後に`ready-to-merge`をautomatic merge gateへ接続する
- [ ] **Partial**: merge直前のsource HEAD、target HEAD、merge-base、conflict、Objective Evidence、required commands、score-manipulation Risk Signalを再確認する。LoopごとのRisk Policy再評価は未実装
- [x] Evidenceに対象commit hashと取得時刻を保存し、stale Verifier Evidenceを検出する
- [ ] **Partial**: merge gate中のsource / target driftはmergeを止めるが、必要範囲の自動再実行は未実装
- [x] conflictがある場合は`resolving-conflicts`へ戻し、conflict-resolution workflowをqueueする
- [x] Gate通過後はOneTeamがmergeし、PR statusを`merged`、Objectiveを`succeeded`にする
- [ ] **Partial**: conflictと不明な失敗をcorrectable / Human Gateへ分類済み。retryable merge errorのbackoffは未実装
- [x] automatic merge、required command pass / failure、stale Evidence、target drift、conflict routingのintegration testを追加する

### Issue lifecycle

- [x] 要件確定、実装開始、PR作成、review、fix、QA、最終検証、Provider Gate、merge結果をIssueへ構造化Markdownで自動記録する
- [x] ユーザー本文を破壊的に上書きせず、system-managed label / status / relationと節目commentで状態を表す
- [ ] Goal Contract変更時は旧条件との差分と変更理由を残す
- [ ] **Partial**: merge後にPR / Issueへfull commit / branch snapshot / merge base / strategy / Verifier / required commands / risk decision / changed file deep linkを含むMarkdown summaryを投稿済み。行単位の主要diffとMemory参照の集約は未完了
- [ ] **Partial**: merge後のIssue自動closeと`done` labelは実装済み。再open時のObjective選択は未実装

## P0: Codex usage remaining待機と自動再開

### Detection / persistence

- [x] `waiting_provider` Agent Job / Objective statusを型、DB、migration、API、UIに追加する
- [x] `provider_quota_exhausted` Wait Reasonを追加する
- [ ] **Partial**: Codex CLIのstructured error / stderr messageからusage limit / rate limit / HTTP 429を分類し、thread / usage eventを収集する。usage eventだけからquota exhaustionを判定する制御は未実装
- [x] provider、model、message、usage snapshot、detectedAt、resetAt、nextRetryAt、retryCount、thread / session idをProvider Wait metadataへ保存する
- [x] provider quota待機をfailed、waiting_human、repeated failure、objective roundとして数えない

### Wait scheduler / recovery

- [x] reset timeがある場合は直後、ない場合はjitter付き・上限付きexponential backoffで再開する
- [ ] quota確認用の軽量probeと、実Job再開を分離して無駄なtoken消費とerror spamを避ける
- [ ] **Partial**: worktree、branch、job input、Objective、Evidence、Codex thread IDを保持する。Codex CLIを同じthreadで継続する実行方式は未実装
- [x] quota回復時に同じJob / Objective stepを自動queueし、通常の完了処理でEvidenceを再取得する
- [x] アプリ再起動時に`waiting_provider`と`nextRetryAt`をDBから復元する
- [x] 状態条件付きupdateにより、同一Jobの二重再開を防止する
- [ ] **Partial**: wait開始 / 自動・手動再開 / cancelをActivityと重複排除された構造化Markdownへ記録し、PRの履歴をlinked Issueにも同期する。Cancel時はObjective / Loopも整合させる。軽量probeによる延長 / 回復eventは未実装
- [x] usage limit、resetあり / なし、別WorkerによるDB復元、手動Resume、Cancelのunit / integration testを追加する

### UI

- [x] Issue / PRのlatest statusとAgent JobにProvider Waitを明示する
- [x] Agent Jobに推定再開時刻、自動再試行までのライブ残り時間、wait reason、最終確認時刻、retry countを表示する
- [x] Resume now、待機Jobのprovider切替付き再開、Cancelを提供する
- [x] quota待機をHuman Gateや実装failureと異なるstatus / calloutで表示する

## P1: GitHub-quality UI

### Information architecture

- [ ] repository headerとIssues / Pull Requests / Agent runs or Checks / Repository / SettingsをGitHubに近い階層へ整理する
- [ ] Issue / PR listをstatus、label、author role、comments、checks、updated timeで走査しやすくする
- [ ] Issue / PR detailをheader、conversation timeline、checks、sidebar metadataに整理する
- [ ] Objective、Evidence、Human Gate、Provider Gateを別のLoop管理画面ではなくIssue / PRの文脈内に統合する
- [ ] loading / empty / error / waiting / retrying状態のvisual languageを統一する
- [ ] **Partial**: diffの`j` / `k` file navigation、ARIA shortcut、text statusは実装済み。全画面のfocus、keyboard、contrast auditは未実装

### Diff viewer（最優先）

- [x] **Done**: file list、file search、sticky file header、previous / next navigation、`j` / `k` keyboard navigation（tree表示は必要性を見て追加）
- [x] **Done**: unified / split diff切り替え
- [x] **Done**: old / new line number、主要なcode / markup / Markdownのsyntax highlighting、split表示のword-level diff
- [x] **Done**: additions / deletions、rename、binary、added / deleted statusの表示
- [x] **Done**: whitespace無視、標準 / 20行context / 全文表示、keyboard accessibleなhunk単位の折りたたみ
- [x] **Done**: viewed状態とreview progressをPR単位でlocalStorageへ永続化
- [ ] **Partial**: file / line hash anchor、hash指定時のFiles changed自動表示、merge summaryからのfile link生成は実装済み。line linkのsystem生成と専用route parameterは未実装
- [x] **Done**: Review / QA Agent findingを正規化し、open / resolved履歴、ファイル件数、該当行inline card、全文contextへの移動を表示する。ユーザー行コメントはsource / target commitを固定して永続化し、stale diffを拒否したうえでMarkdown composerとともに該当行へinline表示する
- [ ] **Partial**: merge system commentのchanged file linkからdiffへ直接移動できる。check summaryとreview findingからの重要行linkは未実装
- [ ] **Partial**: 大規模diffのfile-level lazy loading、選択変更時のabort、source / target commit固定の30件cache、初期1,000行 / 段階描画 / 5,000行DOM上限、finding focused windowは実装済み。scroll virtualizationは未実装
- [ ] **Partial**: diff parser、split row、word diff、syntax tokenizer、deep-link、render limit / focused windowのunit testと6,000行diffのbrowser testは実装済み。component snapshotとscroll virtualization performance計測は未実装

### Conversation / checks

- [ ] GitHub相当のtimelineとしてcomment、label、review、commit、Provider Gate、merge eventを統合表示する
- [ ] checks summaryからAgent Job、Evidence、command output、screenshot、diffへ移動できるようにする
- [ ] comment permalink、編集履歴、折りたたみ、長文tableのresponsive表示を追加する

## P1: 後から読み返せるAgent / system comment

- [x] **Done**: internal milestone commentの共通Markdown contractとbuilderを定義する
  - conclusion / current state
  - Goal Contract summary
  - changes / decision
  - Evidence / checks
  - review findings / remaining risks
  - diff / file / line / commit / PR references
  - next step / stop or wait reason / resume condition
  - Agent role / provider / model / timestamp
- [x] **Done**: requirements、implementation、review、fix、QA、verifier、Provider Gate、ready-to-merge、automatic merge、Issue completionのMarkdown milestone templateを実装
- [x] **Done**: structured Agent outputからserver側で安定したMarkdown summaryを生成し、provider / model / session、Evidence、review / QA finding、next workflow stateを記録する
- [x] **Done**: internal system commentはMarkdownを標準とし、表とcalloutを共通builderで生成する
- [ ] sanitizerのallowlist、URL、CSS、image、data attribute policyとsecurity testを強化する
- [ ] Activityの逐次ログをcommentへ連投せず、節目単位で圧縮・重複排除する
- [ ] **Partial**: merge / Issue完了 / Agent review・QA commentのPR / changed file / finding line参照はdeep link化済み。自由文中の参照検証とcommit link生成は未実装
- [ ] merge後のfinal summaryをIssueとPRの両方から参照できるようにする
- [ ] 日本語 / 英語で情報階層と表の読みやすさが崩れないsnapshot / browser testを追加する

## P2: Loop Engineering制御の強化

- [ ] Goal Contractの`Evidence Required`を型付きにし、種類、必須性、対象commit、freshnessをGateが機械判定する
- [ ] implementation / review / QA / verifierでrole-based provider / modelを設定できるようにする
- [ ] provider usage / token / costをObjectiveに集計し、budgetでqueue前に停止できるようにする
- [ ] Agent全体deadlineとcommand別timeoutを分離する
- [ ] PostToolUse / Stop Hook相当の軽量検証をprovider adapterごとに追加する
- [ ] stale objective、CI failure、regression、TODO / FIXME discoveryをSchedulerへ追加する
- [ ] TriageをIssues / notificationsへ統合し、Loops tabなしで処理できるようにする
- [ ] Worktree cleanup / retention policyを成功、失敗、Human Gate、Provider Gate別に定義する
- [ ] objective hard gate、max rounds、repeated failure、score manipulation、schedulerの直接testを追加する

## P3: Connector / Plugin

- [x] **Designed**: GitHub Issue / Pull Request Connector
- [x] **Designed**: GitHub Actions / CI status Connector
- [x] **Designed**: Linear Connector
- [x] **Designed**: Slack / Discord notification Connector
- [x] **Designed**: Connectorをoptional pluginとして扱う方針
- [ ] **Todo**: 最初のruntime ConnectorとしてGitHub Actions statusをTriage / Evidenceへ接続する
- [ ] **Todo**: Connector failureをAgent Job failureではなくActivity / Triageとして隔離する

## 完了判定

新方針の最小完了条件は次の通り。

- 明確なIssueを作成すると、Human Gateが不要なケースではユーザー操作なしでPRが作成され、review / fix / QA / verifierを経てlocal target branchへmergeされる
- merge直前にHEAD、conflict、required Evidence、Risk Signalが再評価される
- merge後にIssue / PRへ読み返せるfinal summaryが残り、Issueがpolicyどおり更新またはcloseされる
- Codex usage remainingが枯渇してもJobは失敗せず、待機状態と再開予定がUIに表示され、利用枠回復後に自動再開する
- diffで変更ファイル、行番号、syntax、word-level change、review finding、重要箇所へのdeep linkを確認できる
- typecheck、lint、unit / integration test、automatic merge E2E、quota recovery E2E、large diff browser testが通る
