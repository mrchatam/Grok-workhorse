// Configuration loading, defaults, auto-detection and validation. Config files are re-read on every
// request that needs them, so edits to repos.json / profiles.json apply to new tasks without a restart.
//
// Locations (all overridable):
//   APP_DIR    = the checkout/install dir (parent of lib/), or $WH_APP_DIR
//   CONFIG_DIR = $WH_CONFIG_DIR or <APP_DIR>/config
//   DATA_DIR   = $WH_DATA_DIR, else daemon.json "data_dir", else ~/.local/share/grok-workhorse
//
// Worker backends (coding-agent CLIs) are configured under daemon.json "backends"; the adapters that
// know how to drive each CLI live in adapters/. A legacy top-level "kilo" section is merged into
// backends.kilo and "kilo_sandbox" into "worker_sandbox".
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const APP_DIR = path.resolve(process.env.WH_APP_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), ".."))
export const CONFIG_DIR = path.resolve(process.env.WH_CONFIG_DIR || path.join(APP_DIR, "config"))

function bootDataDir() {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, "daemon.json"), "utf8")).data_dir
    return typeof d === "string" && d ? d : null
  } catch {
    return null
  }
}
export const DATA_DIR = path.resolve(process.env.WH_DATA_DIR || bootDataDir() || path.join(os.homedir(), ".local/share/grok-workhorse"))

export const dirs = {
  repos: path.join(DATA_DIR, "repos"),
  worktrees: path.join(DATA_DIR, "worktrees"),
  tasks: path.join(DATA_DIR, "tasks"),
  logs: path.join(DATA_DIR, "logs"),
  run: path.join(DATA_DIR, "run"),
  backendData: path.join(DATA_DIR, "backend-data"), // per-task backend data/state (session DB, snapshots)
}
export const SOCKET_PATH = path.join(dirs.run, "daemon.sock")
export const TOKEN_PATH = path.join(dirs.run, "token")

export const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(APP_DIR, "package.json"), "utf8")).version
  } catch {
    return "0.0.0"
  }
})()

const DEFAULTS = {
  max_concurrent: 2,
  timeouts: { default_min: 30, min_min: 1, max_min: 120, stall_min: 15, test_min: 10, kill_grace_sec: 10 },
  retry: { max_retries: 2, backoff_sec: [30, 120], provider_cooldown_sec: 60 },
  // Automatic cleanup of finished tasks. After worktree_days the worktree + branch + per-task backend data
  // are removed (the diff stays archived in the task dir); after task_days the task dir itself is deleted.
  // Parked tasks (status needs_approval) are skipped unless parked_days is set (worktree only, never the task dir).
  retention: { enabled: true, worktree_days: 7, task_days: 30, parked_days: null, sweep_interval_min: 60 },
  default_backend: "kilo",
  bwrap: null, // null = auto: bwrap bundled with the Kilo CLI package (if installed), then `bwrap` on PATH
  // Per-backend settings. bin null = auto: $WH_<NAME>_BIN, <APP_DIR>/<name>-cli/bin/<exe>, then <exe> on PATH.
  // config_dir: backend config shipped with this repo (read-only); home: the backend's HOME (shared by
  // its tasks; per-task data is mounted over it, see adapters/).
  backends: {
    kilo: { exe: "kilo", bin: null, expected_version: null, config_dir: path.join(APP_DIR, "adapters/kilo/config"), home: path.join(DATA_DIR, "kilo-home"), session_retry_limit: 4 },
    opencode: { exe: "opencode", bin: null, expected_version: null, config_dir: path.join(APP_DIR, "adapters/opencode/config"), home: path.join(DATA_DIR, "opencode-home") },
    "claude-code": { exe: "claude", bin: null, expected_version: null, config_dir: path.join(APP_DIR, "adapters/claude-code"), home: path.join(DATA_DIR, "claude-code-home") },
    codex: { exe: "codex", bin: null, expected_version: null, config_dir: null, home: path.join(DATA_DIR, "codex-home") },
    gemini: { exe: "gemini", bin: null, expected_version: null, config_dir: null, home: path.join(DATA_DIR, "gemini-home") },
    aider: { exe: "aider", bin: null, expected_version: null, config_dir: null, home: path.join(DATA_DIR, "aider-home") },
  },
  env_path: null, // null = auto: node's bin dir, the bin dirs of installed backends, /usr/local/bin:/usr/bin:/bin
  secret_env: [], // extra secret names; every provider's api_key_env is added automatically
  secret_store_path: null, // optional JSON secret store used when a secret is not in the env (lib/credentials.mjs)
  allowed_clone_hosts: ["github.com"], // hosts the daemon may clone repo "url"s from
  limits: { task_max_chars: 20000, details_max_bytes: 65536, summary_max_chars: 1500, test_tail_chars: 1500 },
  // Extra env for both sandboxes (worker runs + daemon test runs); `test_sandbox.env` / `worker_sandbox.env`
  // override per sandbox. PATH, HOME, backend (KILO_*, OPENCODE_*, CLAUDE_*, CODEX_*), XDG_*, WH_* and
  // secret names are ignored (see sandboxEnv in tasks.mjs).
  sandbox_env: {},
  test_sandbox: { enabled: true, ro_binds: [] },
  min_mem_available_mb: 1200,
  // Outer mount-namespace sandbox around every worker run, whatever the backend (lib/sandbox.mjs).
  // `hide` paths get an empty tmpfs (plus, always: DATA_DIR, the repo main clone, the secret-store dir);
  // then only the toolchain (`ro_binds` + auto-detected Node/backend dirs), the backend config dir (ro),
  // the task's git common dir (ro), the backend HOME, this task's own backend data and the task
  // worktree (rw) are bound back.
  worker_sandbox: {
    enabled: true,
    hide: ["/home", "/root", "/workspace", "/tmp", "/run", "/var/tmp", "/mnt", "/media", "/srv"],
    ro_binds: [],
    auto_bind_toolchain: true,
  },
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (e) {
    if (e.code === "ENOENT" && fallback !== undefined) return fallback
    throw new Error(`cannot read config ${file}: ${e.message}`)
  }
}

export function merge(base, over) {
  if (!over || typeof over !== "object" || Array.isArray(over)) return over === undefined ? base : over
  const out = { ...base }
  for (const [k, v] of Object.entries(over)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && base?.[k] && typeof base[k] === "object" ? merge(base[k], v) : v
  }
  return out
}

const real = (p) => {
  try {
    return fs.realpathSync(p)
  } catch {
    return null
  }
}
const isExec = (p) => {
  try {
    fs.accessSync(p, fs.constants.X_OK)
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}
export function which(name, pathVar = process.env.PATH || "") {
  for (const d of pathVar.split(":").filter(Boolean)) if (isExec(path.join(d, name))) return path.join(d, name)
  return null
}

// Package root of a CLI (dir with package.json above the real binary, e.g. an npm package), so the
// whole package (platform binary in node_modules, bundled bwrap) can be bound read-only into the
// sandbox. Standalone binaries: their own dir.
export function packageRoot(bin) {
  let d = path.dirname(real(bin) || bin)
  for (let i = 0; i < 4 && d !== "/"; i++, d = path.dirname(d)) if (fs.existsSync(path.join(d, "package.json"))) return d
  return path.dirname(real(bin) || bin)
}
export const kiloPackageRoot = packageRoot

const envKey = (name) => `WH_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_BIN`
export function locateBackendBin(name, b) {
  if (b.bin) return b.bin
  const exe = b.exe || name
  return [process.env[envKey(name)], path.join(APP_DIR, `${name}-cli/bin/${exe}`)].find((p) => p && isExec(p)) || which(exe) || null
}

const memo = new Map()
function resolveAuto(raw) {
  const envBins = Object.keys(raw.backends).map((n) => process.env[envKey(n)] || "")
  const key = JSON.stringify([raw.backends, raw.bwrap, raw.env_path, envBins, process.env.PATH])
  if (memo.has(key)) return memo.get(key)
  const backends = {}
  const roots = []
  for (const [name, b] of Object.entries(raw.backends)) {
    const bin = locateBackendBin(name, b)
    const found = !!bin && isExec(bin)
    backends[name] = { ...b, name, bin: bin || b.exe || name, bin_real: (bin && real(bin)) || bin || null, installed: found, package_root: found ? packageRoot(bin) : null }
    if (found) roots.push(backends[name].package_root)
  }
  const kroot = backends.kilo?.package_root
  const bwrap = raw.bwrap || (kroot && [path.join(kroot, "bin/bwrap")].find(isExec)) || which("bwrap") || "bwrap"
  const nodeBin = path.dirname(real(process.execPath) || process.execPath)
  const binDirs = Object.values(backends).filter((b) => b.installed).map((b) => path.dirname(b.bin))
  const envPath = raw.env_path || [...new Set([nodeBin, ...binDirs, "/usr/local/bin", "/usr/bin", "/bin"])].join(":")
  // Node prefix (e.g. ~/.local/node22), installed backend packages and PATH dirs; bound read-only into
  // both sandboxes when they would otherwise be hidden.
  const toolchain = [path.dirname(nodeBin), ...roots, ...envPath.split(":")].filter((p) => p && p !== "/" && fs.existsSync(p))
  const out = { backends, bwrap, envPath, toolchain: [...new Set(toolchain)] }
  memo.set(key, out)
  return out
}

export function daemonConfig() {
  const file = readJson(path.join(CONFIG_DIR, "daemon.json"), {})
  // Legacy keys: "kilo" -> backends.kilo (+ kilo.bwrap -> bwrap), "kilo_sandbox" -> worker_sandbox.
  const over = { ...file }
  if (file.kilo && typeof file.kilo === "object") {
    const { bwrap, ...k } = file.kilo
    over.backends = { ...(file.backends || {}), kilo: { ...k, ...(file.backends?.kilo || {}) } }
    if (bwrap && !file.bwrap) over.bwrap = bwrap
    delete over.kilo
  }
  if (file.kilo_sandbox) {
    over.worker_sandbox = merge(file.kilo_sandbox, file.worker_sandbox || {})
    delete over.kilo_sandbox
  }
  const raw = merge(DEFAULTS, over)
  const a = resolveAuto(raw)
  raw.backends = a.backends
  raw.bwrap = a.bwrap
  raw.kilo = raw.backends.kilo // read-only alias for older code/tests
  raw.env_path = a.envPath
  raw.toolchain_binds = raw.worker_sandbox.auto_bind_toolchain === false ? [] : a.toolchain
  raw.data_dir = DATA_DIR
  return raw
}

export const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function reposConfig() {
  const raw = readJson(path.join(CONFIG_DIR, "repos.json"), { repos: {} })
  const out = new Map()
  for (const [name, r] of Object.entries(raw.repos || {})) {
    if (!REPO_NAME_RE.test(name) || name.includes("..")) continue
    if (!r || typeof r !== "object") continue
    if (!r.path && !r.url) continue
    const localPath = r.path ? path.resolve(r.path) : path.join(dirs.repos, name)
    out.set(name, {
      name,
      description: r.description || "",
      path: localPath,
      url: r.url || null,
      default_base: r.default_base || "main",
      test_command: r.test_command || null,
      allowed_test_commands: (r.allowed_test_commands || []).map((s) => new RegExp(s)),
      allowed_test_commands_src: r.allowed_test_commands || [],
      test_network: r.test_network === true,
      trust_project_config: r.trust_project_config === true,
      fetch_before_task: r.fetch_before_task === true,
    })
  }
  return out
}

// profiles.json:
//   providers: { <key>: { name, base_url, api_key_env, max_concurrent, timeout_ms, headers, models: { <modelKey>: {...} } } }
//   profiles:  { <name>: { backend?: "kilo"|"opencode"|..., model: "<providerKey>/<modelKey>", explore_model?,
//                          small_model?, fallback?: [profile...], ... } }
//   default_profile, default_backend? (else daemon.json default_backend), kilo_overlay / opencode_overlay
//   (raw backend config merged into every run of that backend, for advanced use)
export function profilesConfig() {
  const raw = readJson(path.join(CONFIG_DIR, "profiles.json"))
  const providers = {}
  for (const [k, p] of Object.entries(raw.providers || {})) {
    if (!p || typeof p !== "object" || k.startsWith("_")) continue
    providers[k] = { ...p, requires_env: [...new Set([...(p.requires_env || []), ...(p.api_key_env ? [p.api_key_env] : [])])] }
  }
  const profiles = {}
  for (const [k, p] of Object.entries(raw.profiles || {})) {
    if (!p || typeof p !== "object" || k.startsWith("_")) continue
    const fb = p.fallback == null ? [] : Array.isArray(p.fallback) ? p.fallback : [p.fallback]
    profiles[k] = {
      ...p,
      backend: p.backend || raw.default_backend || null, // null = daemon.json default_backend
      provider: p.provider || String(p.model || "").split("/")[0],
      fallback: fb.filter((x) => typeof x === "string" && x !== k),
    }
  }
  const names = Object.keys(profiles)
  return {
    default_profile: raw.default_profile || names[0] || "default",
    profiles,
    providers,
    kilo_overlay: raw.kilo_overlay || {},
    opencode_overlay: raw.opencode_overlay || {},
  }
}

// Every secret name the daemon may need: daemon.json secret_env + each provider's api_key_env/requires_env.
export function secretEnvNames(cfg = daemonConfig(), pc = null) {
  let p = pc
  if (!p) {
    try {
      p = profilesConfig()
    } catch {
      p = { providers: {} }
    }
  }
  const names = new Set(cfg.secret_env || [])
  for (const prov of Object.values(p.providers || {})) for (const n of prov.requires_env || []) names.add(n)
  return [...names].filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n))
}

// Kilo/OpenCode provider definitions generated from profiles.json `providers` (any OpenAI-compatible
// endpoint). The API key reaches the CLI only as {env:NAME}; the daemon puts the value into its env.
export function kiloProviderOverlay(pc) {
  const provider = {}
  for (const [key, p] of Object.entries(pc.providers || {})) {
    if (!p.base_url) continue // legacy/advanced: provider defined in kilo_overlay instead
    const models = {}
    for (const [mk, m] of Object.entries(p.models || {})) {
      if (!m || typeof m !== "object" || mk.startsWith("_")) continue
      models[mk] = {
        id: m.id || mk,
        name: m.name || m.id || mk,
        tool_call: m.tool_call !== false,
        reasoning: m.reasoning === true,
        temperature: m.temperature !== false,
        limit: { context: m.context || 131072, output: m.output || 16384 },
        ...(m.options ? { options: m.options } : {}),
      }
    }
    provider[key] = {
      npm: p.npm || "@ai-sdk/openai-compatible",
      name: p.name || key,
      options: {
        baseURL: p.base_url,
        apiKey: p.api_key_env ? `{env:${p.api_key_env}}` : "none",
        timeout: p.timeout_ms || 600000,
        ...(p.headers ? { headers: p.headers } : {}),
      },
      models,
    }
  }
  return Object.keys(provider).length ? { enabled_providers: Object.keys(provider), provider } : {}
}

// Static checks used by `workhorse health` / `workhorse validate`. Returns a list of problems (strings).
export function validateConfig() {
  const problems = []
  let pc
  try {
    pc = profilesConfig()
  } catch (e) {
    return [e.message]
  }
  if (!Object.keys(pc.profiles).length) problems.push("profiles.json defines no profiles")
  if (!pc.profiles[pc.default_profile]) problems.push(`default_profile '${pc.default_profile}' is not defined`)
  const overlayProviders = pc.kilo_overlay?.provider || {}
  for (const [name, p] of Object.entries(pc.profiles)) {
    if (!p.model || !p.model.includes("/")) {
      problems.push(`profile '${name}': model must look like '<provider>/<model>'`)
      continue
    }
    const [prov, ...rest] = p.model.split("/")
    const mk = rest.join("/")
    const def = pc.providers[prov]
    if (!def && !overlayProviders[prov]) problems.push(`profile '${name}': provider '${prov}' is not defined in providers`)
    else if (def?.base_url && !def.models?.[mk]) problems.push(`profile '${name}': model '${mk}' is not defined under providers.${prov}.models`)
    for (const f of p.fallback) if (!pc.profiles[f]) problems.push(`profile '${name}': fallback profile '${f}' is not defined`)
    if (p.backend && !Object.hasOwn(DEFAULTS.backends, p.backend)) problems.push(`profile '${name}': unknown backend '${p.backend}' (known: ${Object.keys(DEFAULTS.backends).join(", ")})`)
  }
  try {
    reposConfig()
  } catch (e) {
    problems.push(e.message)
  }
  try {
    daemonConfig()
  } catch (e) {
    problems.push(e.message)
  }
  return problems
}
