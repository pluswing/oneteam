# Local Codex CLI setup

one team uses the Codex CLI installed in this project under `node_modules`.

## Commands

```sh
npm run codex:version
npm run codex:login
```

On startup, one team runs `codex login status` for the managed Codex CLI command. If authentication is missing, it starts `codex login` automatically. `npm run codex:login` remains available as a manual fallback.

## Default one team setting

The default Codex command is:

```text
node_modules/.bin/codex
```

The Codex command is managed by the application runtime and is no longer editable from the Settings screen. In packaged Electron builds, one team points this value at the bundled Codex binary.

## Agent execution

Agent jobs run Codex with:

```text
codex exec --json --dangerously-bypass-approvals-and-sandbox
```

The worker passes the target repository with `--cd`, writes a strict output schema
with `--output-schema`, and reads the final response from `--output-last-message`.
JSONL events emitted by Codex are saved as agent activity records.
