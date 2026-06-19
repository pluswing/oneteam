# Loop Engineering TODO

作成日: 2026-06-17

このTODOは、[LOOP_ENGINEERING_ADAPTATION.md](./LOOP_ENGINEERING_ADAPTATION.md) の対応内容を実装順に分解したもの。

## P0: Loop Engineering と名乗るための最小対応

- [x] README / landing page のコピーを `Local Loop Engineering for solo developers` に変更する
- [x] 要件定義に `Loop`、`Goal Contract`、`Evidence`、`Stop Condition`、`Stop Reason` を追加する
- [x] Agent prompt template に `Goal Contract` と `Evidence Required` を追加する
- [x] Agent output schema に `stopReason` と `evidence` を追加する
- [x] Agent Job detail で `stopReason` と `evidence` を確認できるようにする
- [x] 型チェックとテストで既存ワークフローが壊れていないことを確認する

## P1: Loop をプロダクトの中心概念にする

- [x] `loops` / `loop_runs` / `loop_steps` / `loop_memory_entries` のDB設計を追加する
- [x] `Loops` ページを追加する
- [x] Loop 設定は内部自動化に戻し、ユーザー向けの `Loops` タブを非表示にする
- [x] Loop Run detail を追加する
- [x] Label Automation を Loop Trigger として扱えるようにする
- [x] `Triage Inbox` を追加する
- [x] Stop Reason を Issue / PR / Loop Run の一覧で見えるようにする

## P1: Worktree isolation

- [x] Loop Run ごとに git worktree を作成する
- [x] Agent Job を割り当て worktree 内で実行する
- [x] worktree cleanup を実装する
- [x] main workspace の dirty state と Loop Run の実行を分離する
- [x] 同一 Issue / PR への破壊的 Job lock を worktree 実行と両立させる

## P2: Skills / Memory / Verifier

- [x] `.oneteam/skills` を導入する
- [x] `.oneteam/memory` を導入する
- [x] Skills 管理 UI を追加する
- [x] Loop Run 終了時に Memory を更新する
- [x] Verifier Agent を追加する
- [x] Verifier Agent が Stop Condition と Evidence を判定する

## P2: Safety / Budget / Risk

- [x] 最大実行時間を設定できるようにする
- [x] 最大ラウンド数を設定できるようにする
- [x] 最大変更ファイル数 / diff 行数を設定できるようにする
- [x] 実行可能コマンド allowlist / denylist を追加する
- [x] 変更禁止パスと protected branch を設定できるようにする
- [x] Risk Signal 検出時に Human Gate へ移行する

## P3: Connector / Plugin

- [x] GitHub Connector の設計を追加する
- [x] GitHub Actions / CI status Connector の設計を追加する
- [x] Linear Connector の設計を追加する
- [x] Slack / Discord notification Connector の設計を追加する
- [x] Connector を optional plugin として扱う方針を実装資料に追加する
