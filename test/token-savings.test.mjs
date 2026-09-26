// Unit tests for the v0.3.0 token-saving pieces: brief/compact views, usage estimate, token savers
// (prompt fragments, RTK rewrite in the guard plugin), operator tokens, audit rotation, presets/auto
// config, review verdicts and the test-only stub backend gate.
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { spawnSync } from "node:child_process"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kwt-tokens-"))
const cfgDir = path.join(root, "config")
fs.mkdirSync(cfgDir, { recursive: true })
process.env.WH_CONFIG_DIR = cfgDir
process.env.WH_DATA_DIR = path.join(root, "data")
const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")

const { briefResult } = await import("../lib/views.mjs")
const { usageReport, dayOf } = await import("../lib/usage.mjs")
const { effectiveSavers, saverFragments, rtkBin } = await import("../lib/savers.mjs")
const { checkOperatorToken, hashToken, newOperatorToken } = await import("../lib/operator.mjs")
const { rotateAudit, sanitizeParams } = await import("../lib/audit.mjs")
const { reviewVerdict } = await import("../lib/tasks.mjs")
const { deriveHandoff } = await import("../lib/handoff.mjs")
const C = await import("../lib/config.mjs")
const { WorkhorseGuard } = await import("../adapters/kilo/config/plugin/workhorse-guard.js")

const sampleResult = () => ({
  task_id: "wh-20260926-120000-abcd", status: "completed", verdict: "tests_failed", mode: "implement", profile: "cheap",
  summary: "x".repeat(900), files_changed: Array.from({ length: 25 }, (_, i) => ({ path: `f${i}.js`, status: i === 0 ? "A" : "M", added: 1, deleted: 0 })),
  diffstat: "25 files changed", diff_path: "/data/tasks/x/diff.patch", branch: "workhorse/wh-20260926-120000-abcd",
  test_results: { executed: true, passed: false, command: "npm test", exit_code: 1, counts: { failed: 2 }, failing_tests: ["a", "b", "c", "d", "e", "f"], tail: "..." },
  remaining_concerns: ["c1", "c2", "c3", "c4", "c5", "c6", "c7"], errors: ["boom"],
  usage: { tokens: { input: 1000, output: 100, reasoning: 50, cache_read: 5000, cache_write: 0 }, estimated_list_cost_usd: 0.001 },
})

test("briefResult keeps only decision data, capped", () => {
  const r = sampleResult()
  const h = deriveHandoff({ id: r.task_id, status: "completed", mode: "implement", result: r, branch: r.branch, worktree_path: "/wt", session_id: "s1" })
  const b = briefResult(r, h)
  assert.equal(b.summary.length, 301)
  assert.equal(b.files.length, 21)
  assert.equal(b.files[0], "A f0.js")
  assert.equal(b.files[1], "f1.js")
  assert.match(b.files[20], /5 more/)
  assert.equal(b.tests.passed, false)
  assert.deepEqual(b.tests.failing, ["a", "b", "c", "d", "e"])
  assert.equal(b.concerns.length, 5)
  assert.equal(b.next.state, "needs_fix")
  assert.equal(b.next.tool, "continue_task")
  assert.equal(b.usage.tokens, 1150)
  assert.equal(b.diff_path, undefined)
  assert.ok(JSON.stringify(b).length < JSON.stringify({ ...r, handoff: h }).length / 2)
})

test("usageReport groups by profile/day and computes the labelled estimate", () => {
  const now = Date.parse("2026-09-26T12:00:00Z")
  const tasks = [
    { id: "a", created_at: "2026-09-26T10:00:00Z", profile: "cheap", repo: "r", status: "completed", result: { verdict: "success", profile: "strong" }, supervisor_io: { calls: 3, request_chars: 400, response_chars: 1600 },
      runs: [{ profile: "cheap", started_at: "2026-09-26T10:00:01Z", tokens: { input: 10000, output: 1000, reasoning: 0, cache_read: 50000, cache_write: 0 }, cost: 0 },
             { profile: "strong", started_at: "2026-09-26T10:05:00Z", tokens: { input: 20000, output: 2000, reasoning: 1000, cache_read: 0, cache_write: 0 }, cost: 0 }], stats: {} },
    { id: "b", created_at: "2026-09-25T10:00:00Z", profile: "cheap", repo: "r", status: "failed", result: { verdict: "worker_error" }, supervisor_io: { calls: 2, request_chars: 200, response_chars: 200 },
      runs: [{ profile: "cheap", started_at: "2026-09-25T10:00:00Z" }], stats: { tokens: { input: 500, output: 50, reasoning: 0, cache_read: 0, cache_write: 0 }, reported_cost: 0.01 } },
    { id: "old", created_at: "2026-01-01T00:00:00Z", profile: "cheap", repo: "r", status: "completed", result: { verdict: "success" }, runs: [], stats: { tokens: { input: 9e9 } } },
  ]
  const profiles = { cheap: { price_per_mtok: { input: 0.1, output: 0.4 } }, strong: { price_per_mtok: { input: 3, output: 15 } } }
  const u = usageReport(tasks, { days: 7, profiles, supervisor: { price_per_mtok: { input: 3, output: 15 } }, nowMs: now })
  assert.equal(u.tasks, 2)
  const by = Object.fromEntries(u.by_profile.map((p) => [p.profile, p]))
  assert.equal(by.cheap.tokens.input, 10500)
  assert.equal(by.cheap.runs, 2)
  assert.deepEqual(by.cheap.verdicts, { worker_error: 1 })
  assert.deepEqual(by.strong.verdicts, { success: 1 })
  assert.equal(u.by_day.length, 3)
  assert.equal(u.by_day[0].day, dayOf("2026-09-26T10:00:01Z"))
  const se = u.supervisor_estimate
  assert.equal(se.label, "ESTIMATE")
  assert.equal(se.successful_tasks, 1)
  // conservative: only the successful workers' output+reasoning tokens count; input is not counted
  assert.equal(se.worker_output_tokens, 1000 + 2000 + 1000)
  assert.equal(se.worker_input_tokens_not_counted, 10000 + 20000)
  assert.equal(se.supervisor_io.est_tokens, (400 + 1600 + 200 + 200) / 4)
  assert.equal(se.est_supervisor_tokens_avoided, 4000 - 600)
  const workerCost = ((10000 + 50000) * 0.1 + 1000 * 0.4) / 1e6 + (20000 * 3 + 3000 * 15) / 1e6 + (500 * 0.1 + 50 * 0.4) / 1e6
  const net = (4000 * 15 - 450 * 3 - 150 * 15) / 1e6 - workerCost
  assert.ok(Math.abs(se.est_net_usd - Math.round(net * 1e4) / 1e4) < 1e-9)
})

test("token savers: off by default, profile overrides daemon, fragments per mode", () => {
  assert.deepEqual(effectiveSavers({}), { terse: "off", minimal_code: "off", rtk: { enabled: false, bin: null } })
  const s = effectiveSavers({ token_savers: { terse: "full", minimal_code: true, rtk: true } }, { token_savers: { terse: "lite", rtk: { enabled: false } } })
  assert.deepEqual(s, { terse: "lite", minimal_code: "lite", rtk: { enabled: false, bin: null } })
  assert.equal(saverFragments(effectiveSavers({})), "")
  const f = saverFragments(s)
  assert.match(f, /Output style \(token saver\)/)
  assert.match(f, /Code style \(token saver\)/)
  assert.match(f, /RESULT block keeps its exact format/)
  assert.match(f, /Never drop input validation/)
  const rv = saverFragments(s, "review")
  assert.match(rv, /Output style/)
  assert.doesNotMatch(rv, /Code style/)
  assert.equal(rtkBin({ rtk: { enabled: true, bin: "/nonexistent/rtk" } }), null)
  assert.equal(rtkBin({ rtk: { enabled: false, bin: "/bin/sh" } }), null)
  assert.equal(rtkBin({ rtk: { enabled: true, bin: "/bin/sh" } }), "/bin/sh")
})

test("guard plugin rewrites bash commands through rtk only when WH_RTK_BIN is set, re-checks them, and falls back to the original", async () => {
  const fake = path.join(root, "fake-rtk")
  const envOut = path.join(root, "fake-rtk.env")
  // exit 3 + output = rewritten (host decides); "evil" rewrites to something the guard must still block;
  // "envcheck" records the environment the rewrite ran with; "slow" exceeds the timeout.
  fs.writeFileSync(fake, `#!/bin/sh\n[ "$1" = rewrite ] || exit 9\ncase "$2" in\n  "git status") echo "rtk git status"; exit 3;;\n  "ls -la") echo "rtk ls -la"; exit 0;;\n  "evil") echo "curl http://x"; exit 0;;\n  "envcheck") env > "${envOut}"; echo "rtk envcheck"; exit 3;;\n  "slow") sleep 3; echo "rtk slow"; exit 3;;\n  *) exit 1;;\nesac\n`, { mode: 0o755 })
  const run = async (cmd) => {
    const h = await WorkhorseGuard({ directory: "/tmp/wt" })
    const out = { args: { command: cmd } }
    await h["tool.execute.before"]({ tool: "bash" }, out)
    return out.args.command
  }
  delete process.env.WH_RTK_BIN
  assert.equal(await run("git status"), "git status")
  process.env.WH_RTK_BIN = fake
  try {
    assert.equal(await run("git status"), "rtk git status")
    assert.equal(await run("ls -la"), "rtk ls -la")
    assert.equal(await run("python3 -m unittest"), "python3 -m unittest")
    assert.equal(await run("echo a\necho b"), "echo a\necho b", "multi-line commands are left alone")
    assert.equal(await run("evil"), "evil", "a rewrite that fails the re-check falls back to the original command")
    await assert.rejects(run("git push"), /workhorse guard blocked/, "checks run before the rewrite")
    process.env.EXAMPLE_PROVIDER_KEY = "example-secret"
    assert.equal(await run("envcheck"), "rtk envcheck")
    const env = fs.readFileSync(envOut, "utf8")
    assert.ok(!env.includes("example-secret"), "the rewrite runs without secrets")
    assert.match(env, /^RTK_TELEMETRY_DISABLED=1$/m)
    assert.doesNotMatch(env, /^WH_/m)
    const t0 = Date.now()
    assert.equal(await run("slow"), "slow", "a slow rewrite times out and the original runs")
    assert.ok(Date.now() - t0 < 2500)
  } finally {
    delete process.env.WH_RTK_BIN
    delete process.env.EXAMPLE_PROVIDER_KEY
  }
})

test("operator token: sha256 match, constant-time compare, bad input rejected", () => {
  const tok = newOperatorToken()
  assert.match(tok, /^[0-9a-f]{64}$/)
  const cfg = { approvals: { require_operator: true, operator_token_sha256: hashToken(tok) } }
  assert.equal(checkOperatorToken(cfg, tok), true)
  assert.equal(checkOperatorToken(cfg, tok + "\n"), true)
  assert.equal(checkOperatorToken(cfg, "0".repeat(64)), false)
  assert.equal(checkOperatorToken(cfg, undefined), false)
  assert.equal(checkOperatorToken({ approvals: { operator_token_sha256: "short" } }, tok), false)
  assert.equal(sanitizeParams("approve_task", { task_id: "x", operator_token: tok }).operator_token, "[given]")
})

test("audit rotation keeps N files and drops the oldest", () => {
  const f = path.join(root, "audit.jsonl")
  for (let i = 1; i <= 4; i++) {
    fs.writeFileSync(f, `gen${i}\n`.repeat(100))
    assert.equal(rotateAudit({ file: f, maxBytes: 100, keep: 2 }), true)
  }
  assert.equal(fs.existsSync(f), false)
  assert.match(fs.readFileSync(`${f}.1`, "utf8"), /gen4/)
  assert.match(fs.readFileSync(`${f}.2`, "utf8"), /gen3/)
  assert.equal(fs.existsSync(`${f}.3`), false)
  fs.writeFileSync(f, "small\n")
  assert.equal(rotateAudit({ file: f, maxBytes: 100, keep: 2 }), false)
  assert.equal(rotateAudit({ file: f, maxBytes: 0, keep: 2 }), false, "max_mb 0 = never")
})

test("presets, routing, auto and escalate_to are validated; auto caps are hard", () => {
  fs.writeFileSync(path.join(cfgDir, "profiles.json"), JSON.stringify({
    providers: { p: { base_url: "http://127.0.0.1:1/v1", models: { m: {} } } },
    profiles: { a: { model: "p/m", escalate_to: "b", stall_minutes: 2 }, b: { model: "p/m", escalate_to: "b" }, c: { model: "p/m", token_savers: { terse: "loud" } } },
    presets: { x: { profile: "zzz", size: "tiny", bogus: 1 }, ok: { profile: "a", size: "small" } },
    routing: { small: "a", large: "nope" },
    auto: { fix_rounds: 99, max_auto_runs: 50, escalate: true, fix_on: ["tests_failed", "bogus"], review: { enabled: true, profile: "ghost" } },
  }))
  const pc = C.profilesConfig()
  assert.equal(pc.auto.fix_rounds, C.AUTO_HARD.fix_rounds)
  assert.equal(pc.auto.max_auto_runs, C.AUTO_HARD.max_auto_runs)
  assert.deepEqual(pc.auto.fix_on, ["tests_failed"])
  assert.deepEqual(pc.routing, { small: "a", large: "nope" })
  const probs = C.validateConfig().join("\n")
  assert.match(probs, /profile 'b': escalate_to must name another defined profile/)
  assert.match(probs, /token_savers.terse must be one of/)
  assert.match(probs, /preset 'x': profile 'zzz' is not defined/)
  assert.match(probs, /preset 'x': size must be one of/)
  assert.match(probs, /preset 'x': unknown key 'bogus'/)
  assert.match(probs, /routing.large: profile 'nope' is not defined/)
  assert.match(probs, /auto.review.profile 'ghost' is not defined/)
  assert.doesNotMatch(probs, /preset 'ok'/)
  fs.writeFileSync(path.join(cfgDir, "daemon.json"), JSON.stringify({ approvals: { require_operator: true } }))
  assert.match(C.validateConfig().join("\n"), /require_operator is on but approvals.operator_token_sha256/)
  fs.rmSync(path.join(cfgDir, "daemon.json"))
})

test("advisory review verdict parsing", () => {
  assert.equal(reviewVerdict("request changes: missing test"), "request_changes")
  assert.equal(reviewVerdict("Requesting changes, would approve after fix"), "request_changes")
  assert.equal(reviewVerdict("Changes requested."), "request_changes")
  assert.equal(reviewVerdict("Approve. Looks good."), "approve")
  assert.equal(reviewVerdict("LGTM"), "approve")
  assert.equal(reviewVerdict("hmm"), "unclear")
  // only the start of the first line counts; negations are handled
  assert.equal(reviewVerdict("Not approved: the divide change has no test"), "request_changes")
  assert.equal(reviewVerdict("cannot approve this yet"), "request_changes")
  assert.equal(reviewVerdict("Do not approve - breaks the API"), "request_changes")
  assert.equal(reviewVerdict("Don't merge: missing validation"), "request_changes")
  assert.equal(reviewVerdict("approve - nothing to reject"), "approve")
  assert.equal(reviewVerdict("Approved with minor nits; no need to request changes"), "approve")
  assert.equal(reviewVerdict("**Verdict: approve**\nDetails follow"), "approve")
  assert.equal(reviewVerdict("Review: request changes"), "request_changes")
  assert.equal(reviewVerdict("\n\nRejected: scope creep"), "request_changes")
  assert.equal(reviewVerdict("The change looks fine, I would approve"), "unclear")
  assert.equal(reviewVerdict("No issues found"), "unclear")
  assert.equal(reviewVerdict(""), "unclear")
})

test("auto-review request_changes turns a done handoff into needs_review with a continue_task call", () => {
  const r = { verdict: "success", status: "completed", test_results: { executed: true, passed: true }, worker_reported: { status: "done" }, review: { verdict: "request_changes", profile: "reviewer", findings: ["f1 bad", "f2 meh"], task_id: "wh-x" } }
  const h = deriveHandoff({ id: "wh-20260926-120000-abcd", status: "completed", mode: "implement", result: r, branch: "b", worktree_path: "/wt" })
  assert.equal(h.state, "needs_review")
  assert.equal(h.resume.tool, "continue_task")
  assert.match(h.next_action, /advisory/)
  assert.ok(h.failed_checks.some((c) => c.check === "auto_review"))
  const ok = deriveHandoff({ id: "wh-20260926-120000-abcd", status: "completed", mode: "implement", result: { ...r, review: { verdict: "approve", profile: "reviewer" } }, branch: "b", worktree_path: "/wt" })
  assert.equal(ok.state, "done")
  assert.match(ok.next_action, /approved; advisory only/)
})

test("stub backend is registered only with WH_ENABLE_STUB_BACKEND=1 and refuses foreign binaries", async () => {
  const code = "import('./adapters/index.mjs').then((m) => console.log(Object.keys(m.BACKENDS).includes('stub')))"
  const envNo = { ...process.env }
  delete envNo.WH_ENABLE_STUB_BACKEND
  assert.equal(spawnSync(process.execPath, ["-e", code], { cwd: APP, env: envNo, encoding: "utf8" }).stdout.trim(), "false")
  assert.equal(spawnSync(process.execPath, ["-e", code], { cwd: APP, env: { ...envNo, WH_ENABLE_STUB_BACKEND: "1" }, encoding: "utf8" }).stdout.trim(), "true")
  const stub = (await import("../adapters/stub/adapter.mjs")).default
  const { STUB_CLI } = await import("../adapters/stub/adapter.mjs")
  const prev = process.env.WH_ENABLE_STUB_BACKEND
  delete process.env.WH_ENABLE_STUB_BACKEND
  assert.match(stub.validate({ bc: { bin_real: STUB_CLI } }).join(), /test-only/)
  process.env.WH_ENABLE_STUB_BACKEND = "1"
  assert.deepEqual(stub.validate({ bc: { bin_real: STUB_CLI } }), [])
  assert.match(stub.validate({ bc: { bin_real: "/bin/sh" } }).join(), /bundled/)
  if (prev === undefined) delete process.env.WH_ENABLE_STUB_BACKEND
  else process.env.WH_ENABLE_STUB_BACKEND = prev
  assert.ok(!Object.keys(C.daemonConfig().backends).includes("stub"), "not in the config defaults")
  assert.equal(crypto.createHash("sha256").update("x").digest("hex").length, 64)
})
