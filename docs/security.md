# Security model

## Assets and trust

- **Trusted**: the operator, the supervisor agent (it chooses tasks and repos from the allowlists),
  the installed code and config (root-owned), and the daemon.
- **Untrusted**: the worker, which means the coding-agent CLI, the model driving it, every command it
  runs, and the repo content it reads (prompt injection is assumed possible).
- **To protect**: provider API keys and other credentials, the host filesystem, other tasks, the main
  clone and remote repos, the daemon's control socket, and the audit trail.

## Layers

1. **Allowlists, enforced by the daemon.** Repos (by name; clone URLs only from
   `allowed_clone_hosts`), test commands (anchored regexes per repo), profiles and backends. The MCP
   interface accepts names, never paths or URLs.
2. **Outer bwrap sandbox around every worker run, whatever the backend.** Paths in
   `worker_sandbox.hide` (by default `/home /root /workspace /tmp /run /var/tmp /mnt /media /srv`), the
   whole data dir, the main clone and the secret store are hidden: directories become empty tmpfs mounts
   and files are replaced by `/dev/null`. Only these are bound back:
   - read-only: the toolchain (Node, the backend CLI package, PATH dirs, configured `ro_binds`), the
     backend config dir, and the task's git common dir (so a commit fails: objects and refs are
     read-only)
   - read-write: the task worktree and the backend HOME
   - per-task mounts: the task's own session data over the backend HOME's data dirs, so a worker
     cannot read other tasks' sessions

   It uses a private PID namespace and a fresh `/proc`. Hidden paths are invisible however they are
   spelled (symlinks, `/proc/self/root`, …).
3. **Inner sandbox (Kilo only).** Kilo runs model-issued shell commands in its own bwrap/seccomp
   sandbox: writes only in the worktree, no network. OpenCode has no equivalent. Codex uses its own
   workspace-write sandbox. The Claude Code adapter enables Claude's sandbox setting (untested).
4. **Guard plugin/hook** (`adapters/kilo/config/plugin/workhorse-guard.js`, shared by Kilo and
   OpenCode, and reused by the Claude Code PreToolUse hook):
   - blanks secret env vars in model-run shells
   - refuses git history/remote/config mutation, network clients, privilege escalation, nested agents,
     `/proc/*/environ`, credential dirs, commands naming configured secret variables, and literal
     secret-store or daemon-run paths
   - file tools may only touch paths inside the worktree (content is never pattern-matched)
5. **Agent permissions** (`kilo.jsonc` / `opencode.jsonc`): deny by default. There is no web fetch or
   search, no questions, only the `explore` subagent, and edits to `.git`, `.kilo`, `.opencode` or
   agent config files are denied.
6. **Project config is off for untrusted repos.** A repo's own agent config and plugins would run as
   host code, so they are disabled unless the repo sets `trust_project_config: true`. The repo's
   `AGENTS.md`, `CLAUDE.md` and `CONTEXT.md` are still loaded as plain-text instructions.
7. **The daemon verifies.** Tests run in a separate sandbox (no network by default, clean env, fresh
   session). The daemon collects the diff itself and flags commits or main-clone changes as
   `integrity_violation`. The worker's self-report is shown but never trusted for the verdict.
8. **Credentials.** Keys are looked up by env var name. They reach the agent only through its
   environment (never argv, config files or logs), and only the keys the chosen provider needs. The
   audit log and results pass through redaction, and the secret store is hidden from the sandbox.
9. **Root-owned config.** `lock-config.sh` makes the config, `adapters/` and the code-bearing dirs of
   each backend HOME root-owned, so a process running as the service user cannot widen its own
   permissions.
10. **Audit.** Every RPC, task event and tool call is written as JSONL with values redacted.

## Known limitations

- The agent process needs network access to reach the model API, so the outer sandbox does not
  unshare the network. With Kilo, model-run commands are still offline because of the inner sandbox.
  With OpenCode (and any backend without an inner sandbox), model-run commands can reach the network.
  The guard blocks common clients (`curl`, `wget`, `ssh`, …) by name, but interpreters (`python3 -c`)
  can still open sockets.
- The provider key is in the agent process's environment. A sufficiently capable exploit of the agent
  process itself could read it. Use a key scoped to inference with spending limits.
- Claude Code passes its environment to Bash. The PreToolUse hook blocks commands that name the key or
  dump the environment, but that is a pattern check.
- The backend HOME's cache (for example `kilo-home/.cache/kilo`) is shared between tasks and writable,
  except for the root-owned `bin/`.
- Workers can read the repo's full git history (the object store is bound read-only).
- The pattern guards are a second layer. If you find a bypass of the *sandbox*, please report it (see
  [SECURITY.md](../SECURITY.md)).

## Recommendations

- Run on a dedicated VM or user account, with a least-privilege inference key.
- Keep `test_network: false` unless tests need it, and keep `allowed_test_commands` narrow.
- Enable `trust_project_config` only for repos whose agent config you have reviewed.
- Check `workhorse health` daily and read `workhorse audit` after unexpected verdicts.
