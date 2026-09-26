// Optional secret-store credential loading (daemon.json secret_store_path) with a FAKE store file.
// Verifies: store shape parsing, clear 'missing credentials' errors, loading at task spawn and at
// startup, redaction, names-only audit, and that the value never lands in any file.
import { before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import * as H from "./helpers.mjs"

const FAKE = "fake-store-value-0123456789abcdef"
const OTHER = "other-store-secret-9876543210zyx"
const env = await H.setupEnv("store")
const STORE = env && path.join(env.root, "wh-test-secret-store.json")
const writeStore = (obj) => {
  fs.writeFileSync(STORE + ".tmp", JSON.stringify(obj), { mode: 0o600 })
  fs.renameSync(STORE + ".tmp", STORE)
}
if (env) {
  // Same shape as the Grok Bot box store: {version, desktop:{}, card:{NAME: value}, generation}
  writeStore({ version: 1, desktop: {}, card: { OTHER_TOKEN: OTHER }, generation: 1 })
  H.editJson(path.join(env.cfgDir, "daemon.json"), (d) => { d.secret_store_path = STORE })
  // The provider's api_key_env is what makes NVIDIA_API_KEY a required credential.
  H.editJson(path.join(env.cfgDir, "profiles.json"), (p) => { p.providers.mock.api_key_env = "NVIDIA_API_KEY" })
}
const T0 = Date.now()
let mock, daemon, rpc, C

before(async () => {
  if (H.SKIP) return
  C = await import("../lib/credentials.mjs")
  mock = H.startMock(env)
  daemon = await H.startDaemon(env)
  ;({ rpc } = await import("../lib/client.mjs"))
})
after(() => {
  if (H.SKIP) return
  try { process.kill(-daemon.pid, "SIGTERM") } catch {}
  mock.kill()
})

H.itest("extractSecret handles store shapes; loadFromStore errors never quote content", () => {
  const n = "NVIDIA_API_KEY"
  assert.deepEqual(C.extractSecret({ version: 1, desktop: {}, card: { [n]: FAKE }, generation: 2 }, n), { value: FAKE, location: `card.${n}` })
  assert.equal(C.extractSecret({ [n]: FAKE }, n).value, FAKE)
  assert.equal(C.extractSecret({ secrets: { [n]: { value: FAKE } } }, n).value, FAKE)
  assert.equal(C.extractSecret({ secrets: [{ name: n, value: FAKE }] }, n).value, FAKE)
  assert.equal(C.extractSecret({ card: { OTHER: OTHER } }, n), null)
  assert.equal(C.extractSecret({ card: { [n]: "" } }, n), null)
  const missing = C.loadFromStore(path.join(env.root, "nope.json"), [n])
  assert.match(missing.missing[n], /does not exist/)
  const bad = path.join(env.root, "bad.json")
  fs.writeFileSync(bad, `{"card": {"${n}": "${FAKE}" oops`, { mode: 0o600 })
  const r = C.loadFromStore(bad, [n])
  assert.match(r.missing[n], /not valid JSON/)
  assert.ok(!JSON.stringify(r).includes(FAKE), "parse errors must not quote the store")
  fs.unlinkSync(bad)
  const ok = C.loadFromStore(STORE, [n])
  assert.match(ok.missing[n], /entry NVIDIA_API_KEY not present/)
  assert.deepEqual(Object.keys(ok.values), [], "only requested names are returned (OTHER_TOKEN is never extracted)")
})

H.itest("missing store entry: clear 'missing credentials' error, task fails fast", async () => {
  const h = await rpc("health", {})
  assert.ok(!h.credentials.includes("NVIDIA_API_KEY"))
  const lm = await rpc("list_models", {})
  const m = lm.profiles.find((p) => p.name === "mock")
  assert.equal(m.available, false)
  assert.match(m.unavailable_reason, /missing credentials: NVIDIA_API_KEY \(entry NVIDIA_API_KEY not present in secret store/)
  const r = await rpc("delegate_task", { repo: H.REPO_NAME, task: "x" })
  const st = await H.waitFor(rpc, r.task_id, H.isTerminal)
  const res = await rpc("task_result", { task_id: r.task_id })
  assert.equal(st.status, "failed")
  assert.match(res.errors.join(" "), /missing credentials: NVIDIA_API_KEY/)
})

H.itest("entry added later is loaded at task spawn, used, redacted and never persisted", async () => {
  writeStore({ version: 1, desktop: {}, card: { OTHER_TOKEN: OTHER, NVIDIA_API_KEY: FAKE }, generation: 2 })
  const r = await rpc("delegate_task", { repo: H.REPO_NAME, task: "Probe. MOCK_SCENARIO=storeread" })
  const st = await H.waitFor(rpc, r.task_id, H.isTerminal)
  const res = await rpc("task_result", { task_id: r.task_id })
  assert.equal(st.status, "completed", JSON.stringify(res.errors))
  const h = await rpc("health", {})
  assert.ok(h.credentials.includes("NVIDIA_API_KEY"))
  assert.deepEqual(h.credential_sources, [{ name: "NVIDIA_API_KEY", source: "secret_store" }])
  const ev = (await rpc("task_details", { task_id: r.task_id, kind: "raw_events", max_bytes: 65536 })).content
  assert.match(ev, /guard blocked this call: access to the secret store/, "guard must block reading the store from a worker shell")
  assert.match(ev, /fakekey_count=0/)
  const audit = fs.readFileSync(path.join(env.dataDir, "logs/audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
  const loaded = audit.filter((a) => a.kind === "credential" && a.event === "loaded")
  assert.equal(loaded.length, 1)
  assert.deepEqual(Object.keys(loaded[0]).sort(), ["event", "kind", "name", "source", "trigger", "ts"])
  assert.equal(loaded[0].name, "NVIDIA_API_KEY")
  assert.equal(loaded[0].source, "secret_store")
  assert.equal(loaded[0].trigger, "task_spawn")
  // In-process: a loaded store value is registered for redaction.
  const { Manager } = await import("../lib/tasks.mjs")
  const { redact } = await import("../lib/util.mjs")
  assert.equal(redact(`x ${FAKE} y`), `x ${FAKE} y`, "not registered in this process yet")
  new Manager().loadStoreCredentials("test")
  assert.equal(redact(`x ${FAKE} y`), "x [REDACTED] y")
})

H.itest("daemon restart loads the key from the store at startup", async () => {
  process.kill(-daemon.pid, "SIGTERM")
  await H.sleep(1500)
  daemon = await H.startDaemon(env)
  const h = await rpc("health", {})
  assert.deepEqual(h.credential_sources, [{ name: "NVIDIA_API_KEY", source: "secret_store" }])
  const audit = fs.readFileSync(path.join(env.dataDir, "logs/audit.jsonl"), "utf8")
  assert.match(audit, /"kind":"credential","event":"loaded","name":"NVIDIA_API_KEY","source":"secret_store","trigger":"startup"/)
})

H.itest("store values never appear in any log, task file, worktree or Kilo state", () => {
  const hits = []
  const scan = (dir, sinceMs = 0) => {
    let ents
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(dir, e.name)
      if (p === STORE) continue
      if (e.isDirectory()) scan(p, sinceMs)
      else if (e.isFile()) {
        try {
          const st = fs.statSync(p)
          if (st.mtimeMs < sinceMs || st.size > 50 * 1024 * 1024) continue
          const b = fs.readFileSync(p)
          if (b.includes(FAKE) || b.includes(OTHER)) hits.push(p)
        } catch {}
      }
    }
  }
  scan(env.root) // daemon.log, mock.jsonl, data/{logs,tasks,worktrees,run,backend-data}
  scan(H.TEST_HOME, T0 - 1000) // shared backend HOME state written during this test
  assert.deepEqual(hits, [])
})
