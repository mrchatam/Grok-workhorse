// Operator helpers behind `workhorse`: repo allowlist editing, health checks and a provider smoke test.
// None of this is reachable over MCP; it runs with the caller's own file permissions (the config is
// root-owned once locked, so allowlist edits need `sudo workhorse ...`).
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { execFileSync, spawnSync } from "node:child_process"
import { CONFIG_DIR, DATA_DIR, APP_DIR, REPO_NAME_RE, daemonConfig, profilesConfig, reposConfig, validateConfig, secretEnvNames } from "./config.mjs"
import { cloneUrlAllowed } from "./git.mjs"
import { detectTestCommand } from "./tasks.mjs"
import { loadFromStore } from "./credentials.mjs"
import { redact, registerSecret } from "./util.mjs"
import { BACKENDS, profileBackend } from "../adapters/index.mjs"
import { hashToken, newOperatorToken, operatorTokenPath } from "./operator.mjs"
import { effectiveSavers, rtkBin, LEVELS } from "./savers.mjs"

const REPOS_FILE = () => path.join(CONFIG_DIR, "repos.json")
export const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

function writeJsonKeepingOwner(file, obj) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString("hex")}`
  let st = null
  try {
    st = fs.statSync(file)
  } catch {}
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { mode: st ? st.mode & 0o777 : 0o644 })
  if (st && process.getuid?.() === 0) fs.chownSync(tmp, st.uid, st.gid)
  fs.renameSync(tmp, file)
}

function readRepos() {
  try {
    return JSON.parse(fs.readFileSync(REPOS_FILE(), "utf8"))
  } catch (e) {
    if (e.code === "ENOENT") return { repos: {} }
    throw new Error(`cannot read ${REPOS_FILE()}: ${e.message}`)
  }
}

function lockedHint(e) {
  if (e.code === "EACCES" || e.code === "EPERM") return new Error(`cannot write ${REPOS_FILE()} (${e.code}): the config is root-owned (locked). Re-run with sudo, e.g. sudo workhorse add-repo ...`)
  return e
}

// Test-command regexes must be anchored and must not accept free-form input.
export function checkTestRegex(re) {
  if (!re.startsWith("^") || !re.endsWith("$")) return "must be anchored with ^...$"
  try {
    new RegExp(re)
  } catch (e) {
    return `invalid regex: ${e.message}`
  }
  if (/\.\*|\.\+|\\S[*+]|\[\^[^\]]*\][*+]/.test(re)) return "must not contain free-form wildcards (.*, .+, \\S+, [^...]+); enumerate allowed arguments with character classes"
  if (/[;|`<>]|\$\(/.test(re.replace(/\\[;|`<>$(]/g, ""))) return "must not allow shell metacharacters (; | ` < > $( )"
  return null
}

export function repoNameFrom(src) {
  const base = path.basename(String(src).replace(/[/]+$/, "")).replace(/\.git$/, "")
  const n = base.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 64)
  return n || "repo"
}

export function addRepo(src, opts = {}) {
  if (!src) throw new Error('usage: workhorse add-repo <git-url-or-local-path> [--name N] [--test "<cmd>"] [--allow-test "<regex>"]... [--base BRANCH] [--description TEXT] [--test-network] [--fetch] [--force]')
  const cfg = daemonConfig()
  const name = opts.name || repoNameFrom(src)
  if (!REPO_NAME_RE.test(name) || name.includes("..")) throw new Error(`invalid repo name '${name}' (letters, digits, . _ -; max 64)`)
  const entry = { description: opts.description || "" }
  const isUrl = /^(https:\/\/|git@)/.test(src)
  if (isUrl) {
    if (!cloneUrlAllowed(src, cfg.allowed_clone_hosts)) throw new Error(`URL not allowed: use https://<host>/<owner>/<repo>(.git) or git@<host>:<owner>/<repo>.git with <host> in daemon.json allowed_clone_hosts (${cfg.allowed_clone_hosts.join(", ")}); no credentials in the URL`)
    entry.url = src
  } else {
    const abs = path.resolve(src)
    const r = spawnSync("git", ["-C", abs, "rev-parse", "--show-toplevel"], { encoding: "utf8" })
    if (r.status !== 0) throw new Error(`${abs} is not a git repository`)
    entry.path = r.stdout.trim()
  }
  let base = opts.base
  if (!base && entry.path) {
    const r = spawnSync("git", ["-C", entry.path, "symbolic-ref", "--short", "HEAD"], { encoding: "utf8" })
    if (r.status === 0) base = r.stdout.trim()
  }
  entry.default_base = base || "main"
  const test = opts.test || (entry.path ? detectTestCommand(entry.path) : null)
  entry.test_command = test || null
  const allow = [...(opts.allowTest || [])]
  for (const re of allow) {
    const why = checkTestRegex(re)
    if (why) throw new Error(`--allow-test ${JSON.stringify(re)}: ${why}`)
  }
  if (test && /[\n\r\0]/.test(test)) throw new Error("--test must be a single line")
  entry.allowed_test_commands = [...new Set([...(test ? [`^${escapeRegex(test)}$`] : []), ...allow])]
  entry.test_network = opts.testNetwork === true
  entry.trust_project_config = false
  if (opts.fetch) entry.fetch_before_task = true
  const doc = readRepos()
  doc.repos = doc.repos || {}
  if (doc.repos[name] && !opts.force) throw new Error(`repo '${name}' already exists in the allowlist (use --force to replace it, or --name to pick another name)`)
  doc.repos[name] = entry
  try {
    writeJsonKeepingOwner(REPOS_FILE(), doc)
  } catch (e) {
    throw lockedHint(e)
  }
  return { added: name, entry, note: entry.url ? "The daemon clones it on the first task (with its own git credentials)." : "The daemon uses this clone as the main clone; workers never write to it." }
}

export function removeRepo(name) {
  const doc = readRepos()
  if (!doc.repos?.[name]) throw new Error(`repo '${name}' is not in the allowlist`)
  delete doc.repos[name]
  try {
    writeJsonKeepingOwner(REPOS_FILE(), doc)
  } catch (e) {
    throw lockedHint(e)
  }
  return { removed: name, note: "Existing worktrees/clones in the data dir are left in place; clean them up with cleanup_task or workhorse cleanup-old." }
}

// ---------- health ----------
const check = (name, status, detail) => ({ name, status, detail })

export function lockState() {
  const uid = process.getuid?.()
  const cfg = daemonConfig()
  const backendDirs = [...new Set(usedBackends(cfg).map((n) => cfg.backends[n]?.config_dir).filter(Boolean))]
  const paths = [CONFIG_DIR, ...["daemon.json", "profiles.json", "repos.json"].map((f) => path.join(CONFIG_DIR, f)), ...backendDirs]
  const loose = []
  for (const p of paths) {
    try {
      const st = fs.statSync(p)
      if (st.uid !== 0 || st.mode & 0o022) loose.push(p)
      else if (uid !== 0) {
        try {
          fs.accessSync(p, fs.constants.W_OK)
          loose.push(p)
        } catch {}
      }
    } catch {}
  }
  return loose
}

export function bwrapWorks(bwrap) {
  const r = spawnSync(bwrap, ["--unshare-user", "--unshare-pid", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "true"], { encoding: "utf8", timeout: 20000 })
  return { ok: r.status === 0, detail: r.status === 0 ? bwrap : `${bwrap}: ${(r.stderr || r.error?.message || "failed").trim().slice(0, 200)}` }
}

export function cliVersion(bin) {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 60000, env: { PATH: daemonConfig().env_path, HOME: "/tmp" } })
  if (r.status !== 0) return null
  const m = /\d+\.\d+\.\d+[\w.-]*/.exec(r.stdout)
  return m ? m[0] : r.stdout.trim().split(/\s+/).pop()
}
export const kiloVersion = cliVersion

// Backends referenced by at least one profile (or the default backend).
export function usedBackends(cfg = daemonConfig()) {
  const names = new Set([cfg.default_backend || "kilo"])
  try {
    for (const p of Object.values(profilesConfig().profiles)) names.add(profileBackend(p, cfg))
  } catch {}
  return [...names]
}

// report = daemon health_report (or null if unreachable)
export function healthChecks(report, daemonError) {
  const cfg = daemonConfig()
  const out = []
  const problems = validateConfig()
  out.push(problems.length ? check("config", "fail", problems.join("; ")) : check("config", "ok", CONFIG_DIR))
  const major = Number(process.versions.node.split(".")[0])
  out.push(check("node", major >= 22 ? "ok" : "fail", `v${process.versions.node}${major >= 22 ? "" : " (need >= 22)"}`))
  for (const name of usedBackends(cfg)) {
    const b = cfg.backends[name]
    const a = BACKENDS[name]
    if (!a || !b) {
      out.push(check(`backend:${name}`, "fail", "unknown backend"))
      continue
    }
    if (a.status === "skeleton") {
      out.push(check(`backend:${name}`, "fail", "TODO skeleton; cannot run tasks"))
      continue
    }
    const v = b.installed ? cliVersion(b.bin) : null
    const tag = a.status === "tested" ? "" : ` [${a.status}]`
    if (!v) out.push(check(`backend:${name}`, "fail", `${name} CLI not runnable at ${b.bin}${tag}`))
    else if (b.expected_version && v !== b.expected_version) out.push(check(`backend:${name}`, "warn", `version ${v}, expected ${b.expected_version} (re-run the installer to re-pin)${tag}`))
    else out.push(check(`backend:${name}`, a.status === "tested" ? "ok" : "warn", `${v} at ${b.bin}${tag}`))
  }
  const bw = bwrapWorks(cfg.bwrap)
  out.push(check("sandbox", bw.ok ? "ok" : "fail", bw.ok ? `bwrap user namespaces work (${bw.detail})` : bw.detail))
  const loose = lockState()
  out.push(loose.length ? check("config_lock", "warn", `not root-owned/read-only: ${loose.join(", ")} (run sudo scripts/lock-config.sh)`) : check("config_lock", "ok", "config and backend config dirs are root-owned"))
  const repos = (() => {
    try {
      return reposConfig().size
    } catch {
      return 0
    }
  })()
  out.push(check("repos", repos ? "ok" : "warn", repos ? `${repos} allowlisted` : "allowlist is empty (workhorse add-repo)"))
  if (!report) {
    out.push(check("daemon", "fail", `not reachable: ${daemonError || "unknown error"}`))
    return out
  }
  out.push(check("daemon", "ok", `pid ${report.pid}, v${report.version}, up ${report.uptime_s}s, ${report.running} running`))
  if (report.test_stub_backend_enabled) out.push(check("stub_backend", "warn", "the daemon runs with WH_ENABLE_STUB_BACKEND=1 (test-only scripted backend); restart it without that variable"))
  const def = report.profiles.find((p) => p.name === report.default_profile)
  if (!def) out.push(check("credentials", "fail", `default profile '${report.default_profile}' not found`))
  else if (!def.available) out.push(check("credentials", "fail", `default profile '${def.name}' unavailable: ${def.missing_credentials?.length ? `missing ${def.missing_credentials.join(", ")}` : (def.backend_problems || []).join("; ") || "(disabled)"}`))
  else {
    const others = report.profiles.filter((p) => !p.available).map((p) => p.name)
    out.push(check("credentials", others.length ? "warn" : "ok", `default '${def.name}' available (${(report.credential_sources || []).map((c) => `${c.name}:${c.source}`).join(", ") || "no key needed"})${others.length ? `; unavailable: ${others.join(", ")}` : ""}`))
  }
  if (report.disk_free_mb != null) out.push(check("disk", report.disk_free_mb < 200 ? "fail" : report.disk_free_mb < 1024 ? "warn" : "ok", `${report.disk_free_mb} MB free in ${DATA_DIR}`))
  const ret = report.retention || {}
  if (ret.enabled === false) out.push(check("retention", "warn", "automatic cleanup disabled"))
  else if (report.oldest_unremoved_worktree_days != null && report.oldest_unremoved_worktree_days > (ret.worktree_days ?? 7) + 1) out.push(check("retention", "warn", `a finished worktree is ${report.oldest_unremoved_worktree_days} days old (limit ${ret.worktree_days})`))
  else out.push(check("retention", "ok", `worktrees kept ${ret.worktree_days} d, tasks ${ret.task_days} d`))
  const v = report.verdicts_last_24h || {}
  const bad = (v.worker_error || 0) + (v.stalled || 0) + (v.timeout || 0) + (v.integrity_violation || 0)
  const good = (v.success || 0) + (v.success_untested || 0)
  if (report.finished_last_24h && bad && !good) out.push(check("recent_tasks", "warn", `last 24h: ${JSON.stringify(v)} (no successes)`))
  else out.push(check("recent_tasks", "ok", report.finished_last_24h ? `last 24h: ${JSON.stringify(v)}` : "no tasks in the last 24h"))
  return out
}

// ---------- provider smoke test ----------
function keyFor(name) {
  if (!name) return { value: null }
  if (process.env[name]) return { value: process.env[name], source: "env" }
  const store = daemonConfig().secret_store_path
  if (store) {
    const r = loadFromStore(store, [name])
    if (r.values[name]) return { value: r.values[name], source: "secret_store" }
    return { value: null, reason: r.missing[name] }
  }
  return { value: null, reason: "not in env and no secret_store_path configured" }
}

// One small tool-calling chat completion per profile, with the model options Kilo would send.
// Prints only status, finish_reason, whether a tool call came back, latency and usage.
export async function checkProvider(profileNames = []) {
  const pc = profilesConfig()
  const names = profileNames.length ? profileNames : [pc.default_profile, ...(pc.profiles[pc.default_profile]?.fallback || [])]
  const results = []
  for (const name of names) {
    const p = pc.profiles[name]
    if (!p) {
      results.push({ profile: name, ok: false, error: "unknown profile" })
      continue
    }
    const [pk, ...rest] = p.model.split("/")
    const prov = pc.providers[pk]
    const m = prov?.models?.[rest.join("/")]
    if (prov?.kind && prov.kind !== "openai-compatible") {
      results.push({ profile: name, ok: null, skipped: true, error: `provider kind '${prov.kind}' is not checked by check-provider (OpenAI-compatible endpoints only)` })
      continue
    }
    if (!prov?.base_url || !m) {
      results.push({ profile: name, ok: false, error: `provider/model for '${p.model}' is not defined in profiles.json providers` })
      continue
    }
    const key = keyFor(prov.api_key_env)
    if (prov.api_key_env && !key.value) {
      results.push({ profile: name, ok: false, error: `missing credentials: ${prov.api_key_env} (${key.reason || "not set"})` })
      continue
    }
    if (key.value) registerSecret(key.value)
    const body = {
      model: m.id || rest.join("/"),
      max_tokens: Math.min(m.output || 16384, 4096),
      ...(m.options || {}),
      messages: [
        { role: "system", content: "You are a helpful assistant. Use tools when they help." },
        { role: "user", content: "What is the weather in Paris right now? Call the tool." },
      ],
      tools: [{ type: "function", function: { name: "get_weather", description: "Get the current weather for a city.", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } }],
      tool_choice: "auto",
    }
    const t0 = Date.now()
    const r = { profile: name, model: p.model, model_id: body.model, base_url: prov.base_url, key_source: key.source || null }
    try {
      const res = await fetch(`${prov.base_url.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(key.value ? { authorization: `Bearer ${key.value}` } : {}), ...(prov.headers || {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Number(process.env.WH_CHECK_TIMEOUT_MS || 300000)),
      })
      r.status = res.status
      const text = await res.text()
      if (!res.ok) {
        r.ok = false
        r.error = redact(text.slice(0, 500))
      } else {
        const j = JSON.parse(text)
        const c = j.choices?.[0] || {}
        r.finish_reason = c.finish_reason || null
        r.tool_call = !!c.message?.tool_calls?.length
        r.usage = j.usage || null
        r.ok = true
        if (!r.tool_call) r.warning = "model answered without a tool call; coding agents need reliable tool calling"
      }
    } catch (e) {
      r.ok = false
      r.error = redact(`${e.name}: ${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ""}`)
    }
    r.ms = Date.now() - t0
    results.push(r)
  }
  return results
}

export const HELLO_TASK =
  "In hello.mjs, implement greet(name) so it returns exactly `Hello, <name>!` (for example greet(\"Ada\") returns \"Hello, Ada!\"). Keep the change minimal and do not modify hello.test.mjs."

// Create the tiny example repo used by `workhorse hello` (idempotent).
export function createHelloRepo(dir) {
  if (fs.existsSync(path.join(dir, ".git"))) return false
  fs.mkdirSync(dir, { recursive: true })
  const files = {
    "README.md": "# hello-world\n\nExample repo for grok-workhorse smoke tests. Run tests: `node --test`\n",
    "hello.mjs": "// Return a greeting for name.\nexport function greet(name) {\n  throw new Error(\"not implemented\")\n}\n",
    "hello.test.mjs": 'import { test } from "node:test"\nimport assert from "node:assert/strict"\nimport { greet } from "./hello.mjs"\n\ntest("greet", () => {\n  assert.equal(greet("Ada"), "Hello, Ada!")\n  assert.equal(greet("world"), "Hello, world!")\n})\n',
    "package.json": '{ "name": "hello-world", "private": true, "type": "module", "scripts": { "test": "node --test" } }\n',
  }
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), c)
  const g = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } })
  g("init", "-q", "-b", "main")
  g("add", "-A")
  g("-c", "user.name=grok-workhorse", "-c", "user.email=setup@localhost", "commit", "-qm", "hello-world example")
  return true
}

export { DATA_DIR, APP_DIR, secretEnvNames }

// ---------- daemon.json edits (operator CLI; needs sudo once the config is locked) ----------
const DAEMON_FILE = () => path.join(CONFIG_DIR, "daemon.json")
function editDaemonJson(mutate) {
  let doc = {}
  try {
    doc = JSON.parse(fs.readFileSync(DAEMON_FILE(), "utf8"))
  } catch (e) {
    if (e.code !== "ENOENT") throw new Error(`cannot read ${DAEMON_FILE()}: ${e.message}`)
  }
  mutate(doc)
  try {
    writeJsonKeepingOwner(DAEMON_FILE(), doc)
  } catch (e) {
    if (e.code === "EACCES" || e.code === "EPERM") throw new Error(`cannot write ${DAEMON_FILE()} (${e.code}): the config is root-owned (locked). Re-run with sudo.`)
    throw e
  }
  return doc
}

// `workhorse operator-token init [--force] [--enable]`: create the operator token file (0600, owned by
// the caller, normally root) and print its sha256; --enable also writes approvals.require_operator=true
// and the hash into daemon.json. The token itself is never printed.
export function operatorTokenInit({ force = false, enable = false } = {}) {
  const cfg = daemonConfig()
  const file = operatorTokenPath(cfg)
  if (fs.existsSync(file) && !force) throw new Error(`${file} exists; pass --force to replace it (the old token stops working once the hash is updated)`)
  const tok = newOperatorToken()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, tok + "\n", { mode: 0o600 })
  fs.chmodSync(file, 0o600)
  const sha = hashToken(tok)
  if (enable) editDaemonJson((d) => { d.approvals = { ...(d.approvals || {}), require_operator: true, operator_token_sha256: sha } })
  return {
    token_file: file, operator_token_sha256: sha, require_operator: enable ? true : cfg.approvals?.require_operator === true,
    next: enable ? "Restart the daemon (workhorse restart). Approvals from the supervisor now need `sudo workhorse approve <task_id>`." : `Set daemon.json approvals: {"require_operator": true, "operator_token_sha256": "${sha}"} (or re-run with --enable), then restart the daemon.`,
    note: "Keep the token file readable only by the operator (root); the daemon and the supervisor never need it.",
  }
}

// `workhorse token-savers [--terse L] [--minimal-code L] [--rtk on|off] [--rtk-bin PATH] | off`
export function tokenSavers(opts = {}) {
  const set = opts.terse !== undefined || opts.minimal !== undefined || opts.rtk !== undefined || opts.rtkBin !== undefined || opts.off
  if (set) {
    for (const [k, v] of [["terse", opts.terse], ["minimal-code", opts.minimal]]) if (v !== undefined && !LEVELS.includes(v)) throw new Error(`--${k} must be one of ${LEVELS.join(", ")}`)
    if (opts.rtk !== undefined && !["on", "off"].includes(opts.rtk)) throw new Error("--rtk must be on or off")
    if (opts.rtkBin !== undefined && !path.isAbsolute(opts.rtkBin)) throw new Error("--rtk-bin must be an absolute path")
    editDaemonJson((d) => {
      const ts = opts.off ? {} : { ...(d.token_savers || {}) }
      if (opts.off) Object.assign(ts, { terse: "off", minimal_code: "off", rtk: { enabled: false, bin: d.token_savers?.rtk?.bin ?? null } })
      if (opts.terse !== undefined) ts.terse = opts.terse
      if (opts.minimal !== undefined) ts.minimal_code = opts.minimal
      if (opts.rtk !== undefined || opts.rtkBin !== undefined) {
        const cur = typeof ts.rtk === "object" && ts.rtk ? ts.rtk : { enabled: ts.rtk === true, bin: null }
        ts.rtk = { ...cur, ...(opts.rtk !== undefined ? { enabled: opts.rtk === "on" } : {}), ...(opts.rtkBin !== undefined ? { bin: opts.rtkBin } : {}) }
      }
      d.token_savers = ts
    })
  }
  const cfg = daemonConfig()
  const s = effectiveSavers(cfg)
  const bin = rtkBin(s, cfg.env_path) || (s.rtk.bin || null)
  return {
    token_savers: s, rtk_binary: s.rtk.enabled ? (rtkBin(s, cfg.env_path) ? bin : `NOT FOUND (${bin || "rtk not on PATH"}); runs continue without it`) : null,
    ...(set ? { next: "Applies to new worker runs (no restart needed). Per-profile overrides: profiles.json profiles.<name>.token_savers." } : {}),
    docs: "docs/token-savings.md",
  }
}
