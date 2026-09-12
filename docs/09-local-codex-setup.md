# AI provider setup

OneTeam can run agent jobs with Codex, Claude Code, or LM Studio. The active
provider is selected during first setup and can be changed later from Settings.
New agent jobs store the selected provider so existing queued jobs remain
reproducible after a provider switch.

## Codex

```sh
npm run codex:version
npm run codex:login
```

Codex uses the CLI installed in this project under `node_modules`. Before a
Codex job runs, OneTeam checks `codex login status`. If authentication is
missing, it starts `codex login`. `npm run codex:login` remains available as a
manual fallback.

The default Codex command is runtime managed:

```text
node_modules/.bin/codex
```

Agent jobs run Codex with:

```text
codex exec --json --dangerously-bypass-approvals-and-sandbox
```

The worker passes the target repository with `--cd`, writes a strict output schema
with `--output-schema`, and reads the final response from `--output-last-message`.
JSONL events emitted by Codex are saved as agent activity records.

## Claude Code

Claude Code is treated as an external CLI adapter. Configure its command, model,
permission mode, and max turns in Settings. Before a Claude Code job runs, one
team checks `claude auth status` and can launch `claude auth login` when needed.

Agent jobs run Claude Code in non-interactive print mode with stream JSON output
and the same strict OneTeam output schema.

## LM Studio

LM Studio is treated as an OpenAI-compatible local API provider. Configure its
base URL, model, max tool rounds, and temperature in Settings. The default base
URL is:

```text
http://127.0.0.1:1234/v1
```

Because LM Studio is not a code-editing CLI, OneTeam provides a small local tool
loop for repository file reads/writes, file listing, and shell command execution.
