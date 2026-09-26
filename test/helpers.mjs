// Test harness: isolated config/data dirs, a scripted mock LLM, and a test daemon instance.
// Integration tests need the backend CLI under test (WH_TEST_BACKEND, default kilo: WH_KILO_BIN,
// <repo>/kilo-cli/bin/kilo or `kilo` on PATH; opencode: WH_OPENCODE_BIN or `opencode` on PATH), a bwrap
// that can create user namespaces (bundled with the Kilo CLI, or on PATH), git and python3 (mock LLM +
// example repo tests). Without them the integration tests are reported as skipped.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import net from "node:net"
import crypto from "node:crypto"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { spawn, spawnSync, execFileSync } from "node:child_process"

export const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
export const REPO_NAME = "example-calc"
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const uid = process.getuid?.() ?? 0

function findBin(envName, local, exe) {
  const cands = [process.env[envName], local]
  for (const d of (process.env.PATH || "").split(":")) if (d) cands.push(path.join(d, exe))
  return cands.find((p) => p && fs.existsSync(p)) || null
}
export const KILO_BIN = findBin("WH_KILO_BIN", path.join(APP, "kilo-cli/bin/kilo"), "kilo")
export const OPENCODE_BIN = findBin("WH_OPENCODE_BIN", path.join(APP, "opencode-cli/bin/opencode"), "opencode")
// Backend the integration tests drive (the mock scenarios use the Kilo/OpenCode tool names).
export const TEST_BACKEND = process.env.WH_TEST_BACKEND || "kilo"

function detectSkip() {
  if (process.env.WH_SKIP_INTEGRATION) return "WH_SKIP_INTEGRATION is set"
  if (!["kilo", "opencode"].includes(TEST_BACKEND)) return `WH_TEST_BACKEND=${TEST_BACKEND} has no mock integration tests`
  if (TEST_BACKEND === "kilo" && !KILO_BIN) return "Kilo CLI not found (set WH_KILO_BIN)"
  if (TEST_BACKEND === "opencode" && !OPENCODE_BIN) return "OpenCode CLI not found (set WH_OPENCODE_BIN)"
  for (const b of ["git", "python3"]) if (spawnSync(b, ["--version"]).status !== 0) return `${b} not found`
  // (lib/config.mjs is deliberately not imported here: it fixes its paths at import time.)
  let bundled = null
  if (KILO_BIN) {
    let root = path.dirname(fs.realpathSync(KILO_BIN))
    for (let i = 0; i < 4 && !fs.existsSync(path.join(root, "package.json")); i++) root = path.dirname(root)
    bundled = path.join(root, "bin/bwrap")
  }
  const bwrap = bundled && fs.existsSync(bundled) ? bundled : "bwrap"
  const r = spawnSync(bwrap, ["--unshare-user", "--unshare-pid", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "true"])
  if (r.status !== 0) return `bwrap cannot create user namespaces here (${bwrap})`
  return null
}
export const SKIP = detectSkip()
// Use instead of test() in integration files: reported as skipped when the environment can't run them.
export const itest = (name, opts, fn) => (typeof opts === "function" ? test(name, { skip: SKIP || false }, opts) : test(name, { ...opts, skip: SKIP || opts.skip || false }, fn))

export async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = s.address().port
      s.close(() => resolve(p))
    })
  })
}

// A git repo built from test/fixtures/example-repo (a tiny Python package with incomplete functions).
export function exampleRepoSource() {
  // Cache key: fixture content, so edits to the fixture invalidate the cached repo.
  const fx = path.join(APP, "test/fixtures/example-repo")
  const h = crypto.createHash("sha1")
  for (const f of fs.readdirSync(fx, { recursive: true }).sort()) {
    const p = path.join(fx, f)
    if (fs.statSync(p).isFile()) h.update(f).update(fs.readFileSync(p))
  }
  const dir = path.join(os.tmpdir(), `kwt-example-src-${uid}-${h.digest("hex").slice(0, 10)}`)
  if (fs.existsSync(path.join(dir, ".git"))) return dir
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kwt-example-build-"))
  fs.cpSync(path.join(APP, "test/fixtures/example-repo"), tmp, { recursive: true })
  const g = (...a) => execFileSync("git", ["-C", tmp, ...a], { stdio: "ignore" })
  g("init", "-q", "-b", "main")
  g("add", "-A")
  g("-c", "user.name=test", "-c", "user.email=test@localhost", "commit", "-qm", "example repo")
  try {
    fs.renameSync(tmp, dir)
  } catch {
    fs.rmSync(tmp, { recursive: true, force: true }) // another test process won the race
  }
  return dir
}

// Shared across test files and runs: the backend HOME (config/cache). Session data is per task anyway.
export const TEST_KILO_HOME = process.env.WH_TEST_KILO_HOME || path.join(os.tmpdir(), `kwt-kilo-home-${uid}`)
export const TEST_OPENCODE_HOME = path.join(os.tmpdir(), `kwt-opencode-home-${uid}`)

export function baseDaemonConfig(extra = {}) {
  return {
    max_concurrent: 2,
    timeouts: { default_min: 5, min_min: 0.05, max_min: 30, stall_min: 5, test_min: 2, kill_grace_sec: 3 },
    retry: { max_retries: 1, backoff_sec: [1], provider_cooldown_sec: 1 },
    retention: { enabled: false, worktree_days: 7, task_days: 30 },
    default_backend: TEST_BACKEND,
    backends: {
      kilo: { bin: KILO_BIN, home: TEST_KILO_HOME, session_retry_limit: 1 },
      opencode: { bin: OPENCODE_BIN, home: TEST_OPENCODE_HOME },
    },
    secret_env: [],
    secret_store_path: null, // credentials.test.mjs passes a fake store
    ...extra,
  }
}

// Must be called before importing lib/client.mjs (config paths are read at import time).
export async function setupEnv(name, daemonOverrides = {}) {
  if (SKIP) return null
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `kwt-${name}-`))
  const cfgDir = path.join(root, "config")
  const dataDir = path.join(root, "data")
  const scenDir = path.join(root, "scenarios")
  fs.mkdirSync(cfgDir, { recursive: true })
  fs.mkdirSync(path.join(dataDir, "repos"), { recursive: true })
  fs.cpSync(path.join(APP, "test/mock/scenarios"), scenDir, { recursive: true })
  const repoPath = path.join(dataDir, "repos", REPO_NAME)
  execFileSync("git", ["clone", "-q", exampleRepoSource(), repoPath])
  const port = await freePort()
  fs.writeFileSync(path.join(cfgDir, "daemon.json"), JSON.stringify(baseDaemonConfig(daemonOverrides), null, 2))
  fs.writeFileSync(
    path.join(cfgDir, "repos.json"),
    JSON.stringify({
      repos: {
        [REPO_NAME]: {
          description: "test clone", path: repoPath, default_base: "main",
          test_command: "python3 -m unittest discover -s tests -v",
          allowed_test_commands: ["^python3 -m unittest( -v| -q)?( discover -s tests( -v| -q)?|( tests(\\.[A-Za-z0-9_]+)+)+( -v| -q)?)?$"],
        },
      },
    }),
  )
  const prof = JSON.parse(fs.readFileSync(path.join(APP, "test/fixtures/profiles.json"), "utf8").replaceAll("__MOCK_PORT__", String(port)))
  fs.writeFileSync(path.join(cfgDir, "profiles.json"), JSON.stringify(prof, null, 2))
  process.env.WH_CONFIG_DIR = cfgDir
  process.env.WH_DATA_DIR = dataDir
  return { root, cfgDir, dataDir, scenDir, repoPath, port, mockLog: path.join(root, "mock.jsonl") }
}

export function editJson(file, fn) {
  const j = JSON.parse(fs.readFileSync(file, "utf8"))
  fn(j)
  fs.writeFileSync(file, JSON.stringify(j, null, 2))
}

// Write a scenario with placeholders replaced into this env's scenario dir.
export function templateScenario(env, src, dst, repl) {
  let s = fs.readFileSync(path.join(env.scenDir, `${src}.json`), "utf8")
  for (const [k, v] of Object.entries(repl)) s = s.replaceAll(k, v)
  fs.writeFileSync(path.join(env.scenDir, `${dst}.json`), s)
}

export function startMock(env) {
  if (!env) return { kill() {} }
  return spawn("python3", [path.join(APP, "test/mock/mock_llm.py"), String(env.port)], {
    env: { ...process.env, MOCK_LOG: env.mockLog, MOCK_SCENARIOS: env.scenDir },
    stdio: "ignore",
  })
}

export async function startDaemon(env, extraEnv = {}) {
  try { fs.unlinkSync(path.join(env.dataDir, "run", "daemon.sock")) } catch {}
  const p = spawn(process.execPath, [path.join(APP, "bin/workhorsed")], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, WH_CONFIG_DIR: env.cfgDir, WH_DATA_DIR: env.dataDir, ...extraEnv },
    stdio: ["ignore", fs.openSync(path.join(env.root, "daemon.log"), "a"), fs.openSync(path.join(env.root, "daemon.log"), "a")],
    detached: true,
  })
  const sock = path.join(env.dataDir, "run", "daemon.sock")
  for (let i = 0; i < 300; i++) {
    if (fs.existsSync(sock)) break
    await sleep(100)
  }
  await sleep(200)
  return p
}

export async function waitFor(rpc, id, pred, timeoutMs = 120000) {
  const t0 = Date.now()
  let st
  while (Date.now() - t0 < timeoutMs) {
    st = await rpc("task_status", { task_id: id })
    if (pred(st)) return st
    await sleep(500)
  }
  throw new Error(`timeout waiting for task ${id}; last status ${JSON.stringify(st)}`)
}

export const isTerminal = (s) => s.terminal === true

export function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args]).toString()
}

// HOME of the backend under test.
export const TEST_HOME = TEST_BACKEND === "opencode" ? TEST_OPENCODE_HOME : TEST_KILO_HOME
