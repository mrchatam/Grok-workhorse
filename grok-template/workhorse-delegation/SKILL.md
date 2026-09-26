---
name: workhorse-delegation
description: >-
  Use when a coding task could be delegated to Grok Workhorse (MCP tools such as delegate_task,
  wait_task, task_result): deciding whether to delegate, picking a preset or profile, writing the
  task, waiting cheaply, reviewing and accepting or rejecting the result, and fixing setup gaps.
---
# Delegating to Grok Workhorse (supervisor playbook)

You are the supervisor. A Workhorse worker runs one bounded coding task in an isolated git worktree
and returns a structured result. It never commits, merges or pushes. Planning, review and the final
decision are yours.

**Why it exists: to save your (supervisor) tokens.** Every tool call you make and every byte you read
costs more than the worker's cheap model. So: delegate bounded work, wait with one `wait_task` call
instead of polling, read the `brief` view, and let the daemon do automatic fix rounds and cheap reviews.

## 1. Delegate or not
Delegate bounded, checkable work: a clearly specified function or feature, mechanical refactors,
writing or fixing tests, a focused bug, or code exploration (`mode: "review"`, which edits nothing).
Do it yourself, or ask the user first, when requirements are ambiguous, when the work is architecture
or security design (auth, crypto, secrets), when it is latency-sensitive (tasks take minutes), or when
the repo is not in `list_repos`. Adding a repo is the owner's decision.

## 2. Preset, size or profile
Call `list_models` once per session. Prefer, in this order:
- a **preset** whose description fits (`preset: "quick-fix"`); presets bundle profile, size, timeout,
  test command, standing instructions and automatic follow-ups chosen by the owner;
- a **size** (`size: "small" | "medium" | "large"`) when `routing` is configured: the daemon picks the
  cheapest profile the owner routed for that size;
- an explicit `profile` only when the user asks for one or its description clearly fits better;
- otherwise `default_profile`.
Skip profiles with `available: false` and tell the user their `unavailable_reason`. Don't invent model
names.

## 3. Write the task
The worker sees nothing from this conversation, so the task text must stand on its own:
- the goal and acceptance criteria ("tests in tests/test_x.py pass; no public API change")
- where in the code to look, constraints (style, no new dependencies) and what not to touch
- `test_command` only if the repo default is wrong (it must match the allowed patterns in `list_repos`)
- `timeout_minutes` sized to the task (default 30)

Split large work into independent tasks, and never put secrets in the task text. Independent tasks
can go in **one `delegate_tasks` call** (up to 10).

**Automatic follow-ups (let the daemon spend cheap tokens instead of yours):**
- `auto_fix_rounds: 1..3`: after failing tests or a missing/partial RESULT block, the daemon sends the
  worker a fix round itself (same session) before reporting back.
- `escalate: true`: if the profile still fails, retry on the next profile of its `escalate_to` chain
  (for example cheap -> mid -> strong). Hard caps on runs, tokens and cost apply; the result carries the
  trail (`auto.trail`, e.g. `cheap:tests_failed->fix`, `cheap:tests_failed->mid`).
- `auto_review: true` (or a profile name): a cheap reviewer reads a successful diff and adds an
  advisory `review` verdict. `request_changes` turns the handoff into `needs_review`; you decide.
Use them when the owner configured them or for well-tested repos; skip them for exploratory work.

## 4. Wait (one call, not a polling loop)
`delegate_task` returns a `task_id` immediately. Then call **`wait_task`** with `task_id` (or
`task_ids` plus `mode: "any" | "all"`). It blocks up to `max_wait_s` (max 55 s, default 45) and returns
as soon as the task is finished or parked, with the brief result included. If `done` is false, call it
again. Don't poll `task_status` in a loop; use it only to look at progress. A few minutes with no turns
usually means the provider is queueing, and the daemon detects stalls on its own. A parked task
(`needs_approval`) also counts as done: it waits for a human decision.

## 5. Review (the brief view first, the full view or `task_details` only when needed)
`wait_task` and `task_result` with `view: "brief"` return about 0.5-1 KB: `verdict`, `summary`,
`files`, `tests`, `concerns`, `next` (state, owner, action and the suggested tool call), `review` and
`auto`. That is enough to accept a green, small change. Ask for `task_result` (full, the default) or
`task_details` only when you need integrity details, the whole handoff, logs or the diff.
- In the full view, `integrity.commits_made` must be 0 and `main_clone_unchanged` must be true. If not, reject and tell the user.
- Trust the daemon-run `test_results` over the worker's self-reported tests.
- For non-trivial changes, read the diff (`task_details` kind `diff`). Look for scope creep, deleted or
  weakened tests, hard-coded outputs, new dependencies and stray tool files.
- Verdicts: `success`, `tests_failed`, `no_changes`, `success_untested`, `blocked`, `worker_error`,
  `timeout`, `stalled`, `cancelled`, `interrupted`, `integrity_violation`.
- **Read `next` (brief) or `handoff` (full) first.** `handoff.state` (done, needs_fix, needs_review, needs_approval, needs_input,
  blocked, retryable, closed), `handoff.owner` (who acts next) and `handoff.next_action` (one exact
  instruction) tell you what to do. `handoff.failed_checks` lists the facts (failing tests with names,
  blocked calls, integrity, timeout or stall). `handoff.resume` has a suggested tool call and says whether
  the session and worktree can be reused. Don't guess past it.

## 6. Next step
- **Accept**: tell the user what changed, where it is (`branch`, `worktree_path`, `diff_path`) and the
  test evidence. Commit, push or open a PR only if the user asked.
- **Revise**: `continue_task` with specific feedback (same session and worktree). This also works for
  `interrupted`, `timeout`, `stalled` and `needs_approval` tasks. `handoff.resume.args` is a good
  starting point.
- **Human approval** (`status: needs_approval`, `handoff.owner: "human"`): relay `handoff.next_action`
  to the user word for word and wait for their answer. Don't approve on their behalf. If the owner
  enabled `approvals.require_operator`, your `approve_task` only records the request; the human then
  confirms it with `workhorse approve <id>` and the operator token. Tell the user that. Then call
  `approve_task` with `decision: "approve"` (put their answer or conditions in `instructions`) or
  `decision: "reject"` (with `instructions` to redirect the worker, or without them to close the task).
  Approval does not lift sandbox rules. If the request needs network or an install, the user must do that
  outside first.
- **Hand off**: when you stop before the task is done (the user must decide, you ran out of time, you
  are waiting on something), call `update_handoff` with the `owner`, one exact `next_action` and a
  `note`, so a later agent or the user can resume without guessing. Use `state: "needs_approval"` or
  `"needs_input"` to park it for a human (this also keeps its worktree from retention cleanup), and
  `state: "closed"` when it needs nobody.
- **Find open work**: `list_tasks` with `status: "needs_attention"` (optionally `owner: "human"`).
- **Second opinion**: `delegate_task` with `mode: "review"` and `review_task_id`.
- **Spend**: `usage_report` (or `workhorse stats` for the owner) shows worker tokens by profile and day
  and an ESTIMATE of supervisor tokens avoided.
- **Stop**: `cancel_task`. Use `cleanup_task` only once the user no longer needs the work (it archives
  the patch and refuses unmerged changes unless told to discard them).

## 7. Setup gaps
When a task fails for environment reasons (missing toolchain or offline cache, a test command that is
not allowlisted, missing credentials), don't hand-write the code as a workaround. Tell the user what is
missing and how to fix it: `workhorse health`, `sudo workhorse add-repo …`, or the read-only cache binds
described in the project's docs/configuration.md. If a worker stops early without a `## RESULT` block,
that is a model quirk: send `continue_task` telling it to finish.
