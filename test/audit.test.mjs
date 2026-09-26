// Audit records: reserved fields (ts, kind; task_id, event, status for task events) cannot be clobbered
// by event data. Regression test for run_started, whose run kind used to overwrite the audit `kind`.
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kwt-audit-"))
process.env.WH_CONFIG_DIR = path.join(root, "config")
process.env.WH_DATA_DIR = path.join(root, "data")
fs.mkdirSync(process.env.WH_CONFIG_DIR, { recursive: true })
const { withReserved, auditRecord, audit } = await import("../lib/audit.mjs")
const { Manager } = await import("../lib/tasks.mjs")
const { dirs } = await import("../lib/config.mjs")
fs.mkdirSync(dirs.logs, { recursive: true })
const lines = () => fs.readFileSync(path.join(dirs.logs, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))

test("withReserved: reserved values win, clashing data keys are kept with a data_ prefix", () => {
  assert.deepEqual(withReserved({ kind: "task", event: "x" }, { kind: "initial", run: 1 }), { kind: "task", event: "x", data_kind: "initial", run: 1 })
  assert.deepEqual(withReserved({ kind: "task" }, { kind: "task" }), { kind: "task" }, "same value: no duplicate")
  assert.deepEqual(withReserved({ a: 1 }, undefined), { a: 1 })
  const r = auditRecord("rpc", { ts: "forged", kind: "forged", method: "m" })
  assert.equal(r.kind, "rpc")
  assert.notEqual(r.ts, "forged")
  assert.equal(r.data_ts, "forged")
  assert.equal(r.data_kind, "forged")
  assert.deepEqual(Object.keys(r).slice(0, 2), ["ts", "kind"])
})

test("task events keep kind/task_id/event/status; run_started records run_kind", () => {
  const mgr = new Manager()
  const t = { id: "wh-20260926-120000-ab12", status: "running" }
  mgr.event(t, "run_started", { run: 1, run_kind: "continue" })
  mgr.event(t, "weird", { kind: "initial", task_id: "wh-other", event: "spoof", status: "completed", ts: "x" })
  audit("credential", { event: "loaded", name: "K" })
  const [a, b, c] = lines().slice(-3)
  assert.equal(a.kind, "task")
  assert.equal(a.event, "run_started")
  assert.equal(a.run_kind, "continue")
  assert.equal(b.kind, "task")
  assert.equal(b.task_id, t.id)
  assert.equal(b.event, "weird")
  assert.equal(b.status, "running")
  assert.deepEqual([b.data_kind, b.data_task_id, b.data_event, b.data_status, b.data_ts], ["initial", "wh-other", "spoof", "completed", "x"])
  assert.equal(c.kind, "credential")
  assert.equal(c.event, "loaded", "event is an ordinary field outside task events")
})

test("startRun passes the run kind as run_kind, not kind", () => {
  const src = fs.readFileSync(new URL("../lib/tasks.mjs", import.meta.url), "utf8")
  const call = src.split("\n").find((l) => l.includes('this.event(t, "run_started"'))
  assert.match(call, /run_kind: spec\.kind/)
  assert.doesNotMatch(call, /[{,]\s*kind:/)
})

test.after(() => fs.rmSync(root, { recursive: true, force: true }))
