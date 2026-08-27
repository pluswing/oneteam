# Loop Engineering Objective Implementation Plan

作成日: 2026-06-25

> 2026-08-27 update: この資料はstanding objective導入時の実装計画として残す。次の目標であるIssueからmergeまでの自動完遂、Provider Gate、GitHub-quality UI / diffは、[LOOP_ENGINEERING_ADAPTATION.md](./LOOP_ENGINEERING_ADAPTATION.md) と [LOOP_ENGINEERING_TODO.md](./LOOP_ENGINEERING_TODO.md) を正とする。

## 目的

OneTeam のユーザー体験は Issue-first のまま保ち、Issue の裏側で次の 5 つを確実に回す。

- standing objective
- hard verification gate
- scheduler
- judge separation
- memory

ユーザーに Loops タブや細かな Loop 設定を直接触らせるのではなく、Issue と Pull Request の通常画面から状態だけ見えるようにする。

## 実装手順

### 1. Standing Objective

Issue ごとに `objective_runs` を作る。

`objective_runs` は、requirements、implementation、review、fix、QA、verifier の複数 Agent Job を束ねる長い実行単位とする。

最小項目:

- `issue_id`
- `pull_request_id`
- `status`
- `round_count`
- `max_rounds`
- `last_agent_job_id`
- `judge_agent_job_id`
- `generator_ai_provider`
- `judge_ai_provider`
- `last_failure_signature`
- `repeated_failure_count`
- `stop_reason`
- `evidence_json`
- `summary`

### 2. Existing Loop Run との関係

既存の `loops` / `loop_runs` / `loop_steps` は、個々の label automation step の実行記録として残す。

`objective_runs` は、それらを Issue / PR 単位で束ねる上位概念にする。

```text
Issue
  objective_run
    requirements job
      loop_run / loop_step
    implementation job
      loop_run / loop_step
    review job
      loop_run / loop_step
    qa job
      loop_run / loop_step
    verifier job
      loop_run / loop_step
```

### 3. Hard Verification Gate

Objective に紐づく Agent Job は、完了時に gate を通す。

MVP では次を必須にする。

- implementation は verification command / changed files / risk signal を evidence に持つ
- verifier は objective に蓄積された evidence と Stop Condition を見て判定する
- evidence なしの `passed` は `waiting_human` に落とす
- risk signal がある場合は Human Gate へ送る
- score manipulation を diff scanner で risk signal として検出する

### 4. Scheduler

OneTeam 起動中に内部 scheduler を回す。

MVP の discovery:

- open issue に objective が無ければ作成する
- command detection で required command が missing の場合は triage item にする
- stale objective / repeated failure は後続タスクで扱う

Scheduler はすぐ実装へ流さず、Triage Item または objective state の更新に留める。

### 5. Judge Separation

`verifier` Agent Job を objective の judge として記録する。

記録するもの:

- `judge_agent_job_id`
- `judge_ai_provider`
- verifier verdict
- missing evidence
- notes

将来は role-based provider settings により、implementation と verifier で別 provider / model を選べるようにする。

### 6. Memory

Objective の状態変化を `loop_memory_entries` と `.oneteam/memory/loop-notes.md` に残す。

記録するもの:

- objective 作成
- verification gate で止まった理由
- verifier の判定
- ready-to-merge
- repeated failure

### 7. Agent Comment Format

Agent コメントは `bodyFormat` を持つ。

- `markdown`: 既存互換の Markdown
- `html`: raw HTML。ただし表示前に allowlist sanitizer を通す

ユーザーコメントは当面 `markdown` に固定する。Agent / system comment のみ HTML を返せる。

禁止:

- `<script>`
- event handler attributes
- `javascript:` URL
- unsafe CSS function
- iframe / object / embed

## 今回の実装範囲

- `objective_runs` table の追加
- Issue / PR / Agent Job / Label Automation から objective を自動作成・接続
- Worker 完了時の objective 更新
- implementation / verifier の hard verification gate
- repeated failure / max rounds の基本制御
- Scheduler worker の追加
- Objective status API と詳細画面サイドパネル表示
- Agent comment の `markdown | html` 対応
