# API request / response schema

## 1. 目的

UI と server の境界を定義する。MVP 実装では、この資料を基準に route、request validation、response schema、error handling を作る。

## 2. 共通仕様

### 2.1 Base

- Base path: `/api`
- Content-Type: `application/json`
- datetime: ISO 8601 string
- pagination: cursor 方式または page 方式。MVP は page 方式でよい。

### 2.2 Error Response

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Title is required.",
    "details": {
      "field": "title"
    }
  }
}
```

### 2.3 List Response

```json
{
  "items": [],
  "page": {
    "limit": 50,
    "offset": 0,
    "total": 124
  }
}
```

### 2.4 Soft Delete

`DELETE` endpoints は物理削除しない。対象 record の `deletedAt` を設定し、通常の list / detail response から除外する。

## 3. 共通 Resource Schema

### 3.1 Label

```json
{
  "id": 1,
  "name": "reviewing",
  "color": "#0969da",
  "kind": "system",
  "description": "Review in progress",
  "createdAt": "2026-05-20T10:00:00.000Z",
  "updatedAt": "2026-05-20T10:00:00.000Z"
}
```

### 3.2 Comment

```json
{
  "id": 10,
  "targetType": "issue",
  "targetId": 24,
  "authorType": "agent",
  "agentType": "requirements",
  "body": "Markdown comment",
  "metadata": {},
  "createdAt": "2026-05-20T10:00:00.000Z",
  "updatedAt": "2026-05-20T10:00:00.000Z"
}
```

### 3.3 Activity

```json
{
  "id": 100,
  "agentJobId": 55,
  "targetType": "issue",
  "targetId": 24,
  "activityType": "command",
  "title": "Ran tests",
  "body": "`npm test` completed successfully.",
  "payload": {
    "command": "npm test",
    "exitCode": 0,
    "durationMs": 18234
  },
  "createdAt": "2026-05-20T10:00:00.000Z"
}
```

## 4. Projects

### 4.1 GET /api/projects

Response:

```json
{
  "items": [
    {
      "id": "project_123",
      "name": "example-app",
      "repoPath": "/Users/me/example-app",
      "defaultBranch": "main",
      "locale": "en",
      "createdAt": "2026-05-20T10:00:00.000Z",
      "updatedAt": "2026-05-20T10:00:00.000Z"
    }
  ]
}
```

### 4.2 POST /api/projects

Request:

```json
{
  "mode": "import",
  "name": "example-app",
  "repoPath": "/Users/me/example-app",
  "defaultBranch": "main",
  "locale": "en",
  "codex": {
    "command": "node_modules/.bin/codex",
    "model": "model-name",
    "fullAccess": true
  }
}
```

Response:

```json
{
  "project": {
    "id": "project_123",
    "name": "example-app",
    "repoPath": "/Users/me/example-app",
    "defaultBranch": "main",
    "locale": "en"
  },
  "commandDetectionJobId": 1
}
```

## 5. Commands

### 5.1 GET /api/projects/:projectId/commands

Response:

```json
{
  "items": [
    {
      "id": 1,
      "commandType": "build",
      "command": "npm run build",
      "detectionSource": "package_json",
      "isRequired": true,
      "isAvailable": true,
      "lastDetectedAt": "2026-05-20T10:00:00.000Z"
    }
  ]
}
```

### 5.2 POST /api/projects/:projectId/commands/detect

Request:

```json
{
  "createIssuesForMissingCommands": true
}
```

Response:

```json
{
  "jobId": 20,
  "detected": [
    {
      "commandType": "test",
      "command": "npm test",
      "source": "package_json"
    }
  ],
  "missing": ["build", "lint"],
  "createdIssueIds": [25, 26]
}
```

## 6. Issues

### 6.1 GET /api/projects/:projectId/issues

Query:

| Name | Type | Example |
| --- | --- | --- |
| `status` | string | `open` |
| `label` | string | `ready-for-implementation` |
| `q` | string | `build` |
| `limit` | number | `50` |
| `offset` | number | `0` |

Response:

```json
{
  "items": [
    {
      "id": 24,
      "title": "Add build command",
      "bodyPreview": "Missing build command was detected.",
      "status": "open",
      "labels": [],
      "commentCount": 2,
      "updatedAt": "2026-05-20T10:00:00.000Z"
    }
  ],
  "page": {
    "limit": 50,
    "offset": 0,
    "total": 1
  }
}
```

### 6.2 POST /api/projects/:projectId/issues

Request:

```json
{
  "title": "Add build command",
  "body": "Markdown body",
  "labelIds": [1, 2]
}
```

Response:

```json
{
  "issue": {
    "id": 24,
    "title": "Add build command",
    "body": "Markdown body",
    "status": "open",
    "labels": [],
    "createdAt": "2026-05-20T10:00:00.000Z",
    "updatedAt": "2026-05-20T10:00:00.000Z"
  },
  "automationJobIds": [55]
}
```

### 6.3 GET /api/projects/:projectId/issues/:issueId

Response:

```json
{
  "issue": {
    "id": 24,
    "title": "Add build command",
    "body": "Markdown body",
    "status": "open",
    "labels": [],
    "linkedPullRequests": [],
    "agentState": {
      "latestJobId": 55,
      "status": "waiting_human"
    },
    "createdAt": "2026-05-20T10:00:00.000Z",
    "updatedAt": "2026-05-20T10:00:00.000Z"
  }
}
```

### 6.4 PATCH /api/projects/:projectId/issues/:issueId

Request:

```json
{
  "title": "Add build command",
  "body": "Updated Markdown",
  "status": "open",
  "labelIds": [1, 2]
}
```

Response:

```json
{
  "issue": {
    "id": 24,
    "title": "Add build command",
    "status": "open",
    "labels": []
  },
  "automationJobIds": [56]
}
```

### 6.5 DELETE /api/projects/:projectId/issues/:issueId

Response:

```json
{
  "deleted": true
}
```

### 6.6 Comments

`POST /api/projects/:projectId/issues/:issueId/comments`

Request:

```json
{
  "body": "Use Vite for the build command."
}
```

Response:

```json
{
  "comment": {
    "id": 12,
    "authorType": "user",
    "body": "Use Vite for the build command.",
    "createdAt": "2026-05-20T10:00:00.000Z"
  },
  "autoResumedJobId": 56
}
```

`autoResumedJobId` は、`waiting_human` job が自動再開された場合に返す。
再開時は同じ job を `queued` に戻し、`attempt` を increment する。

### 6.7 Activities

`GET /api/projects/:projectId/issues/:issueId/activities`

Response:

```json
{
  "items": []
}
```

## 7. Pull Requests

### 7.1 GET /api/projects/:projectId/pull-requests

Response:

```json
{
  "items": [
    {
      "id": 8,
      "issueId": 24,
      "title": "Add build command",
      "status": "open",
      "sourceBranch": "oneteam/issue-24-add-build-command",
      "targetBranch": "main",
      "labels": [],
      "commentCount": 3,
      "changedFileCount": 2,
      "commitCount": 1,
      "updatedAt": "2026-05-20T10:00:00.000Z"
    }
  ]
}
```

### 7.2 POST /api/projects/:projectId/pull-requests

Request:

```json
{
  "issueId": 24,
  "title": "Add build command",
  "body": "Implementation summary",
  "sourceBranch": "oneteam/issue-24-add-build-command",
  "targetBranch": "main"
}
```

Response:

```json
{
  "pullRequest": {
    "id": 8,
    "issueId": 24,
    "title": "Add build command",
    "status": "open",
    "sourceBranch": "oneteam/issue-24-add-build-command",
    "targetBranch": "main",
    "labels": []
  },
  "automationJobIds": [72]
}
```

### 7.3 GET /api/projects/:projectId/pull-requests/:pullRequestId/diff

Response:

```json
{
  "files": [
    {
      "path": "package.json",
      "status": "modified",
      "additions": 1,
      "deletions": 0,
      "patch": "@@ ..."
    }
  ]
}
```

### 7.4 POST /api/projects/:projectId/pull-requests/:pullRequestId/resolve-conflicts

Request:

```json
{
  "mode": "agent"
}
```

Response:

```json
{
  "jobId": 72,
  "label": "resolving-conflicts"
}
```

`jobId` is `null` when an active fix job already exists for the pull request.

## 8. Agent Jobs

### 8.1 POST /api/projects/:projectId/agent-jobs

Request:

```json
{
  "agentType": "requirements",
  "targetType": "issue",
  "targetId": 24,
  "triggerType": "manual"
}
```

Response:

```json
{
  "job": {
    "id": 55,
    "agentType": "requirements",
    "targetType": "issue",
    "targetId": 24,
    "status": "queued",
    "lockKey": null,
    "createdAt": "2026-05-20T10:00:00.000Z"
  }
}
```

### 8.2 GET /api/projects/:projectId/agent-jobs

Query:

| Name | Type | Example |
| --- | --- | --- |
| `targetType` | string | `issue` |
| `targetId` | number | `24` |
| `status` | string | `running` |

Response:

```json
{
  "items": [
    {
      "id": 55,
      "agentType": "requirements",
      "targetType": "issue",
      "targetId": 24,
      "status": "running",
      "attempt": 1,
      "lockKey": null,
      "createdAt": "2026-05-20T10:00:00.000Z"
    }
  ]
}
```

### 8.3 GET /api/projects/:projectId/agent-jobs/:jobId

Response:

```json
{
  "job": {
    "id": 55,
    "agentType": "requirements",
    "status": "running",
    "input": {},
    "output": null,
    "error": null,
    "lockKey": "project:project_123:issue:24:write",
    "createdAt": "2026-05-20T10:00:00.000Z",
    "startedAt": "2026-05-20T10:00:03.000Z",
    "finishedAt": null
  }
}
```

### 8.4 POST /api/projects/:projectId/agent-jobs/:jobId/cancel

`queued` / `running` / `waiting_human` jobs can be canceled. For running Codex
jobs, the worker observes the canceled state and terminates the process.

Response:

```json
{
  "canceled": true,
  "job": {
    "id": 55,
    "status": "canceled",
    "error": "Cancellation requested."
  }
}
```

### 8.5 POST /api/projects/:projectId/agent-jobs/:jobId/retry

Response:

```json
{
  "jobId": 56
}
```

## 9. Repository

### 9.1 GET /api/projects/:projectId/repository/status

Response:

```json
{
  "branch": "main",
  "clean": true,
  "changedFiles": [],
  "ahead": 0,
  "behind": 0
}
```

### 9.2 GET /api/projects/:projectId/repository/merge-conflicts

Query:

| Name | Type | Example |
| --- | --- | --- |
| `sourceBranch` | string | `oneteam/issue-24-add-build-command` |
| `targetBranch` | string | `main` |

Response:

```json
{
  "hasConflicts": true,
  "files": [
    {
      "path": "package.json",
      "reason": "content"
    }
  ]
}
```

## 10. Validation Rules

- `title` is required for issue and pull request.
- `sourceBranch` and `targetBranch` are required for pull request.
- `agentType` must be one of supported agent types.
- `targetType` must be `issue` or `pull_request`.
- `DELETE` cannot be called for already deleted records.
- comment body must not be empty.
