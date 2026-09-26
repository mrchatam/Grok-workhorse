# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
