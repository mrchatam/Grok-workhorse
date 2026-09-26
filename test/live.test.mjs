// Live end-to-end test against a real model provider (opt-in, costs a few cents of tokens):
//   WH_LIVE_TEST=1 NVIDIA_API_KEY=... npm run test:live
// Profiles come from WH_LIVE_PROFILES (a profiles.json path; default config/examples/profiles.nvidia.json)
// and WH_LIVE_PROFILE picks one (default: its default_profile). The backend under test is WH_TEST_BACKEND
// (default kilo). Skipped unless WH_LIVE_TEST=1 and the profile's API key is in the environment.
import { test, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import * as H from "./helpers.mjs"

const profFile = process.env.WH_LIVE_PROFILES || path.join(H.APP, "config/examples/profiles.nvidia.json")
const profiles = JSON.parse(fs.readFileSync(profFile, "utf8"))
const pname = process.env.WH_LIVE_PROFILE || profiles.default_profile
const model = profiles.profiles?.[pname]?.model || ""
const keyName = profiles.providers?.[model.split("/")[0]]?.api_key_env
const skip =
  process.env.WH_LIVE_TEST !== "1" ? "set WH_LIVE_TEST=1 to run the live test"
  : H.SKIP ? H.SKIP
  : !profiles.profiles?.[pname] ? `profile '${pname}' not found in ${profFile}`
  : keyName && !process.env[keyName] ? `${keyName} is not set`
  : false

let env, daemon
if (!skip) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kwt-live-"))
  env = { root, cfgDir: path.join(root, "config"), dataDir: path.join(root, "data") }
  fs.mkdirSync(env.cfgDir, { recursive: true })
  fs.mkdirSync(path.join(env.dataDir, "repos"), { recursive: true })
  fs.writeFileSync(path.join(env.cfgDir, "daemon.json"), JSON.stringify(H.baseDaemonConfig({ timeouts: { default_min: 20, min_min: 1, max_min: 30, stall_min: 15, test_min: 5, kill_grace_sec: 5 } })))
  const prof = { ...profiles, default_profile: pname, profiles: { ...profiles.profiles, [pname]: { ...profiles.profiles[pname], backend: H.TEST_BACKEND } } }
  fs.writeFileSync(path.join(env.cfgDir, "profiles.json"), JSON.stringify(prof))
  process.env.WH_CONFIG_DIR = env.cfgDir
  process.env.WH_DATA_DIR = env.dataDir
  const { createHelloRepo } = await import("../lib/admin.mjs")
  const repo = path.join(env.dataDir, "repos", "hello-world")
  createHelloRepo(repo)
  fs.writeFileSync(path.join(env.cfgDir, "repos.json"), JSON.stringify({ repos: { "hello-world": { path: repo, default_base: "main", test_command: "node --test" } } }))
}
after(async () => {
  if (daemon) try { process.kill(-daemon.pid, "SIGTERM") } catch {}
})

test(`live: hello-world task on profile '${pname}' (${H.TEST_BACKEND})`, { skip, timeout: 30 * 60000 }, async () => {
  const { HELLO_TASK } = await import("../lib/admin.mjs")
  daemon = await H.startDaemon(env, keyName ? { [keyName]: process.env[keyName] } : {})
  const { rpc } = await import("../lib/client.mjs")
  const r = await rpc("delegate_task", { repo: "hello-world", task: HELLO_TASK, timeout_minutes: 20 })
  const st = await H.waitFor(rpc, r.task_id, H.isTerminal, 25 * 60000)
  const res = await rpc("task_result", { task_id: r.task_id })
  console.log(JSON.stringify({ verdict: res.verdict, backend: res.backend, model: res.worker_model, seconds: res.timings.total_s, tokens: res.usage.tokens, concerns: res.remaining_concerns }))
  assert.equal(st.status, "completed", JSON.stringify(res.errors))
  assert.equal(res.verdict, "success", JSON.stringify(res.remaining_concerns))
  assert.equal(res.test_results.passed, true)
})
