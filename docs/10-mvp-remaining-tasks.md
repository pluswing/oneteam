# MVP remaining tasks

## P1. Implementation Agent hardening

- No open MVP tasks after the current pass.

## P1. Review / Fix / QA flow

- No open MVP tasks after the current pass.

## P2. Pull request and Git UI polish

- No open MVP tasks after the current pass.

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
- Implementation verification: successful implementation jobs now run configured lint/test/build commands, save command summaries and changed files to Activity, and fail before pull request creation when verification fails.
- Local pull request creation from structured implementation output is covered by the worker flow and verification tests.
- Review / Fix / QA flow: structured review findings, fix summaries, and QA verdicts now create actionable Activity entries and drive label transitions; conflict fix jobs fail when merge conflicts remain.
- Pull request Git polish: pull request list/detail now include Git-derived file and commit counts; detail view adds a commits tab and a visible conflict resolution action.
- Diff polish: large patches now render as a bounded preview with an explicit expand/collapse action.
