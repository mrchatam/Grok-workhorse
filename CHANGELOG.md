# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
[0.1.0]: https://github.com/mrchatam/Grok-workhorse/releases/tag/v0.1.0
