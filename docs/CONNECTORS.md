# Connector / Plugin Design

One Team keeps Loop Engineering local-first. Connectors are optional plugins that translate external events into local Loop inputs and publish local Loop outcomes back to external tools.

## Common Contract

Connectors must not bypass the local Loop model.

- Inbound events create `triage_items`, issues, pull requests, labels, or loop runs through the public API.
- Outbound events read issues, pull requests, loop runs, stop reasons, evidence, and memory through the public API.
- Connector state is stored under `.oneteam/connectors/<connector-name>/`.
- Credentials are never committed. Plugins read secrets from environment variables or the host keychain.
- Connectors must be disableable without changing core DB schema or agent behavior.

## GitHub Connector

Purpose:

- Import GitHub issues and pull requests into local issues / pull requests.
- Mirror label transitions into Loop Triggers.
- Publish comments that summarize stop reasons, evidence, and human handoff questions.

Inbound mapping:

- `issues.opened` -> `triage_items` or local issue.
- `issues.labeled` -> local label update, then Label Automation starts the matching Loop.
- `pull_request.opened` -> local pull request with `reviewing` label.
- `pull_request.synchronize` -> optional verifier or review loop run.

Outbound mapping:

- Agent comments -> GitHub issue / PR comments.
- Loop Run terminal state -> GitHub check summary or comment.
- `waiting_human` -> comment with required questions.

## GitHub Actions / CI Status Connector

Purpose:

- Treat CI status as Evidence for Verifier Agent decisions.
- Stop or reopen loops based on failed CI.

Inbound mapping:

- `check_suite.completed` / `workflow_run.completed` -> loop memory entry and PR activity.
- Failed CI -> `triage_items` or `fixing` label.
- Passed CI -> evidence attached to the latest Loop Run.

Outbound mapping:

- Local verifier result -> GitHub commit status or check run summary.

## Linear Connector

Purpose:

- Import Linear issues as local issues.
- Reflect local stop reasons and evidence back to Linear comments.

Inbound mapping:

- Linear issue created / updated -> local issue upsert.
- Linear state transition -> local label transition.

Outbound mapping:

- Requirements comment -> Linear comment.
- PR link / Loop Run summary -> Linear comment.
- `waiting_human` -> Linear comment and optional assignee notification.

## Slack / Discord Notification Connector

Purpose:

- Notify humans only at loop boundaries and human gates.

Events:

- Loop Run started.
- Loop Run stopped with `passed`, `failed`, `risk_detected`, `timeout`, or `waiting_human`.
- Triage item created.
- Verifier reports missing evidence.

Messages should include:

- Target link.
- Stop reason.
- Short evidence summary.
- Human questions when present.

## Optional Plugin Policy

Connectors are optional plugins, not core dependencies.

- Core must work with no connector installed.
- Plugins call HTTP APIs or documented local service boundaries.
- Plugins may add UI panels, but they must not alter existing workflow labels.
- Plugins can register connector-specific settings under `.oneteam/connectors`.
- Plugin failures must create activities or triage items instead of failing agent jobs.
