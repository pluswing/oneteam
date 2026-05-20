# one team 実装資料

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

## 前提

- UI は browser で開く Web アプリケーション。
- 初期 UI locale は `en`。
- one team は 1 インスタンスにつき 1 repository を管理する。
- AI 実行基盤は Codex CLI。
- Codex CLI は full access で実行し、個別のコマンド承認は必須にしない。
- merge はユーザーが行い、merge conflict の修正は one team が支援する。
- issue / pull request の削除は論理削除。
- Agent の作業進捗はコメントとは別に Activity Log として時系列保存する。
