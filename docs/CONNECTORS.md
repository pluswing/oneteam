# Connector / Plugin Design

OneTeam keeps Loop Engineering local-first. Connectors are optional plugins that translate external events into local Loop inputs and publish local Loop outcomes back to external tools.

## Common Contract

Connectors must not bypass the local Loop model.

- Inbound events create `triage_items`, issues, pull requests, labels, or loop runs through the public API or the same runtime service boundaries.
- Outbound events read issues, pull requests, loop runs, stop reasons, evidence, and memory through the public API or the same runtime service boundaries.
- Connector-specific delivery checkpoints are stored under `.oneteam/connectors/<connector-name>/` when needed. Normalized Evidence, Activity, and Triage remain in the local database.
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

Runtime status: implemented as an optional, read-only polling Connector.

Purpose:

- Treat CI status as Evidence for Verifier Agent decisions.
- Stop or reopen loops based on failed CI.

Current inbound mapping:

- Resolve every open local PR source branch to its exact local commit.
- Call `GET /repos/{owner}/{repo}/actions/runs?head_sha={commit}` and normalize each workflow run as `ci_status` Objective Evidence.
- Record status transitions as rich Markdown PR Activity.
- Create a high-priority Triage item for `action_required`, `cancelled`, `failure`, `stale`, `startup_failure`, or `timed_out` conclusions.
- Replace Evidence for the same workflow run attempt when its status changes; stable Connector keys prevent duplicate Evidence, Activity, and Triage on later polls.
- Isolate remote, authentication, rate-limit, response, and local revision failures as Connector Triage / PR Activity. These failures never fail or enqueue an Agent Job.

The implementation follows GitHub's [List workflow runs for a repository](https://docs.github.com/en/rest/actions/workflow-runs?apiVersion=2026-03-10#list-workflow-runs-for-a-repository) endpoint. Public repository reads can run without a token. A private repository token needs read access; a fine-grained token needs `Actions: read`.

Enable it with environment variables before starting OneTeam:

```sh
ONETEAM_GITHUB_ACTIONS_CONNECTOR=true \
ONETEAM_GITHUB_TOKEN=github_pat_... \
npm run dev
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `ONETEAM_GITHUB_ACTIONS_CONNECTOR` | `false` | Set to `true` to start polling. |
| `ONETEAM_GITHUB_TOKEN` | none | Optional for public repositories; required for private repositories. It is read from the process environment and never persisted. |
| `ONETEAM_GITHUB_REPOSITORY` | inferred from `origin` | Override with `owner/repository`, especially when `origin` is not a GitHub URL. |
| `ONETEAM_GITHUB_ACTIONS_POLL_INTERVAL_MS` | `60000` | Poll interval in milliseconds. |
| `ONETEAM_GITHUB_API_BASE_URL` | `https://api.github.com` | REST API base URL, including a GitHub Enterprise API endpoint when applicable. |
| `ONETEAM_GITHUB_API_VERSION` | `2026-03-10` | Value sent in `X-GitHub-Api-Version`. |

Planned outbound mapping:

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
