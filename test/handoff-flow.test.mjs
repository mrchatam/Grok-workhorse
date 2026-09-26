// Handoff + approval flow through the task Manager, without a backend CLI or sandbox: tasks are created
// with delegate(), a worker run is simulated (worktree edits + final message), then finalize() runs the
// real diff/test/verdict/handoff code. Runs in CI.
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const root = fs.mkdtempSync(path.join(os.tmpdir(), "kwt-handoff-"))
const cfgDir = path.join(root, "config")
const dataDir = path.join(root, "data")
const repoPath = path.join(root, "src-repo")
fs.mkdirSync(cfgDir, { recursive: true })
fs.mkdirSync(repoPath, { recursive: true })
fs.writeFileSync(path.join(repoPath, "a.txt"), "one\n")
const g = (...a) => execFileSync("git", ["-C", repoPath, ...a], { stdio: "ignore" })
g("init", "-q", "-b", "main")
g("add", "-A")
g("-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "-qm", "init")
const PASS = "echo '# pass 1'; exit 0"
const FAIL = "echo 'not ok 1 - adds numbers'; echo '# fail 1'; exit 1"
fs.writeFileSync(path.join(cfgDir, "daemon.json"), JSON.stringify({
  test_sandbox: { enabled: false }, worker_sandbox: { enabled: false }, retention: { enabled: false, worktree_days: 7, task_days: 30 },
  timeouts: { default_min: 5, min_min: 0.05, max_min: 30, stall_min: 5, test_min: 1, kill_grace_sec: 1 }, secret_env: [], min_mem_available_mb: 0,
}))
fs.writeFileSync(path.join(cfgDir, "repos.json"), JSON.stringify({ repos: { demo: { path: repoPath, default_base: "main", test_command: PASS, allowed_test_commands: [".*"] } } }))
fs.writeFileSync(path.join(cfgDir, "profiles.json"), fs.readFileSync(path.join(APP, "test/fixtures/profiles.json"), "utf8").replaceAll("__MOCK_PORT__", "9"))
process.env.WH_CONFIG_DIR = cfgDir
process.env.WH_DATA_DIR = dataDir

const { Manager } = await import("../lib/tasks.mjs")
const { dirs } = await import("../lib/config.mjs")

// No worker is ever spawned: scheduling and the backend check are stubbed out.
function manager() {
  const m = new Manager()
  m.schedule = async () => {}
  m.checkBackend = () => {}
  m.load()
  return m
}
let mgr
before(() => {
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true })
  mgr = manager()
})
after(() => fs.rmSync(root, { recursive: true, force: true }))

const RESULT = (status, extra = "") => `Work report.\n\n## RESULT\nstatus: ${status}\nsummary: did some work\nfiles_changed: b.txt\ntests: sh -> ok\nconcerns: none\n${extra}`
// Create a task and simulate a finished worker run.
async function finishedTask({ text, edit = true, test = PASS, blocked = [] } = {}) {
  const d = await mgr.delegate({ repo: "demo", task: "add b.txt", test_command: test })
  const t = mgr.tasks.get(d.task_id)
  t.test_command = test
  if (edit) fs.writeFileSync(path.join(t.worktree_path, "b.txt"), "two\n")
  t.session_id = "ses_test"
  t.session_backend = t.backend
  t.last_text = text
  t.started_at = new Date().toISOString()
  t.runs.push({ n: t.runs.length + 1, kind: "initial", profile: t.profile, backend: t.backend, started_at: t.started_at, finished_at: new Date().toISOString(), exit_code: 0 })
  for (const b of blocked) { t.stats.blocked_calls++; t.blocked.push(b) }
  await mgr.finalize(t, { tests: true, status: "completed" })
  return t
}
const audit = () => fs.readFileSync(path.join(dirs.logs, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))

test("success: done handoff in task_result, status and list_tasks", async () => {
  const t = await finishedTask({ text: RESULT("done") })
  assert.equal(t.status, "completed")
  const r = mgr.result(t.id)
  assert.equal(r.verdict, "success")
  assert.equal(r.handoff.state, "done")
  assert.equal(r.handoff.owner, "supervisor")
  assert.equal(r.handoff.updated_by, "daemon")
  assert.equal(r.handoff.resume.session_reusable, true)
  assert.equal(r.handoff.resume.worktree_path, t.worktree_path)
  const s = mgr.status(t.id)
  assert.equal(s.terminal, true)
  assert.equal(s.parked, false)
  assert.equal(s.handoff.state, "done")
  assert.equal(mgr.list({}).tasks.find((x) => x.task_id === t.id).handoff.state, "done")
  assert.ok(!mgr.list({ status: "needs_attention" }).tasks.some((x) => x.task_id === t.id))
  assert.ok(mgr.list({ status: "completed" }).tasks.some((x) => x.task_id === t.id), "plain status filter still works")
})

test("tests_failed: needs_fix with the failing test, in needs_attention", async () => {
  const t = await finishedTask({ text: RESULT("done"), test: FAIL })
  const r = mgr.result(t.id)
  assert.equal(r.verdict, "tests_failed")
  assert.deepEqual(r.test_results.failing_tests, ["adds numbers"])
  assert.equal(r.handoff.state, "needs_fix")
  assert.match(r.handoff.next_action, /adds numbers/)
  assert.ok(mgr.list({ status: "needs_attention" }).tasks.some((x) => x.task_id === t.id))
  assert.ok(mgr.list({ status: "terminal" }).tasks.some((x) => x.task_id === t.id))
})

test("needs_approval: worker request parks the task; filters, retention and approve", async () => {
  const t = await finishedTask({ text: RESULT("needs_approval", "needs: approve adding dependency left-pad to package.json") })
  assert.equal(t.status, "needs_approval")
  const r = mgr.result(t.id)
  assert.equal(r.status, "needs_approval")
  assert.equal(r.verdict, "blocked", "verdict stays in the existing set")
  assert.equal(r.worker_reported.needs, "approve adding dependency left-pad to package.json")
  assert.equal(r.handoff.state, "needs_approval")
  assert.equal(r.handoff.owner, "human")
  assert.match(r.handoff.next_action, /left-pad/)
  assert.equal(r.handoff.resume.tool, "approve_task")
  const s = mgr.status(t.id)
  assert.equal(s.terminal, true, "pollers stop polling a parked task")
  assert.equal(s.parked, true)
  assert.match(s.hint, /approve_task/)
  for (const f of [{ status: "needs_approval" }, { status: "parked" }, { status: "needs_attention" }, { status: "needs_attention", owner: "human" }, { status: "terminal" }])
    assert.ok(mgr.list(f).tasks.some((x) => x.task_id === t.id), JSON.stringify(f))
  assert.ok(!mgr.list({ status: "active" }).tasks.some((x) => x.task_id === t.id))
  assert.ok(!mgr.list({ owner: "supervisor" }).tasks.some((x) => x.task_id === t.id))
  // retention never removes a parked worktree unless parked_days is set
  const sw = await mgr.sweep({ worktree_days: 0, dry_run: true })
  assert.ok(!sw.worktrees_removed.includes(t.id))
  assert.ok(sw.parked_kept.includes(t.id))
  assert.ok((await mgr.sweep({ worktree_days: 0, parked_days: 0, dry_run: true })).worktrees_removed.includes(t.id))
  await mgr.sweep({ worktree_days: 0, task_days: 0, dry_run: false, trigger: "test" }).catch(() => {})
  assert.ok(fs.existsSync(t.worktree_path), "parked worktree survives a real sweep")
  assert.ok(mgr.tasks.has(t.id))
  const h = mgr.healthReport()
  assert.ok(h.parked_tasks >= 1 && h.needs_attention >= 1)
  // approve resumes via the continue path
  const a = await mgr.approve({ task_id: t.id, decision: "approve", instructions: "Use version 1.3.0.", note: "fine by me", by: "reviewer-1" })
  assert.equal(a.status, "queued")
  assert.equal(a.decision, "approve")
  assert.equal(a.resumes_session, true)
  assert.equal(t.pending_run.kind, "continue")
  assert.match(t.pending_run.message, /APPROVED by reviewer-1: approve adding dependency left-pad/)
  assert.match(t.pending_run.message, /Use version 1\.3\.0\./)
  assert.equal(t.approvals.length, 1)
  assert.equal(t.approvals[0].by, "reviewer-1")
  const prev = t.previous_results.at(-1)
  assert.equal(prev.handoff.state, "needs_approval")
  assert.equal(prev.approval.decision, "approve")
  assert.equal(mgr.status(t.id).handoff, null, "no handoff while active")
  // the follow-up run finishes
  t.last_text = RESULT("done")
  await mgr.finalize(t, { tests: true, status: "completed" })
  assert.equal(t.status, "completed")
  assert.equal(mgr.result(t.id).handoff.state, "done")
  assert.equal(mgr.result(t.id).handoff.context.previous_attempts, 1)
  const ev = audit().filter((l) => l.task_id === t.id).map((l) => l.event)
  for (const e of ["parked", "approval", "continue_queued", "finished"]) assert.ok(ev.includes(e), e)
})

test("blocked with a blocked tool call parks; plain blocked does not", async () => {
  const t = await finishedTask({ text: RESULT("blocked"), edit: false, blocked: [{ tool: "bash", input: "npm install left-pad", error: "workhorse guard blocked: network" }] })
  assert.equal(t.status, "needs_approval")
  assert.match(mgr.result(t.id).handoff.next_action, /npm install left-pad/)
  const p = await finishedTask({ text: RESULT("blocked"), edit: false })
  assert.equal(p.status, "completed")
  assert.equal(mgr.result(p.id).verdict, "blocked")
  assert.equal(mgr.result(p.id).handoff.state, "blocked")
})

test("reject: closes a parked task (worktree kept), or resumes it with instructions", async () => {
  const t = await finishedTask({ text: RESULT("needs_input", "needs: which config format, YAML or TOML?") })
  assert.equal(mgr.result(t.id).handoff.state, "needs_input")
  const r = await mgr.approve({ task_id: t.id, decision: "reject", note: "out of scope" })
  assert.equal(r.status, "cancelled")
  assert.equal(r.handoff.state, "closed")
  assert.equal(r.handoff.updated_by, "supervisor")
  assert.match(r.handoff.next_action, /approval rejected by supervisor: out of scope/)
  assert.equal(mgr.result(t.id).verdict, "blocked")
  assert.equal(mgr.result(t.id).status, "cancelled")
  assert.ok(fs.existsSync(t.worktree_path))
  assert.ok(!mgr.list({ status: "needs_attention" }).tasks.some((x) => x.task_id === t.id))
  await assert.rejects(mgr.approve({ task_id: t.id, decision: "approve" }), /not waiting for approval/)
  // continue_task still works from the closed task
  assert.equal((await mgr.continueTask(t.id, "do it after all")).status, "queued")

  const u = await finishedTask({ text: RESULT("needs_approval", "needs: approve deleting the legacy module") })
  const r2 = await mgr.approve({ task_id: u.id, decision: "reject", instructions: "Keep the legacy module; deprecate it instead." }, { client: "workhorse" })
  assert.equal(r2.status, "queued")
  assert.match(u.pending_run.message, /^DENIED by human \(cli\): approve deleting the legacy module\. Do not do that\./)
  assert.match(u.pending_run.message, /deprecate it instead/)

  const c = await finishedTask({ text: RESULT("needs_approval", "needs: approve X") })
  assert.equal((await mgr.cancel(c.id)).status, "cancelled")
  assert.equal(mgr.result(c.id).handoff.state, "closed")
  const ev = audit().filter((l) => l.task_id === t.id).map((l) => l.event)
  for (const e of ["approval", "closed"]) assert.ok(ev.includes(e), e)
})

test("approve_task validation", async () => {
  const t = await finishedTask({ text: RESULT("done") })
  await assert.rejects(mgr.approve({ task_id: t.id, decision: "approve" }), /not waiting for approval/)
  await assert.rejects(mgr.approve({ task_id: t.id, decision: "maybe" }), /decision must be/)
  await assert.rejects(mgr.approve({ task_id: t.id, decision: "approve", bogus: 1 }), /unknown parameter 'bogus'/)
  await assert.rejects(mgr.approve({ task_id: "wh-bad", decision: "approve" }), /invalid task_id/)
  const q = await mgr.delegate({ repo: "demo", task: "queued only" })
  await assert.rejects(mgr.approve({ task_id: q.task_id, decision: "approve" }), /nothing to approve yet/)
})

test("update_handoff: owner/next_action/note, parking by state, validation", async () => {
  const t = await finishedTask({ text: RESULT("done"), test: FAIL })
  const u = mgr.updateHandoff({ task_id: t.id, owner: "release-bot", next_action: "Fix adds numbers in calc.js, then rerun npm test", note: "flaky on CI too", by: "supervisor-1" })
  assert.equal(u.handoff.owner, "release-bot")
  assert.equal(u.handoff.next_action, "Fix adds numbers in calc.js, then rerun npm test")
  assert.equal(u.handoff.notes[0].note, "flaky on CI too")
  assert.equal(u.handoff.updated_by, "supervisor-1")
  assert.equal(u.handoff.derived, false)
  assert.equal(u.handoff.state, "needs_fix", "state untouched")
  assert.deepEqual(u.handoff.history.at(-1).changed, ["owner", "next_action", "note"])
  assert.ok(mgr.list({ owner: "release-bot" }).tasks.some((x) => x.task_id === t.id))
  // park for a human, then unpark
  const p = mgr.updateHandoff({ task_id: t.id, state: "needs_approval", next_action: "Human must decide whether the flaky test may be skipped" }, { client: "workhorse" })
  assert.equal(p.status, "needs_approval")
  assert.equal(p.handoff.owner, "human")
  assert.equal(p.handoff.updated_by, "human (cli)")
  assert.equal(t.parked_from, "completed")
  const back = mgr.updateHandoff({ task_id: t.id, state: "closed" })
  assert.equal(back.status, "completed")
  assert.equal(back.handoff.state, "closed")
  assert.ok(!mgr.list({ status: "needs_attention" }).tasks.some((x) => x.task_id === t.id))
  // validation
  assert.throws(() => mgr.updateHandoff({ task_id: t.id }), /nothing to update/)
  assert.throws(() => mgr.updateHandoff({ task_id: t.id, state: "whatever" }), /state must be one of/)
  assert.throws(() => mgr.updateHandoff({ task_id: t.id, owner: "x\ny" }), /owner must be/)
  assert.throws(() => mgr.updateHandoff({ task_id: t.id, note: "   " }), /note must be/)
  assert.throws(() => mgr.updateHandoff({ task_id: t.id, note: "ok", by: "$(id)" }), /by must be/)
  assert.throws(() => mgr.updateHandoff({ task_id: t.id, owner: "a", extra: 1 }), /unknown parameter 'extra'/)
  const q = await mgr.delegate({ repo: "demo", task: "still queued" })
  assert.throws(() => mgr.updateHandoff({ task_id: q.task_id, owner: "human" }), /once the task has finished/)
  assert.ok(audit().some((l) => l.task_id === t.id && l.event === "handoff_updated" && l.by === "supervisor-1"))
})

test("persistence across restart, and tasks from v0.1.0 without a handoff", async () => {
  const parked = await finishedTask({ text: RESULT("needs_approval", "needs: approve raising the timeout") })
  const edited = await finishedTask({ text: RESULT("done") })
  mgr.updateHandoff({ task_id: edited.id, owner: "human", note: "check the wording" })
  const legacy = await finishedTask({ text: RESULT("done"), test: FAIL })
  const file = path.join(dirs.tasks, legacy.id, "task.json")
  const j = JSON.parse(fs.readFileSync(file, "utf8"))
  delete j.handoff
  delete j.result.test_results.failing_tests
  fs.writeFileSync(file, JSON.stringify(j))
  const before = { p: mgr.result(parked.id).handoff, e: mgr.result(edited.id).handoff }

  const m2 = manager() // a restarted daemon reads task.json files
  assert.equal(m2.status(parked.id).status, "needs_approval")
  assert.deepEqual(m2.result(parked.id).handoff, before.p)
  assert.deepEqual(m2.result(edited.id).handoff, before.e)
  assert.equal(m2.result(edited.id).handoff.notes[0].note, "check the wording")
  const lh = m2.result(legacy.id).handoff
  assert.equal(lh.state, "needs_fix", "derived on the fly for old tasks")
  assert.match(lh.next_action, /adds numbers/)
  assert.ok(m2.list({ status: "parked" }).tasks.some((x) => x.task_id === parked.id))
  await m2.recover() // restart recovery leaves parked tasks alone
  assert.equal(m2.tasks.get(parked.id).status, "needs_approval")
  m2.schedule = async () => {}
  const a = await m2.approve({ task_id: parked.id, decision: "approve" })
  assert.equal(a.status, "queued")
  assert.match(m2.tasks.get(parked.id).pending_run.message, /approve raising the timeout/)
  // cleanup removes the worktree; the handoff's resume facts follow
  const done = await finishedTask({ text: RESULT("done") })
  await mgr.cleanup(done.id, true)
  assert.equal(mgr.result(done.id).handoff.resume.worktree_exists, false)
  assert.equal(mgr.result(done.id).handoff.resume.session_reusable, false)
  assert.throws(() => mgr.updateHandoff({ task_id: done.id, state: "needs_approval" }), /cannot be parked/)
})

test("removing a parked task's worktree closes it (cleanup_task, or retention with parked_days)", async () => {
  const a = await finishedTask({ text: RESULT("needs_approval", "needs: approve A") })
  await mgr.cleanup(a.id, true)
  assert.equal(a.status, "cancelled")
  assert.equal(mgr.result(a.id).handoff.state, "closed")
  assert.match(mgr.result(a.id).handoff.next_action, /worktree is gone; the diff is archived/)
  const b = await finishedTask({ text: RESULT("needs_approval", "needs: approve B") })
  const sw = await mgr.sweep({ worktree_days: 1000, task_days: 1000, parked_days: 0, trigger: "test" })
  assert.ok(sw.worktrees_removed.includes(b.id))
  assert.equal(fs.existsSync(b.worktree_path), false)
  assert.equal(b.status, "cancelled")
  assert.equal(mgr.result(b.id).handoff.updated_by, "retention")
  assert.ok(mgr.tasks.has(b.id), "the closed task record stays (it follows normal retention from now on)")
})

test("a task stopped by a graceful shutdown (interrupted, no result) is finalized on restart", async () => {
  const d = await mgr.delegate({ repo: "demo", task: "interrupted by shutdown", test_command: PASS })
  const t = mgr.tasks.get(d.task_id)
  fs.writeFileSync(path.join(t.worktree_path, "partial.txt"), "half done\n")
  t.session_id = "ses_int"
  t.runs.push({ n: 1, kind: "initial", profile: t.profile, backend: t.backend, started_at: new Date().toISOString(), finished_at: new Date().toISOString(), reason: "shutdown" })
  // what shutdown() / onExit() leave behind: status interrupted, an error, no result
  t.status = "interrupted"
  t.errors.push("workhorse daemon stopped while this task was running. Use continue_task to resume.")
  mgr.save(t)
  assert.equal(mgr.result(t.id).message.includes("No result yet"), true)
  const m2 = manager()
  await m2.recover()
  const r = m2.result(t.id)
  assert.equal(r.status, "interrupted")
  assert.equal(r.verdict, "interrupted")
  assert.deepEqual(r.files_changed.map((f) => f.path), ["partial.txt"])
  assert.equal(r.handoff.state, "retryable")
  assert.equal(r.handoff.resume.tool, "continue_task")
  assert.ok(r.handoff.failed_checks.some((c) => c.check === "interrupted"))
  assert.ok(audit().some((l) => l.task_id === t.id && l.event === "finalize_interrupted_on_restart"))
  const again = manager()
  await again.recover() // idempotent: a finalized interrupted task is left alone
  assert.equal(again.result(t.id).timings.finished_at, r.timings.finished_at)
})

test("cleanup marks the task before its first async step: continue/approve/update are refused meanwhile", async () => {
  const t = await finishedTask({ text: RESULT("needs_approval", "needs: approve Z") })
  const pending = mgr.cleanup(t.id, true) // not awaited: removal is in progress
  await assert.rejects(mgr.continueTask(t.id, "more"), /being cleaned up/)
  await assert.rejects(mgr.approve({ task_id: t.id, decision: "approve" }), /being cleaned up/)
  assert.throws(() => mgr.updateHandoff({ task_id: t.id, note: "x" }), /being cleaned up/)
  await assert.rejects(mgr.cleanup(t.id, true), /being cleaned up/)
  const sw = await mgr.sweep({ worktree_days: 0, parked_days: 0, dry_run: true })
  assert.ok(!sw.worktrees_removed.includes(t.id), "retention skips a task being cleaned up")
  await pending
  assert.equal(t.worktree_removed, true)
  assert.equal(t.status, "cancelled")
  assert.equal(mgr.cleaning.size, 0)
  await assert.rejects(mgr.continueTask(t.id, "more"), /cleaned up; delegate a new task/)
  // same guard during retention's worktree removal
  const u = await finishedTask({ text: RESULT("done") })
  const p2 = mgr.removeTaskWorktree(u, "test")
  await assert.rejects(mgr.continueTask(u.id, "more"), /being cleaned up/)
  await p2
  assert.equal(mgr.cleaning.size, 0)
})
