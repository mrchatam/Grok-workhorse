// Task manager: validation, scheduling, worker process lifecycle, finalization and recovery.
// Backend-specific parts (command line, env, config, event parsing) live in adapters/.
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { spawn } from "node:child_process"
import { dirs, daemonConfig, reposConfig, profilesConfig, secretEnvNames, REPO_NAME_RE, DATA_DIR, VERSION } from "./config.mjs"
import { now, writeJsonAtomic, readJsonSafe, redact, registerSecret, tail, head, readRange, ensureDir } from "./util.mjs"
import * as G from "./git.mjs"
import { alive, procStart, killTree } from "./procs.mjs"
import { audit, withReserved } from "./audit.mjs"
import { loadFromStore } from "./credentials.mjs"
import { outerSandboxArgs } from "./sandbox.mjs"
import { getBackend, profileBackend, backendProblems, backendSummary } from "../adapters/index.mjs"
import { deriveHandoff, handoffSummary, normalizeWorkerStatus, extractFailingTests, HANDOFF_STATES, PARK_STATES, QUIET_STATES, APPROVABLE_STATES, OWNER_RE } from "./handoff.mjs"

const TERMINAL = new Set(["completed", "failed", "timeout", "stalled", "cancelled", "interrupted"])
const ACTIVE = new Set(["queued", "running", "testing", "finalizing", "retry_wait"])
// Parked: the worker has finished (no process, result ready) but the task waits for a human decision
// (approve_task / continue_task). Not closed, so retention never removes its worktree automatically
// (unless retention.parked_days is set). Pollers treat it like a terminal status (task_status terminal: true).
const PARKED = new Set(["needs_approval"])
const settled = (s) => TERMINAL.has(s) || PARKED.has(s)
export { TERMINAL, PARKED, ACTIVE }
const hasText = (s) => typeof s === "string" && !!s.trim() && !/^(none|n\/a|-)\.?$/i.test(s.trim())
const TASK_ID_RE = /^wh-[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/

class UserError extends Error {}
export { UserError }

function newTaskId() {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, "0")
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  return `wh-${stamp}-${crypto.randomBytes(2).toString("hex")}`
}

// Tool errors/outputs that mean "policy or sandbox refused this", across backends.
const BLOCKED_RE = /workhorse guard blocked|rule which prevents you|unavailable tool|Read-only file system|Operation not permitted|Permission denied|denied by (policy|sandbox)|blocked by (hook|policy)/

// Extra env for sandboxed processes (toolchain settings such as GOMODCACHE/GOPROXY/GOCACHE, npm offline
// cache): daemon.json `sandbox_env` (worker + tests) overlaid by `test_sandbox.env` / `worker_sandbox.env`.
// String values and plain names only; PATH, HOME, backend control vars (KILO_*, OPENCODE_*, CLAUDE_*,
// CODEX_*, ANTHROPIC_*), XDG_*, WH_* and secret names cannot be set this way.
export function sandboxEnv(cfg, which) {
  const secret = new Set([...(cfg.secret_env || []), ...(cfg.secret_names || [])])
  const out = {}
  const sect = which === "kilo_sandbox" ? "worker_sandbox" : which
  for (const [k, v] of Object.entries({ ...(cfg.sandbox_env || {}), ...((cfg[sect] || cfg[which])?.env || {}) })) {
    if (typeof v !== "string" || !/^[A-Za-z][A-Za-z0-9_]*$/.test(k) || k === "PATH" || k === "HOME" || /^(KILO_|OPENCODE_|CLAUDE_|CODEX_|ANTHROPIC_|XDG_|WH_)/.test(k) || secret.has(k)) continue
    out[k] = v
  }
  return out
}

function hhmmss() {
  return new Date().toTimeString().slice(0, 8)
}

export function parseResultBlock(text) {
  if (!text) return null
  const idx = text.lastIndexOf("## RESULT")
  if (idx < 0) return null
  const body = text.slice(idx + 9).replace(/```/g, "")
  const keys = ["status", "summary", "files_changed", "tests", "concerns", "needs"]
  const out = {}
  let cur = null
  for (const raw of body.split("\n")) {
    const line = raw.replace(/^\s*[-*]\s*/, "")
    const m = line.match(/^\s*\**(status|summary|files_changed|tests|concerns|needs)\**\s*:\s*(.*)$/i)
    if (m) {
      cur = m[1].toLowerCase()
      out[cur] = m[2].trim()
    } else if (cur && line.trim()) {
      out[cur] += " " + line.trim()
    }
  }
  if (!keys.some((k) => k in out)) return null
  if (out.status) out.status = normalizeWorkerStatus(out.status)
  return out
}

export function parseTestOutput(out) {
  const c = {}
  let m
  if ((m = out.match(/Ran (\d+) tests?/))) {
    c.ran = Number(m[1])
    const f = out.match(/FAILED \(([^)]*)\)/)
    if (f) {
      for (const part of f[1].split(",")) {
        const [k, v] = part.trim().split("=")
        if (v) c[k] = Number(v)
      }
    }
  }
  if ((m = out.match(/(\d+) passed/))) c.passed = Number(m[1])
  if ((m = out.match(/(\d+) failed/))) c.failed = Number(m[1])
  if ((m = out.match(/(\d+) errors?\b/)) && c.errors === undefined) c.errors = Number(m[1])
  if ((m = out.match(/# pass (\d+)/))) c.passed = Number(m[1])
  if ((m = out.match(/# fail (\d+)/))) c.failed = Number(m[1])
  return c
}

function memAvailableMb() {
  try { return Math.round(Number(/MemAvailable:\s+(\d+)/.exec(fs.readFileSync("/proc/meminfo", "utf8"))[1]) / 1024) } catch { return null }
}

export class Manager {
  constructor() {
    this.tasks = new Map()
    this.live = new Map()
    this.offered = {}
    this.fromStore = {} // name -> value loaded from daemon.json secret_store_path (memory only)
    this.startedAt = Date.now()
    this.storeMissing = {} // name -> reason the store could not provide it (no values)
    this.cooldown = {}
    this.shuttingDown = false
  }

  // ---------- persistence ----------
  taskDir(id) {
    return path.join(dirs.tasks, id)
  }
  // Per-task backend data (session DB, snapshots, tool output, per-task settings); the adapter decides
  // how it is exposed (e.g. Kilo/OpenCode mount it over their HOME's .local/{share,state}). Kept for
  // continue_task and removed with the worktree.
  backendDataDir(id) {
    return path.join(dirs.backendData, id)
  }
  save(t) {
    t.updated_at = now()
    writeJsonAtomic(path.join(this.taskDir(t.id), "task.json"), t)
  }
  get(id) {
    if (typeof id !== "string" || !TASK_ID_RE.test(id)) throw new UserError(`invalid task_id '${String(id).slice(0, 60)}'`)
    const t = this.tasks.get(id)
    if (!t) throw new UserError(`unknown task_id '${id}'`)
    return t
  }
  event(t, kind, data = {}) {
    // task_id, event and status are reserved (a clashing data key is kept as data_<key>); ts/kind are reserved by audit().
    audit("task", withReserved({ task_id: t.id, event: kind, status: t.status }, data))
  }
  activity(t, line) {
    try {
      fs.appendFileSync(path.join(this.taskDir(t.id), "activity.log"), redact(`[${hhmmss()}] ${line}`) + "\n")
    } catch {}
  }

  async init() {
    for (const d of Object.values(dirs)) ensureDir(d)
    for (const b of Object.values(daemonConfig().backends)) {
      try {
        if (b.installed && b.home) ensureDir(b.home, 0o755)
      } catch {}
    }
    this.load()
    await this.recover()
    this.timer = setInterval(() => this.schedule().catch((e) => audit("error", { where: "schedule", error: e.message })), 2000)
    this.schedule().catch(() => {})
    const ret = daemonConfig().retention || {}
    const every = Math.max(1, Number(ret.sweep_interval_min) || 60) * 60000
    this.sweepTimer = setInterval(() => this.autoSweep(), every)
    this.sweepTimer.unref?.()
    setTimeout(() => this.autoSweep(), 30000).unref?.()
  }

  // Read every persisted task.json (tasks, their results and handoff records survive restarts).
  load() {
    ensureDir(dirs.tasks)
    for (const id of fs.readdirSync(dirs.tasks)) {
      const t = readJsonSafe(path.join(dirs.tasks, id, "task.json"))
      if (t && t.id === id) this.tasks.set(id, t)
    }
  }

  async recover() {
    const cfg = daemonConfig()
    for (const t of this.tasks.values()) {
      if (t.status === "running") {
        const run = t.runs[t.runs.length - 1]
        if (run && alive(run.pid, run.pid_start)) await killTree(run.pid, cfg.timeouts.kill_grace_sec * 1000)
        if (run) Object.assign(run, { finished_at: now(), reason: "daemon_restart", exit_code: null })
        t.errors = [...(t.errors || []), "workhorse daemon restarted while this task was running; the worker process was stopped. Use continue_task to resume in the same session and worktree."]
        t.status = "interrupted"
        this.save(t)
        this.event(t, "interrupted_on_restart")
        await this.finalize(t, { tests: false, status: "interrupted" })
      } else if (t.status === "testing" || t.status === "finalizing") {
        this.event(t, "refinalize_on_restart")
        await this.finalize(t, { tests: t.status === "testing", status: t.pending_final_status || "completed" })
      }
    }
  }

  // ---------- config helpers ----------
  repo(name) {
    if (typeof name !== "string" || !REPO_NAME_RE.test(name) || name.includes(".."))
      throw new UserError(`invalid repo name; call list_repos for allowed names`)
    const r = reposConfig().get(name)
    if (!r) throw new UserError(`repo '${name}' is not in the allowlist; call list_repos for allowed names`)
    return r
  }
  profile(name) {
    const pc = profilesConfig()
    const pname = name || pc.default_profile
    if (typeof pname !== "string" || !Object.hasOwn(pc.profiles, pname)) throw new UserError(`unknown profile '${pname}'; call list_models`)
    const p = pc.profiles[pname]
    if (p.enabled === false) throw new UserError(`profile '${pname}' is disabled: ${p.disabled_reason || "see list_models"}`)
    return { name: pname, ...p, backend: profileBackend(p, daemonConfig()), providerCfg: pc.providers[p.provider] || {} }
  }
  // Throws a UserError when the profile's backend cannot run it (unknown, skeleton, not installed, ...).
  checkBackend(profile) {
    const problems = backendProblems(profile, profilesConfig(), daemonConfig())
    if (problems.length) throw new UserError(`profile '${profile.name}' cannot run: ${problems.join("; ")}`)
  }
  secretNames() {
    return secretEnvNames(daemonConfig())
  }
  secretEnv() {
    const out = {}
    for (const k of this.secretNames()) {
      const v = this.offered[k] || process.env[k] || this.fromStore[k]
      if (v) out[k] = v
    }
    return out
  }
  // [{name, source}] (an array, so redact() does not blank values keyed by credential names)
  credentialSources() {
    const out = []
    for (const k of this.secretNames()) {
      const source = this.offered[k] ? "mcp_offer" : process.env[k] ? "env" : this.fromStore[k] ? "secret_store" : null
      if (source) out.push({ name: k, source })
    }
    return out
  }
  // Fill secret_env names that are in neither the daemon env nor a shim offer from the configured
  // secret store. Called at startup and before each task spawn when a credential is missing.
  // Audits only names, the source and names-only reasons; values go to memory + the redaction registry.
  loadStoreCredentials(trigger) {
    const cfg = daemonConfig()
    const want = this.secretNames().filter((k) => !this.offered[k] && !process.env[k] && !this.fromStore[k])
    if (!want.length || !cfg.secret_store_path) return { loaded: [], missing: want }
    const r = loadFromStore(cfg.secret_store_path, want)
    for (const w of r.warnings) if (this.storeWarning !== w) { this.storeWarning = w; audit("credential", { event: "store_warning", source: "secret_store", warning: w }) }
    const loaded = []
    for (const [k, v] of Object.entries(r.values)) {
      registerSecret(v)
      this.fromStore[k] = v
      delete this.storeMissing[k]
      loaded.push(k)
      audit("credential", { event: "loaded", name: k, source: "secret_store", trigger })
    }
    for (const [k, reason] of Object.entries(r.missing)) {
      if (this.storeMissing[k] !== reason) audit("credential", { event: "missing", name: k, source: "secret_store", trigger, reason })
      this.storeMissing[k] = reason
    }
    return { loaded, missing: Object.keys(r.missing) }
  }
  missingCredsMessage(missing) {
    const store = daemonConfig().secret_store_path
    const why = missing.map((k) => (this.storeMissing[k] ? `${k} (${this.storeMissing[k]})` : k)).join(", ")
    return `missing credentials: ${why}. Not in the workhorse daemon env, not offered by the MCP shim${store ? ", and not loadable from the secret store" : " (no secret_store_path configured)"}. Put it in the MCP connector env${store ? `, add it to the secret store (${store})` : ""}, or restart the daemon from an environment that has it (see README 'Credentials').`
  }
  offerEnv(env) {
    const allowed = new Set(this.secretNames())
    const accepted = []
    let changed = false
    for (const [k, v] of Object.entries(env || {})) {
      if (allowed.has(k) && typeof v === "string" && v.length > 0 && v.length < 4096) {
        if (this.offered[k] !== v && process.env[k] !== v) changed = true
        this.offered[k] = v
        registerSecret(v)
        accepted.push(k)
      }
    }
    return { accepted, changed }
  }
  missingCreds(profile) {
    const need = profile.providerCfg.requires_env || []
    if (need.some((k) => !this.secretEnv()[k])) this.loadStoreCredentials("task_spawn")
    const have = this.secretEnv()
    return need.filter((k) => !have[k])
  }
  validateTestCommand(repo, cmd) {
    if (cmd === undefined || cmd === null || cmd === "") return null
    if (typeof cmd !== "string" || cmd.length > 500 || /[\n\r\0]/.test(cmd)) throw new UserError("test_command must be a single line under 500 chars")
    if (cmd === repo.test_command) return cmd
    if (repo.allowed_test_commands.some((re) => re.test(cmd))) return cmd
    throw new UserError(
      `test_command not allowed for repo '${repo.name}'. Default: ${JSON.stringify(repo.test_command)}; allowed patterns: ${JSON.stringify(repo.allowed_test_commands_src)}`,
    )
  }
  timeoutMin(v) {
    const t = daemonConfig().timeouts
    if (v === undefined || v === null) return t.default_min
    if (typeof v !== "number" || !Number.isFinite(v) || v < t.min_min || v > t.max_min)
      throw new UserError(`timeout_minutes must be between ${t.min_min} and ${t.max_min}`)
    return v
  }

  // ---------- public API ----------
  async delegate(params) {
    const allowedKeys = new Set(["repo", "task", "profile", "test_command", "base_ref", "timeout_minutes", "mode", "review_task_id"])
    for (const k of Object.keys(params || {})) if (!allowedKeys.has(k)) throw new UserError(`unknown parameter '${k}'`)
    const cfg = daemonConfig()
    const repo = this.repo(params.repo)
    const mode = params.mode || "implement"
    if (!["implement", "review"].includes(mode)) throw new UserError("mode must be 'implement' or 'review'")
    const text = params.task
    if (typeof text !== "string" || !text.trim()) throw new UserError("task (description) is required")
    if (text.length > cfg.limits.task_max_chars) throw new UserError(`task description exceeds ${cfg.limits.task_max_chars} chars`)
    const profile = this.profile(params.profile)
    this.checkBackend(profile)
    const testCommand = this.validateTestCommand(repo, params.test_command)
    const timeout = this.timeoutMin(params.timeout_minutes)
    let review = null
    if (params.review_task_id !== undefined) {
      if (mode !== "review") throw new UserError("review_task_id requires mode='review'")
      const target = this.get(params.review_task_id)
      if (target.repo !== repo.name) throw new UserError("review_task_id belongs to a different repo")
      if (!settled(target.status)) throw new UserError("the task to review is still active; wait until it finishes")
      const patchFile = path.join(this.taskDir(target.id), "diff.patch")
      if (!fs.existsSync(patchFile) || fs.statSync(patchFile).size === 0) throw new UserError("the task to review has no diff")
      review = { task_id: target.id, base_commit: target.base_commit, patch: patchFile }
    }
    await G.ensureRepo(repo)
    const baseRef = params.base_ref ?? (review ? null : repo.default_base)
    const baseCommit = review ? review.base_commit : await G.resolveCommit(repo.path, baseRef)
    const id = newTaskId()
    const branch = `workhorse/${id}`
    const wt = path.join(dirs.worktrees, repo.name, id)
    ensureDir(this.taskDir(id))
    await G.addWorktree(repo.path, wt, branch, baseCommit)
    if (review) {
      const r = await G.git(wt, ["apply", "--binary", "--whitespace=nowarn", review.patch], { allowFail: true })
      if (r.code !== 0) {
        await G.removeWorktree(repo.path, wt, branch)
        throw new UserError(`could not apply the reviewed task's patch: ${r.stderr.trim()}`)
      }
    }
    const fp = await G.mainCloneFingerprint(repo.path)
    const t = {
      id, repo: repo.name, mode, profile: profile.name, backend: profile.backend, model: profile.model, agent: mode === "review" ? "review" : "worker",
      task: text, test_command: testCommand, base_ref: baseRef || `task:${review.task_id}`, base_commit: baseCommit,
      review_of: review?.task_id || null, reviewed_patch_sha: review ? crypto.createHash("sha256").update(fs.readFileSync(review.patch)).digest("hex") : null,
      branch, worktree_path: wt, timeout_min: timeout, status: "queued", phase: "waiting for a free worker slot",
      session_id: null, session_backend: null, created_at: now(), started_at: null, finished_at: null, updated_at: now(),
      runs: [], retries: 0, fallback_used: false, errors: [],
      stats: { turns: 0, tool_calls: 0, tool_errors: 0, failed_commands: 0, blocked_calls: 0, tokens: { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 }, reported_cost: 0, by_tool: {} },
      blocked: [], main_fingerprint: fp, result: null, previous_results: [], worktree_removed: false,
      pending_run: { kind: "initial", profile: profile.name, timeout_min: timeout },
    }
    this.tasks.set(id, t)
    this.save(t)
    this.event(t, "created", { repo: repo.name, profile: profile.name, backend: profile.backend, mode, base_commit: baseCommit })
    await this.schedule()
    return { task_id: id, status: t.status, repo: repo.name, mode, profile: profile.name, backend: profile.backend, model: profile.model, branch, worktree_path: wt, base_ref: t.base_ref, base_commit: baseCommit, queue_position: this.queuePosition(t), next_step: "Poll task_status every 30-60s; when status is terminal call task_result." }
  }

  queuePosition(t) {
    if (t.status !== "queued") return 0
    return [...this.tasks.values()].filter((x) => x.status === "queued" && x.created_at <= t.created_at).length
  }

  status(id) {
    const t = this.get(id)
    const run = t.runs[t.runs.length - 1]
    const live = this.live.get(id)
    return {
      task_id: t.id, status: t.status, terminal: settled(t.status), parked: PARKED.has(t.status), phase: t.phase, repo: t.repo, mode: t.mode, profile: t.profile, backend: run?.backend || t.backend || "kilo", model: run?.model || t.model,
      session_id: t.session_id, runs: t.runs.length, retries: t.retries,
      elapsed_s: t.started_at ? Math.round(((t.finished_at ? Date.parse(t.finished_at) : Date.now()) - Date.parse(t.started_at)) / 1000) : 0,
      seconds_since_last_activity: live ? Math.round((Date.now() - live.lastActivity) / 1000) : null,
      activity: { turns: t.stats.turns, tool_calls: t.stats.tool_calls, tool_errors: t.stats.tool_errors, blocked_calls: t.stats.blocked_calls },
      verdict: t.result?.verdict || null, queue_position: this.queuePosition(t), retry_at: t.retry_at || null,
      handoff: settled(t.status) ? handoffSummary(this.handoffOf(t)) : null,
      hint: PARKED.has(t.status)
        ? "Parked: waiting for a human decision. Read handoff.next_action; answer with approve_task (or continue_task)."
        : TERMINAL.has(t.status) ? "Call task_result for the structured summary; handoff.next_action says what to do next." : "Still working; poll again later.",
    }
  }

  result(id) {
    const t = this.get(id)
    if (!t.result) return { task_id: t.id, status: t.status, terminal: settled(t.status), message: "No result yet; the task is still active. Poll task_status." }
    return { ...t.result, status: t.status, handoff: this.handoffOf(t) }
  }

  // The task's handoff record: the persisted one, or (tasks finished before v0.2.0) derived on the fly.
  // Worktree/session facts are refreshed, since cleanup can remove the worktree after the handoff was written.
  handoffOf(t) {
    if (!t.result || !settled(t.status)) return null
    const h = t.handoff || redact(deriveHandoff(t, { at: t.finished_at || t.updated_at }))
    const alive = !t.worktree_removed
    return { ...h, resume: { ...h.resume, worktree_exists: alive, worktree_path: alive ? t.worktree_path : null, session_reusable: !!(alive && h.resume?.session_reusable) } }
  }

  needsAttention(t) {
    if (!settled(t.status)) return false
    if (PARKED.has(t.status)) return true
    const h = this.handoffOf(t)
    return !!h && !QUIET_STATES.has(h.state)
  }

  details(id, kind = "activity", offset = 0, maxBytes, run) {
    const t = this.get(id)
    const cfg = daemonConfig()
    const cap = Math.min(Math.max(1024, Number(maxBytes) || 16384), cfg.limits.details_max_bytes)
    const n = run ? Number(run) : t.runs.length
    if (run !== undefined && (!Number.isInteger(n) || n < 1 || n > t.runs.length)) throw new UserError(`run must be 1..${t.runs.length}`)
    const files = {
      activity: "activity.log",
      diff: "diff.patch",
      test_log: "test.log",
      final_message: "final_message.txt",
      raw_events: `run-${n}.events.jsonl`,
      stderr: `run-${n}.stderr.log`,
    }
    if (!Object.hasOwn(files, kind)) throw new UserError(`kind must be one of ${Object.keys(files).join(", ")}`)
    const off = Math.max(0, Number(offset) || 0)
    const r = readRange(path.join(this.taskDir(t.id), files[kind]), off, cap)
    return { task_id: t.id, kind, run: kind === "raw_events" || kind === "stderr" ? n : undefined, ...r, content: redact(r.content) }
  }

  list(filter = {}) {
    let arr = [...this.tasks.values()]
    const f = filter.status
    // 'terminal' = no worker running (includes parked tasks); 'parked' = waiting for approve_task;
    // 'needs_attention' = parked tasks plus finished tasks whose handoff is not done/closed.
    if (f) arr = arr.filter((t) => (f === "active" ? ACTIVE.has(t.status) : f === "terminal" ? settled(t.status) : f === "parked" ? PARKED.has(t.status) : f === "needs_attention" ? this.needsAttention(t) : t.status === f))
    if (filter.repo) arr = arr.filter((t) => t.repo === filter.repo)
    if (filter.owner) arr = arr.filter((t) => String(this.handoffOf(t)?.owner || "").toLowerCase() === String(filter.owner).toLowerCase())
    arr.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    const limit = Math.min(Math.max(1, Number(filter.limit) || 20), 200)
    return {
      total: arr.length,
      tasks: arr.slice(0, limit).map((t) => ({
        task_id: t.id, status: t.status, verdict: t.result?.verdict || null, repo: t.repo, mode: t.mode, profile: t.profile,
        created_at: t.created_at, finished_at: t.finished_at, task: head(t.task, 120), branch: t.branch, worktree_removed: t.worktree_removed,
        handoff: settled(t.status) ? (({ state, owner, next_action }) => ({ state, owner, next_action }))(handoffSummary(this.handoffOf(t)) || {}) : null,
      })),
    }
  }

  async continueTask(id, instructions, timeoutMinutes, profileName, { approval = null } = {}) {
    const t = this.get(id)
    if (!settled(t.status)) throw new UserError(`task is ${t.status}; continue_task works only on finished or parked tasks (cancel it first if needed)`)
    if (t.worktree_removed) throw new UserError("task worktree was cleaned up; delegate a new task instead")
    if (typeof instructions !== "string" || !instructions.trim()) throw new UserError("instructions are required")
    if (instructions.length > daemonConfig().limits.task_max_chars) throw new UserError("instructions too long")
    const profile = this.profile(profileName || t.profile)
    this.checkBackend(profile)
    const timeout = this.timeoutMin(timeoutMinutes)
    const h = this.handoffOf(t)
    if (t.result) t.previous_results.push({ at: now(), status: t.status, verdict: t.result.verdict, summary: t.result.summary, handoff: h ? { state: h.state, owner: h.owner, next_action: h.next_action } : undefined, approval: approval || undefined })
    if (approval) t.approvals = [...(t.approvals || []), approval].slice(-20)
    t.result = null
    t.handoff = null
    delete t.parked_from
    t.status = "queued"
    t.phase = "follow-up queued"
    t.finished_at = null
    t.retries = 0
    t.fallback_used = false
    t.fallbacks_tried = []
    t.pending_profile_origin = profile.name
    t.pending_run = { kind: "continue", message: instructions, profile: profile.name, timeout_min: timeout }
    this.save(t)
    this.event(t, "continue_queued", { profile: profile.name, ...(approval ? { approval: approval.decision, by: approval.by } : {}) })
    await this.schedule()
    return { task_id: t.id, status: t.status, session_id: t.session_id, profile: profile.name, backend: profile.backend, resumes_session: this.sessionBackend(t) === profile.backend && !!t.session_id, next_step: "Poll task_status; then task_result." }
  }

  async cancel(id) {
    const t = this.get(id)
    const live = this.live.get(id)
    if (live) {
      live.killedFor = "cancel"
      this.event(t, "cancel_requested")
      await killTree(live.child.pid, daemonConfig().timeouts.kill_grace_sec * 1000)
      return { task_id: id, status: "cancelling", message: "worker process stopped; worktree kept for inspection." }
    }
    if (t.status === "queued" || t.status === "retry_wait") {
      t.status = "cancelled"
      this.save(t)
      this.event(t, "cancelled")
      await this.finalize(t, { tests: false, status: "cancelled" })
      return { task_id: id, status: "cancelled" }
    }
    if (PARKED.has(t.status)) return this.closeTask(t, "supervisor", "cancelled via cancel_task")
    throw new UserError(`task is ${t.status}; nothing to cancel`)
  }

  // ---------- handoff / approval ----------
  // Who is acting: an explicit `by`, else "human (cli)" for the operator CLI, else "supervisor" (MCP).
  actor(by, caller) {
    if (by !== undefined && by !== null && by !== "") {
      if (typeof by !== "string" || !OWNER_RE.test(by)) throw new UserError("by must be a short name (letters, digits, space, _.:@/+-; max 80 chars)")
      return by
    }
    return caller?.client === "workhorse" ? "human (cli)" : "supervisor"
  }

  checkText(name, v, max = 2000) {
    if (v === undefined || v === null) return undefined
    if (typeof v !== "string" || !v.trim() || v.length > max) throw new UserError(`${name} must be a non-empty string up to ${max} chars`)
    return v.trim()
  }

  handoff(id) {
    const t = this.get(id)
    if (!settled(t.status)) return { task_id: t.id, status: t.status, handoff: null, message: "The task is still active; the handoff is written when it finishes." }
    return { task_id: t.id, status: t.status, verdict: t.result?.verdict || null, handoff: this.handoffOf(t), approvals: t.approvals || [] }
  }

  // Supervisor/human edits of the handoff. Setting state needs_approval/needs_input parks a finished task;
  // setting any other state on a parked task unparks it (back to the status it had, else completed).
  updateHandoff(p = {}, caller = null) {
    const allowed = new Set(["task_id", "owner", "next_action", "note", "state", "by"])
    for (const k of Object.keys(p)) if (!allowed.has(k)) throw new UserError(`unknown parameter '${k}'`)
    const t = this.get(p.task_id)
    if (!settled(t.status)) throw new UserError(`task is ${t.status}; the handoff exists once the task has finished`)
    if (p.state !== undefined && !HANDOFF_STATES.includes(p.state)) throw new UserError(`state must be one of ${HANDOFF_STATES.join(", ")}`)
    if (p.owner !== undefined && (typeof p.owner !== "string" || !OWNER_RE.test(p.owner))) throw new UserError("owner must be 'supervisor', 'human' or a short name (letters, digits, space, _.:@/+-; max 80 chars)")
    const nextAction = this.checkText("next_action", p.next_action)
    const note = this.checkText("note", p.note)
    if (p.state === undefined && p.owner === undefined && nextAction === undefined && note === undefined) throw new UserError("nothing to update: pass state, owner, next_action and/or note")
    const who = this.actor(p.by, caller)
    const at = now()
    const h = { ...this.handoffOf(t) }
    const changed = []
    if (p.state !== undefined && p.state !== h.state) { h.state = p.state; changed.push("state") }
    if (p.owner !== undefined && p.owner !== h.owner) { h.owner = p.owner; changed.push("owner") }
    if (nextAction !== undefined) {
      h.next_action = nextAction
      changed.push("next_action")
    }
    if (note !== undefined) {
      h.notes = [...(h.notes || []), { at, by: who, note }].slice(-20)
      changed.push("note")
    }
    const from = t.status
    if (p.state !== undefined) {
      if (PARK_STATES.has(p.state) && TERMINAL.has(t.status)) {
        if (t.worktree_removed) throw new UserError("task worktree was cleaned up; it cannot be parked for approval")
        t.parked_from = t.status
        t.status = "needs_approval"
        if (p.owner === undefined && h.owner !== "human") { h.owner = "human"; changed.push("owner") }
      } else if (!PARK_STATES.has(p.state) && PARKED.has(t.status)) {
        t.status = t.parked_from || "completed"
        delete t.parked_from
      }
    }
    h.history = [...(h.history || []), { at, by: who, event: "update", changed, state: h.state, owner: h.owner, ...(from !== t.status ? { from_status: from, to_status: t.status } : {}) }].slice(-20)
    h.derived = false
    h.updated_at = at
    h.updated_by = who
    t.handoff = redact(h)
    this.save(t)
    this.event(t, "handoff_updated", { by: who, changed, state: h.state, owner: h.owner, ...(from !== t.status ? { from_status: from } : {}) })
    return { task_id: t.id, status: t.status, handoff: this.handoffOf(t) }
  }

  // Answer a parked/blocked task. approve: resume via the continue path with the approval in the
  // follow-up message. reject: with instructions, resume and tell the worker not to do it; without,
  // close the task (status cancelled, handoff closed; the worktree is kept).
  async approve(p = {}, caller = null) {
    const allowed = new Set(["task_id", "decision", "instructions", "note", "by", "timeout_minutes", "profile"])
    for (const k of Object.keys(p)) if (!allowed.has(k)) throw new UserError(`unknown parameter '${k}'`)
    const t = this.get(p.task_id)
    if (p.decision !== "approve" && p.decision !== "reject") throw new UserError("decision must be 'approve' or 'reject'")
    if (!settled(t.status)) throw new UserError(`task is ${t.status}; nothing to approve yet`)
    const h = this.handoffOf(t)
    if (!PARKED.has(t.status) && !APPROVABLE_STATES.has(h?.state)) throw new UserError(`task is not waiting for approval (status ${t.status}, handoff state ${h?.state || "none"}); use continue_task or update_handoff`)
    const instructions = this.checkText("instructions", p.instructions, daemonConfig().limits.task_max_chars)
    const note = this.checkText("note", p.note)
    const who = this.actor(p.by, caller)
    const request = h?.context?.worker_request || h?.next_action || "the pending request"
    const rec = { at: now(), by: who, decision: p.decision, request: head(request, 300), ...(note ? { note } : {}), ...(instructions ? { instructions: head(instructions, 300) } : {}) }
    const logApproval = () => this.event(t, "approval", { decision: p.decision, by: who, handoff_state: h?.state || null, resumed: !(p.decision === "reject" && !instructions) })
    if (p.decision === "reject" && !instructions) {
      logApproval()
      return this.closeTask(t, who, `approval rejected by ${who}${note ? `: ${note}` : ""}`, rec)
    }
    const msg = p.decision === "approve"
      ? `APPROVED by ${who}: ${request}${note ? `\nNote: ${note}` : ""}\n\n${instructions || "Proceed with the approved action and finish the task."}\n\n(Approval does not change the sandbox: actions it blocks stay blocked. If the approved action needs network or an install, the operator has done it outside, or you must report that under concerns.)`
      : `DENIED by ${who}: ${request}. Do not do that.${note ? `\nNote: ${note}` : ""}\n\n${instructions}`
    const r = await this.continueTask(t.id, msg, p.timeout_minutes, p.profile, { approval: rec })
    logApproval()
    return { ...r, decision: p.decision, approval: rec }
  }

  closeTask(t, who, reason, rec = null) {
    const from = t.status
    const h = { ...this.handoffOf(t) }
    t.status = "cancelled"
    delete t.parked_from
    if (t.result) t.result = { ...t.result, status: "cancelled" }
    if (rec) t.approvals = [...(t.approvals || []), rec].slice(-20)
    const at = now()
    h.state = "closed"
    h.owner = "supervisor"
    h.next_action = t.worktree_removed
      ? `Closed (${reason}). The worktree is gone; the diff is archived at ${path.join(this.taskDir(t.id), "diff.patch")}. Delegate a new task if the work is still needed.`
      : `Closed (${reason}). The worktree is kept: merge any useful partial diff, continue_task to resume, or cleanup_task (discard_unmerged_changes=true) to drop it.`
    h.resume = { ...h.resume, tool: null, args: null }
    h.history = [...(h.history || []), { at, by: who, event: "closed", reason, from_status: from }].slice(-20)
    h.derived = false
    h.updated_at = at
    h.updated_by = who
    t.handoff = redact(h)
    this.save(t)
    this.event(t, "closed", { by: who, from_status: from, reason })
    return { task_id: t.id, status: t.status, ...(rec ? { decision: rec.decision } : {}), handoff: this.handoffOf(t) }
  }

  async cleanup(id, discard = false) {
    const t = this.get(id)
    if (!settled(t.status)) throw new UserError(`task is ${t.status}; cancel it or wait before cleanup`)
    if (t.worktree_removed) return { task_id: id, message: "already cleaned up", diff_path: path.join(this.taskDir(id), "diff.patch") }
    const repo = this.repo(t.repo)
    const wt = t.worktree_path
    let files = []
    let commits = 0
    if (fs.existsSync(wt)) {
      const d = await G.collectDiff(wt, t.base_commit, path.join(this.taskDir(id), "cleanup.index"))
      fs.writeFileSync(path.join(this.taskDir(id), "diff.patch"), d.patch)
      files = d.files
      commits = await G.commitsSince(wt, t.base_commit)
    }
    let merged = true
    if (t.mode === "implement" && (files.length || commits)) {
      const target = await G.resolveCommit(repo.path, repo.default_base).catch(() => null)
      merged = target ? commits === 0 && (await G.changesMergedInto(repo.path, wt, files, target)) : false
    }
    if (!merged && discard !== true) {
      throw new UserError(
        `task has ${files.length} changed file(s) not present on '${repo.default_base}'. The patch is archived at ${path.join(this.taskDir(id), "diff.patch")}. ` +
          `Merge/apply it first, or call cleanup_task again with discard_unmerged_changes=true to delete the worktree anyway.`,
      )
    }
    await G.removeWorktree(repo.path, wt, t.branch)
    fs.rmSync(this.backendDataDir(id), { recursive: true, force: true })
    t.worktree_removed = true
    t.cleanup = { at: now(), merged, discarded_unmerged: !merged, files: files.length }
    this.save(t)
    this.event(t, "cleanup", t.cleanup)
    if (PARKED.has(t.status)) this.closeTask(t, "supervisor", "worktree removed with cleanup_task while waiting for approval")
    return { task_id: id, removed_worktree: wt, deleted_branch: t.branch, merged, archived_diff_path: path.join(this.taskDir(id), "diff.patch") }
  }

  // ---------- retention ----------
  // Remove old finished work. worktree_days: worktree + workhorse/<task> branch + per-task backend data of tasks
  // finished longer ago (the diff is archived to the task dir first, merged or not). task_days: delete
  // the task dir itself. Explicit params override daemon.json `retention` (0 = everything finished).
  // Parked tasks (needs_approval) are skipped: their worktree waits for the human, unless parked_days
  // (param or retention.parked_days) is set, in which case only the worktree is removed after that many
  // days since the handoff was last updated. Parked task dirs are never purged automatically.
  async sweep({ worktree_days, task_days, parked_days, dry_run = false, trigger = "manual" } = {}) {
    const ret = daemonConfig().retention || {}
    const wd = worktree_days ?? ret.worktree_days
    const td = task_days ?? ret.task_days
    const pd = parked_days ?? ret.parked_days
    for (const [k, v] of [["worktree_days", wd], ["task_days", td], ["parked_days", pd]])
      if (v !== null && v !== undefined && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) throw new UserError(`${k} must be a number >= 0`)
    const age = (t) => (Date.now() - Date.parse(t.finished_at || t.updated_at || t.created_at)) / 86400000
    const out = { dry_run: !!dry_run, worktree_days: wd ?? null, task_days: td ?? null, parked_days: pd ?? null, worktrees_removed: [], tasks_deleted: [], parked_kept: [], errors: [] }
    for (const t of [...this.tasks.values()]) {
      if (this.live.has(t.id)) continue
      if (PARKED.has(t.status)) {
        const pa = (Date.now() - Date.parse(t.handoff?.updated_at || t.finished_at || t.updated_at || t.created_at)) / 86400000
        if (pd != null && pa >= pd && !t.worktree_removed) {
          out.worktrees_removed.push(t.id)
          if (!dry_run) {
            try {
              await this.removeTaskWorktree(t, trigger)
              this.closeTask(t, "retention", `no decision within ${pd} day(s); worktree removed by retention (diff archived)`)
            } catch (e) {
              out.errors.push(`${t.id}: ${e.message}`)
            }
          }
        } else if (!t.worktree_removed) out.parked_kept.push(t.id)
        continue
      }
      if (!TERMINAL.has(t.status)) continue
      const a = age(t)
      try {
        if (wd != null && a >= wd && !t.worktree_removed) {
          out.worktrees_removed.push(t.id)
          if (!dry_run) await this.removeTaskWorktree(t, trigger)
        }
        if (td != null && a >= td) {
          out.tasks_deleted.push(t.id)
          if (!dry_run) {
            if (!t.worktree_removed) await this.removeTaskWorktree(t, trigger)
            fs.rmSync(this.taskDir(t.id), { recursive: true, force: true })
            fs.rmSync(this.backendDataDir(t.id), { recursive: true, force: true })
            this.tasks.delete(t.id)
            audit("task", { task_id: t.id, event: "purged", trigger, age_days: Math.round(a * 10) / 10 })
          }
        }
      } catch (e) {
        out.errors.push(`${t.id}: ${e.message}`)
      }
    }
    if (!dry_run && (out.worktrees_removed.length || out.tasks_deleted.length)) audit("retention", { event: "sweep", trigger, worktrees_removed: out.worktrees_removed.length, tasks_deleted: out.tasks_deleted.length })
    return out
  }
  async removeTaskWorktree(t, trigger) {
    const repo = this.repoSafe(t)
    let files = 0
    if (fs.existsSync(t.worktree_path)) {
      const d = await G.collectDiff(t.worktree_path, t.base_commit, path.join(this.taskDir(t.id), "cleanup.index")).catch(() => null)
      if (d) {
        fs.writeFileSync(path.join(this.taskDir(t.id), "diff.patch"), d.patch)
        files = d.files.length
      }
    }
    if (repo) await G.removeWorktree(repo.path, t.worktree_path, t.branch)
    else fs.rmSync(t.worktree_path, { recursive: true, force: true })
    fs.rmSync(this.backendDataDir(t.id), { recursive: true, force: true })
    t.worktree_removed = true
    t.cleanup = { at: now(), auto: true, trigger, files }
    this.save(t)
    this.event(t, "cleanup", t.cleanup)
  }
  autoSweep() {
    const ret = daemonConfig().retention || {}
    if (ret.enabled === false || this.shuttingDown) return
    this.sweep({ trigger: "retention" }).catch((e) => audit("error", { where: "sweep", error: e.message }))
  }

  // ---------- health ----------
  healthReport() {
    const cfg = daemonConfig()
    const pc = profilesConfig()
    const have = this.secretEnv()
    const day = Date.now() - 86400000
    const verdicts = {}
    let finished24 = 0
    const counts = {}
    let oldestWorktreeDays = null
    let parked = 0
    let attention = 0
    let oldestParkedDays = null
    for (const t of this.tasks.values()) {
      counts[t.status] = (counts[t.status] || 0) + 1
      if (PARKED.has(t.status)) {
        parked++
        const d = (Date.now() - Date.parse(t.handoff?.updated_at || t.finished_at || t.updated_at)) / 86400000
        oldestParkedDays = Math.max(oldestParkedDays ?? 0, Math.round(d * 10) / 10)
      }
      if (this.needsAttention(t)) attention++
      if (t.finished_at && Date.parse(t.finished_at) >= day && t.result) {
        finished24++
        verdicts[t.result.verdict] = (verdicts[t.result.verdict] || 0) + 1
      }
      if (TERMINAL.has(t.status) && !t.worktree_removed && t.finished_at) {
        const d = (Date.now() - Date.parse(t.finished_at)) / 86400000
        oldestWorktreeDays = Math.max(oldestWorktreeDays ?? 0, Math.round(d * 10) / 10)
      }
    }
    let diskFreeMb = null
    try {
      const st = fs.statfsSync(DATA_DIR)
      diskFreeMb = Math.round((st.bavail * st.bsize) / 1048576)
    } catch {}
    const profiles = Object.entries(pc.profiles).map(([name, p]) => {
      const missing = ((pc.providers[p.provider] || {}).requires_env || []).filter((k) => !have[k])
      const bp = backendProblems({ name, ...p }, pc, cfg)
      return { name, backend: profileBackend(p, cfg), model: p.model, available: p.enabled !== false && missing.length === 0 && bp.length === 0, missing_credentials: missing, backend_problems: bp }
    })
    return {
      version: VERSION, pid: process.pid, uptime_s: Math.round((Date.now() - this.startedAt) / 1000), data_dir: DATA_DIR,
      running: this.live.size, tasks_by_status: counts, default_profile: pc.default_profile, profiles,
      finished_last_24h: finished24, verdicts_last_24h: verdicts,
      retention: cfg.retention, oldest_unremoved_worktree_days: oldestWorktreeDays,
      parked_tasks: parked, oldest_parked_days: oldestParkedDays, needs_attention: attention,
      disk_free_mb: diskFreeMb, mem_available_mb: memAvailableMb(),
      default_backend: cfg.default_backend, bwrap: cfg.bwrap,
      backends: backendSummary(cfg).map((b) => ({ name: b.name, status: b.status, installed: b.installed, bin: b.bin, expected_version: cfg.backends[b.name]?.expected_version || null })),
      stall_min: cfg.timeouts.stall_min,
    }
  }

  listRepos() {
    return {
      repos: [...reposConfig().values()].map((r) => ({
        name: r.name, description: r.description, default_base: r.default_base, source: r.url ? "remote" : "local",
        cloned: fs.existsSync(path.join(r.path, ".git")), default_test_command: r.test_command, allowed_test_command_patterns: r.allowed_test_commands_src,
      })),
    }
  }

  listModels() {
    const pc = profilesConfig()
    const cfg = daemonConfig()
    if (this.secretNames().some((k) => !this.secretEnv()[k])) this.loadStoreCredentials("list_models")
    const have = this.secretEnv()
    return {
      default_profile: pc.default_profile,
      profiles: Object.entries(pc.profiles).map(([name, p]) => {
        const missing = ((pc.providers[p.provider] || {}).requires_env || []).filter((k) => !have[k])
        const [pk, ...mk] = String(p.model || "").split("/")
        const modelId = pc.providers[pk]?.models?.[mk.join("/")]?.id || null
        const bp = backendProblems({ name, ...p }, pc, cfg)
        return {
          name, description: p.description, backend: profileBackend(p, cfg), model: p.model, model_id: modelId, provider: p.provider, fallback: p.fallback,
          available: p.enabled !== false && missing.length === 0 && bp.length === 0,
          unavailable_reason: p.enabled === false ? p.disabled_reason || "disabled" : bp.length ? bp.join("; ") : missing.length ? this.missingCredsMessage(missing) : null,
        }
      }),
      modes: { implement: "worker agent edits code in a fresh worktree", review: "read-only review agent; pass review_task_id to review another task's diff, or base_ref to review a branch" },
      backends: backendSummary(cfg).map((b) => ({ name: b.name, status: b.status, installed: b.installed, summary: b.summary })),
      limits: { max_concurrent: cfg.max_concurrent, timeout_minutes: { default: cfg.timeouts.default_min, min: cfg.timeouts.min_min, max: cfg.timeouts.max_min }, stall_minutes: cfg.timeouts.stall_min, provider_max_concurrent: Object.fromEntries(Object.entries(pc.providers).map(([k, v]) => [k, v.max_concurrent || 1])) },
    }
  }

  // ---------- scheduling ----------
  async schedule() {
    if (this.shuttingDown || this.scheduling) return
    this.scheduling = true
    try {
      const cfg = daemonConfig()
      const t0 = Date.now()
      for (const t of this.tasks.values()) {
        if (t.status === "retry_wait" && Date.parse(t.retry_at) <= t0) {
          t.status = "queued"
          this.save(t)
        }
      }
      const queued = [...this.tasks.values()].filter((t) => t.status === "queued").sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
      for (const t of queued) {
        if (this.live.size >= cfg.max_concurrent) break
        let profile
        try {
          profile = this.profile(t.pending_run?.profile || t.profile)
        } catch (e) {
          await this.failFast(t, e.message)
          continue
        }
        const bp = backendProblems(profile, profilesConfig(), cfg)
        if (bp.length) {
          await this.failFast(t, `profile '${profile.name}' cannot run: ${bp.join("; ")}`)
          continue
        }
        const prov = profile.provider
        const provRunning = [...this.live.values()].filter((l) => l.provider === prov).length
        if (provRunning >= (profile.providerCfg.max_concurrent || 1)) continue
        if ((this.cooldown[prov] || 0) > t0) continue
        const missing = this.missingCreds(profile)
        if (missing.length) {
          await this.failFast(t, this.missingCredsMessage(missing))
          continue
        }
        // Memory admission: each worker (e.g. a Kilo process) needs ~1 GB (measured PSS). With other tasks running, wait
        // rather than risk OOM on this shared VM; with none running, start anyway (no deadlock).
        const minMem = cfg.min_mem_available_mb || 0
        if (minMem && this.live.size > 0) {
          const availMb = memAvailableMb()
          if (availMb !== null && availMb < minMem) {
            const phase = `queued: waiting for memory (${availMb} MB available < ${minMem} MB required per worker)`
            if (t.phase !== phase) { t.phase = phase; this.save(t) }
            break
          }
        }
        await this.startRun(t, profile).catch(async (e) => this.failFast(t, `failed to start the ${profile.backend} worker: ${e.message}`))
      }
    } finally {
      this.scheduling = false
    }
  }

  async failFast(t, msg) {
    t.errors.push(msg)
    t.status = "failed"
    this.save(t)
    this.event(t, "failed_fast", { error: msg })
    await this.finalize(t, { tests: false, status: "failed" })
  }

  buildMessage(t, spec) {
    const short = t.base_commit.slice(0, 10)
    const testLine = t.test_command || this.repoSafe(t)?.test_command
    if (spec.kind === "continue") {
      return `Follow-up instructions from the supervisor for task ${t.id}:\n\n${spec.message}\n\nContinue in the same worktree (check \`git status\` / \`git diff\` for what is already done).${testLine ? ` Test command: ${testLine}` : ""}\nEnd with an updated ## RESULT block.`
    }
    if (spec.kind === "retry" || spec.kind === "fallback") {
      if (t.session_id && this.sessionBackend(t) === (spec.backend || t.backend))
        return `The previous attempt stopped because of a model API error. Continue task ${t.id} from where you left off; check \`git status\` / \`git diff\` to see what is already done. End with the ## RESULT block.`
    }
    if (t.mode === "review") {
      const what = t.review_of
        ? `the uncommitted changes in this worktree (they are the output of worker task ${t.review_of}; see \`git diff HEAD\` and \`git status\` for new files)`
        : `the commits on HEAD (${t.base_ref} @ ${short}) relative to the repository default branch (use \`git log\`, \`git merge-base\`, \`git diff <merge-base>..HEAD\`)`
      return `REVIEW TASK ${t.id} (read-only: do not modify, create or delete any files).\n\nReview ${what}.\n\nReviewer instructions from the supervisor:\n${t.task}\n\n${testLine ? `You may run the tests: ${testLine}\n\n` : ""}Report correctness bugs, missing or weak tests, risky or out-of-scope changes and convention violations, citing file:line. Put each finding under concerns (semicolon-separated, most severe first) in the ## RESULT block, set files_changed: none, and put your overall verdict (approve / request changes) in summary.`
    }
    return `Task ${t.id} (delegated by the supervisor):\n\n${t.task}\n\nContext:\n- Repository: ${t.repo}; you are in a dedicated git worktree on branch ${t.branch}, based on ${t.base_ref} @ ${short}.\n- ${testLine ? `Test command: ${testLine} (run it before finishing).` : "No test command was given; discover and run the project's tests if any."}\n- Follow the workhorse contract from your instructions and finish with the ## RESULT block.`
  }

  // Backend that owns t.session_id (tasks created before backends existed: kilo).
  sessionBackend(t) {
    return t.session_backend || t.backend || "kilo"
  }

  repoSafe(t) {
    try {
      return this.repo(t.repo)
    } catch {
      return null
    }
  }

  // Base env for every backend (the adapter adds its own on top): PATH, HOME = the backend's HOME, the
  // sandbox_env extras, the guard inputs and only the secrets this profile's provider needs.
  baseWorkerEnv(profile, bc) {
    const cfg = daemonConfig()
    const secretNames = this.secretNames()
    // Literal substrings the guard refuses in shell commands: the secret store (and its dir / file
    // name) and the daemon's run dir. The outer sandbox hides them anyway; this is a second layer.
    const store = cfg.secret_store_path
    const denyPaths = [dirs.run, store, store && path.dirname(store), store && path.basename(store)].filter((p) => p && p.length >= 6 && p !== "/")
    const env = {
      ...sandboxEnv({ ...cfg, secret_names: secretNames }, "worker_sandbox"),
      PATH: cfg.env_path,
      HOME: bc.home,
      WH_SECRET_NAMES: secretNames.join(","),
      WH_GUARD_DENY_PATHS: JSON.stringify([...new Set(denyPaths)]),
      LANG: "C.UTF-8",
      TERM: "dumb",
      NO_COLOR: "1",
    }
    const secrets = this.secretEnv()
    const provSecrets = {}
    for (const k of profile.providerCfg.requires_env || []) if (secrets[k]) provSecrets[k] = env[k] = secrets[k]
    return { env, provSecrets }
  }

  // Paths every sandbox hides: configured `hide` list, the data dir (run/ token, tasks/, logs/, other
  // worktrees, other tasks' backend data), the repo's main clone and the secret store (file and dir).
  hiddenPaths(cfg, repo) {
    const store = cfg.secret_store_path
    return [...(cfg.worker_sandbox?.hide || []), DATA_DIR, ...Object.values(dirs), repo?.path, store && path.dirname(store), store].filter(Boolean)
  }
  // Toolchain dirs to bind read-only: configured ro_binds + auto-detected Node/backend/PATH dirs, the latter
  // only when they would otherwise be hidden (no point re-binding /usr/bin over itself).
  toolchainBinds(cfg, extra = []) {
    const hide = (cfg.worker_sandbox?.hide || []).map((h) => path.resolve(h))
    const under = (p) => hide.some((h) => p === h || p.startsWith(h + "/"))
    return [...new Set([...extra, ...cfg.toolchain_binds.filter((p) => under(path.resolve(p)))])].filter((p) => fs.existsSync(p))
  }

  // Outer sandbox (lib/sandbox.mjs) for this task's worker process: hide everything in hiddenPaths(),
  // bind back only the toolchain (ro), this task's git common dir (ro), whatever the backend adapter
  // asks for (its config dir ro, its HOME rw, per-task data mounts) and this task's worktree (rw).
  async workerSandboxArgs(t, cfg, extra) {
    const sb = cfg.worker_sandbox || {}
    const repo = this.repoSafe(t)
    const r = await G.git(t.worktree_path, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { allowFail: true })
    const commonDir = r.code === 0 ? r.stdout.trim() : null
    if (!commonDir) throw new Error("cannot resolve the worktree's git dir for the sandbox")
    return outerSandboxArgs({
      hide: this.hiddenPaths(cfg, repo),
      roBinds: [...this.toolchainBinds(cfg, sb.ro_binds || []), ...(extra.roBinds || []), commonDir],
      rwBinds: [...(extra.rwBinds || []), t.worktree_path],
      mounts: extra.mounts || [],
      chdir: t.worktree_path,
    })
  }

  async startRun(t, profile) {
    const cfg = daemonConfig()
    const pc = profilesConfig()
    const spec = t.pending_run || { kind: "initial", profile: profile.name, timeout_min: t.timeout_min }
    const n = t.runs.length + 1
    const dir = this.taskDir(t.id)
    if (!fs.existsSync(t.worktree_path)) throw new Error("worktree is missing")
    const backend = getBackend(profile.backend)
    const bc = cfg.backends[profile.backend]
    const sandboxed = cfg.worker_sandbox?.enabled !== false
    const message = this.buildMessage(t, { ...spec, backend: profile.backend })
    const agent = t.agent
    const { env: baseEnv, provSecrets } = this.baseWorkerEnv(profile, bc)
    // Sessions are backend-specific: resume only a session created by the same backend.
    const resumeSession = t.session_id && spec.kind !== "initial" && this.sessionBackend(t) === profile.backend ? t.session_id : null
    const ctx = {
      t, profile, pc, cfg, bc, repo: this.repoSafe(t), agent, message, resumeSession,
      dataDir: this.backendDataDir(t.id), home: bc.home, sandboxed, secrets: provSecrets,
    }
    ensureDir(ctx.dataDir, 0o700)
    if (bc.home) ensureDir(bc.home, 0o755)
    backend.prepare(ctx)
    const args = backend.command(ctx)
    const env = { ...baseEnv, ...backend.env(ctx) }
    const outFile = path.join(dir, `run-${n}.events.jsonl`)
    const errFile = path.join(dir, `run-${n}.stderr.log`)
    const outFd = fs.openSync(outFile, "a", 0o600)
    const errFd = fs.openSync(errFile, "a", 0o600)
    let child
    try {
      let bin = bc.bin
      let argv = args
      if (sandboxed) {
        argv = [...(await this.workerSandboxArgs(t, cfg, backend.sandbox(ctx))), "--", bc.bin_real || bc.bin, ...args]
        bin = cfg.bwrap
      }
      child = spawn(bin, argv, { cwd: t.worktree_path, env, stdio: ["ignore", outFd, errFd], detached: true })
    } finally {
      fs.closeSync(outFd)
      fs.closeSync(errFd)
    }
    const run = { n, kind: spec.kind, profile: profile.name, backend: profile.backend, model: profile.model, agent, resumed_session: !!resumeSession, started_at: now(), finished_at: null, pid: child.pid, pid_start: null, exit_code: null, signal: null, reason: null, events: 0, errors: [], timeout_min: spec.timeout_min || t.timeout_min }
    run.pid_start = procStart(child.pid)
    t.runs.push(run)
    t.status = "running"
    t.phase = `run ${n} (${spec.kind}) with ${profile.name} [${profile.backend}]`
    t.started_at = t.started_at || now()
    t.pending_run = null
    t.retry_at = null
    t.last_text = t.last_text || null
    this.save(t)
    this.event(t, "run_started", { run: n, run_kind: spec.kind, profile: profile.name, backend: profile.backend, model: profile.model, pid: child.pid })
    this.activity(t, `run ${n} started (${spec.kind}, profile ${profile.name}, backend ${profile.backend}, model ${profile.model})`)
    const live = { child, backend, parseState: {}, provider: profile.provider, outFile, errFile, offset: 0, buf: "", errSize: 0, lastActivity: Date.now(), lastSave: 0, killedFor: null, run }
    this.live.set(t.id, live)
    live.interval = setInterval(() => this.poll(t, live).catch(() => {}), 1000)
    child.on("error", (e) => {
      run.errors.push({ message: `spawn error: ${e.message}` })
    })
    child.on("exit", (code, signal) => {
      this.onExit(t, live, code, signal).catch((e) => audit("error", { where: "onExit", task_id: t.id, error: e.message }))
    })
  }

  async poll(t, live) {
    const cfg = daemonConfig()
    this.drain(t, live)
    try {
      const s = fs.statSync(live.errFile).size
      if (s !== live.errSize) {
        live.errSize = s
        live.lastActivity = Date.now()
      }
    } catch {}
    if (live.killedFor) return
    const elapsedMin = (Date.now() - Date.parse(live.run.started_at)) / 60000
    if (elapsedMin > live.run.timeout_min) {
      live.killedFor = "timeout"
      this.activity(t, `wall-clock timeout (${live.run.timeout_min} min) reached; stopping the worker`)
      await killTree(live.child.pid, cfg.timeouts.kill_grace_sec * 1000)
      return
    }
    if ((Date.now() - live.lastActivity) / 60000 > cfg.timeouts.stall_min) {
      live.killedFor = "stalled"
      this.activity(t, `no activity for ${cfg.timeouts.stall_min} min; stopping the worker`)
      await killTree(live.child.pid, cfg.timeouts.kill_grace_sec * 1000)
      return
    }
    if (Date.now() - live.lastSave > 5000) {
      live.lastSave = Date.now()
      this.save(t)
    }
  }

  drain(t, live) {
    const r = readRange(live.outFile, live.offset, 4 * 1024 * 1024)
    if (!r.content) return
    live.offset = r.next_offset
    live.lastActivity = Date.now()
    const text = live.buf + r.content
    const lines = text.split("\n")
    live.buf = lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      let ev
      try {
        ev = JSON.parse(line)
      } catch {
        continue
      }
      let events = []
      try {
        events = live.backend.parse(ev, live.parseState) || []
      } catch (e) {
        audit("error", { where: "parse", task_id: t.id, error: e.message })
      }
      live.run.events++
      for (const ne of events) this.handleEvent(t, live.run, ne)
    }
  }

  // Normalized backend events (adapters/index.mjs) -> task stats, activity log, errors.
  handleEvent(t, run, ev) {
    const s = t.stats
    switch (ev.type) {
      case "session":
        // The first session id of a run is the task's session (later ids may be subagent sessions).
        // A resumed run keeps the existing one; a fresh run (or another backend) replaces it.
        if (ev.id && !run.session_seen) {
          run.session_seen = true
          if (!run.resumed_session) {
            t.session_id = ev.id
            t.session_backend = run.backend
          }
        }
        break
      case "step": {
        s.turns += ev.turns ?? 1
        const tk = ev.tokens || {}
        for (const k of ["input", "output", "reasoning", "cache_read", "cache_write"]) s.tokens[k] += tk[k] || 0
        s.reported_cost = (s.reported_cost ?? s.kilo_cost ?? 0) + (ev.cost || 0)
        break
      }
      case "tool": {
        s.tool_calls++
        const tool = ev.tool || "?"
        s.by_tool[tool] = (s.by_tool[tool] || 0) + 1
        const inputPreview = head(ev.input || "", 200)
        let outcome = "ok"
        if (!ev.ok) {
          s.tool_errors++
          outcome = "ERROR"
          const err = String(ev.error || "")
          if (BLOCKED_RE.test(err + (ev.output || ""))) {
            s.blocked_calls++
            if (t.blocked.length < 30) t.blocked.push({ tool, input: inputPreview, error: head(err, 300) })
            outcome = "BLOCKED"
          }
        } else if (ev.shell) {
          if (typeof ev.exit === "number" && ev.exit !== 0) {
            s.failed_commands++
            outcome = `exit ${ev.exit}`
          }
          if (/Read-only file system/.test(ev.output || "")) {
            s.blocked_calls++
            if (t.blocked.length < 30) t.blocked.push({ tool, input: inputPreview, error: "sandbox: Read-only file system" })
            outcome = "BLOCKED(sandbox)"
          }
        }
        const out = ev.ok ? ev.output : ev.error
        this.activity(t, `run${run.n} ${tool} ${outcome}: ${inputPreview.replace(/\n/g, " ")} => ${head(String(out || "").replace(/\s+/g, " "), 300)}`)
        break
      }
      case "text":
        if (ev.text?.trim()) {
          t.last_text = ev.text
          this.activity(t, `run${run.n} assistant: ${head(ev.text.replace(/\s+/g, " "), 400)}`)
        }
        break
      case "error": {
        const rec = { message: head(String(ev.message || "error"), 500), statusCode: ev.statusCode ?? null, retryable: !!ev.retryable }
        run.errors.push(rec)
        this.activity(t, `run${run.n} ERROR: ${rec.message}${rec.statusCode ? ` (HTTP ${rec.statusCode})` : ""}`)
        break
      }
    }
  }

  async onExit(t, live, code, signal) {
    clearInterval(live.interval)
    this.drain(t, live)
    this.live.delete(t.id)
    const run = live.run
    Object.assign(run, { finished_at: now(), exit_code: code, signal, reason: live.killedFor || (code === 0 ? "exited" : "error") })
    this.event(t, "run_exited", { run: run.n, exit_code: code, signal, reason: run.reason })
    this.activity(t, `run ${run.n} exited code=${code} signal=${signal || "-"} reason=${run.reason}`)
    if (this.shuttingDown || live.killedFor === "shutdown") {
      t.status = "interrupted"
      t.errors.push("workhorse daemon stopped while this task was running. Use continue_task to resume.")
      this.save(t)
      return
    }
    const cfg = daemonConfig()
    if (live.killedFor === "cancel") return this.finalize(t, { tests: false, status: "cancelled" })
    if (live.killedFor === "timeout" || live.killedFor === "stalled") {
      t.errors.push(live.killedFor === "timeout" ? `wall-clock timeout of ${run.timeout_min} min reached` : `no activity for ${cfg.timeouts.stall_min} min (stalled)`)
      return this.finalize(t, { tests: true, status: live.killedFor })
    }
    if (code === 0) return this.finalize(t, { tests: true, status: "completed" })
    const retryable = run.errors.some((e) => e.retryable)
    if (retryable) {
      const prov = live.provider
      this.cooldown[prov] = Date.now() + cfg.retry.provider_cooldown_sec * 1000
      if (t.retries < cfg.retry.max_retries) {
        const backoff = cfg.retry.backoff_sec[Math.min(t.retries, cfg.retry.backoff_sec.length - 1)]
        t.retries++
        t.status = "retry_wait"
        t.retry_at = new Date(Date.now() + backoff * 1000).toISOString()
        t.phase = `model API error (rate limit / server error); retry ${t.retries}/${cfg.retry.max_retries} at ${t.retry_at}`
        t.pending_run = { kind: "retry", profile: run.profile, timeout_min: run.timeout_min }
        this.save(t)
        this.event(t, "retry_scheduled", { retries: t.retries, backoff_sec: backoff })
        return
      }
      // Fallback chain: the ORIGINAL profile's `fallback` list, tried in order, each profile once.
      let chain = []
      try {
        chain = this.profile(t.pending_profile_origin || t.profile).fallback || []
      } catch {}
      t.fallbacks_tried = t.fallbacks_tried || []
      for (const fb of chain) {
        if (fb === run.profile || t.fallbacks_tried.includes(fb)) continue
        try {
          this.profile(fb)
        } catch {
          continue
        }
        t.fallback_used = true
        t.fallbacks_tried.push(fb)
        t.status = "queued"
        t.phase = `falling back to profile ${fb} after repeated model API errors`
        t.pending_run = { kind: "fallback", profile: fb, timeout_min: run.timeout_min }
        this.save(t)
        this.event(t, "fallback_scheduled", { profile: fb })
        return
      }
    }
    t.errors.push(...run.errors.map((e) => e.message).slice(-5))
    if (!run.errors.length) t.errors.push(`${run.backend || "worker"} exited with code ${code}${signal ? ` (signal ${signal})` : ""}; see task_details kind=stderr`)
    return this.finalize(t, { tests: true, status: "failed" })
  }

  // ---------- finalization ----------
  async runTests(t) {
    const cfg = daemonConfig()
    const repo = this.repoSafe(t)
    let cmd = t.test_command
    let source = "task"
    if (!cmd && repo?.test_command) {
      cmd = repo.test_command
      source = "repo_default"
    }
    if (!cmd) {
      cmd = detectTestCommand(t.worktree_path)
      source = "auto_detected"
    }
    if (!cmd) return { executed: false, reason: "no test command configured or detected" }
    const logFile = path.join(this.taskDir(t.id), "test.log")
    const commonDir = (await G.git(t.worktree_path, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { allowFail: true })).stdout.trim()
    let bin = "/bin/sh"
    let args = ["-c", cmd]
    const env = { ...sandboxEnv({ ...cfg, secret_names: this.secretNames() }, "test_sandbox"), PATH: cfg.env_path, HOME: "/tmp", LANG: "C.UTF-8", CI: "1", PYTHONDONTWRITEBYTECODE: "1" }
    if (cfg.test_sandbox.enabled) {
      // Same hiding as the worker sandbox (data dir, secret store, main clone, /home, /tmp, ...), plus no
      // network (unless the repo sets test_network), a fresh session and a clean env.
      bin = cfg.bwrap
      args = [
        ...(repo?.test_network ? [] : ["--unshare-net"]), "--die-with-parent", "--new-session",
        ...outerSandboxArgs({
          hide: this.hiddenPaths(cfg, repo),
          roBinds: [...this.toolchainBinds(cfg, cfg.test_sandbox.ro_binds || []), ...(commonDir && fs.existsSync(commonDir) ? [commonDir] : [])],
          rwBinds: [t.worktree_path],
          chdir: t.worktree_path,
        }),
        "--clearenv",
      ]
      for (const [k, v] of Object.entries(env)) args.push("--setenv", k, v)
      args.push("--", "/bin/sh", "-c", cmd)
    }
    const started = Date.now()
    const res = await new Promise((resolve) => {
      const out = []
      let size = 0
      const child = spawn(bin, args, { cwd: t.worktree_path, env, stdio: ["ignore", "pipe", "pipe"], detached: true })
      const onData = (d) => {
        size += d.length
        if (size < 2 * 1024 * 1024) out.push(d)
      }
      child.stdout.on("data", onData)
      child.stderr.on("data", onData)
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        killTree(child.pid, 3000)
      }, cfg.timeouts.test_min * 60000)
      child.on("error", (e) => out.push(Buffer.from(`\n[workhorse] failed to start tests: ${e.message}\n`)))
      child.on("close", (code, signal) => {
        clearTimeout(timer)
        resolve({ code, signal, timedOut, output: Buffer.concat(out).toString("utf8") })
      })
    })
    const output = redact(res.output)
    fs.writeFileSync(logFile, `$ ${cmd}\n# sandbox=${cfg.test_sandbox.enabled} network=${!!repo?.test_network}\n${output}\n# exit=${res.code} signal=${res.signal || "-"} timed_out=${res.timedOut}\n`)
    const counts = parseTestOutput(output)
    return {
      executed: true, command: cmd, source, sandboxed: cfg.test_sandbox.enabled, exit_code: res.code, timed_out: res.timedOut,
      passed: res.code === 0 && !res.timedOut, counts, duration_s: Math.round((Date.now() - started) / 100) / 10,
      ...(res.code === 0 && !res.timedOut ? {} : { failing_tests: extractFailingTests(output) }),
      tail: tail(output, cfg.limits.test_tail_chars),
    }
  }

  async finalize(t, { tests, status }) {
    const cfg = daemonConfig()
    t.pending_final_status = status
    t.status = tests ? "testing" : "finalizing"
    t.phase = tests ? "running tests and collecting diff" : "collecting diff"
    this.save(t)
    const dir = this.taskDir(t.id)
    const errors = [...(t.errors || [])]
    let diff = { patch: "", files: [], shortstat: "no changes" }
    let commits = 0
    let mainUnchanged = null
    let testRes = { executed: false, reason: tests ? "not run" : "skipped for this status" }
    try {
      if (fs.existsSync(t.worktree_path)) {
        diff = await G.collectDiff(t.worktree_path, t.base_commit, path.join(dir, "tmp.index"))
        fs.writeFileSync(path.join(dir, "diff.patch"), diff.patch)
        commits = await G.commitsSince(t.worktree_path, t.base_commit)
      }
      const repo = this.repoSafe(t)
      if (repo) {
        const fp = await G.mainCloneFingerprint(repo.path)
        mainUnchanged = fp.head === t.main_fingerprint.head && fp.status === t.main_fingerprint.status && fp.branches === t.main_fingerprint.branches
      }
    } catch (e) {
      errors.push(`diff collection failed: ${e.message}`)
    }
    if (tests && fs.existsSync(t.worktree_path)) {
      t.phase = "running tests"
      this.save(t)
      try {
        testRes = await this.runTests(t)
      } catch (e) {
        testRes = { executed: false, reason: `test run failed: ${e.message}` }
      }
    }
    fs.writeFileSync(path.join(dir, "final_message.txt"), redact(t.last_text || ""))
    const worker = parseResultBlock(t.last_text || "")
    const concerns = []
    if (worker?.concerns && !/^none\.?$/i.test(worker.concerns.trim())) concerns.push(...worker.concerns.split(/;\s*/).map((s) => s.trim()).filter(Boolean))
    if (testRes.executed && !testRes.passed) concerns.push(`daemon-run tests failed (exit ${testRes.exit_code}); see task_details kind=test_log`)
    if (t.stats.blocked_calls) concerns.push(`${t.stats.blocked_calls} tool call(s) were blocked by policy/sandbox (see task_details kind=activity)`)
    if (commits) concerns.push(`INTEGRITY: ${commits} commit(s) were created on ${t.branch} (workers must not commit)`)
    if (mainUnchanged === false) concerns.push("INTEGRITY: the main clone's HEAD/status/branches changed during the task")
    if (worker?.status && worker.status !== "done") concerns.push(`worker reported status '${worker.status}'`)
    if (!worker && status === "completed") concerns.push("worker did not end with the required ## RESULT block")
    if (t.fallback_used) concerns.push("fallback profile was used after repeated model API errors")
    let reviewTouched = false
    if (t.mode === "review" && t.reviewed_patch_sha) reviewTouched = crypto.createHash("sha256").update(diff.patch).digest("hex") !== t.reviewed_patch_sha
    if (reviewTouched) concerns.push("review agent modified files in its review worktree (the reviewed task's worktree is untouched)")
    let verdict
    if (commits || mainUnchanged === false) verdict = "integrity_violation"
    else if (status !== "completed") verdict = status === "failed" ? "worker_error" : status
    else if (worker?.status === "blocked" || PARK_STATES.has(worker?.status)) verdict = "blocked"
    else if (t.mode === "implement" && diff.files.length === 0) verdict = "no_changes"
    else if (testRes.executed) verdict = testRes.passed ? "success" : "tests_failed"
    else verdict = "success_untested"
    const pc = (() => {
      try {
        return this.profile(t.runs[t.runs.length - 1]?.profile || t.profile)
      } catch {
        return {}
      }
    })()
    const price = pc.price_per_mtok || null
    const est = price ? ((t.stats.tokens.input + t.stats.tokens.cache_read) * (price.input || 0) + (t.stats.tokens.output + t.stats.tokens.reasoning) * (price.output || 0)) / 1e6 : null
    // Park the task for a human when the worker asks for approval/input, or reports blocked with a concrete
    // request or after policy/sandbox-blocked tool calls (an action it considers necessary).
    let finalStatus = status
    if (verdict === "blocked" && (PARK_STATES.has(worker?.status) || (worker?.status === "blocked" && (hasText(worker.needs) || t.stats.blocked_calls > 0)))) finalStatus = "needs_approval"
    const first = t.runs[0]
    const last = t.runs[t.runs.length - 1]
    const finishedAt = now()
    status = finalStatus
    t.status = status
    t.finished_at = finishedAt
    t.phase = "finished"
    t.result = redact({
      task_id: t.id, session_id: t.session_id, status, verdict, mode: t.mode, repo: t.repo, profile: last?.profile || t.profile, backend: last?.backend || t.backend || "kilo",
      worker_model: last?.model || t.model, agent: t.agent, review_of: t.review_of || undefined,
      summary: head(worker?.summary || (t.last_text || "").trim() || "(no final message from worker)", cfg.limits.summary_max_chars),
      worker_reported: worker ? { status: worker.status, files_changed: worker.files_changed, tests: worker.tests, ...(hasText(worker.needs) ? { needs: head(worker.needs.trim(), 500) } : {}) } : null,
      files_changed: t.mode === "review" && !reviewTouched ? [] : diff.files, reviewed_files: t.mode === "review" ? diff.files : undefined, diffstat: diff.shortstat, diff_path: path.join(dir, "diff.patch"), diff_bytes: Buffer.byteLength(diff.patch),
      worktree_path: t.worktree_removed ? null : t.worktree_path, branch: t.branch, base_ref: t.base_ref, base_commit: t.base_commit,
      tests_executed: [testRes.executed ? { command: testRes.command, by: "daemon", source: testRes.source, sandboxed: testRes.sandboxed } : null, worker?.tests ? { command: worker.tests, by: "worker (self-reported)" } : null].filter(Boolean),
      test_results: testRes,
      errors: [...new Set(errors)].slice(-10),
      remaining_concerns: concerns,
      integrity: { commits_made: commits, main_clone_unchanged: mainUnchanged, pushed: false },
      timings: {
        created_at: t.created_at, started_at: t.started_at, finished_at: finishedAt,
        queue_s: first ? Math.round((Date.parse(first.started_at) - Date.parse(t.created_at)) / 1000) : null,
        worker_s: t.runs.reduce((a, r) => a + (r.finished_at ? (Date.parse(r.finished_at) - Date.parse(r.started_at)) / 1000 : 0), 0),
        tests_s: testRes.duration_s ?? 0,
        total_s: t.started_at ? Math.round((Date.parse(finishedAt) - Date.parse(t.created_at)) / 1000) : 0,
      },
      usage: { tokens: t.stats.tokens, backend_reported_cost_usd: Math.round((t.stats.reported_cost ?? t.stats.kilo_cost ?? 0) * 1e6) / 1e6, estimated_list_cost_usd: est === null ? null : Math.round(est * 1e6) / 1e6, pricing_note: pc.price_note || null },
      activity: { turns: t.stats.turns, tool_calls: t.stats.tool_calls, tool_errors: t.stats.tool_errors, failed_commands: t.stats.failed_commands, blocked_calls: t.stats.blocked_calls, by_tool: t.stats.by_tool, runs: t.runs.length, retries: t.retries, fallback_used: t.fallback_used, fallbacks_tried: t.fallbacks_tried || [] },
      blocked_examples: t.blocked.slice(0, 5),
      details_hint: "task_details kinds: activity, diff, test_log, final_message, raw_events, stderr",
    })
    t.errors = []
    delete t.parked_from
    t.handoff = redact(deriveHandoff(t, { at: finishedAt }))
    this.save(t)
    this.event(t, "finished", { verdict, files: diff.files.length, tests_passed: testRes.passed ?? null, handoff_state: t.handoff.state, owner: t.handoff.owner })
    if (PARKED.has(t.status)) this.event(t, "parked", { handoff_state: t.handoff.state, request: t.handoff.context?.worker_request || null })
    this.schedule().catch(() => {})
  }

  async shutdown() {
    this.shuttingDown = true
    clearInterval(this.timer)
    clearInterval(this.sweepTimer)
    const cfg = daemonConfig()
    await Promise.all(
      [...this.live.entries()].map(async ([id, live]) => {
        live.killedFor = "shutdown"
        await killTree(live.child.pid, cfg.timeouts.kill_grace_sec * 1000)
        const t = this.tasks.get(id)
        if (t && t.status === "running") {
          t.status = "interrupted"
          t.errors.push("workhorse daemon stopped while this task was running. Use continue_task to resume.")
          Object.assign(live.run, { finished_at: now(), reason: "shutdown" })
          this.save(t)
          this.event(t, "interrupted_on_shutdown")
        }
      }),
    )
  }
}

export function detectTestCommand(wt) {
  const has = (f) => fs.existsSync(path.join(wt, f))
  if (has("package.json")) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(wt, "package.json"), "utf8"))
      if (pkg.scripts?.test && !/no test specified/.test(pkg.scripts.test)) return "npm test --silent"
    } catch {}
  }
  if (has("pytest.ini") || has("conftest.py") || (has("pyproject.toml") && /pytest/.test(fs.readFileSync(path.join(wt, "pyproject.toml"), "utf8")))) return "python3 -m pytest -q"
  if (has("tests") && fs.readdirSync(path.join(wt, "tests")).some((f) => /^test.*\.py$/.test(f))) return "python3 -m unittest discover -s tests -v"
  if (has("go.mod")) return "go test ./..."
  if (has("Cargo.toml")) return "cargo test"
  return null
}
