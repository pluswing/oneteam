# i18n リソース設計

## 1. 目的

初期 UI は英語で実装しつつ、将来の日本語化・多言語化に対応できるよう、翻訳 resource、key 命名、formatting、テスト方針を定義する。

## 2. 基本方針

- 初期 locale は `en`。
- fallback locale も `en`。
- UI の固定文言は source code に直書きしない。
- user-generated content は翻訳しない。
- system labels は内部値と表示文言を分けられるようにする。
- 日付、数値、複数形は locale-aware formatter を使う。

## 3. 推奨構成

```text
apps/web/src/i18n/
  index.ts
  locales/
    en/
      common.json
      setup.json
      issues.json
      pullRequests.json
      repository.json
      settings.json
      agents.json
    ja/
      common.json
      setup.json
      issues.json
      pullRequests.json
      repository.json
      settings.json
      agents.json
```

MVP では `en` のみ必須。`ja` は空または後続実装でよい。

## 4. Namespace

| Namespace | 用途 |
| --- | --- |
| `common` | 共通 button、status、navigation |
| `setup` | Setup Wizard |
| `issues` | Issue list / detail |
| `pullRequests` | PR list / detail |
| `repository` | Repository 画面 |
| `settings` | Settings 画面 |
| `agents` | Agent job / Activity Log |

## 5. Key Naming

形式:

```text
{screen}.{section}.{element}.{variant}
```

例:

```text
issues.list.title
issues.detail.tabs.conversation
pullRequests.detail.actions.startReview
agents.status.waitingHuman
```

## 6. common.json 例

```json
{
  "app": {
    "name": "one team"
  },
  "nav": {
    "issues": "Issues",
    "pullRequests": "Pull Requests",
    "repository": "Repository",
    "settings": "Settings"
  },
  "actions": {
    "save": "Save",
    "cancel": "Cancel",
    "delete": "Delete",
    "retry": "Retry",
    "close": "Close",
    "create": "Create",
    "edit": "Edit"
  },
  "status": {
    "open": "Open",
    "closed": "Closed",
    "running": "Running",
    "waiting": "Waiting",
    "failed": "Failed",
    "completed": "Completed"
  }
}
```

## 7. agents.json 例

```json
{
  "job": {
    "status": {
      "queued": "Queued",
      "running": "Running",
      "waiting_human": "Waiting for your reply",
      "succeeded": "Succeeded",
      "failed": "Failed",
      "canceled": "Canceled"
    },
    "actions": {
      "startRequirements": "Start requirements",
      "startImplementation": "Start implementation",
      "startReview": "Start review",
      "runQa": "Run QA",
      "cancel": "Cancel job",
      "retry": "Retry job"
    }
  },
  "activity": {
    "title": "Activity",
    "types": {
      "thinking": "Thinking summary",
      "progress": "Progress",
      "command": "Command",
      "file_change": "File change",
      "test": "Test",
      "error": "Error",
      "system": "System"
    }
  }
}
```

## 8. Label Display

system label の DB value は英語の安定した slug とし、UI 表示は key 経由にできるようにする。

推奨 mapping:

```ts
const systemLabelKeys = {
  "requirements": "labels.issue.requirements",
  "needs-input": "labels.shared.waitingHuman",
  "ready-for-implementation": "labels.issue.implementationWaiting",
  "implementing": "labels.issue.implementing",
  "pull-request-created": "labels.issue.pullRequestCreated",
  "reviewing": "labels.pullRequest.reviewing",
  "fixing": "labels.pullRequest.fixing",
  "resolving-conflicts": "labels.pullRequest.conflictFixing",
  "testing": "labels.pullRequest.testing",
  "done": "labels.shared.completed"
};
```

`common.json`:

```json
{
  "labels": {
    "issue": {
      "requirements": "Requirements",
      "implementationWaiting": "Ready for implementation",
      "implementing": "Implementing",
      "pullRequestCreated": "Pull request created"
    },
    "pullRequest": {
      "reviewing": "Reviewing",
      "fixing": "Fixing",
      "conflictFixing": "Resolving conflicts",
      "testing": "Testing"
    },
    "shared": {
      "waitingHuman": "Waiting for reply",
      "completed": "Completed"
    }
  }
}
```

## 9. Interpolation

翻訳 string には named interpolation を使う。

```json
{
  "issues": {
    "list": {
      "count": "{{count}} issues"
    }
  }
}
```

## 10. Pluralization

plural が必要な文言は i18n library の plural rule を使う。

```json
{
  "comments": {
    "count_one": "{{count}} comment",
    "count_other": "{{count}} comments"
  }
}
```

## 11. Date / Time

相対時刻と絶対時刻は formatter を分ける。

```ts
formatRelativeTime(date, locale);
formatDateTime(date, locale);
```

表示例:

- `updated 5m ago`
- `May 20, 2026, 10:00`

## 12. User Content

翻訳しないもの:

- issue title / body
- pull request title / body
- comments
- Activity body
- command output
- file paths
- branch names

翻訳するもの:

- navigation
- button
- form label
- empty state
- validation message
- status label display
- activity type display

## 13. Validation Message Keys

```json
{
  "validation": {
    "required": "{{field}} is required.",
    "invalidPath": "Enter a valid path.",
    "commandNotFound": "Command was not found.",
    "commentEmpty": "Comment cannot be empty."
  }
}
```

## 14. Implementation Notes

- React components should call `t("namespace:key")` or equivalent helper.
- Avoid constructing sentences by concatenating translated fragments.
- Keep resource keys stable.
- API should return machine-readable codes; UI translates them.
- DB should not store translated UI strings except user content.

## 15. Testing

MVP で必要な i18n tests:

- missing key がないことを検出する unit test。
- default locale `en` が読み込めること。
- AppShell navigation が translation resource から表示されること。
- status / label display が mapping 経由で表示されること。

## 16. Acceptance Criteria

- 初期表示は英語 UI。
- 固定文言は translation resource から取得される。
- locale は project / settings から参照できる。
- system label は内部値と表示文言を分離できる。
- 将来的に `ja` resource を追加すれば日本語 UI に切り替えられる。
