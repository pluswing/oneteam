# MVP remaining tasks

## P1. Implementation Agent hardening

- Run detected build / test / lint commands and persist results.
- Persist changed files and command summaries as Activity.
- Create a local pull request from structured agent output.

## P1. Review / Fix / QA flow

- Make review findings structured and easy to act on.
- Route review findings to `修正中`, approvals to `テスト中`.
- Route fix completion back to `レビュー中`.
- Route QA defects to `修正中`, and pass results to `完了`.
- Add conflict fix verification.

## P2. Pull request and Git UI polish

- Add a commits tab to pull request detail.
- Populate pull request `changedFileCount` and `commitCount` from Git.
- Add merge conflict detection and a visible resolve-conflicts action.
- Improve diff rendering for larger patches.

## P2. Settings and validation

- Let users edit Codex command and model after setup.
- Validate the Codex CLI path before saving.
- Expose locale setting.
- Show database and server runtime settings clearly.

## P3. CRUD and QA finish

- Add issue / pull request edit forms for title, body, and status.
- Add issue / pull request delete buttons that use logical delete APIs.
- Add Playwright smoke coverage for setup, label automation, and agent job controls.
- Add a final manual E2E checklist from setup to QA completion.

## Completed in current pass

- Human Gate completion: `waiting_human` now moves the target to `確認待ち`, stores previous labels, restores them when the user comments, and requeues the same waiting job.
- Implementation branch preflight: implementation jobs now create or reuse `oneteam/issue-{issueId}-{slug}` branches before Codex runs, and pause in Human Gate when another branch has uncommitted changes.
