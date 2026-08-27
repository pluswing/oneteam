# OneTeam: Local Loop Engineering for solo developers

OneTeam is a local web application for solo developers who want to design, run, verify, and remember AI development loops from local issues.

It provides a GitHub-like local control plane for issues, pull requests, labels, comments, activity logs, and agent jobs. From an issue, OneTeam can help define a goal contract, prepare an implementation branch, run Codex CLI, collect evidence, create a local pull request, review changes, route fixes, support QA, and stop with a clear reason.

## Website

- [English](https://pluswing.github.io/oneteam/)
- [日本語](https://pluswing.github.io/oneteam/ja.html)

## What It Does

- Manage one local Git repository per OneTeam instance.
- Create local issues and pull requests without GitHub integration.
- Turn issues into verifiable AI development loops with goal contracts, evidence, and stop reasons.
- Drive workflow with labels such as `requirements`, `ready-for-implementation`, `reviewing`, `fixing`, `testing`, `done`, and `ready-to-merge`.
- Run AI agent jobs through the local Codex CLI.
- Switch the UI and AI agent output language between English and Japanese.
- Save AI progress, thinking summaries, command results, changed files, and errors as Activity Log entries.
- Auto-detect install/dev/build/test/lint commands from the repository.
- Pause safely for human input with Human Gate and resume when the user comments.
- Prepare implementation branches as `oneteam/issue-{issueId}-{slug}`.
- Detect dirty working trees and merge conflicts before unsafe operations.
- Run Playwright smoke coverage for the core setup and workflow controls.

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
- AI execution: Codex CLI via `node_modules/.bin/codex`

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
8. Verifier Agent checks the stop condition and evidence, then marks the pull request `ready-to-merge`.
9. The user performs the final merge.

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
- [Loop Engineering adaptation](./docs/LOOP_ENGINEERING_ADAPTATION.md)
- [Loop Engineering TODO](./docs/LOOP_ENGINEERING_TODO.md)

## Current Status

The MVP implementation is complete. The remaining work is product hardening beyond MVP: deeper UX polish, broader browser coverage, larger repository performance tuning, and future integrations.

The next target is an autonomous local workflow that continues from an issue through implementation, verification, pull request creation, review, and policy-gated merge. It will persist Codex capacity waits and resume after usage recovers, while retaining the existing Loop Engineering gates. UI work will prioritize a GitHub-quality pull request diff and durable Markdown or sanitized HTML system comments. See [the updated design](./docs/LOOP_ENGINEERING_ADAPTATION.md) and [implementation TODO](./docs/LOOP_ENGINEERING_TODO.md).
