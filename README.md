# OneTeam: Local Loop Engineering for solo developers

OneTeam is a local web application for solo developers who want to design, run, verify, and remember autonomous AI development loops from local issues.

It provides a GitHub-like local control plane for issues, pull requests, labels, comments, activity logs, and agent jobs. From an issue, OneTeam defines a Goal Contract, prepares isolated worktrees, runs the selected AI provider, collects Evidence, creates a local pull request, reviews and fixes changes, performs QA and final verification, and merges automatically when every policy gate passes. Human and provider-capacity gates preserve the complete execution state for later resumption.

## Website

- [English](https://pluswing.github.io/oneteam/)
- [日本語](https://pluswing.github.io/oneteam/ja.html)

## What It Does

- Manage one local Git repository per OneTeam instance.
- Create local issues and pull requests without GitHub integration.
- Turn issues into verifiable AI development loops with goal contracts, evidence, and stop reasons.
- Drive workflow with labels such as `requirements`, `ready-for-implementation`, `reviewing`, `fixing`, `testing`, `done`, and `ready-to-merge`.
- Run role-routed AI agent jobs through Codex CLI, Claude Code, or LM Studio.
- Switch the UI and AI agent output language between English and Japanese.
- Save AI progress, thinking summaries, command results, changed files, and errors as Activity Log entries.
- Auto-detect install/dev/build/test/lint commands from the repository.
- Pause safely for human input with Human Gate and resume when the user comments.
- Isolate writing Agents in branch worktrees and read-only Agents in commit-pinned snapshot worktrees.
- Re-run required commands and risk checks immediately before policy-gated local merge.
- Persist Codex usage-limit waits and resume the same Job, Objective, thread, and worktree after capacity recovers.
- Optionally poll GitHub Actions workflow status into Objective Evidence, PR Activity, and Triage without coupling Connector failures to Agent Jobs.
- Run Playwright browser coverage for workflow controls, large diff performance, keyboard behavior, and screen-level text contrast.

## Tech Stack

- Package manager: npm
- Language: TypeScript
- Runtime: Node.js
- UI: React + Vite
- API: Hono
- Database: libSQL
- ORM / query builder: Drizzle ORM
- Unit and integration tests: Vitest
- E2E smoke tests: Playwright
- AI execution: Codex CLI via `node_modules/.bin/codex`, Claude Code, or LM Studio

## Requirements

- Node.js
- npm
- git
- Codex CLI authentication. OneTeam checks this on launch and starts `codex login` when needed.

## Getting Started

Install dependencies:

```sh
npm install
```

Start the development server:

```sh
npm run dev
```

Open the app:

```text
http://127.0.0.1:3579
```

The API runs at:

```text
http://127.0.0.1:3580
```

On first launch, use the setup screen to import or create a repository project. OneTeam will run command detection, store project settings in `<imported-repo>/.oneteam/data/oneteam.db`, and create skills/memory files under `<imported-repo>/.oneteam/`. To force a repository database on startup, set `ONETEAM_REPOSITORY_PATH=/path/to/repo`.

When the agent worker starts, OneTeam runs `codex login status`. If Codex is not authenticated yet, OneTeam starts `codex login` automatically.

The optional read-only GitHub Actions Connector can attach workflow status to local PR Objectives and create Triage items for failed CI. It is disabled by default. See [Connector setup](./docs/CONNECTORS.md#github-actions--ci-status-connector) for token permissions and environment variables.

Run the desktop app in development:

```sh
npm run app:dev
```

Create a local packaged app directory:

```sh
npm run app:dir
```

## Common Commands

```sh
npm run dev
npm run build
npm run app:dev
npm run app:dir
npm run app:pack
npm run start
npm run typecheck
npm run lint
npm test
npm run e2e
```

Install the Playwright browser once before running E2E tests on a fresh machine:

```sh
npm run e2e:install
```

Check Codex CLI availability:

```sh
npm run codex:version
```

## Loop Workflow

1. Create an issue.
2. OneTeam automatically starts `requirements`.
3. Requirements Agent turns the request into a goal contract with acceptance criteria, evidence requirements, and stop conditions.
4. Implementation Agent prepares a branch, runs Codex, verifies commands, and creates a local pull request.
5. Review Agent checks requirement coverage, evidence, and risk, then sends the pull request to `fixing` or `testing`.
6. Fix Agent resolves review, QA, or conflict findings and returns to `reviewing`.
7. QA Agent records evidence and sends defects to `fixing` or hands the pull request to final verification with `done`.
8. Verifier Agent checks the stop condition and typed Evidence, then marks the pull request `ready-to-merge`.
9. The automatic merge gate rechecks source / target snapshots, conflicts, commands, Evidence freshness, and risk policy before merging locally.
10. OneTeam finalizes the PR, Objective, Issue, comments, Activity, and Loop Memory idempotently. It stops at a Human Gate only when policy or missing Evidence requires a decision.

## Project Structure

```text
src/client      React + Vite UI
src/server      Hono API, agent worker, Git integration
src/server/db   libSQL schema, migrations, repositories
src/server/agents
                prompt rendering, Codex adapter, agent worker
src/server/services
                command detection, label automation, Git helpers, verification
src/shared      shared DTOs and utilities
src/test        Vitest unit and integration tests
e2e             Playwright smoke tests
docs            requirements and implementation documents
```

## Documentation

- [Requirements](./docs/REQUIREMENTS.md)
- [Implementation docs](./docs/README.md)
- [Agent prompts](./docs/03-agent-prompt-templates.md)
- [Agent job state machine](./docs/04-agent-job-state-machine.md)
- [API schemas](./docs/05-api-schemas.md)
- [MVP completion status](./docs/10-mvp-remaining-tasks.md)
- [Manual E2E checklist](./docs/11-manual-e2e-checklist.md)
- [Local Codex CLI setup](./docs/09-local-codex-setup.md)
- [Connector setup](./docs/CONNECTORS.md)
- [Loop Engineering adaptation](./docs/LOOP_ENGINEERING_ADAPTATION.md)
- [Loop Engineering TODO](./docs/LOOP_ENGINEERING_TODO.md)

## Current Status

The autonomous local workflow target is implemented: Issue → requirements → implementation → local PR → review / fix → QA → verification → policy-gated merge → Issue and Memory finalization. Codex capacity waits recover automatically, every Loop Step is isolated from the primary workspace, the diff viewer is optimized for review, and durable Markdown or sanitized HTML records retain the decision trail.

All concrete implementation items in the current plan are complete. The remaining `Partial` area is optional future integration beyond the implemented GitHub Actions status runtime: GitHub Issue / PR synchronization, Linear, and Slack / Discord Connectors. See [the design](./docs/LOOP_ENGINEERING_ADAPTATION.md) and [implementation status](./docs/LOOP_ENGINEERING_TODO.md).
