# OneTeam

OneTeam is a local Loop Engineering app powered by Codex. It keeps GitHub-style Issues, Pull Requests, comments, diffs and Agent logs in one folder.

**One loop = Issue → implementation → PR → review / fix → verification → merge → retrospective → reusable knowledge.**

After merging, Codex reviews the work, test results, retries and model choices. OneTeam saves the retrospective and applies proposed knowledge changes under `.oneteam/`. The next task receives that knowledge. A merged PR remains “Reflecting” until its knowledge update is saved.

## Start

Requirements: Node.js 20.19+ or 22.12+, npm, Git, and a Codex login. The Codex CLI is included in the dependencies.

```sh
npm install
npm run app:dev
```

Drop a Git repository folder onto the desktop app or choose a folder. The repository must already have its first commit. OneTeam initializes `.oneteam` when needed and opens an empty Issue list. **Initialization creates no Issue or Agent job.** Later launches reopen the last folder; the folder button opens another one.

Create an Issue describing the requested change and acceptance criteria. OneTeam queues it automatically. Loops execute one at a time in that folder. No project registration, provider selector, model selector or detailed settings screen is needed.

For browser development:

```sh
npm run dev
# UI:  http://127.0.0.1:3579
# API: http://127.0.0.1:3580
```

Use the path form on the browser setup screen. Folder drag-and-drop is provided by the Electron app. If authentication is needed, the desktop app opens Codex login when execution starts. You can also run `npm run codex:login`, then resume the Loop.

## Development workflow

- **Issues / Pull Requests:** descriptions, comments and their edit history, review findings, Git diffs, line comments and commit history.
- **Development Loop panel:** current phase, pause / resume / cancel, related PR and Agent jobs, retrospective and knowledge changes. A paused or failed Loop holds the queue until it is resumed or canceled.
- **Agent tab:** progress, commands, changed files, test evidence and execution history. Each attempt records the selected model, model returned by Codex, reasoning effort, selection reason, thread / turn IDs, timestamps and available usage.
- **Repository tab:** detected commands, working-tree status and commit history.

Implementation and fixes use branch worktrees. Other roles use commit snapshots. OneTeam runs detected verification commands and checks the source and target commits again before merging. Changed commits require fresh verification; conflicts return to fixing. Missing evidence, execution errors or unresolved input stop the Loop with an explanation. Reply to an Agent's question in the Issue or PR to resume it.

Closing an Issue before merge cancels its Loop. Reopening creates follow-up work while preserving earlier deliveries. A merge requested from the PR screen uses the same Loop engine and verification checks. Standalone local PRs can still be managed manually.

## Automatic Codex models

OneTeam asks the bundled Codex App Server for its model catalog. A versioned internal policy chooses a model and supported reasoning effort from task scope, changed files, review findings and previous quality failures:

- Small documentation or wording changes prefer a lightweight model.
- Normal development uses a standard coding model.
- Architecture, data migration, security, concurrency or repeated quality failures prefer stronger reasoning.

Model availability also depends on the account. If a catalog entry is rejected before any tool work, OneTeam records the failed attempt and retries with another available model. Capacity limits use persisted waiting and retry, rather than treating them as code-quality failures. Codex model reroutes are recorded. Unknown historical models and missing usage remain unknown; token counts are not presented as billing costs.

## Knowledge and local data

```text
.oneteam/
  workspace.json               Workspace identity and initialization state
  AGENTS.md                    Shared guidance and knowledge index
  knowledge/*.md               Reusable practices maintained by retrospectives
  retrospectives/loop-<id>.md   Reports tied to the actual merge commit
  data/oneteam.db               Issues, PRs, Loops, jobs, logs and revisions
  data/artifacts/               Verification artifacts
  backups/                     Backup before the Loop schema migration
```

Knowledge changes can create, edit, consolidate or delete Markdown files inside `knowledge/`; the common `AGENTS.md` index cannot be deleted. A retrospective may report that no reusable change is needed. The Agent proposes changes; OneTeam validates paths and file hashes, saves the before/after journal and applies the files. Concurrent user edits stop application instead of being overwritten. Interrupted application resumes from the saved journal.

Open “Retrospective & history” in an Issue, PR or Agent Loop panel to inspect the report and file versions. An applied knowledge change can be restored to its previous version, provided the file has not subsequently changed. Pause an active Loop before restoring knowledge. For a conflicting pending proposal, reconcile the named file with the recorded version before resuming; the failed proposal is retained for inspection.

`.oneteam/` is excluded through the repository's local Git exclude file. It is local application data, so back up this directory when moving the workspace. Isolated worktrees live under `~/.oneteam/worktrees/`.

## Existing workspaces

The first open after this rewrite backs up the database and knowledge before applying the new schema. Issues, PRs, comments, activities, job IDs and verification records remain intact. Active legacy Objectives become paused Development Loops. Resume them explicitly; continued execution uses a new Codex job and preserves the old provider history. Completed legacy work is not assigned invented retrospectives.

Old `skills/` files remain readable as context, and old `memory/` files remain on disk. New Loops use the retrospective knowledge store. The old configurable Loop scheduler, Triage workflow, other provider executors and GitHub Actions polling are no longer active.

## Development and verification

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run e2e:install  # once on a new machine
npm run e2e
npm run app:dir     # unpacked desktop app
npm run app:pack    # packaged desktop app
```

Vitest covers Loop sequencing, real Git merges, migration, restart recovery, knowledge application/restoration, workspace isolation and model routing. Playwright creates two Issues and runs the production Loop engine with a deterministic Agent fixture, then checks learning transfer, model logs, large diffs, line comments, keyboard navigation and English/Japanese contrast. Codex authentication and live execution are checked separately from reproducible tests.

Runtime overrides for development: `ONETEAM_HOME`, `ONETEAM_REPOSITORY_PATH`, `ONETEAM_DATABASE_URL`, `ONETEAM_AGENT_WORKER=false`, `ONETEAM_AGENT_POLL_INTERVAL_MS`, `ONETEAM_CODEX_COMMAND`, `ONETEAM_CODEX_AUTO_LOGIN=false`, `HOST`, and `PORT`. A fixed database override is intended for tests and cannot switch between repositories. Provider and model environment overrides are no longer used.

The implementation uses TypeScript, Electron, React/Vite, Hono, libSQL/Drizzle, Vitest and Playwright. See the [rewrite plan](docs/LOOP_ENGINEERING_REBUILD_PLAN.md) for the architecture and migration decisions. Earlier documents under `docs/` describe the previous design unless marked otherwise.
