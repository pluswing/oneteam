# OneTeam: Issue-driven development with AI for solo developers

OneTeam is a local web application for solo developers who want to work with AI through an issue-driven development flow.

It provides a GitHub-like local workflow for issues, pull requests, labels, comments, activity logs, and agent jobs. From an issue, OneTeam can help clarify requirements, prepare an implementation branch, run Codex CLI, collect verification results, create a local pull request, review changes, route fixes, and support QA.

## What It Does

- Manage one local Git repository per OneTeam instance.
- Create local issues and pull requests without GitHub integration.
- Drive workflow with labels such as `requirements`, `ready-for-implementation`, `reviewing`, `fixing`, `testing`, and `done`.
- Run AI agent jobs through the local Codex CLI.
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
- Codex CLI authentication, configured through the project-local Codex package

## Getting Started

Install dependencies:

```sh
npm install
```

Log in to the project-local Codex CLI:

```sh
npm run codex:login
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

On first launch, use the setup screen to import or create a repository project. OneTeam will run command detection and store project settings in the local libSQL database.

## Common Commands

```sh
npm run dev
npm run build
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

## Agent Workflow

1. Create an issue.
2. Apply or trigger `requirements`.
3. Requirements Agent clarifies the request and moves it to `ready-for-implementation`.
4. Implementation Agent prepares a branch, runs Codex, verifies commands, and creates a local pull request.
5. Review Agent sends the pull request to `fixing` or `testing`.
6. Fix Agent resolves review, QA, or conflict findings and returns to `reviewing`.
7. QA Agent sends defects to `fixing` or completes the pull request with `done`.
8. The user performs the final merge.

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

## Current Status

The MVP implementation is complete. The remaining work is product hardening beyond MVP: deeper UX polish, broader browser coverage, larger repository performance tuning, and future integrations.
