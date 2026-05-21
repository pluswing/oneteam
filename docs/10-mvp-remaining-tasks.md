# MVP remaining tasks

## P1. Implementation Agent hardening

- No open MVP tasks after the current pass.

## P1. Review / Fix / QA flow

- No open MVP tasks after the current pass.

## P2. Pull request and Git UI polish

- No open MVP tasks after the current pass.

## P2. Settings and validation

- No open MVP tasks after the current pass.

## P3. CRUD and QA finish

- Add Playwright smoke coverage for setup, label automation, and agent job controls.

## Completed in current pass

- Human Gate completion: `waiting_human` now moves the target to `確認待ち`, stores previous labels, restores them when the user comments, and requeues the same waiting job.
- Implementation branch preflight: implementation jobs now create or reuse `oneteam/issue-{issueId}-{slug}` branches before Codex runs, and pause in Human Gate when another branch has uncommitted changes.
- Implementation verification: successful implementation jobs now run configured lint/test/build commands, save command summaries and changed files to Activity, and fail before pull request creation when verification fails.
- Local pull request creation from structured implementation output is covered by the worker flow and verification tests.
- Review / Fix / QA flow: structured review findings, fix summaries, and QA verdicts now create actionable Activity entries and drive label transitions; conflict fix jobs fail when merge conflicts remain.
- Pull request Git polish: pull request list/detail now include Git-derived file and commit counts; detail view adds a commits tab and a visible conflict resolution action.
- Diff polish: large patches now render as a bounded preview with an explicit expand/collapse action.
- Settings polish: users can edit Codex command/model and locale after setup; the server validates the Codex command before saving and shows runtime server/database settings.
- CRUD polish: issue and pull request detail panels now expose title/body/status edit forms and logical delete actions.
- Manual E2E checklist: `docs/11-manual-e2e-checklist.md` covers setup, issue automation, PR review/fix/QA, CRUD, cancellation, retry, and final verification.
