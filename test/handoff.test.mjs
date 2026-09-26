// Handoff derivation: pure unit tests (no daemon, no backend CLI).
import { test } from "node:test"
import assert from "node:assert/strict"
import { deriveHandoff, extractFailingTests, normalizeWorkerStatus, handoffSummary, HANDOFF_STATES } from "../lib/handoff.mjs"
import { parseResultBlock } from "../lib/tasks.mjs"

const ID = "wh-20260926-120000-ab12"
function task(result = {}, extra = {}) {
  const base = {
    id: ID, mode: "implement", status: "completed", branch: `workhorse/${ID}`, worktree_path: `/data/worktrees/r/${ID}`, worktree_removed: false,
    session_id: "ses_1", base_commit: "abc123", timeout_min: 30, previous_results: [],
    ...extra,
  }
  base.result = {
    verdict: "success", status: base.status, summary: "did it", worker_reported: { status: "done" }, files_changed: [{ path: "a.py" }], diffstat: "1 file changed",
    diff_path: `/data/tasks/${ID}/diff.patch`, worktree_path: base.worktree_path, test_results: { executed: true, passed: true, command: "pytest", exit_code: 0 },
    errors: [], remaining_concerns: [], integrity: { commits_made: 0, main_clone_unchanged: true }, activity: { blocked_calls: 0 }, blocked_examples: [],
    ...result,
  }
  return base
}
const checks = (h) => h.failed_checks.map((c) => c.check)

test("parseResultBlock reads needs and normalizes approval statuses", () => {
  const r = parseResultBlock("x\n## RESULT\nstatus: needs approval\nsummary: stuck\nfiles_changed: none\ntests: none\nconcerns: none\nneeds: approve adding left-pad to package.json")
  assert.equal(r.status, "needs_approval")
  assert.equal(r.needs, "approve adding left-pad to package.json")
  assert.equal(parseResultBlock("## RESULT\nstatus: needs_input").status, "needs_input")
  assert.equal(parseResultBlock("## RESULT\nstatus: blocked | partial").status, "blocked")
  for (const [a, b] of [["Needs-Approval", "needs_approval"], ["approval required", "needs_approval"], ["awaiting input", "needs_input"], ["needs human input", "needs_input"], ["done.", "done."], ["partial, mostly", "partial"]]) assert.equal(normalizeWorkerStatus(a), b, a)
})

test("extractFailingTests understands common runners", () => {
  const out = [
    "FAIL: test_divide (tests.test_core.TestCore.test_divide)", "ERROR: test_mul (tests.test_core.TestCore)",
    "FAILED tests/test_x.py::test_y - AssertionError", "not ok 3 - adds numbers", "--- FAIL: TestParse (0.00s)", "test parser::works ... FAILED", "  ✕ renders header (5 ms)",
  ].join("\n")
  assert.deepEqual(extractFailingTests(out), ["test_divide (tests.test_core.TestCore.test_divide)", "test_mul (tests.test_core.TestCore)", "tests/test_x.py::test_y", "adds numbers", "TestParse", "parser::works", "renders header (5 ms)"])
  assert.deepEqual(extractFailingTests(""), [])
  assert.equal(extractFailingTests(Array.from({ length: 30 }, (_, i) => `not ok ${i} - t${i}`).join("\n")).length, 10)
})

test("success -> done, owner supervisor, merge next action, resume facts", () => {
  const h = deriveHandoff(task(), { at: "2026-09-26T12:00:00.000Z" })
  assert.equal(h.state, "done")
  assert.equal(h.owner, "supervisor")
  assert.match(h.next_action, /merge branch workhorse\/wh-/)
  assert.deepEqual(h.failed_checks, [])
  assert.equal(h.resume.task_id, ID)
  assert.equal(h.resume.tool, null)
  assert.equal(h.resume.session_reusable, true)
  assert.equal(h.resume.worktree_path, `/data/worktrees/r/${ID}`)
  assert.equal(h.resume.branch, `workhorse/${ID}`)
  assert.equal(h.context.summary, "did it")
  assert.equal(h.context.diffstat, "1 file changed")
  assert.equal(h.updated_at, "2026-09-26T12:00:00.000Z")
  assert.equal(h.updated_by, "daemon")
  for (const k of ["state", "failed_checks", "owner", "next_action", "resume", "context", "updated_at", "updated_by"]) assert.ok(k in h, k)
  assert.ok(HANDOFF_STATES.includes(h.state))
})

test("success variants: review mode, partial, missing RESULT block, untested", () => {
  assert.match(deriveHandoff(task({ files_changed: [] }, { mode: "review" })).next_action, /review findings/)
  const partial = deriveHandoff(task({ worker_reported: { status: "partial" }, remaining_concerns: ["divide not done"] }))
  assert.equal(partial.state, "needs_fix")
  assert.equal(partial.resume.tool, "continue_task")
  assert.match(partial.next_action, /partial \(divide not done\)/)
  assert.ok(checks(partial).includes("worker_status"))
  const noBlock = deriveHandoff(task({ worker_reported: null }))
  assert.equal(noBlock.state, "needs_fix")
  assert.ok(checks(noBlock).includes("result_block"))
  const untested = deriveHandoff(task({ verdict: "success_untested", test_results: { executed: false, reason: "no test command configured or detected" } }))
  assert.equal(untested.state, "needs_review")
  assert.match(untested.next_action, /No tests ran \(no test command configured or detected\)/)
})

test("tests_failed -> needs_fix with the failing check, test names and a continue_task suggestion", () => {
  const h = deriveHandoff(task({
    verdict: "tests_failed",
    test_results: { executed: true, passed: false, command: "python3 -m unittest -v", exit_code: 1, timed_out: false, counts: { ran: 5, failures: 1 }, tail: "FAIL: test_divide (tests.test_core.TestCore)\nRan 5 tests\nFAILED (failures=1)" },
    remaining_concerns: ["daemon-run tests failed (exit 1); see task_details kind=test_log"],
  }))
  assert.equal(h.state, "needs_fix")
  assert.equal(h.owner, "supervisor")
  const c = h.failed_checks.find((x) => x.check === "tests")
  assert.equal(c.command, "python3 -m unittest -v")
  assert.equal(c.exit_code, 1)
  assert.deepEqual(c.failing_tests, ["test_divide (tests.test_core.TestCore)"])
  assert.match(c.excerpt, /FAILED \(failures=1\)/)
  assert.match(h.next_action, /^Run continue_task with instructions to fix the failing test\(s\) test_divide/)
  assert.equal(h.resume.tool, "continue_task")
  assert.equal(h.resume.args.task_id, ID)
  assert.match(h.resume.args.instructions, /do not weaken or delete tests/)
  // failing_tests computed by the daemon from the full log win over the tail
  const h2 = deriveHandoff(task({ verdict: "tests_failed", test_results: { executed: true, passed: false, command: "npm test", exit_code: 1, tail: "", failing_tests: ["adds numbers"] } }))
  assert.match(h2.next_action, /adds numbers/)
})

test("no_changes -> needs_fix", () => {
  const h = deriveHandoff(task({ verdict: "no_changes", files_changed: [] }))
  assert.equal(h.state, "needs_fix")
  assert.ok(checks(h).includes("no_changes"))
  assert.equal(h.resume.tool, "continue_task")
})

test("worker_error -> retryable, or blocked on a human for setup problems", () => {
  const r = deriveHandoff(task({ verdict: "worker_error", errors: ["kilo exited with code 1; see task_details kind=stderr"], test_results: { executed: false } }, { status: "failed" }))
  assert.equal(r.state, "retryable")
  assert.equal(r.owner, "supervisor")
  assert.ok(checks(r).includes("worker_error"))
  const s = deriveHandoff(task({ verdict: "worker_error", errors: ["missing credentials: NVIDIA_API_KEY. Not in the workhorse daemon env"], test_results: { executed: false } }, { status: "failed" }))
  assert.equal(s.state, "blocked")
  assert.equal(s.owner, "human")
  assert.match(s.next_action, /^Human must fix the setup: missing credentials/)
})

test("timeout, stalled, interrupted -> retryable with continue_task", () => {
  const t = deriveHandoff(task({ verdict: "timeout", errors: ["wall-clock timeout of 30 min reached"] }, { status: "timeout" }))
  assert.equal(t.state, "retryable")
  assert.deepEqual(checks(t), ["timeout"])
  assert.equal(t.resume.args.timeout_minutes, 45)
  const s = deriveHandoff(task({ verdict: "stalled", errors: ["no activity for 15 min (stalled)"] }, { status: "stalled" }))
  assert.deepEqual(checks(s), ["stall"])
  assert.match(s.next_action, /stalled/)
  const i = deriveHandoff(task({ verdict: "interrupted", test_results: { executed: false } }, { status: "interrupted" }))
  assert.equal(i.state, "retryable")
  assert.ok(checks(i).includes("interrupted"))
  assert.equal(i.resume.session_reusable, true)
})

test("cancelled -> closed", () => {
  const h = deriveHandoff(task({ verdict: "cancelled", test_results: { executed: false } }, { status: "cancelled" }))
  assert.equal(h.state, "closed")
  assert.equal(h.resume.tool, null)
})

test("blocked: parked needs_approval / needs_input use the worker's request; plain blocked goes to a human", () => {
  const blockedEx = [{ tool: "bash", input: "npm install left-pad", error: "workhorse guard blocked: network" }]
  const p = deriveHandoff(task({ verdict: "blocked", worker_reported: { status: "needs_approval", needs: "approve adding left-pad" }, activity: { blocked_calls: 1 }, blocked_examples: blockedEx }, { status: "needs_approval" }))
  assert.equal(p.state, "needs_approval")
  assert.equal(p.owner, "human")
  assert.match(p.next_action, /^Human must approve or deny: approve adding left-pad/)
  assert.equal(p.resume.tool, "approve_task")
  assert.equal(p.context.worker_request, "approve adding left-pad")
  const bc = p.failed_checks.find((c) => c.check === "blocked_calls")
  assert.equal(bc.count, 1)
  assert.equal(bc.examples[0].input, "npm install left-pad")
  const q = deriveHandoff(task({ verdict: "blocked", worker_reported: { status: "needs_input", needs: "which API version?" } }, { status: "needs_approval" }))
  assert.equal(q.state, "needs_input")
  assert.match(q.next_action, /^Human must answer the worker: which API version\?/)
  // parked because of blocked calls, no explicit request: the blocked action is named
  const b = deriveHandoff(task({ verdict: "blocked", worker_reported: { status: "blocked" }, activity: { blocked_calls: 1 }, blocked_examples: blockedEx, remaining_concerns: ["1 tool call(s) were blocked by policy/sandbox (see task_details kind=activity)"] }, { status: "needs_approval" }))
  assert.equal(b.state, "needs_approval")
  assert.match(b.next_action, /bash `npm install left-pad`/)
  const plain = deriveHandoff(task({ verdict: "blocked", worker_reported: { status: "blocked" }, remaining_concerns: ["go toolchain missing"] }))
  assert.equal(plain.state, "blocked")
  assert.equal(plain.owner, "human")
  assert.match(plain.next_action, /go toolchain missing/)
})

test("integrity_violation -> blocked on a human, no resume tool", () => {
  const h = deriveHandoff(task({ verdict: "integrity_violation", integrity: { commits_made: 2, main_clone_unchanged: true }, remaining_concerns: ["INTEGRITY: 2 commit(s) were created on workhorse/x (workers must not commit)"] }))
  assert.equal(h.state, "blocked")
  assert.equal(h.owner, "human")
  assert.equal(h.failed_checks[0].check, "integrity")
  assert.equal(h.failed_checks[0].commits_made, 2)
  assert.match(h.next_action, /Do not merge/)
  assert.equal(h.resume.tool, null)
})

test("removed worktree: session not reusable; summary form", () => {
  const h = deriveHandoff(task({}, { worktree_removed: true }))
  assert.equal(h.resume.session_reusable, false)
  assert.equal(h.resume.worktree_path, null)
  const s = handoffSummary(deriveHandoff(task({ verdict: "tests_failed", test_results: { executed: true, passed: false, command: "x", exit_code: 2 } })))
  assert.deepEqual(Object.keys(s), ["state", "owner", "next_action", "failed_checks", "updated_at", "updated_by"])
  assert.deepEqual(s.failed_checks, ["tests"])
  assert.equal(handoffSummary(null), null)
})
