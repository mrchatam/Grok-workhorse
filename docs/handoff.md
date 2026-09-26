# Handoff records and the approval flow

Every finished task carries a **handoff record**: who must act next, the one exact thing they must do,
which checks failed, and how to resume. A later agent (or a human) can pick the task up from the
record alone, without reading the whole conversation or guessing. The idea came from community
feedback: a supervisor is more useful when it keeps a blocked task as blocked, with the failed check,
the owner and the exact next action.

The daemon derives the record deterministically from the verdict and data it already has (daemon-run
test results, integrity checks, blocked tool calls, the worker's `## RESULT` block). The model is never
asked to write it. When the worker reports `status: blocked`, `needs_approval` or `needs_input` with a
`needs:` line, that request is quoted in the record.

## Where it appears

| Where | What |
|---|---|
| `task_result` | the full record under `handoff` |
| `task_status` | `handoff`: state, owner, next_action (first 300 chars), names of failed checks, updated_at/by |
| `list_tasks` | `handoff`: state, owner, next_action per task; filters `status: "needs_attention"`, `status: "parked"`, `owner` |
| `task.json` | persisted with the task, so it survives daemon restarts |
| audit log | `finished` (with `handoff_state`, `owner`), `parked`, `handoff_updated`, `approval`, `closed` events |

Tasks finished before v0.2.0 have no stored record. For those the daemon derives one when asked.

## Fields

```jsonc
{
  "state": "needs_fix",          // done | needs_fix | needs_review | needs_approval | needs_input | blocked | retryable | closed
  "owner": "supervisor",         // who acts next: "supervisor", "human" or a named owner
  "next_action": "Run continue_task with instructions to fix the failing test(s) adds numbers; see task_details kind=test_log.",
  "failed_checks": [             // facts, most important first
    { "check": "tests", "command": "npm test", "exit_code": 1, "timed_out": false, "counts": { "failed": 1 },
      "failing_tests": ["adds numbers"], "excerpt": "…last lines of the test output…", "log": "task_details kind=test_log" }
  ],
  "resume": {
    "task_id": "wh-20260926-171500-ab12",
    "tool": "continue_task",     // continue_task | approve_task | null (nothing to resume)
    "args": { "task_id": "…", "instructions": "The daemon-run tests failed: …" },   // suggested call
    "session_reusable": true,    // the worktree exists and the agent session can be resumed
    "session_id": "ses_…", "worktree_path": "…/worktrees/demo/wh-…", "worktree_exists": true,
    "branch": "workhorse/wh-…", "base_commit": "…"
  },
  "context": {
    "verdict": "tests_failed", "status": "completed", "summary": "worker summary",
    "worker_status": "done", "worker_request": null, "remaining_concerns": ["…"],
    "diffstat": "2 files changed, 10 insertions(+)", "files_changed": 2, "diff_path": "…/diff.patch",
    "diff": "task_details kind=diff", "previous_attempts": 0
  },
  "notes": [],                   // appended by update_handoff
  "history": [],                 // who changed what (last 20)
  "derived": true,               // false once a supervisor or human has edited it
  "updated_at": "2026-09-26T17:20:00.000Z",
  "updated_by": "daemon"         // daemon | supervisor | human (cli) | the `by` value given
}
```

`failed_checks[].check` is one of `integrity`, `tests`, `timeout`, `stall`, `interrupted`,
`worker_error`, `blocked_calls` (count plus up to five examples), `worker_status` (the worker reported
something other than `done`), `result_block` (no `## RESULT` block) or `no_changes`.

## Verdict to handoff

| Verdict / situation | state | owner | next_action (shape) |
|---|---|---|---|
| `success` | `done` | supervisor | review the diff, merge the branch, cleanup_task |
| `success`, worker reported `partial` or no `## RESULT` block | `needs_fix` | supervisor | continue_task to finish |
| `success_untested` | `needs_review` | supervisor | review the diff by hand (no tests ran: reason) |
| `tests_failed` | `needs_fix` | supervisor | continue_task to fix the named failing tests |
| `no_changes` | `needs_fix` | supervisor | continue_task with more specific instructions, or close |
| `worker_error` | `retryable` | supervisor | continue_task to retry |
| `worker_error` from a setup problem (missing credentials, backend not installed, …) | `blocked` | human | fix the setup, then continue_task |
| `timeout`, `stalled`, `interrupted` | `retryable` | supervisor | continue_task to resume (timeouts suggest a 1.5x `timeout_minutes`) |
| `cancelled` | `closed` | supervisor | nothing pending |
| `blocked` (worker said blocked, no request, no blocked calls) | `blocked` | human | resolve the blocker, then approve_task or continue_task |
| worker asked for approval/input, or blocked with a request or after blocked tool calls | `needs_approval` / `needs_input` | human | approve or deny (or answer) with approve_task |
| `integrity_violation` | `blocked` | human | inspect the branch, do not merge |

## The `needs_approval` status (parked tasks)

A task is **parked** (status `needs_approval`) when the worker finished with

- `status: needs_approval` or `status: needs_input` in its `## RESULT` block, or
- `status: blocked` plus a `needs:` request, or after tool calls the policy or sandbox blocked.

The verdict stays `blocked`, so the existing verdict set is unchanged. A parked task:

- has no worker process. `task_status` reports `terminal: true` (so existing pollers stop) and
  `parked: true`. Its hint points to `approve_task`.
- is not closed. It appears in `list_tasks` with `status: "needs_approval"`, `"parked"`,
  `"needs_attention"` and `"terminal"`.
- keeps its worktree. Retention sweeps skip parked tasks unless `retention.parked_days` (or
  `cleanup_old parked_days` / `workhorse cleanup-old --parked-days N`) is set. When it is set, a task
  parked longer than that (counted from the last handoff update) loses its worktree (the diff is
  archived) and is closed (`updated_by: "retention"`). After that it follows normal retention. A parked
  task record is never purged. `workhorse health` reports `parked_tasks`, `oldest_parked_days` and
  `needs_attention`.
- can be resumed with `continue_task`, answered with `approve_task`, closed with `approve_task
  decision=reject` or `cancel_task`, or cleaned up explicitly with `cleanup_task`. Cleaning up also
  closes it.

`list_tasks` with `status: "needs_attention"` returns parked tasks plus every finished task whose
handoff state is not `done` or `closed` (failed tests, retryable timeouts, blockers, …).

## Updating the handoff

`update_handoff` (MCP) / `workhorse handoff <id> --owner … --next … --note … --state …` (CLI) edits a
finished task's record: `owner`, `next_action`, `state`, and a `note` that is appended with a timestamp and
author. `by` names who is acting (default `supervisor` over MCP, `human (cli)` from the CLI). Each
change goes into `history` and the audit log.

Setting `state` to `needs_approval` or `needs_input` parks a finished task for a human (the owner
becomes `human` unless you pass one), which also protects its worktree from retention. Setting
`state: "closed"` on a parked task closes it exactly like `approve_task decision=reject` without
instructions or `cancel_task`: status `cancelled`, handoff `closed`, worktree kept (other fields in the
same call are applied afterwards). Setting any other state on a parked task unparks it. It goes back
to its previous status, or `completed`.
`workhorse handoff <id>` without options prints the record and past approvals.

## Approving or rejecting

`approve_task` (MCP) / `workhorse approve <id>` and `workhorse reject <id>` (CLI) answer a task that is
parked, or whose handoff state is `needs_approval`, `needs_input` or `blocked`:

- `decision: "approve"` resumes the task through the `continue_task` path: same worktree, and the same
  agent session when the backend matches. The follow-up message starts with `APPROVED by <by>: <the
  worker's request>`, then your `instructions` (for `needs_input`, the answer).
- `decision: "reject"` with `instructions` resumes the task with `DENIED by <by>: … Do not do that.`
  followed by your instructions.
- `decision: "reject"` without instructions closes the task: status `cancelled`, verdict unchanged,
  handoff state `closed`. The worktree is kept (`continue_task` still works, and `cleanup_task` removes it).

Every decision is stored in `task.approvals` and in the `previous_results` entry of the run it
answered, and is logged as an `approval` event.

**Attribution.** `by` is free text chosen by the caller. Each approval, handoff update and close
also records `source`: `channel` (`mcp` for the MCP shim, `cli` for the operator CLI) and `auth`
(what the daemon actually verified). Both channels use the same daemon socket token, so `channel` is
what the client declares and `auth` is `daemon_token`; treat neither `by` nor `channel` as proof of
who acted.

**Approval does not change the sandbox.** It is a decision passed to the worker, not a permission
grant. The guard and bwrap rules still apply, so a worker still cannot reach the network or install
packages. If the approved action needs that (for example adding a dependency to an offline cache), the
human does it outside the sandbox first and then approves. The `next_action` text says so.

## Supervisor loop (short)

1. After `task_result`, read `handoff.state`, `owner` and `next_action`.
2. If the owner is `supervisor`, do the next action (often the `resume` suggestion). If it is `human`,
   relay `next_action` to the user verbatim and wait for their decision, then call `approve_task`.
3. When you stop working on a task that is not done, record where it stands with `update_handoff`
   (owner, one exact next action, a note) so the next agent can resume it without guessing.
