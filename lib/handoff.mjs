// Handoff records: who must act next on a finished task, what exactly they must do, and how to resume.
// Derived deterministically by the daemon from the verdict and the data it already has (test results,
// integrity checks, blocked tool calls, the worker's ## RESULT block); the model is never asked to
// produce it. The supervisor or a human can update it later (update_handoff / approve_task).
import { head } from "./util.mjs"

export const HANDOFF_STATES = ["done", "needs_fix", "needs_review", "needs_approval", "needs_input", "blocked", "retryable", "closed"]
// Handoff states that park a task (status needs_approval) until a human answers with approve_task.
export const PARK_STATES = new Set(["needs_approval", "needs_input"])
// Handoff states that need nobody's attention.
export const QUIET_STATES = new Set(["done", "closed"])
// Handoff states approve_task accepts.
export const APPROVABLE_STATES = new Set(["needs_approval", "needs_input", "blocked"])
export const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9 _.:@/+-]{0,79}$/

// Worker-reported status from the ## RESULT block, normalized: "needs approval" / "needs-input" /
// "approval_required" / "awaiting approval" -> needs_approval / needs_input; otherwise the first word.
export function normalizeWorkerStatus(s) {
  if (typeof s !== "string") return s
  const v = s.toLowerCase().trim()
  let m
  if ((m = v.match(/^(?:needs?|requires?|awaiting|waiting[\s_-]+for)[\s_-]*(approval|input|human[\s_-]+input|answer|decision)/))) return m[1] === "approval" || m[1] === "decision" ? "needs_approval" : "needs_input"
  if ((m = v.match(/^(approval|input)[\s_-]*(required|needed)/))) return m[1] === "approval" ? "needs_approval" : "needs_input"
  return v.split(/[\s|,]/)[0]
}

// Names/lines of failing tests in test output (unittest, pytest, node:test, go, cargo, jest/mocha-ish).
export function extractFailingTests(output, max = 10) {
  if (!output) return []
  const out = []
  const add = (s) => {
    s = head(String(s).trim(), 200)
    if (s && !out.includes(s) && out.length < max) out.push(s)
  }
  for (const line of String(output).split("\n")) {
    let m
    if ((m = line.match(/^(?:FAIL|ERROR): (\S+ \([^)]+\))/))) add(m[1]) // unittest
    else if ((m = line.match(/^(?:FAILED|ERROR) (\S+::\S+)/))) add(m[1]) // pytest -rf / summary
    else if ((m = line.match(/^\s*not ok \d+ - (.+?)(?:\s+#.*)?$/))) add(m[1]) // node:test / TAP
    else if ((m = line.match(/^\s*--- FAIL: (\S+)/))) add(m[1]) // go
    else if ((m = line.match(/^test (\S+) \.\.\. FAILED/))) add(m[1]) // cargo
    else if ((m = line.match(/^\s*[✕✗×]\s+(.+)$/))) add(m[1]) // jest/vitest
  }
  return out
}

function hasText(s) {
  return typeof s === "string" && s.trim() && !/^(none|n\/a|-)\.?$/i.test(s.trim())
}

const SETUP_ERROR_RE = /missing credentials|cannot run:|is disabled|unknown profile|failed to start the .* worker|worktree is missing|not installed/i

// Build the handoff record for a finished task. `t` is the persisted task (t.result set by finalize).
export function deriveHandoff(t, { by = "daemon", at = new Date().toISOString() } = {}) {
  const r = t.result || {}
  const verdict = r.verdict || null
  const status = t.status
  const tr = r.test_results || {}
  const wr = r.worker_reported || null
  const wStatus = wr?.status || null
  const request = hasText(wr?.needs) ? head(wr.needs.trim(), 500) : null
  const concerns = Array.isArray(r.remaining_concerns) ? r.remaining_concerns : []
  const errors = Array.isArray(r.errors) ? r.errors : []
  const worktreeAlive = !t.worktree_removed && !!(r.worktree_path || t.worktree_path)
  const sessionReusable = worktreeAlive && !!t.session_id
  const failed = []

  // ---- failed checks (facts, most important first) ----
  if (verdict === "integrity_violation" || (r.integrity && (r.integrity.commits_made > 0 || r.integrity.main_clone_unchanged === false))) {
    failed.push({ check: "integrity", commits_made: r.integrity?.commits_made ?? null, main_clone_unchanged: r.integrity?.main_clone_unchanged ?? null, detail: concerns.filter((c) => c.startsWith("INTEGRITY")).join("; ") || "integrity check failed" })
  }
  if (tr.executed && !tr.passed) {
    const failing = Array.isArray(tr.failing_tests) && tr.failing_tests.length ? tr.failing_tests : extractFailingTests(tr.tail)
    failed.push({ check: "tests", command: tr.command, exit_code: tr.exit_code, timed_out: !!tr.timed_out, counts: tr.counts || {}, failing_tests: failing, excerpt: head(String(tr.tail || "").trim().split("\n").slice(-12).join("\n"), 800), log: "task_details kind=test_log" })
  }
  if (status === "timeout" || verdict === "timeout") failed.push({ check: "timeout", detail: errors.find((e) => /timeout/i.test(e)) || "wall-clock timeout reached; the worker was stopped" })
  if (status === "stalled" || verdict === "stalled") failed.push({ check: "stall", detail: errors.find((e) => /stall|no activity/i.test(e)) || "no worker activity; the worker was stopped" })
  if (status === "interrupted" || verdict === "interrupted") failed.push({ check: "interrupted", detail: errors.find((e) => /restart|stopped/i.test(e)) || "the daemon stopped while the worker was running" })
  if (verdict === "worker_error") failed.push({ check: "worker_error", detail: head(errors.slice(-3).join("; ") || "the worker exited with an error", 600) })
  if ((r.activity?.blocked_calls || 0) > 0) {
    failed.push({ check: "blocked_calls", count: r.activity.blocked_calls, examples: (r.blocked_examples || []).slice(0, 5).map((b) => ({ tool: b.tool, input: head(b.input || "", 160), error: head(b.error || "", 160) })), log: "task_details kind=activity" })
  }
  if (wStatus && wStatus !== "done") failed.push({ check: "worker_status", reported: wStatus, ...(request ? { request } : {}) })
  if (!wr && status === "completed" && t.mode !== "review") failed.push({ check: "result_block", detail: "worker did not end with the required ## RESULT block" })
  if (verdict === "no_changes") failed.push({ check: "no_changes", detail: "implement task produced an empty diff" })

  // ---- state, owner, next action, resume tool ----
  let state, owner, next, tool, args
  const id = t.id
  const cont = (instructions, extra = {}) => ({ task_id: id, instructions, ...extra })
  const testsFailing = failed.find((f) => f.check === "tests")
  const firstConcern = concerns.find((c) => !/^(daemon-run tests failed|INTEGRITY|worker reported status|\d+ tool call\(s\) were blocked)/.test(c))
  const blockedEx = (r.blocked_examples || [])[0]
  const blockedDesc = blockedEx ? `${blockedEx.tool} \`${head(String(blockedEx.input || "").replace(/\s+/g, " "), 120)}\`` : null

  if (verdict === "integrity_violation") {
    state = "blocked"
    owner = "human"
    next = `Human must inspect ${t.branch || "the task branch"} before anything else: ${failed[0].detail}. Do not merge. Then either cleanup_task with discard_unmerged_changes=true, or continue_task after fixing the repository state.`
    tool = null
  } else if (status === "needs_approval" || (verdict === "blocked" && PARK_STATES.has(wStatus))) {
    state = wStatus === "needs_input" ? "needs_input" : "needs_approval"
    owner = "human"
    const what = request || firstConcern || (blockedDesc ? `the worker needs ${blockedDesc}, which the sandbox/policy blocked` : "see the worker summary")
    next = state === "needs_input"
      ? `Human must answer the worker: ${what}. Then call approve_task with decision=approve and the answer as instructions (or decision=reject).`
      : `Human must approve or deny: ${what}. Then call approve_task with decision=approve (optionally with instructions) or decision=reject. Approval does not lift sandbox rules: an action the sandbox forbids (network, installs) must be done by the human first.`
    tool = "approve_task"
    args = { task_id: id, decision: "approve", instructions: "<approval note or answer>" }
  } else if (verdict === "blocked") {
    state = "blocked"
    owner = "human"
    const what = request || firstConcern || (blockedDesc ? `blocked action ${blockedDesc}` : "the worker reported status blocked without details (see summary)")
    next = `Human must resolve the blocker: ${what}. Then call approve_task (decision=approve) or continue_task to resume, or approve_task decision=reject to close.`
    tool = "approve_task"
    args = { task_id: id, decision: "approve", instructions: "<what was fixed or decided>" }
  } else if (verdict === "tests_failed") {
    state = "needs_fix"
    owner = "supervisor"
    const names = testsFailing?.failing_tests?.length ? testsFailing.failing_tests.slice(0, 3).join(", ") : null
    const what = names ? `the failing test(s) ${names}` : `the failing tests (\`${tr.command}\` exit ${tr.exit_code}${tr.timed_out ? ", timed out" : ""})`
    next = `Run continue_task with instructions to fix ${what}; see task_details kind=test_log.`
    tool = "continue_task"
    args = cont(`The daemon-run tests failed: \`${tr.command}\` exited ${tr.exit_code}.${names ? ` Failing: ${names}.` : ""} Fix the cause (do not weaken or delete tests), rerun the tests and report.`)
  } else if (verdict === "worker_error") {
    const setup = errors.some((e) => SETUP_ERROR_RE.test(e))
    if (setup) {
      state = "blocked"
      owner = "human"
      next = `Human must fix the setup: ${head(errors.find((e) => SETUP_ERROR_RE.test(e)), 300)}. Then continue_task to retry.`
      tool = "continue_task"
      args = cont("The setup problem was fixed. Continue the task from where you left off.")
    } else {
      state = "retryable"
      owner = "supervisor"
      next = `Run continue_task to retry (worker error: ${head(errors.slice(-1)[0] || "see task_details kind=stderr", 200)}).`
      tool = "continue_task"
      args = cont("The previous run ended with an error. Check `git status` / `git diff`, continue from where you left off and finish with the ## RESULT block.")
    }
  } else if (verdict === "timeout" || verdict === "stalled" || verdict === "interrupted") {
    state = "retryable"
    owner = "supervisor"
    const why = verdict === "timeout" ? "hit the wall-clock timeout" : verdict === "stalled" ? "stalled (no activity)" : "was interrupted by a daemon stop/restart"
    next = `Run continue_task to resume: the worker ${why}${verdict === "timeout" ? "; consider a larger timeout_minutes or a narrower instruction" : ""}.`
    tool = "continue_task"
    args = cont("Resume the task where you left off. Check `git status` / `git diff` for what is already done, finish the remaining work, run the tests and end with the ## RESULT block.", verdict === "timeout" ? { timeout_minutes: Math.min(120, Math.round((t.timeout_min || 30) * 1.5)) } : {})
  } else if (verdict === "cancelled") {
    state = "closed"
    owner = "supervisor"
    next = "Nothing pending (cancelled). continue_task resumes it; cleanup_task removes the worktree when the work is no longer needed."
    tool = null
  } else if (verdict === "no_changes") {
    state = "needs_fix"
    owner = "supervisor"
    next = "Worker made no changes. Read the summary; if work was expected, run continue_task with more specific instructions (files, functions, acceptance criteria); otherwise close with update_handoff state=closed."
    tool = "continue_task"
    args = cont("You made no changes. Implement the task now: <be specific about files and acceptance criteria>.")
  } else if (verdict === "success" || verdict === "success_untested") {
    const partial = wStatus === "partial"
    const noBlock = failed.some((f) => f.check === "result_block")
    if (partial || noBlock) {
      state = "needs_fix"
      owner = "supervisor"
      next = partial
        ? `Worker reported status partial${firstConcern ? ` (${head(firstConcern, 200)})` : ""}. Run continue_task with instructions to finish the remaining work.`
        : "Worker stopped without the ## RESULT block (possibly unfinished). Run continue_task telling it to finish and report, or review the diff and accept."
      tool = "continue_task"
      args = cont(partial ? "Finish the remaining work you reported as partial, rerun the tests and end with the ## RESULT block." : "Finish the task if anything is left, run the tests and end with the ## RESULT block.")
    } else if (verdict === "success_untested") {
      state = "needs_review"
      owner = "supervisor"
      next = `No tests ran (${tr.reason || "no test command"}). Review the diff by hand (task_details kind=diff) before merging ${t.branch}; then cleanup_task.`
      tool = null
    } else if (t.mode === "review") {
      state = "done"
      owner = "supervisor"
      next = "Read the review findings in summary and remaining_concerns; act on them (continue_task on the reviewed task) or accept."
      tool = null
    } else {
      state = "done"
      owner = "supervisor"
      next = `Review the diff (task_details kind=diff) and merge branch ${t.branch}, then cleanup_task.`
      tool = null
    }
  } else {
    state = "needs_review"
    owner = "supervisor"
    next = "Read task_result and decide."
    tool = null
  }

  return {
    state, owner, next_action: head(next, 1000),
    failed_checks: failed,
    resume: {
      task_id: id, tool, args: tool ? args : null, session_reusable: sessionReusable, session_id: t.session_id || null,
      worktree_path: worktreeAlive ? t.worktree_path : null, worktree_exists: worktreeAlive, branch: t.branch || null, base_commit: t.base_commit || null,
    },
    context: {
      verdict, status, summary: head(r.summary || "", 600), worker_status: wStatus, worker_request: request,
      remaining_concerns: concerns.slice(0, 10), diffstat: r.diffstat || null, files_changed: Array.isArray(r.files_changed) ? r.files_changed.length : 0,
      diff_path: r.diff_path || null, diff: "task_details kind=diff", previous_attempts: (t.previous_results || []).length,
    },
    notes: [],
    derived: true,
    updated_at: at, updated_by: by,
  }
}

// Short form for task_status / list_tasks.
export function handoffSummary(h) {
  if (!h) return null
  return { state: h.state, owner: h.owner, next_action: head(h.next_action || "", 300), failed_checks: (h.failed_checks || []).map((f) => f.check), updated_at: h.updated_at, updated_by: h.updated_by }
}
