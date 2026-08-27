# OneTeam 実装資料

このディレクトリは、`REQUIREMENTS.md` を実装へ渡すための詳細資料をまとめる。

読む順番は次の通り。

1. [画面一覧・ワイヤーフレーム](./01-screens-wireframes.md)
2. [DB schema 詳細](./02-db-schema.md)
3. [Agent prompt template](./03-agent-prompt-templates.md)
4. [Agent Job state machine](./04-agent-job-state-machine.md)
5. [API request / response schema](./05-api-schemas.md)
6. [MVP タスク分解](./06-mvp-task-breakdown.md)
7. [command auto-detection 仕様](./07-command-auto-detection.md)
8. [i18n リソース設計](./08-i18n-resource-design.md)
9. [AI provider setup](./09-local-codex-setup.md)
10. [Loop Engineering 適合方針](./LOOP_ENGINEERING_ADAPTATION.md)
11. [Connector / Plugin Design](./CONNECTORS.md)
12. [Loop Engineering TODO](./LOOP_ENGINEERING_TODO.md)

## 前提

- UI は browser で開く Web アプリケーション。
- 初期 UI locale は `en`。
- OneTeam は 1 インスタンスにつき 1 repository を管理する。
- AI 実行基盤は Codex、Claude Code、LM Studio を切り替え可能な provider adapter として扱う。
- Codex / Claude Code は外部 CLI adapter、LM Studio は OpenAI-compatible local API + OneTeam tool loop として扱う。
- 目標ワークフローでは、Verifier、Evidence Gate、merge 直前検証を通過した PR は OneTeam が自動 merge する。merge conflict、stale Evidence、Risk Signal は修正、再検証、または Human Gate に戻す。
- Codex の usage remaining 枯渇は `waiting_provider` として待機し、利用枠回復後に自動再開する。
- UI は GitHub 相当の issue / pull request 体験を目標とし、特に diff と後から読み返せる Agent / system comment を重視する。
- issue / pull request の削除は論理削除。
- Agent の作業進捗はコメントとは別に Activity Log として時系列保存する。
