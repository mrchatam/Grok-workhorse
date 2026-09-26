# Configuration

The config dir is `<prefix>/config` (override with `WH_CONFIG_DIR`). Files are re-read for every new
task, so edits take effect without a restart, except `data_dir`. Installed config is root-owned. To edit:

```bash
sudo bash <prefix>/scripts/unlock-config.sh
$EDITOR <prefix>/config/profiles.json
workhorse validate
sudo bash <prefix>/scripts/lock-config.sh
```

## profiles.json

```jsonc
{
  "default_profile": "default",
  "default_backend": "kilo",            // optional; else daemon.json default_backend
  "profiles": {
    "<name>": {
      "description": "shown to the supervisor in list_models",
      "backend": "kilo",                  // kilo | opencode | claude-code | codex (gemini/aider: skeletons)
      "model": "<provider key>/<model key>",
      "explore_model": "<provider>/<model>", // optional cheaper model for Kilo/OpenCode's explore subagent
      "fallback": ["<other profile>", "..."], // tried in order after repeated 429/5xx; [] = none
      "enabled": true, "disabled_reason": "...",
      "price_per_mtok": { "input": 0.5, "output": 2.5 }, "price_note": "estimate only"
    }
  },
  "providers": {
    "<provider key>": {
      "name": "display name",
      "kind": "openai-compatible",         // default; "anthropic" for the claude-code backend
      "base_url": "https://host/v1",
      "api_key_env": "NAME_OF_ENV_VAR",     // the NAME, never the key; null for keyless local servers
      "max_concurrent": 2,                  // concurrent tasks on this provider
      "timeout_ms": 600000,
      "headers": { "X-Title": "..." },
      "models": {
        "<model key>": { "id": "model id as the API expects it", "context": 131072, "output": 16384,
                         "reasoning": false, "tool_call": true, "temperature": true, "options": {} }
      }
    }
  },
  "kilo_overlay": {},      // raw Kilo config merged into every Kilo run (advanced)
  "opencode_overlay": {}   // same for OpenCode
}
```

Examples: [`config/examples/profiles.nvidia.json`](../config/examples/profiles.nvidia.json),
[`profiles.openrouter.json`](../config/examples/profiles.openrouter.json) and
[`profiles.custom.json`](../config/examples/profiles.custom.json) (vLLM, LiteLLM, Ollama, …).

## repos.json

Prefer `sudo workhorse add-repo <url|path> --test "<cmd>" [--allow-test "<regex>"]...` over editing by hand.

| Key | Meaning |
|---|---|
| `path` | Existing local clone to use as the main clone (workers never write to it) |
| `url` | https/ssh URL on a host in `allowed_clone_hosts`; the daemon clones it into `data_dir/repos/<name>` with its own git credentials |
| `default_base` | Branch that new worktrees start from (default `main`) |
| `test_command` | Default test command, run by the daemon in the test sandbox |
| `allowed_test_commands` | Anchored regexes for other `test_command` values the supervisor may pass |
| `test_network` | Give the test sandbox network access (default false) |
| `trust_project_config` | Load the repo's own agent config and plugins (default false; see [security.md](security.md)) |
| `fetch_before_task` | `git fetch` the main clone before each task |

## daemon.json

Every key is optional. Defaults are in `lib/config.mjs`.

| Key | Default | Meaning |
|---|---|---|
| `data_dir` | `~/.local/share/grok-workhorse` | Clones, worktrees, tasks, logs, socket (`WH_DATA_DIR` overrides) |
| `max_concurrent` | 2 | Tasks running at once |
| `timeouts` | default 30, min 1, max 120, **stall 15**, test 10 (minutes), kill_grace_sec 10 | |
| `retry` | 2 retries, back-off [30, 120] s, provider cooldown 60 s | For retryable model API errors |
| `retention` | enabled, worktree_days 7, task_days 30, parked_days null, sweep every 60 min | Automatic cleanup. Parked (`needs_approval`) tasks are skipped unless `parked_days` is set. When it is set, their worktree is removed that many days after the last handoff update and the task is closed ([handoff.md](handoff.md)) |
| `default_backend` | `kilo` | Backend for profiles without `backend` |
| `bwrap` | auto: bundled with Kilo, else `bwrap` on PATH | |
| `backends.<name>` | `bin` (auto: `$WH_<NAME>_BIN`, `<prefix>/<name>-cli/bin/<exe>`, PATH), `expected_version`, `config_dir`, `home` | Per-backend settings; `kilo` also has `session_retry_limit` |
| `env_path` | auto | PATH for workers and tests |
| `secret_env` | [] | Extra secret names (every provider's `api_key_env` is added automatically) |
| `secret_store_path` | null | Optional JSON secret store, mode 0600 (`{NAME: value}`, `{secrets: {...}}`, `[{name, value}]`, ...; see `lib/credentials.mjs`) |
| `allowed_clone_hosts` | `["github.com"]` | |
| `min_mem_available_mb` | 1200 | Memory admission for starting another worker |
| `sandbox_env` | {} | Extra env for workers and tests (for example `GOFLAGS`, `GOPROXY=off`); PATH, HOME, backend, XDG, WH and secret names are refused |
| `test_sandbox` | enabled, `ro_binds` [] , `env` {} | |
| `worker_sandbox` | enabled, `hide` [...], `ro_binds` [], `auto_bind_toolchain` true, `env` {} | Outer sandbox around worker runs |

The legacy keys `kilo` (maps to `backends.kilo` and `bwrap`) and `kilo_sandbox` (maps to
`worker_sandbox`) are still accepted.

### Toolchains and offline caches

Worker and test commands run without network access (Kilo). Provide dependencies read-only and point
tools at them:

```json
{
  "worker_sandbox": { "ro_binds": ["/opt/go", "/srv/cache/gomod"] },
  "test_sandbox":   { "ro_binds": ["/opt/go", "/srv/cache/gomod"] },
  "sandbox_env":    { "GOMODCACHE": "/srv/cache/gomod", "GOFLAGS": "-mod=mod", "GOPROXY": "off", "GOCACHE": "/tmp/kilo/go-build" }
}
```

## Credentials

Lookup order for every name in `secretEnvNames` (the providers' `api_key_env` values plus
`secret_env`):

1. the daemon's own environment (for example a systemd `Environment=` / `EnvironmentFile=`, or `sudo --preserve-env` at start)
2. the MCP shim's environment (the connector env of your MCP client), offered to the daemon in memory
3. `secret_store_path`, re-read before a task when a key is still missing

Only the keys required by the chosen profile's provider are passed to that worker.

## Environment variables

| Variable | Used by |
|---|---|
| `WH_CONFIG_DIR`, `WH_DATA_DIR`, `WH_APP_DIR` | all: override locations |
| `WH_KILO_BIN`, `WH_OPENCODE_BIN`, `WH_CLAUDE_CODE_BIN`, `WH_CODEX_BIN` | backend binary auto-detection |
| `WH_ALLOW_ROOT` | allow running the daemon as root (not recommended) |
| `WH_TEST_BACKEND`, `WH_LIVE_TEST`, `WH_LIVE_PROFILES`, `WH_LIVE_PROFILE`, `WH_SKIP_INTEGRATION` | tests |
