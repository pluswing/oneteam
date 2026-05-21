# Manual E2E checklist

Use this checklist for a final MVP pass from setup through QA completion.

## 1. Setup

- Start the app with `npm run dev`.
- Open `http://127.0.0.1:3579`.
- Create or import a repository project.
- Confirm command detection runs after setup.
- Confirm missing command issues are created when build/test/lint/dev commands are unavailable.
- Open Settings and confirm Codex command, model, locale, server, and database values are shown.
- Save Settings with a valid Codex command and confirm the success message appears.

## 2. Issue workflow

- Create an issue with a clear implementation request.
- Apply `要件定義中` and confirm a requirements job is queued.
- Add a user comment while a job is `waiting_human` and confirm the previous label is restored.
- Move the issue to `実装待ち` and confirm an implementation job is queued.
- Confirm the implementation job prepares `oneteam/issue-{issueId}-{slug}`.
- Confirm dirty working tree protection moves the issue to `確認待ち`.
- Confirm successful implementation records changed files and verification command results.
- Confirm a local pull request is created from implementation output.

## 3. Pull request workflow

- Open the pull request detail view.
- Confirm file and commit counts are populated.
- Open the Files tab and expand a large diff preview.
- Open the Commits tab and confirm commits are listed.
- Confirm merge conflicts show a visible resolve action when present.
- Run review and confirm findings route the pull request to `修正中`.
- Run fix and confirm completion routes the pull request to `レビュー中`.
- Run review approval and confirm it routes the pull request to `テスト中`.
- Run QA with a defect and confirm it routes the pull request to `修正中`.
- Run QA with no defects and confirm it routes the pull request to `完了`.

## 4. CRUD and recovery

- Edit an issue title, body, and status from the detail view.
- Edit a pull request title, body, and status from the detail view.
- Delete an issue and confirm it disappears from the open issue list.
- Delete a pull request and confirm it disappears from the open pull request list.
- Cancel a queued or running agent job and confirm Activity records the cancellation.
- Retry a failed agent job and confirm a new attempt is queued.

## 5. Final verification

- Run `npm run typecheck`.
- Run `npm run lint`.
- Run `npm test`.
- Run `npm run build`.
- Confirm the API health endpoint returns `{"status":"ok","name":"one team"}`.
