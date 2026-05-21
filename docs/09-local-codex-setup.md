# Local Codex CLI setup

one team uses the Codex CLI installed in this project under `node_modules`.

## Commands

```sh
npm run codex:version
npm run codex:login
```

`npm run codex:login` runs `node_modules/.bin/codex login`, so authentication is configured for the local Codex CLI package used by one team.

## Default one team setting

The default Codex command is:

```text
node_modules/.bin/codex
```

If an older setup stored `codex` as the command, one team normalizes it to `node_modules/.bin/codex` before running agent jobs.

## Agent execution

Agent jobs run Codex with:

```text
codex exec --json --dangerously-bypass-approvals-and-sandbox
```

The worker passes the target repository with `--cd`, writes a strict output schema
with `--output-schema`, and reads the final response from `--output-last-message`.
JSONL events emitted by Codex are saved as agent activity records.
