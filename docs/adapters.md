# Backend adapters

A backend adapter teaches the daemon how to drive one coding-agent CLI. Everything else is shared by
all backends: the MCP API, queue, per-task worktrees, outer sandbox, allowlists, credentials, audit
log, daemon-run tests and the structured result.

## Matrix

| Backend | Status | How it is driven | Guard | Inner shell sandbox | Providers |
|---|---|---|---|---|---|
| `kilo` | **tested**: full integration suite (mock LLM) + live runs | `kilo run --format json --agent worker --model … --dir <wt> [--session id]` | plugin (`workhorse-guard.js`) | yes (bwrap + seccomp, no network) | OpenAI-compatible via `profiles.json` |
| `opencode` | **tested**: full integration suite (mock LLM) + a live hello run, OpenCode 1.18.32 | `opencode run --format json …` (same flags) | same plugin | **no**, so commands keep network | OpenAI-compatible |
| `claude-code` | untested: unit tests for command, settings, parsing and hook | `claude -p <msg> --output-format stream-json --verbose --model <id> [--resume id]` | PreToolUse hook (`adapters/claude-code/pretooluse-guard.mjs`) | Claude's `sandbox` setting | `kind: "anthropic"` (`ANTHROPIC_API_KEY`, optional `base_url`) |
| `codex` | untested: unit tests for command and parsing | `codex exec --json --sandbox workspace-write -C <wt> -m <id> -c model_providers…`, `codex exec resume <id>` | none (no hook API) | Codex workspace-write sandbox | OpenAI-compatible (`wire_api` chat by default) |
| `gemini` | skeleton (TODO) | | | | |
| `aider` | skeleton (TODO) | | | | |

Install a backend CLI, set `"backend": "<name>"` in a profile, and check it with `workhorse backends`
and `workhorse health`. The installer can pin OpenCode (`--with-opencode`). Other CLIs are found through
`WH_<NAME>_BIN`, `<prefix>/<name>-cli/bin/<exe>` or PATH, or by setting `daemon.json
backends.<name>.bin`.

### Using the claude-code backend (untested)

```json
{
  "profiles": { "claude": { "backend": "claude-code", "model": "anthropic/sonnet" } },
  "providers": { "anthropic": { "kind": "anthropic", "api_key_env": "ANTHROPIC_API_KEY",
                                "models": { "sonnet": { "id": "<claude model id>" } } } }
}
```

## Interface

Adapters are plain objects exported from `adapters/<name>/adapter.mjs` and registered in
`adapters/index.mjs`:

| Member | Purpose |
|---|---|
| `name`, `status` (`tested` \| `untested` \| `skeleton`), `summary`, `notes[]`, `capabilities{}` | Metadata shown by `workhorse backends`, `list_models` and health |
| `validate({profile, pc, cfg, bc}) → string[]` | Problems with running this profile on this backend (for example the wrong provider kind) |
| `prepare(ctx)` | Per run: create per-task dirs, settings files, hook config |
| `command(ctx) → string[]` | argv after the binary; `ctx.resumeSession` is set when resuming |
| `env(ctx) → object` | Backend env, merged over the daemon's base env (PATH, HOME, LANG, `sandbox_env`, the provider's secrets, `WH_SECRET_NAMES`, `WH_GUARD_DENY_PATHS`) |
| `sandbox(ctx) → {roBinds, rwBinds, mounts}` | Extra outer-sandbox binds (config dir, HOME, per-task data mounts) |
| `parse(event, state) → events[]` | One JSON line of the CLI's stdout to normalized events |

`ctx` contains `t` (the task), `profile`, `pc` (profiles config), `cfg` (daemon config), `bc` (the
resolved backend config: `bin`, `config_dir`, `home`, …), `repo`, `agent` (`worker` or `review`),
`message`, `resumeSession`, `dataDir` (per-task backend data), `home`, `sandboxed` and `secrets`.

Normalized events:

```js
{ type: "session", id }
{ type: "step", turns, tokens: { input, output, reasoning, cache_read, cache_write }, cost }
{ type: "tool", tool, shell, input, ok, error, output, exit }
{ type: "text", text }            // the last text must contain the ## RESULT block
{ type: "error", message, statusCode, retryable }
```

Cancel, timeout and stall handling are common: the daemon kills the process tree.

## Adding an adapter

1. Copy `adapters/codex/adapter.mjs` (a compact example) to `adapters/<name>/adapter.mjs` and register it in `adapters/index.mjs`. Add defaults under `backends` in `lib/config.mjs` (`exe`, `config_dir`, `home`).
2. Deliver the worker contract (`adapters/kilo/config/AGENTS.md`, available through `contractText()`) as the CLI's system prompt or instructions.
3. Make every permission non-interactive: the run is headless and nobody can answer prompts.
4. Wire a guard if the CLI has a pre-tool hook (reuse `workhorse-guard.js`, as the Claude Code hook does), and disable project-level config unless `ctx.repo.trust_project_config`.
5. Keep per-task state under `ctx.dataDir`, and return `sandbox()` binds for anything the CLI must read.
6. Add unit tests to `test/adapters.test.mjs` with recorded or synthetic event streams. If the CLI can point at an OpenAI-compatible base URL, run the mock integration suite with `WH_TEST_BACKEND=<name>` (extend `test/helpers.mjs`).
7. Mark the status honestly and open a PR (see [CONTRIBUTING.md](../CONTRIBUTING.md)).
