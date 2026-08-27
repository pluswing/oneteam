# Qiita Article Based Loop Engineering Gap Analysis

作成日: 2026-06-25

> 2026-08-27 update: 本文は2026-06-25時点のgap分析として残す。standing objective、内部Scheduler、hard gate、repeated failure、score manipulation scanはその後実装された。現在の実装棚卸しと次の方針は [LOOP_ENGINEERING_TODO.md](./LOOP_ENGINEERING_TODO.md) を参照する。

参照:

- Qiita: [入門から実践 -「 ループエンジニアリング」](https://qiita.com/Syoitu/items/97ed37e7ba9c38dc75d8)
- 記事の最終更新日: 2026-06-21

## 結論

OneTeam は、Issue を起点に requirements、implementation、review、fix、QA、verifier をつなぎ、Worktree、Evidence、Stop Reason、Memory、Human Gate を持つため、Loop Engineering の土台はかなり揃っている。

一方で、参照記事のいう Loop Engineering は「人間が都度プロンプトを打つ位置から降り、目標・検証・停止条件・記憶・再実行を仕組みとして回す」ことに重心がある。現状の OneTeam はまだ「ラベル遷移ごとに Agent Job を起動し、その実行を Loop Run として記録する」構造が中心で、記事の意味での「立ちっぱなしの目標が、評価役と上限に制御されながら自走する Loop」には届いていない部分がある。

特に不足しているのは、Scheduler / Discovery、Stop Hook 相当の強制検証、複数 Agent Job を束ねる standing objective、評価役モデルの分離、ズル防止ルール、コスト・最大ラウンドの実効制御、Connector 実装である。

また、`docs/LOOP_ENGINEERING_TODO.md` は一部の項目が `[x]` になっているが、実装済み、内部 API あり、設計のみ、UI は存在するが非表示、という状態が混ざっている。Loop Engineering の完成度を判断する資料としては、実装状態を分け直す必要がある。

## 参照記事から抽出した基準

記事では、Loop Engineering を単なるプロンプト改善ではなく、Prompt、Context、Harness の上に乗る「自動で何度も回る仕組み」の設計として説明している。

OneTeam の評価基準として見るべき要点は次の通り。

| 基準 | 内容 | OneTeam で見るべき点 |
| --- | --- | --- |
| 5 つのアクション | discovery、handoff、verification、persistence、scheduling | 仕事の発見、Agent への受け渡し、別 Agent による検証、記憶、定期/イベント起動が揃っているか |
| 6 つのパーツ | Automations、Worktrees、Skills、Connectors、Sub-agents、Memory | 実装として存在するか、設計だけか |
| 評価役 | 生成役と評価役を分け、可能なら別モデルにする | verifier/review/QA が実装者から独立しているか |
| Stop Hook | Agent が完了を名乗る前に強制的に検証を走らせる | 自己申告ではなく、システムが完了を止められるか |
| 上限 | maxRuns、同一エラー反復、予算で止める | ループ暴走を実際に止められるか |
| ズル防止 | テスト削除、assertion 弱体化、skip 化などを禁止する | プロンプトだけでなく差分検査で検知できるか |
| 人間の判断 | ループを作っても、判断は人間が保持する | ready-to-merge、Human Gate、説明責任があるか |

## 現状で合っている点

| 観点 | 現状 | 評価 |
| --- | --- | --- |
| Issue 起点の workflow | Issue 作成後、requirements から implementation へ進む | OneTeam のプロダクト思想と相性がよい |
| Agent 分業 | requirements、implementation、review、fix、QA、verifier がある | Sub-agents の土台として妥当 |
| Evidence | Agent 出力 schema、Activity、Job detail に evidence がある | 完了の自己申告を弱める方向としてよい |
| Stop Reason | job / loop run に stopReason がある | 「なぜ止まったか」を扱える |
| Worktree | implementation / fix で worktree を使う | handoff と作業隔離に合っている |
| Memory / Skills | import した repository root の `.oneteam/skills` と `.oneteam/memory` を使う | repository ごとに知識を持ち運べる点はよい |
| Human Gate | `needs-input`、ready-to-merge、ユーザー merge がある | 人間の判断を残している |
| ユーザーに Loops を設定させない方針 | issue の要件定義から loop 設定を推定する prompt がある | プロダクト体験として自然 |

## 不足または齟齬がある点

### 1. Loop Run が workflow 全体の standing objective になっていない

重要度: High

現状では、`Label: requirements`、`Label: ready-for-implementation`、`Label: reviewing` のように、ラベルごとに system loop が作られ、各ラベル遷移で別の Loop Run が作られる。

これは実行履歴としては有用だが、記事が重視する「1 つの立ちっぱなしの目標を、判定役が OK するか上限に達するまで回す」構造とは違う。

影響:

- Issue から PR ready-to-merge までを 1 つの Loop として追跡しづらい。
- Stop Condition、Evidence、Human Gate、Verifier の結果が workflow 全体で集約されにくい。
- 「何周したか」「どこで詰まったか」「同じ失敗が続いたか」を横断的に判断しづらい。

対応案:

- `workflow_runs` または `objective_runs` を追加し、Issue 単位で requirements -> implementation -> review -> fix -> QA -> verifier を束ねる。
- 既存の `loop_runs` は workflow 内の step run として扱うか、`loop_steps` の粒度に寄せる。
- Issue / PR 画面に workflow 全体の Stop Condition、Evidence、Stop Reason、最終 verifier 結果を集約表示する。

### 2. Stop Hook / PostToolUse Hook 相当の強制制約がない

重要度: High

現状では implementation の後処理として verification command を実行し、失敗すれば job を failed にできる。ただし、記事で示されているような「Agent が止まろうとした瞬間にテストを差し戻す」「ファイル編集のたびに型チェックを返す」という hard harness にはなっていない。

影響:

- Agent は作業中に壊れた状態のまま進み続けることがある。
- 最後にまとめて検証するため、失敗原因が大きくなりやすい。
- Claude Code の `.claude/settings.json` hooks で可能な制御を、OneTeam 経由ではまだ再現できていない。

対応案:

- Provider ごとの harness 層を用意する。
- Claude Code 選択時は、import repository に `.claude/settings.json` と `.claude/agents/fixer.md` を生成または同期する選択肢を持つ。
- LM Studio の tool loop では、Write/Edit 相当の tool 実行後に lightweight check を実行し、失敗出力を次ターンの context に戻す。
- Codex / Claude Code の CLI adapter でも、final result 適用前の validation gate を強化し、必須 evidence がなければ完了扱いにしない。

### 3. Scheduler / Discovery が実装として弱い

重要度: High

現状の Automation は、主に user issue と label transition を起点にしている。Triage Item の API と UI は存在するが、Loops tab はユーザー向け導線から外れており、定期スキャンや外部イベントから自律的に仕事を発見する scheduler は見当たらない。

影響:

- 記事の 5 アクションのうち discovery と scheduling が弱い。
- 「放っておいても仕事を拾う Loop」ではなく、「ユーザーが issue/label を作った後に走る workflow」に寄っている。
- Triage Inbox は概念としてあるが、現在の issue-first UI では活用されにくい。

対応案:

- issue-first 方針は維持しつつ、内部 scheduler worker を追加する。
- まずは repository local scan から始める。
  - command detection 未完了
  - test/lint/build command の失敗
  - stale issue / stale PR
  - main との差分で壊れた検証
  - TODO / FIXME の候補抽出
- 発見したものはすぐ実装せず、Triage Item または draft issue として出す。
- Loops tab を復活させるのではなく、Issues / Agent Jobs / 通知に triage 結果を出す。

### 4. 評価役モデルの分離が不十分

重要度: Medium / High

Agent type は分かれているが、active AI provider は project setting の 1 つを使う構造で、review / QA / verifier に別 provider や別 model を割り当てる設定はない。

記事では、生成役と評価役を分けるだけでなく、可能なら別モデルで判定することが重要とされている。

影響:

- implementation と verifier が同じ provider / model の自己延長になりやすい。
- verifier の独立性を evidence として説明しづらい。
- LLM Studio などローカルモデル選択時に、評価の厳しさを agent role ごとに変えられない。

対応案:

- project settings に role based provider settings を追加する。
  - default
  - implementer
  - reviewer
  - qa
  - verifier / judge
- Agent Job に実際に使った provider / model を記録する。
- ready-to-merge の evidence に verifier provider / model を含める。

### 5. 最大ラウンド数とコスト上限が実効制御になっていない

重要度: Medium / High

DB schema と loop config には `max_rounds` や `cost_budget` があるが、現在の worker では workflow 全体の round count、同一失敗の連続検出、cost budget 超過による停止が明確には実装されていない。

影響:

- 記事が警告する token / cost runaway を実際には止めきれない。
- `docs/LOOP_ENGINEERING_TODO.md` の `[x] 最大ラウンド数` と `[x] cost/budget` は、設定項目としては存在しても Loop controller としては未完成に見える。

対応案:

- objective run 単位で attempt count を持つ。
- verification failure の signature を保存し、同じ signature が 2 回続いたら fixer または Human Gate に渡す。
- job start 前に budget を確認し、超過時は queue しない。
- token / command time / provider usage が取れる範囲で usage evidence を保存する。

### 6. ズル防止が prompt と risk policy に寄っている

重要度: High

Risk policy は changed files、diff lines、protected paths、protected branches、command allow/deny を見ている。一方で、記事で強調されている「テスト削除」「assertion 弱体化」「skip 化」「try/catch で握りつぶす」などの score manipulation を差分として検知する仕組みはまだ弱い。

影響:

- テストが通っても、受け入れ条件が弱体化している可能性が残る。
- verifier が見落とすと、Loop が「通すための変更」に逃げる余地がある。

対応案:

- diff scanner を追加する。
- まずは危険 signal として検出する。
  - test file deletion
  - `.skip` / `.only` の追加
  - assertion count の大幅減少
  - snapshot の大量更新
  - error handling の握りつぶし
  - expected value の過度な緩和
- signal が出た場合は Human Gate または verifier mandatory review にする。

### 7. Skills / Memory はあるが、Provider specific harness にはなっていない

重要度: Medium

OneTeam は repository root の `.oneteam/skills` と `.oneteam/memory` を正とし、prompt context に入れる設計になっている。これは provider 非依存の知識管理としてよい。

ただし、参照記事の Claude Code 最小構成は `CLAUDE.md`、`.claude/settings.json`、`.claude/agents/fixer.md` のように、ツールが直接読む hard harness を置く形である。OneTeam の `.oneteam` knowledge は prompt context としては使えるが、Claude Code 側の hooks / sub-agent 定義とはまだ接続されていない。

影響:

- Claude Code に切り替えても、記事でいう Claude Code native loop の強制力はそのまま得られない。
- provider を切り替えた時、skills の流用はできても harness の強度が揃わない。

対応案:

- `.oneteam` を canonical source とし、provider specific files を生成する。
  - Claude Code: `CLAUDE.md`、`.claude/settings.json`、`.claude/agents/fixer.md`
  - Codex: adapter prompt + schema + post-run validation policy
  - LM Studio: local tool loop policy
- provider specific files は手書きの source of truth にせず、OneTeam から再生成可能にする。

### 8. Connectors は設計資料が中心で、実装済みではない

重要度: Medium

`docs/CONNECTORS.md` には GitHub、CI、Linear、Slack / Discord の方針がある。しかし現状では optional plugin としての設計に見え、実際の connector runtime、MCP server、webhook ingestion、external status sync は見当たらない。

影響:

- 記事の 6 パーツのうち Connectors は未実装に近い。
- 「issue tracker・CI・Slack などに手が届く Loop」ではなく、local repository と local DB の Loop に留まっている。

対応案:

- TODO では `[x] Connector 設計を追加` とし、`Connector 実装` は別タスクに分ける。
- MVP connector を 1 つだけ実装するなら GitHub Actions status connector がよい。
- inbound は triage item 作成、outbound は PR comment / check summary から始める。

### 9. Triage Inbox / Loops UI の状態がドキュメントと体験でずれている

重要度: Medium

`LoopsView.tsx` は存在するが、現在の route / navigation からは外れている。これは「ユーザーに Loop 設定を直接触らせない」という直近の方針とは合っている。

ただし、`docs/LOOP_ENGINEERING_TODO.md` では `Loops ページを追加する`、`Triage Inbox を追加する` が `[x]` のままなので、ユーザー視点では実装済みなのか内部機能なのかが曖昧である。

影響:

- プロダクト仕様として「Loops タブがある/ない」が読み手に伝わらない。
- Triage Inbox をどう使うべきかが不明確になる。

対応案:

- TODO の状態を次のように分ける。
  - Done: ユーザーが使える
  - Internal: API / DB / worker 内部で使う
  - Hidden: 実装はあるが UI から外している
  - Designed: 設計のみ
  - Deferred: 未実装
- Triage は Loops tab ではなく Issues に統合する方針を明記する。

### 10. 人間の理解を保つ仕組みがまだ弱い

重要度: Medium

ready-to-merge はユーザー merge を前提にしており、人間判断を残している点はよい。ただし、記事が警告する「理解の劣化」「判断の放棄」への対策として、ユーザーが変更内容を把握するための明示的な仕組みはまだ薄い。

影響:

- PR が ready-to-merge になっても、ユーザーが内容を理解しないまま merge する可能性がある。
- Loop が長くなるほど、なぜその変更になったかが追いづらくなる。

対応案:

- ready-to-merge notification に次を必須で含める。
  - Goal Contract の要約
  - 実装したこと
  - やらなかったこと
  - 検証 evidence
  - 残リスク
  - 人間が見るべき diff の場所
- merge 前の checklist を PR 画面に出す。
- Memory に「今回学んだ制約」「次回の注意点」を残す。

## ドキュメント上の破綻 / 過大表現

### `docs/LOOP_ENGINEERING_TODO.md`

次の項目は `[x]` のままだと誤解が出る。

| 項目 | 現状の見え方 | 推奨ステータス |
| --- | --- | --- |
| `Loops ページを追加する` | `LoopsView.tsx` はあるが route / nav から外れている | Hidden / Internal |
| `Triage Inbox を追加する` | API / UI 実装はあるが主要導線に出ていない | Internal / Hidden |
| `最大ラウンド数を設定できるようにする` | schema / form はあるが workflow controller としての制御が弱い | Partial |
| `cost budget` 相当 | schema はあるが実効制御が見当たらない | Designed / Partial |
| `Connector 設計` | 設計資料はあるが connector runtime はない | Designed |
| `Skills 管理 UI` | `.oneteam` knowledge はあるが、現在の主要導線上の管理 UI としては確認が必要 | Partial |

### `docs/LOOP_ENGINEERING_ADAPTATION.md`

方針としては妥当。ただし、「Loop をプロダクトの中心概念にする」という初期方針から、現在は「ユーザー体験は Issue-first、Loop 設定は内部自動化」に変わっている。

追記した方がよいこと:

- OneTeam の外部向け primary UX は Issue-first のままにする。
- Loop はユーザーが直接設定する対象ではなく、requirements agent が issue から推定する internal control plane とする。
- ただし workflow 全体を束ねる objective run は必要。

## 優先対応案

### P0: 仕様とドキュメントの整合

- `docs/LOOP_ENGINEERING_TODO.md` の `[x]` を Done / Partial / Internal / Hidden / Designed / Deferred に分ける。
- `docs/LOOP_ENGINEERING_ADAPTATION.md` に、現在の issue-first 方針を追記する。
- Connectors、Scheduler、cost budget、max rounds は「設計済み」と「実効制御済み」を分ける。

### P1: Loop controller の中核を作る

- Issue 単位の `objective_run` を追加する。
- requirements -> implementation -> review -> fix -> QA -> verifier を 1 つの run として束ねる。
- round count、same failure signature、max round exceeded、budget exceeded を objective run で判定する。
- verifier が pass するまで ready-to-merge にしない。

### P1: Hard verification gate を追加する

- 必須 evidence がない final result を failed または waiting_human にする。
- diff scanner で score manipulation を risk signal 化する。
- verification command failure は fixer / fix label / Human Gate に自動でつなぐ。

### P2: Provider specific harness を生成する

- `.oneteam` knowledge を source of truth にする。
- Claude Code 用の `CLAUDE.md` / `.claude/settings.json` / `.claude/agents/fixer.md` を生成する。
- LM Studio tool loop に PostToolUse 相当の lightweight validation を入れる。
- Codex adapter の post-run validation を Stop Hook 相当に強める。

### P2: Discovery / Scheduler を issue-first に統合する

- scheduler worker を追加する。
- 発見結果は Triage Item または draft issue として出す。
- ユーザーに Loops tab を触らせず、Issues / Agent Jobs / notifications に自然に表示する。

### P3: Connector 実装

- GitHub Actions status connector を最初に実装する。
- 失敗 CI を Triage Item にし、成功 CI を PR / objective run evidence に添付する。
- GitHub / Linear / Slack は optional plugin として段階的に追加する。

## 判断

現状の OneTeam は、Loop Engineering の思想と大きく矛盾してはいない。むしろ issue-first にした判断は、単独開発者が判断を手放さないための UI としてよい。

ただし、今のままでは「Loop Engineering の名前を使った Agent Job workflow」に見える余地がある。Loop Engineering としてより強くするには、ユーザーに Loops 設定を触らせることではなく、Issue の裏側で standing objective、hard verification gate、scheduler、judge separation、memory を確実に回すことが重要である。
