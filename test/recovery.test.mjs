// Concurrency cap + crash recovery (daemon SIGKILLed mid-task) + resume via continue_task.
import { after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import * as H from "./helpers.mjs"

const env = await H.setupEnv("recovery")
const mock = H.startMock(env)
let daemon = env && (await H.startDaemon(env))
const { rpc } = env ? await import("../lib/client.mjs") : {}
after(() => {
  if (H.SKIP) return
  try { process.kill(-daemon.pid, "SIGTERM") } catch {}
  mock.kill()
})
const taskJson = (id) => JSON.parse(fs.readFileSync(path.join(env.dataDir, "tasks", id, "task.json"), "utf8"))

H.itest("max_concurrent=2: third task waits in queue; separate worktrees", async () => {
  const ids = []
  for (let i = 0; i < 3; i++) ids.push(await rpc("delegate_task", { repo: H.REPO_NAME, task: `MOCK_SCENARIO=slow #${i}` }))
  await H.sleep(1500)
  const sts = await Promise.all(ids.map((r) => rpc("task_status", { task_id: r.task_id })))
  assert.deepEqual(sts.map((s) => s.status).sort(), ["queued", "running", "running"])
  assert.equal(new Set(ids.map((r) => r.worktree_path)).size, 3)
  assert.equal(new Set(ids.map((r) => r.branch)).size, 3)
  let maxRunning = 0
  while (true) {
    const s = await Promise.all(ids.map((r) => rpc("task_status", { task_id: r.task_id })))
    maxRunning = Math.max(maxRunning, s.filter((x) => x.status === "running").length)
    if (s.every((x) => x.terminal)) break
    await H.sleep(300)
  }
  assert.equal(maxRunning, 2)
  for (const r of ids) assert.equal((await rpc("task_result", { task_id: r.task_id })).status, "completed")
})

H.itest("daemon SIGKILL mid-task -> restart marks task interrupted, kills orphan Kilo, continue_task resumes", async () => {
  const r = await rpc("delegate_task", { repo: H.REPO_NAME, task: "MOCK_SCENARIO=slowthendone" })
  await H.waitFor(rpc, r.task_id, (s) => s.status === "running")
  await H.sleep(12000) // Kilo boots, runs the tool call (echo partial; sleep 25)
  const run = taskJson(r.task_id).runs[0]
  assert.ok(fs.existsSync(`/proc/${run.pid}`), "kilo running")
  process.kill(daemon.pid, "SIGKILL")
  await H.sleep(1000)
  assert.ok(fs.existsSync(`/proc/${run.pid}`), "orphaned kilo still alive while daemon is down")
  daemon = await H.startDaemon(env)
  const st = await H.waitFor(rpc, r.task_id, H.isTerminal, 60000)
  assert.equal(st.status, "interrupted")
  await H.sleep(500)
  assert.equal(fs.existsSync(`/proc/${run.pid}`), false, "orphan killed on recovery")
  const res = await rpc("task_result", { task_id: r.task_id })
  assert.equal(res.verdict, "interrupted")
  assert.match(res.errors.join(" "), /continue_task/)
  assert.ok(res.session_id)
  const c = await rpc("continue_task", { task_id: r.task_id, instructions: "Resume and finish." })
  assert.equal(c.session_id, res.session_id)
  const st2 = await H.waitFor(rpc, r.task_id, H.isTerminal, 120000)
  const res2 = await rpc("task_result", { task_id: r.task_id })
  assert.equal(st2.status, "completed")
  assert.equal(res2.session_id, res.session_id)
  assert.equal(res2.activity.runs, 2)
  const log = fs.readFileSync(path.join(env.dataDir, "logs/audit.jsonl"), "utf8")
  assert.match(log, /interrupted_on_restart/)
})

H.itest("graceful SIGTERM marks running tasks interrupted", async () => {
  const r = await rpc("delegate_task", { repo: H.REPO_NAME, task: "MOCK_SCENARIO=slowthendone" })
  await H.waitFor(rpc, r.task_id, (s) => s.status === "running")
  await H.sleep(3000)
  const pid = taskJson(r.task_id).runs[0].pid
  process.kill(daemon.pid, "SIGTERM")
  for (let i = 0; i < 50 && fs.existsSync(`/proc/${daemon.pid}`); i++) await H.sleep(200)
  assert.equal(taskJson(r.task_id).status, "interrupted")
  assert.equal(fs.existsSync(`/proc/${pid}`), false)
  daemon = await H.startDaemon(env)
  assert.equal((await rpc("task_status", { task_id: r.task_id })).status, "interrupted")
  // finalized on restart: a result and a retryable handoff exist
  const res = await rpc("task_result", { task_id: r.task_id })
  assert.equal(res.verdict, "interrupted")
  assert.equal(res.handoff.state, "retryable")
})

H.itest("a daemon started while the previous one is still stopping waits for it and keeps its own socket", async () => {
  const r = await rpc("delegate_task", { repo: H.REPO_NAME, task: "MOCK_SCENARIO=slowthendone" })
  await H.waitFor(rpc, r.task_id, (s) => s.status === "running")
  await H.sleep(2000)
  const old = daemon
  process.kill(old.pid, "SIGTERM") // old daemon removes its socket, then finalizes the running task
  daemon = await H.startDaemon(env) // must wait for the old process instead of racing it
  assert.ok(old.exitCode !== null || old.signalCode !== null || !fs.existsSync(`/proc/${old.pid}`), "old daemon exited before the new one listened")
  await H.sleep(1500)
  const sock = path.join(env.dataDir, "run", "daemon.sock")
  assert.ok(fs.existsSync(sock), "the new daemon's socket survived the old daemon's shutdown")
  assert.equal((await rpc("health", {})).pid, daemon.pid)
  assert.equal(Number(fs.readFileSync(path.join(env.dataDir, "run", "daemon.pid"), "utf8")), daemon.pid)
  assert.equal((await rpc("task_status", { task_id: r.task_id })).status, "interrupted")
})
