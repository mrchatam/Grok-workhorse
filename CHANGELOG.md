# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.0] - Unreleased

Token savings. Workhorse exists to reduce supervisor (for example Grok) usage by letting smaller,
user-chosen models do bounded work; this release cuts what the supervisor reads and how often it has to
act, and adds opt-in savers for the workers. Builds on 0.2.0. See [docs/token-savings.md](docs/token-savings.md).

### Added
- **`wait_task`** (MCP, RPC, `workhorse wait`): long-poll one task (`task_id`) or several (`task_ids`,
  `mode: "any" | "all"`) until they finish or park, up to `max_wait_s` (default 45, cap 55 s to stay
  under common 60 s MCP request timeouts). Returns the brief result.
- **`view: "brief"`** for `task_result` and `wait_task` (~0.5-1 KB: verdict, short summary, files,
  tests, concerns, `next` with the suggested call, review, automatic trail, tokens). `full` stays the
  default for `task_result`.
- **`delegate_tasks`**: up to 10 tasks in one call, with per-entry errors.
- **Presets and size routing** in `profiles.json`: `presets` (profile, size, mode, timeout, test
  command, standing instructions, follow-up flags) and `routing` (`small`/`medium`/`large` -> profile).
  `list_models` shows them.
- **Automatic follow-ups** (off by default; per call, per preset or `profiles.json` `auto`):
  `auto_fix_rounds` (same-session fix rounds after failing tests or a missing/partial RESULT, max 3),
  `escalate` along each profile's new `escalate_to` chain (fresh session, same worktree), hard caps
  `max_auto_runs` (default 3, cap 6), `max_tokens`, `max_cost_usd`. The trail is in `result.auto`.
- **`auto_review`**: an advisory read-only review on a (cheap) profile after a successful run; new
  transient status `reviewing`. `request_changes` makes the handoff `needs_review`.
- **`usage_report`** (MCP, RPC) and **`workhorse stats`**: worker tokens and estimated list cost by
  profile and day, plus a clearly labelled ESTIMATE of supervisor tokens avoided (formula documented;
  optional `daemon.json supervisor.price_per_mtok` for USD). The daemon now records per-run tokens and
  cost, and the characters each supervisor call sent and received.
- **Worker token savers** (`token_savers` in daemon.json, per-profile override; all off by default):
  `terse` and `minimal_code` instruction fragments (`lite`/`full`, our own wording inspired by Caveman
  and Ponytail) and `rtk` (Kilo/OpenCode: the guard plugin rewrites worker bash commands through
  `rtk rewrite`). `workhorse token-savers`, installer `--token-savers` / `--rtk-bin`. The daemon's own
  test run never goes through them.
- **`approvals.require_operator`**: MCP `approve_task` only records an approval request; a human
  confirms with `sudo workhorse approve <id>`, which sends a separate operator token (the daemon stores
  its SHA-256). `workhorse operator-token init [--enable]`.
- **Per-profile `stall_minutes`.**
- **Audit log rotation** (`audit.max_mb`, `audit.keep`).
- **Test-only stub backend** (`adapters/stub`), registered only when the daemon runs with
  `WH_ENABLE_STUB_BACKEND=1` and limited to its bundled script, so the approval, continue, retry,
  fallback, restart, handoff, auto-fix, escalation and review flows run end to end in GitHub Actions
  (`npm run test:stub`). `workhorse health` warns if a daemon runs with the flag.

### Changed
- The MCP shim returns compact JSON (9-18% fewer characters on typical responses).
- The full `task_result` no longer repeats top-level fields inside `handoff.context` (`get_handoff`
  still returns the complete record).
- `delegate_task`'s `next_step` and the MCP instructions point to `wait_task`; the delegation skill draft
  prefers `wait_task`, the brief view, presets/size, batches and automatic follow-ups.
- The installer installs Kilo CLI and OpenCode from committed lockfiles (`scripts/pins/`, `npm ci`,
  integrity-checked) when the pinned version is requested, and falls back to `npm install -g` with a
  warning otherwise.
- CI runs the unit tests, then the stub end-to-end suite.

## [0.2.0] - Unreleased

Task handoff records and a human-approval state, based on community feedback. A supervisor should keep a
blocked task as blocked, with the failed check, the owner and the exact next action, so a later agent
can resume it without guessing.

### Added
- **Handoff record** on every finished task (`task.handoff`, persisted in `task.json`): `state` (`done`,
  `needs_fix`, `needs_review`, `needs_approval`, `needs_input`, `blocked`, `retryable`, `closed`),
  `failed_checks` (tests with command, exit code, failing test names and an excerpt; integrity; blocked
  tool calls; timeout, stall or interrupt; worker error; missing `## RESULT`; no changes), `owner`,
  `next_action`, `resume` (suggested tool + args, session reusable, worktree, branch), `context`,
  `notes`, `history`, `updated_at` / `updated_by`. The daemon derives it deterministically from the
  verdict and the data it already has. `task_result` returns it in full, and `task_status` and
  `list_tasks` return a summary. Tasks finished before 0.2.0 get a derived record on the fly.
- **Parked status `needs_approval`**: the task waits for a human decision when the worker reports
  `status: needs_approval` / `needs_input`, or `blocked` with a request or after blocked tool calls.
  No worker runs. `task_status` reports `terminal: true, parked: true`. Retention keeps the worktree
  unless `retention.parked_days` is set. With it set, expired parked tasks lose their worktree (the
  diff is archived) and are closed. `cleanup_task` on a parked task also closes it.
- MCP tools `update_handoff` (owner, next_action, state, note; state `needs_approval` / `needs_input`
  parks a task and any other state unparks it) and `approve_task` (`approve` resumes through the
  continue path with the approval noted, and `reject` closes the task or redirects it with
  instructions).
- `list_tasks` filters `status: "needs_attention"` (parked tasks plus finished tasks whose handoff is
  not done or closed) and `status: "parked"`, and a new `owner` filter.
- CLI: `workhorse handoff <id>` (show or update), `workhorse approve <id>`, `workhorse reject <id>`,
  `workhorse attention`, `workhorse tasks --status/--owner`, `workhorse cleanup-old --parked-days N`.
- Worker contract: RESULT statuses `needs_approval` and `needs_input`, plus an optional `needs:` line
  for the one exact request.
- `test_results.failing_tests` (names parsed from the full test log) when tests fail.
- `health_report`: `parked_tasks`, `oldest_parked_days`, `needs_attention`.
- Audit events `parked`, `handoff_updated`, `approval`, `closed`. `finished` now carries
  `handoff_state` and `owner`.
- Docs: [docs/handoff.md](docs/handoff.md). The delegation skill draft now tells the supervisor to follow
  `handoff.next_action`, relay approvals and hand off with `update_handoff`.

### Changed
- `continue_task` also accepts parked (`needs_approval`) tasks. Each `previous_results` entry records
  the handoff it replaced, and the approval that answered it.
- `cancel_task` on a parked task closes it (status `cancelled`, handoff `closed`).
- `list_tasks status: "terminal"` also includes parked tasks, since no worker is running.
- `update_handoff state: "closed"` on a parked task closes it like `cancel_task` / reject without
  instructions (status `cancelled`, handoff `closed`) instead of unparking it to `completed`.
- Approvals, handoff updates and closes record `source` (`channel` mcp/cli, `auth`) next to the
  free-text `by`, so attribution is not only a caller-chosen name.

### Fixed
- A task stopped by a graceful daemon shutdown (`workhorse stop`, SIGTERM) was marked `interrupted`
  but never finalized, so it had no result and no handoff. It is now finalized on the next start.
- The daemon's shutdown removed the socket path unconditionally after finalizing tasks, which could
  delete the socket of a daemon started in the meantime. It now removes only its own socket (same
  inode), writes `run/daemon.pid`, and a new daemon waits for a previous one that is still stopping
  before recovery. `workhorse stop` / `restart` wait for the processes to exit.
- `cleanup_task` and retention mark a task before their first async step. While its worktree is being
  removed, `continue_task`, `approve_task`, `update_handoff` and a second cleanup are refused instead of
  queueing a run into a worktree that is being deleted.
- Audit log: the `run_started` event's run kind (`initial`, `continue`, `retry`, `fallback`) overwrote
  the record's `kind` (`task`). It is now `run_kind`. Reserved audit fields (`ts`, `kind`, and
  `task_id`, `event`, `status` on task events) can no longer be overwritten by event data. A clashing
  key is kept as `data_<key>`.

### Compatibility
- Existing statuses, verdicts and tool arguments are unchanged. A parked task's verdict is the existing
  `blocked`. Tasks that used to end as `completed` + `blocked` are now `needs_approval` + `blocked` when
  the worker made a concrete request or hit blocked tool calls. Without either, they stay `completed`.

## [0.1.0] - 2026-09-26

First public release.

### Added
- Stdio MCP server (`workhorse-mcp`) with `list_repos`, `list_models`, `delegate_task`, `task_status`,
  `task_result`, `task_details`, `continue_task`, `cancel_task`, `list_tasks` and `cleanup_task`,
  backed by one persistent daemon (unix socket plus token).
- Pluggable worker backends. `kilo` and `opencode` adapters are tested against the full mock
  integration suite and a live hello task. `claude-code` (PreToolUse guard hook) and `codex` adapters are implemented but
  untested. `gemini` and `aider` are TODO skeletons.
- A git worktree per task, an outer bwrap sandbox per task (hides the data dir, other tasks, the
  secret store, the main clone, `/home`, `/tmp`, …), per-task agent session data, and a test sandbox
  with no network.
- Guard plugin for Kilo/OpenCode (git mutation, network clients, secret access, paths outside the
  worktree) and the same rules as a Claude Code PreToolUse hook.
- Profiles for any OpenAI-compatible provider, with fallback chains and retries with back-off. Example
  profiles for NVIDIA NIM, OpenRouter and custom endpoints.
- Credentials from the daemon env, the MCP connector env, or an optional secret-store fallback.
- Structured results with daemon-run tests, verdicts, integrity checks, usage and timings, plus an
  append-only audit log.
- Stall detection (15 min), timeouts, cancel, recovery after restart, retention sweeps and
  `workhorse health`.
- Idempotent installer (`scripts/install.sh`) with pinned Kilo CLI, optional pinned OpenCode, config
  locking, a hello-world smoke task and optional systemd; `uninstall.sh`.
- Draft Grok Bot skills in `grok-template/` (getting started, delegation).

[Unreleased]: https://github.com/mrchatam/Grok-workhorse/compare/v0.1.0...HEAD
[0.2.0]: https://github.com/mrchatam/Grok-workhorse/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/mrchatam/Grok-workhorse/releases/tag/v0.1.0
