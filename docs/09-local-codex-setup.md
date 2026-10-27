# Local Codex setup

OneTeam uses the Codex CLI installed on your machine. It does not bundle, install or update Codex. Install and maintain it using the [official CLI instructions](https://learn.chatgpt.com/docs/cli), then verify and sign in from your terminal:

```sh
codex --version
codex login
codex login status
```

The default command is `codex`, resolved from PATH. On macOS, OneTeam loads the login shell's PATH so Finder launches can find the same Codex and Node.js installation as your terminal. Jobs, chat, advisory translation and authentication use the same configured command and the usual Codex account/configuration directory. For a custom installation, set `ONETEAM_CODEX_COMMAND` to an executable path before launching OneTeam.

OneTeam checks login status before execution and opens login when needed. The CLI and, for npm-based installations, Node.js must be available on the app's PATH. A missing CLI is not replaced with a bundled copy or automatically installed. Developers can use `npm run codex:version` and `npm run codex:login` to invoke the terminal-installed CLI.

OneTeam uses `codex app-server --listen stdio://` and retrieves every page of `model/list` before execution and model retries. It follows official successor metadata, current recommendations and newer listed Sol models, instead of permanently pinning automatic selection to one model name. See [Automatic Codex models](../README.md#automatic-codex-models) for selection, completed-work cost estimates, quality escalation and limitations.

GPT-6.1 Sol is the reviewed baseline. A successful `thread/start` alone is insufficient: inference may still reject the model. An automatic access rejection is recorded and must not silently send work to the older GPT-5.6 Sol. Check the installed CLI version, login, account access and workspace model permissions, or explicitly select another model. Explicit selections are never silently replaced. Unlisted rejected probes have a ten-minute cooldown, bypassed by a fresh listing or explicit choice. Catalog failures stop work rather than using stale application data. Updating OneTeam does not update your CLI. Model access still depends on the client, account and rollout; future task completion cost cannot be guaranteed before execution.

## Chat

The Chat tab uses the same terminal-installed Codex CLI and login. Its conversations have separate persistent Codex threads and repository-local message histories. It uses the App Server's experimental dynamic-tool protocol to call OneTeam's existing project APIs, including Issue/PR operations, merge, Job restart, model settings, Loop control, knowledge and vulnerability operations. Use a recent Codex version that supports `dynamicTools` and `item/tool/call`.

Each chat's model and reasoning controls apply to its next reply. Ask the assistant to inspect the current chat settings or to change development defaults, role-specific settings or a Job's model. Explicitly selected models are not silently replaced if access is denied. Automatic selection keeps the reviewed preference and fallback behavior described above. A Job's active model changes only when its execution is restarted; OneTeam waits for its previous execution and worktree lifecycle before requeueing it.

The chat assistant is restricted to OneTeam's tools and read-only repository source inspection. Development Jobs keep the full command access described below. A stopped or interrupted response preserves completed operations and records incomplete work; OneTeam does not automatically replay it after restart. Conversation data is part of `.oneteam/data/oneteam.db` and should be included in repository workspace backups.

## Command execution, Git and Docker

OneTeam's development Agent jobs use `sandbox: "danger-full-access"` and `approvalPolicy: "never"`. Commands run with the permissions of the user running OneTeam, with filesystem and network access enabled and no per-command approval prompt. This applies to every development role, including requirements, review, command detection and retrospective. Each role still follows its task instructions, including instructions to inspect without changing source files. The background advisory-translation helper remains read-only.

Full access is needed because Git worktrees store their index, locks, objects and refs in the source repository's `.git/` directory, outside the job's worktree. Codex's `workspace-write` mode protects Git metadata even when the worktree itself is writable. It can therefore reject `git add` or `git commit` with `Unable to create .../.git/worktrees/.../index.lock: Operation not permitted`. Network access alone does not resolve this. OneTeam reapplies full access on thread start, thread resume and every turn so previously restricted jobs can continue.

Commands such as `git`, `docker`, `jq`, `node`, package managers and build/test tools must be installed and available on the app's PATH. User caches, temporary directories and local daemon sockets are accessible under the current user's OS permissions. macOS privacy controls, administrator-enforced Codex policies and commands requiring administrator privileges still apply.

For Docker, start Docker Desktop and check that `docker version` succeeds in your terminal using the intended context. If OneTeam was already running, use a rebuilt app, quit and reopen it, then resume the failed Loop. Changing Git metadata or Docker socket file permissions, deleting lock files, or granting macOS Full Disk Access is not required for this sandbox-policy fix.

## Autonomous development Loops

Routine implementation choices and requests for permission to continue are resolved within the authorized task. A proposed human handoff is reconsidered once in the same worktree if it lacks a concrete indispensable blocker; the agent must explain attempted recovery and why user information or authority is necessary. Interactive question tools receive no fabricated answer. Managed verification/evidence failures go through bounded automatic repair and re-verification. Explicit pauses, cancellation, policy boundaries, budgets and genuine external blockers remain enforced. See [Automatic progress and human handoffs](../README.md#automatic-progress-and-human-handoffs).
