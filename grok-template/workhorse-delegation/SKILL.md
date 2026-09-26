---
name: workhorse-delegation
description: >-
  Use when a coding task could be delegated to Grok Workhorse (MCP tools such as delegate_task,
  task_status, task_result): deciding whether to delegate, picking a profile, writing the task,
  reviewing and accepting or rejecting the result, and fixing setup gaps.
---
# Delegating to Grok Workhorse (supervisor playbook)

You are the supervisor. A Workhorse worker runs one bounded coding task in an isolated git worktree
and returns a structured result. It never commits, merges or pushes. Planning, review and the final
decision are yours.

## 1. Delegate or not
Delegate bounded, checkable work: a clearly specified function or feature, mechanical refactors,
writing or fixing tests, a focused bug, or code exploration (`mode: "review"`, which edits nothing).
Do it yourself, or ask the user first, when requirements are ambiguous, when the work is architecture
or security design (auth, crypto, secrets), when it is latency-sensitive (tasks take minutes), or when
the repo is not in `list_repos`. Adding a repo is the owner's decision.

## 2. Profile
Call `list_models` once per session. Use `default_profile` unless the user asks for another profile
or a profile's description clearly fits better. Skip profiles with `available: false` and tell the user
their `unavailable_reason`. Don't invent model names.

## 3. Write the task
The worker sees nothing from this conversation, so the task text must stand on its own:
- the goal and acceptance criteria ("tests in tests/test_x.py pass; no public API change")
- where in the code to look, constraints (style, no new dependencies) and what not to touch
- `test_command` only if the repo default is wrong (it must match the allowed patterns in `list_repos`)
- `timeout_minutes` sized to the task (default 30)

Split large work into independent tasks, and never put secrets in the task text.

## 4. Wait
`delegate_task` returns a `task_id` immediately. Check `task_status` every 1-2 minutes, not in a tight
loop. A few minutes with no turns usually means the provider is queueing. The daemon detects stalls
on its own.

## 5. Review (`task_result`, then `task_details` as needed)
- `integrity.commits_made` must be 0 and `main_clone_unchanged` must be true. If not, reject and tell the user.
- Trust the daemon-run `test_results` over the worker's self-reported tests.
- For non-trivial changes, read the diff (`task_details` kind `diff`). Look for scope creep, deleted or
  weakened tests, hard-coded outputs, new dependencies and stray tool files.
- Verdicts: `success`, `tests_failed`, `no_changes`, `success_untested`, `blocked`, `worker_error`,
  `timeout`, `stalled`, `cancelled`, `interrupted`, `integrity_violation`.

## 6. Next step
- **Accept**: tell the user what changed, where it is (`branch`, `worktree_path`, `diff_path`) and the
  test evidence. Commit, push or open a PR only if the user asked.
- **Revise**: `continue_task` with specific feedback (same session and worktree). This also works for
  `interrupted`, `timeout` and `stalled` tasks.
- **Second opinion**: `delegate_task` with `mode: "review"` and `review_task_id`.
- **Stop**: `cancel_task`. Use `cleanup_task` only once the user no longer needs the work (it archives
  the patch and refuses unmerged changes unless told to discard them).

## 7. Setup gaps
When a task fails for environment reasons (missing toolchain or offline cache, a test command that is
not allowlisted, missing credentials), don't hand-write the code as a workaround. Tell the user what is
missing and how to fix it: `workhorse health`, `sudo workhorse add-repo …`, or the read-only cache binds
described in the project's docs/configuration.md. If a worker stops early without a `## RESULT` block,
that is a model quirk: send `continue_task` telling it to finish.
