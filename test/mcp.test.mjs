// End-to-end through the stdio MCP shim with the official MCP SDK client. The shim auto-starts the
// supervisor+daemon (no daemon running beforehand), exactly like a Grok Bot connector would.
import { after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import * as H from "./helpers.mjs"

const env = await H.setupEnv("mcp")
const mock = H.startMock(env)
const mkClient = async (extra = {}) => {
  const transport = new StdioClientTransport({
    command: path.join(H.APP, "bin/workhorse-mcp"),
    args: [],
    env: { PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`, HOME: process.env.HOME, WH_CONFIG_DIR: env.cfgDir, WH_DATA_DIR: env.dataDir, ...extra },
  })
  const c = new Client({ name: "wh-test", version: "1" })
  await c.connect(transport)
  return c
}
const call = async (c, name, args = {}) => {
  const r = await c.callTool({ name, arguments: args })
  const text = r.content[0].text
  if (r.isError) throw new Error(text)
  return JSON.parse(text)
}
after(async () => {
  if (H.SKIP) return
  fs.writeFileSync(path.join(env.dataDir, "run", "stop"), "")
  try { process.kill(Number(fs.readFileSync(path.join(env.dataDir, "run", "supervisor.pid"), "utf8")), "SIGTERM") } catch {}
  await H.sleep(1500)
  mock.kill()
})

H.itest("tools are exposed with schemas", async () => {
  const c = await mkClient()
  try {
    const { tools } = await c.listTools()
    assert.deepEqual(tools.map((t) => t.name).sort(), ["approve_task", "cancel_task", "cleanup_task", "continue_task", "delegate_task", "delegate_tasks", "list_models", "list_repos", "list_tasks", "task_details", "task_result", "task_status", "update_handoff", "usage_report", "wait_task"])
    for (const t of tools) assert.ok(t.description.length > 40, t.name)
    const approve = tools.find((t) => t.name === "approve_task")
    assert.ok(!("operator_token" in approve.inputSchema.properties), "the operator token is never an MCP parameter")
  } finally {
    await c.close()
  }
})

H.itest("delegate via MCP, poll, result; two shims share one daemon", async () => {
  const a = await mkClient()
  const b = await mkClient()
  const repos = await call(a, "list_repos")
  assert.equal(repos.repos[0].name, H.REPO_NAME)
  const models = await call(b, "list_models")
  assert.ok(models.profiles.length >= 2)
  const r = await call(a, "delegate_task", { repo: H.REPO_NAME, task: "Implement multiply and divide in calc/core.py so tests/test_core.py passes. MOCK_SCENARIO=implement_core", test_command: "python3 -m unittest tests.test_core -v" })
  let w
  for (let i = 0; i < 20; i++) {
    const raw = await b.callTool({ name: "wait_task", arguments: { task_id: r.task_id, max_wait_s: 30 } }) // other shim sees the same task
    assert.ok(!raw.content[0].text.includes("\n  "), "compact JSON")
    w = JSON.parse(raw.content[0].text)
    if (w.done) break
  }
  assert.equal(w.task.verdict, "success")
  assert.equal(w.task.next.state, "done")
  const res = await call(a, "task_result", { task_id: r.task_id })
  assert.equal(res.verdict, "success", JSON.stringify(res, null, 1))
  assert.equal(res.integrity.commits_made, 0)
  assert.equal(res.integrity.main_clone_unchanged, true)
  assert.ok(res.files_changed.every((f) => f.path.startsWith("calc/")))
  const d = await call(b, "task_details", { task_id: r.task_id, kind: "diff" })
  assert.match(d.content, /def multiply/)
  const lt = await call(a, "list_tasks", {})
  assert.ok(lt.tasks.some((t) => t.task_id === r.task_id))
  await assert.rejects(call(a, "delegate_task", { repo: "../../etc", task: "x" }), /invalid repo name/)
  await assert.rejects(call(a, "task_status", { task_id: "nope" }), /error/i)
  fs.writeFileSync(path.join(env.root, "e2e-result.json"), JSON.stringify(res, null, 2))
  await a.close()
  await b.close()
})

H.itest("credentials offered by a shim reach the daemon in memory and survive a daemon crash", async () => {
  const plain = await mkClient()
  const p0 = (await call(plain, "list_models")).profiles.find((p) => p.name === "needsoffer")
  assert.equal(p0.available, false)
  const keyed = await mkClient({ WH_TEST_OFFER_KEY: "offered-secret-value-42424242" })
  const p1 = (await call(keyed, "list_models")).profiles.find((p) => p.name === "needsoffer")
  assert.equal(p1.available, true)
  // crash the daemon; the supervisor restarts it (from an env without the key); the shim re-offers
  const dpid = Number(fs.readFileSync(`/proc/${fs.readFileSync(path.join(env.dataDir, "run", "supervisor.pid"), "utf8").trim()}/task/${fs.readFileSync(path.join(env.dataDir, "run", "supervisor.pid"), "utf8").trim()}/children`, "utf8").trim().split(" ")[0])
  process.kill(dpid, "SIGKILL")
  await H.sleep(3500)
  const r = await call(keyed, "delegate_task", { repo: H.REPO_NAME, profile: "needsoffer", task: "MOCK_SCENARIO=implement_core", test_command: "python3 -m unittest tests.test_core -v" })
  let st
  for (let i = 0; i < 120; i++) { st = await call(keyed, "task_status", { task_id: r.task_id }); if (st.terminal) break; await H.sleep(1000) }
  assert.equal((await call(keyed, "task_result", { task_id: r.task_id })).verdict, "success")
  for (const f of ["logs/audit.jsonl", "logs/daemon.log"]) assert.ok(!fs.readFileSync(path.join(env.dataDir, f), "utf8").includes("offered-secret-value"), f)
  for (const id of fs.readdirSync(path.join(env.dataDir, "tasks")))
    for (const f of fs.readdirSync(path.join(env.dataDir, "tasks", id))) assert.ok(!fs.readFileSync(path.join(env.dataDir, "tasks", id, f), "utf8").includes("offered-secret-value"), f)
  await plain.close(); await keyed.close()
})
