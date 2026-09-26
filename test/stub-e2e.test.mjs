// End-to-end tests of the real daemon with the TEST-ONLY stub backend (adapters/stub): scheduler, spawn,
// event parsing, daemon-run tests, finalize, handoff, approval, continue, retry/fallback, restart,
// automatic fix/escalation, auto-review, wait_task, delegate_tasks, usage_report, presets/routing,
// require_operator and token savers. Needs only git + python3, so it runs in CI.
import { test, after, before } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { setupStubEnv, stest, startDaemon, sleep, REPO_NAME, STUB_TEST_CMD, stubMessages, editJson, STUB_SKIP } from "./helpers.mjs"

const env = await setupStubEnv("e2e")
let rpc
let daemon
const DAEMON_ENV = { WH_ENABLE_STUB_BACKEND: "1" }

before(async () => {
  if (!env) return
  ;({ rpc } = await import("../lib/client.mjs"))
  daemon = await startDaemon(env, DAEMON_ENV)
})
after(async () => {
  if (daemon) try { process.kill(-daemon.pid, "SIGTERM") } catch {}
  await sleep(300)
})

const task = (scenario, extra = "") => `MOCK_SCENARIO=${scenario} Implement multiply and divide in calc/core.py. ${extra}`
const delegate = (p) => rpc("delegate_task", { repo: REPO_NAME, test_command: STUB_TEST_CMD, ...p })
async function waitDone(id, view = "brief", maxMs = 60000) {
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs) {
    const w = await rpc("wait_task", { task_id: id, max_wait_s: 20, view })
    if (w.done) return w.task
  }
  throw new Error(`task ${id} did not finish`)
}
const cfgFile = (f) => path.join(env.cfgDir, f)

stest("happy path: wait_task long-poll returns a compact brief result", async () => {
  const d = await delegate({ task: task("happy") })
  assert.equal(d.profile, "cheap")
  assert.match(d.next_step, /wait_task/)
  const r = await waitDone(d.task_id)
  assert.equal(r.verdict, "success")
  assert.equal(r.status, "completed")
  assert.equal(r.tests.passed, true)
  assert.deepEqual(r.files, ["calc/core.py"])
  assert.equal(r.next.state, "done")
  assert.equal(r.usage.tokens, 13200)
  assert.ok(JSON.stringify(r).length < 1500, `brief result is ${JSON.stringify(r).length} chars`)
  const full = await rpc("task_result", { task_id: d.task_id })
  assert.equal(full.verdict, "success")
  assert.equal(full.handoff.context.summary, undefined, "handoff context no longer repeats top-level fields")
  assert.ok(JSON.stringify(full).length > JSON.stringify(r).length * 2)
  const brief = await rpc("task_result", { task_id: d.task_id, view: "brief" })
  assert.deepEqual(brief, r)
  await assert.rejects(rpc("task_result", { task_id: d.task_id, view: "huge" }), /view must be/)
})

stest("health_report flags a daemon that runs with the test-only stub backend", async () => {
  const h = await rpc("health_report", {})
  assert.equal(h.test_stub_backend_enabled, true)
  const { healthChecks } = await import("../lib/admin.mjs")
  const c = healthChecks(h, null).find((x) => x.name === "stub_backend")
  assert.equal(c?.status, "warn")
})

stest("wait_task returns done=false with progress when the timeout passes first", async () => {
  const d = await delegate({ task: task("slow") })
  const w = await rpc("wait_task", { task_id: d.task_id, max_wait_s: 1 })
  assert.equal(w.done, false)
  assert.match(w.hint, /again/)
  assert.ok(["queued", "running"].includes(w.task.status))
  assert.ok(w.waited_s >= 0.9 && w.waited_s < 5, `waited ${w.waited_s}`)
  await assert.rejects(rpc("wait_task", { task_id: d.task_id, task_ids: [d.task_id] }), /not both/)
  await rpc("cancel_task", { task_id: d.task_id })
  const r = await waitDone(d.task_id)
  assert.equal(r.verdict, "cancelled")
})

stest("presets and size routing pick the profile; explicit profile wins", async () => {
  const a = await delegate({ task: "no scenario", preset: "quick-fix" })
  assert.equal(a.profile, "cheap")
  assert.equal(a.preset, "quick-fix")
  const b = await delegate({ task: "no scenario", size: "large" })
  assert.equal(b.profile, "strong")
  assert.equal(b.routed_by_size, "large")
  const c = await delegate({ task: "no scenario", size: "large", profile: "mid" })
  assert.equal(c.profile, "mid")
  await assert.rejects(delegate({ task: "x", preset: "nope" }), /unknown preset/)
  await assert.rejects(delegate({ task: "x", size: "huge" }), /size must be/)
  const w = await rpc("wait_task", { task_ids: [a.task_id, b.task_id, c.task_id], mode: "all", max_wait_s: 30 })
  assert.equal(w.done, true)
  assert.equal(w.settled, 3)
  assert.match(stubMessages(env, a.task_id)[0].message, /Standing instructions \(preset quick-fix\):\nKeep the diff minimal\./)
  const lm = await rpc("list_models")
  assert.deepEqual(lm.routing, { small: "cheap", medium: "mid", large: "strong" })
  assert.equal(lm.presets[0].name, "quick-fix")
})

stest("delegate_tasks: partial success, then wait_task any/all over many ids", async () => {
  const r = await rpc("delegate_tasks", { defaults: { repo: REPO_NAME, test_command: STUB_TEST_CMD }, tasks: [{ task: task("happy") }, { task: task("happy") }, { task: "x", repo: "nope" }] })
  assert.equal(r.created, 2)
  assert.equal(r.failed, 1)
  assert.equal(r.results[2].ok, false)
  assert.match(r.results[2].error, /allowlist/)
  const any = await rpc("wait_task", { task_ids: r.task_ids, mode: "any", max_wait_s: 30 })
  assert.equal(any.done, true)
  assert.ok(any.settled >= 1)
  const all = await rpc("wait_task", { task_ids: r.task_ids, mode: "all", max_wait_s: 30 })
  assert.equal(all.done, true)
  assert.deepEqual(all.tasks.map((t) => t.verdict), ["success", "success"])
  await assert.rejects(rpc("delegate_tasks", { tasks: [] }), /1\.\.10/)
})

stest("approval: parked task resumes in the same session after approve_task", async () => {
  const d = await delegate({ task: task("approval") })
  const p = await waitDone(d.task_id)
  assert.equal(p.status, "needs_approval")
  assert.equal(p.next.state, "needs_approval")
  assert.equal(p.next.tool, "approve_task")
  await rpc("approve_task", { task_id: d.task_id, decision: "approve", instructions: "Approved, go ahead." })
  const r = await waitDone(d.task_id)
  assert.equal(r.verdict, "success")
  const msgs = stubMessages(env, d.task_id)
  assert.equal(msgs.length, 2)
  assert.match(msgs[1].message, /APPROVED by supervisor/)
  assert.equal(msgs[1].session, msgs[0].session, "same session resumed")
})

stest("continue_task after a partial result", async () => {
  const d = await delegate({ task: task("partial") })
  const p = await waitDone(d.task_id)
  assert.equal(p.next.state, "needs_fix")
  await rpc("continue_task", { task_id: d.task_id, instructions: "Finish divide." })
  const r = await waitDone(d.task_id)
  assert.equal(r.verdict, "success")
})

stest("retry after a rate limit, and fallback to another profile", async () => {
  const a = await delegate({ task: task("retry") })
  const ra = await rpc("task_result", { task_id: (await waitDone(a.task_id)).task_id })
  assert.equal(ra.verdict, "success")
  assert.equal(ra.activity.retries, 1)
  const b = await delegate({ task: task("fallback"), profile: "flaky" })
  const rb = await rpc("task_result", { task_id: (await waitDone(b.task_id)).task_id })
  assert.equal(rb.verdict, "success")
  assert.equal(rb.activity.fallback_used, true)
  assert.equal(rb.profile, "cheap")
})

stest("auto_fix_rounds: a failing test run is fixed automatically in the same session", async () => {
  const d = await delegate({ task: task("fixloop"), auto_fix_rounds: 1 })
  assert.equal(d.auto.fix_rounds, 1)
  const r = await waitDone(d.task_id)
  assert.equal(r.verdict, "success")
  assert.deepEqual(r.auto.trail, ["cheap:tests_failed->auto_fix", "cheap:success"])
  assert.equal(r.auto.runs, 1)
  const msgs = stubMessages(env, d.task_id)
  assert.match(msgs[1].message, /Automatic follow-up from the workhorse daemon/)
  assert.match(msgs[1].message, /test_multiply/)
  assert.equal(msgs[1].session, msgs[0].session)
  await assert.rejects(delegate({ task: "x", auto_fix_rounds: 9 }), /auto_fix_rounds must be/)
})

stest("escalation chain cheap -> mid -> strong, with a fresh session and a trail", async () => {
  const d = await delegate({ task: task("escalate"), escalate: true })
  const r = await waitDone(d.task_id)
  assert.equal(r.verdict, "success")
  assert.equal(r.profile, "strong")
  assert.deepEqual(r.auto.trail, ["cheap:tests_failed->escalate", "mid:tests_failed->escalate", "strong:success"])
  const msgs = stubMessages(env, d.task_id)
  assert.equal(msgs.length, 3)
  assert.match(msgs[1].message, /ESCALATION for task .*profile cheap/)
  assert.notEqual(msgs[1].session, msgs[0].session, "escalation starts a fresh session")
  const full = await rpc("task_result", { task_id: d.task_id })
  assert.equal(full.auto.trail[0].tokens, 8600)
  const expected = (8000 * 0.1 + 600 * 0.4 + 8000 * 0.5 + 600 * 2 + 20000 * 3 + 1500 * 15) / 1e6
  assert.ok(Math.abs(full.usage.estimated_list_cost_usd - expected) < 1e-9, `cost ${full.usage.estimated_list_cost_usd} vs ${expected}`)
})

stest("escalation stops at the max_auto_runs cap and says so in the handoff", async () => {
  editJson(cfgFile("profiles.json"), (j) => { j.auto = { max_auto_runs: 1 } })
  try {
    const d = await delegate({ task: task("escalate"), escalate: true })
    const r = await waitDone(d.task_id)
    assert.equal(r.verdict, "tests_failed")
    assert.equal(r.profile, "mid")
    assert.equal(r.auto.stopped, "max_auto_runs")
    assert.match(r.next.action, /Automatic follow-ups already ran 1x .*stopped: max_auto_runs/)
  } finally {
    editJson(cfgFile("profiles.json"), (j) => { delete j.auto })
  }
})

stest("auto_review: a cheap advisory review is attached to the result", async () => {
  const d = await delegate({ task: task("review"), auto_review: "reviewer" })
  const r = await waitDone(d.task_id)
  assert.equal(r.verdict, "success")
  assert.equal(r.review.verdict, "request_changes")
  assert.equal(r.review.profile, "reviewer")
  assert.equal(r.review.advisory, true)
  assert.match(r.review.findings[0], /docstring/)
  assert.equal(r.next.state, "needs_review")
  assert.equal(r.next.tool, "continue_task")
  const child = await rpc("task_result", { task_id: r.review.task_id })
  assert.equal(child.mode, "review")
  const list = await rpc("list_tasks", { limit: 200 })
  assert.ok(list.tasks.some((t) => t.task_id === r.review.task_id))
})

stest("require_operator: the supervisor's approve only records a request; the operator token confirms", async () => {
  const tok = crypto.randomBytes(32).toString("hex")
  editJson(cfgFile("daemon.json"), (j) => { j.approvals = { require_operator: true, operator_token_sha256: crypto.createHash("sha256").update(tok).digest("hex") } })
  try {
    const d = await delegate({ task: task("approval") })
    await waitDone(d.task_id)
    const req = await rpc("approve_task", { task_id: d.task_id, decision: "approve", instructions: "ok from supervisor" })
    assert.equal(req.approval_requested, true)
    assert.equal((await rpc("task_status", { task_id: d.task_id })).status, "needs_approval")
    await assert.rejects(rpc("continue_task", { task_id: d.task_id, instructions: "do it anyway" }), /require_operator/)
    await assert.rejects(rpc("update_handoff", { task_id: d.task_id, state: "done" }), /only the operator/)
    await assert.rejects(rpc("approve_task", { task_id: d.task_id, decision: "approve", operator_token: "0".repeat(64) }), /operator token rejected/)
    const brief = await rpc("task_result", { task_id: d.task_id, view: "brief" })
    assert.equal(brief.approval_request.waiting_for, "operator")
    assert.match(brief.next.action, /sudo workhorse approve/)
    const ok = await rpc("approve_task", { task_id: d.task_id, decision: "approve", operator_token: tok }, { caller: { client: "workhorse" } })
    assert.match(ok.approval.by, /^operator \(requested by supervisor\)/)
    const r = await waitDone(d.task_id)
    assert.equal(r.verdict, "success")
    assert.match(stubMessages(env, d.task_id)[1].message, /ok from supervisor/, "the recorded instructions are used")
    const audit = fs.readFileSync(path.join(env.dataDir, "logs/audit.jsonl"), "utf8")
    assert.ok(!audit.includes(tok), "the operator token never reaches the audit log")
  } finally {
    editJson(cfgFile("daemon.json"), (j) => { delete j.approvals })
  }
})

stest("per-profile stall_minutes stops a silent worker early", async () => {
  const d = await delegate({ task: task("slow"), profile: "sleepy" })
  const r = await waitDone(d.task_id, "brief", 30000)
  assert.equal(r.verdict, "stalled")
  assert.equal(r.next.state, "retryable")
})

stest("token savers: prompt fragments go into the first message of a fresh session only", async () => {
  editJson(cfgFile("daemon.json"), (j) => { j.token_savers = { terse: "lite", minimal_code: "lite" } })
  try {
    const d = await delegate({ task: task("partial") })
    await waitDone(d.task_id)
    await rpc("continue_task", { task_id: d.task_id, instructions: "Finish divide." })
    const r = await waitDone(d.task_id, "full")
    assert.deepEqual(r.token_savers, { terse: "lite", minimal_code: "lite", rtk: false })
    const msgs = stubMessages(env, d.task_id)
    assert.match(msgs[0].message, /Output style \(token saver\)/)
    assert.match(msgs[0].message, /Code style \(token saver\)/)
    assert.doesNotMatch(msgs[1].message, /token saver/)
  } finally {
    editJson(cfgFile("daemon.json"), (j) => { delete j.token_savers })
  }
})

stest("usage_report: tokens by profile/day and a labelled supervisor ESTIMATE", async () => {
  const u = await rpc("usage_report", {})
  const by = Object.fromEntries(u.by_profile.map((p) => [p.profile, p]))
  assert.ok(by.cheap.tokens.input > 0)
  assert.ok(by.strong.tokens.input >= 20000)
  assert.ok(by.reviewer.tokens.input >= 3000)
  assert.ok(u.by_day.length >= 3)
  const se = u.supervisor_estimate
  assert.equal(se.label, "ESTIMATE")
  assert.ok(se.supervisor_io.calls > 10)
  assert.ok(se.worker_work_tokens > 0)
  assert.ok(se.est_supervisor_tokens_avoided > 0)
  assert.match(se.formula, /chars_per_token/)
  const one = await rpc("usage_report", { profile: "strong", days: 1 })
  assert.deepEqual(one.by_profile.map((p) => p.profile).sort(), ["mid", "strong"].filter((x) => one.by_profile.some((p) => p.profile === x)).sort())
})

stest("restart: a killed daemon leaves an interrupted, retryable task that resumes", async () => {
  const d = await delegate({ task: task("slow") })
  for (let i = 0; i < 50 && (await rpc("task_status", { task_id: d.task_id })).status !== "running"; i++) await sleep(100)
  process.kill(-daemon.pid, "SIGKILL")
  await sleep(300)
  daemon = await startDaemon(env, DAEMON_ENV)
  const r = await waitDone(d.task_id)
  assert.equal(r.verdict, "interrupted")
  assert.equal(r.next.state, "retryable")
  assert.equal(r.next.tool, "continue_task")
  await rpc("continue_task", { task_id: d.task_id, instructions: r.next.args.instructions })
  const r2 = await waitDone(d.task_id)
  assert.equal(r2.verdict, "success")
})

stest("restart: a graceful stop (SIGTERM) also leaves a finalized, retryable task", async () => {
  const d = await delegate({ task: task("slow") })
  for (let i = 0; i < 50 && (await rpc("task_status", { task_id: d.task_id })).status !== "running"; i++) await sleep(100)
  process.kill(-daemon.pid, "SIGTERM")
  for (let i = 0; i < 100 && fs.existsSync(path.join(env.dataDir, "run/daemon.sock")); i++) await sleep(100)
  daemon = await startDaemon(env, DAEMON_ENV)
  const r = await waitDone(d.task_id)
  assert.equal(r.verdict, "interrupted")
  assert.equal(r.next.state, "retryable")
})

test("stub backend suite prerequisites", { skip: !STUB_SKIP }, () => {})
