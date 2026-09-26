# Troubleshooting

Start with `workhorse health` (add `--json` for details), then `workhorse logs 100`,
`workhorse audit 50` and `workhorse call task_details '{"task_id":"…","kind":"stderr"}'`.

## bwrap: "setting up uid map: Permission denied" / "No permissions to create new namespace"

Unprivileged user namespaces are blocked.

- **Ubuntu 23.10 / 24.04+ (AppArmor):** `kernel.apparmor_restrict_unprivileged_userns=1` blocks them
  for unconfined binaries. Either add an AppArmor profile for the bwrap binary in use (Kilo's bundled
  one is `<prefix>/kilo-cli/lib/node_modules/@kilocode/cli/bin/bwrap`):
  ```
  # /etc/apparmor.d/workhorse-bwrap
  abi <abi/4.0>,
  include <tunables/global>
  profile workhorse-bwrap /opt/grok-workhorse/kilo-cli/lib/node_modules/@kilocode/cli/bin/bwrap flags=(unconfined) {
    userns,
  }
  ```
  then run `sudo apparmor_parser -r /etc/apparmor.d/workhorse-bwrap`. Alternatively, set the sysctl to
  0 (this weakens the host-wide default).
- **Debian (older):** `sysctl kernel.unprivileged_userns_clone=1`.
- **Containers:** nested user namespaces usually fail in unprivileged Docker/Podman. Use a VM.

## "nested bwrap failed"

Kilo's inner sandbox needs to create a user namespace inside the outer one. The outer sandbox
deliberately does not pass `--disable-userns`. If your kernel limits `user.max_user_namespaces`, raise it.

## Task fails fast with "missing credentials"

The provider's `api_key_env` was not found in the daemon env, the MCP connector env or the secret
store. Put it in the connector env (recommended) or restart the daemon from an environment that has it
(`sudo -u <user> --preserve-env=NAME workhorse restart`), then run `workhorse check-provider`.

## Verdict `stalled` / `timeout`

`stalled` means no output from the agent for `timeouts.stall_min` (15 min by default), which is often
a hung provider or a model stuck in a long reasoning step. `timeout` means the wall-clock limit was hit.
Check `task_details kind=activity` and `stderr`, then use `continue_task` (it resumes the session) or
choose a faster profile.

## Verdict `blocked` or many blocked calls

The worker tried something the policy denies (a git commit, network, paths outside the worktree).
`task_result.blocked_examples` shows the calls. That is usually fine. If a legitimate build step needs
something, provide it through `ro_binds` and `sandbox_env` rather than loosening the guard.

If the worker considers the blocked action necessary (or asks for approval/input), the task is parked
in status `needs_approval`. `task_result.handoff.next_action` names the exact request. Do the action
yourself if it needs network or an install, then `workhorse approve <id>` (or `approve_task`), or
`workhorse reject <id>`. See [handoff.md](handoff.md).

## Parked tasks pile up

`workhorse attention` lists tasks that need someone. Parked tasks keep their worktree until they are
answered, closed (`workhorse reject <id>`) or cleaned up (`cleanup_task`). To expire them
automatically, set `retention.parked_days`.

## Builds fail inside the sandbox (Go, npm, pip)

There is no network (Kilo) and no writable HOME cache, so dependencies must be available offline.
Mount a read-only module cache and point the tool at it; see
[configuration.md](configuration.md#toolchains-and-offline-caches). Set writable build caches to a path
under `/tmp/kilo` (a per-task tmpfs), for example `GOCACHE=/tmp/kilo/go-build`.

## "profile '…' cannot run: backend '…' CLI not found"

Install the CLI (OpenCode: re-run the installer with `--with-opencode`) or set
`daemon.json backends.<name>.bin`. `workhorse backends` shows what was detected.

## The config is not writable

That is intended: installed config is root-owned. Use `sudo bash <prefix>/scripts/unlock-config.sh`,
then `lock-config.sh` when you are done. `workhorse add-repo` and `remove-repo` work with `sudo`.

## Resetting

`workhorse stop`, then remove `data_dir/tasks/<id>` or `data_dir/worktrees/...` as needed, or run
`workhorse cleanup-old --days 0 --task-days 0`. A full reinstall keeps the data dir unless you uninstall
with `--purge-data`.
