// workhorse daemon: JSON-RPC over HTTP on a unix socket (0600, in a 0700 dir) + bearer token file (0600).
import fs from "node:fs"
import http from "node:http"
import crypto from "node:crypto"
import { dirs, SOCKET_PATH, TOKEN_PATH } from "./config.mjs"
import { ensureDir, redact, registerSecret } from "./util.mjs"
import { audit, sanitizeParams } from "./audit.mjs"
import { Manager, UserError } from "./tasks.mjs"
import { daemonConfig, secretEnvNames, VERSION } from "./config.mjs"

export async function startDaemon() {
  ensureDir(dirs.run, 0o700)
  fs.chmodSync(dirs.run, 0o700)
  for (const d of [dirs.tasks, dirs.logs, dirs.worktrees, dirs.repos]) ensureDir(d)
  let token
  if (fs.existsSync(TOKEN_PATH)) token = fs.readFileSync(TOKEN_PATH, "utf8").trim()
  if (!token || token.length < 32) {
    token = crypto.randomBytes(32).toString("hex")
    fs.writeFileSync(TOKEN_PATH, token + "\n", { mode: 0o600 })
  }
  fs.chmodSync(TOKEN_PATH, 0o600)
  const tokenBuf = Buffer.from(token)
  for (const k of secretEnvNames(daemonConfig())) if (process.env[k]) registerSecret(process.env[k])

  const mgr = new Manager()
  mgr.loadStoreCredentials("startup")
  await mgr.init()

  const methods = {
    health: () => ({ ok: true, version: VERSION, pid: process.pid, running: mgr.live.size, tasks: mgr.tasks.size, credentials: Object.keys(mgr.secretEnv()), credential_sources: mgr.credentialSources() }),
    health_report: () => ({ ok: true, ...mgr.healthReport(), credential_sources: mgr.credentialSources() }),
    cleanup_old: (p) => mgr.sweep({ worktree_days: p.worktree_days, task_days: p.task_days, dry_run: p.dry_run === true, trigger: "manual" }),
    offer_env: (p) => mgr.offerEnv(p.env),
    delegate_task: (p) => mgr.delegate(p),
    task_status: (p) => mgr.status(p.task_id),
    task_result: (p) => mgr.result(p.task_id),
    task_details: (p) => mgr.details(p.task_id, p.kind, p.offset, p.max_bytes, p.run),
    continue_task: (p) => mgr.continueTask(p.task_id, p.instructions, p.timeout_minutes, p.profile),
    cancel_task: (p) => mgr.cancel(p.task_id),
    list_tasks: (p) => mgr.list(p),
    cleanup_task: (p) => mgr.cleanup(p.task_id, p.discard_unmerged_changes),
    list_repos: () => mgr.listRepos(),
    list_models: () => mgr.listModels(),
  }

  const server = http.createServer((req, res) => {
    const send = (code, obj) => {
      const body = JSON.stringify(redact(obj))
      res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body) })
      res.end(body)
    }
    const auth = String(req.headers.authorization || "")
    const given = Buffer.from(auth.startsWith("Bearer ") ? auth.slice(7) : "")
    if (given.length !== tokenBuf.length || !crypto.timingSafeEqual(given, tokenBuf)) {
      audit("rpc_denied", { reason: "bad token" })
      return send(401, { error: "unauthorized" })
    }
    if (req.method !== "POST" || req.url !== "/rpc") return send(404, { error: "not found" })
    let size = 0
    const chunks = []
    req.on("data", (c) => {
      size += c.length
      if (size > 512 * 1024) req.destroy()
      else chunks.push(c)
    })
    req.on("end", async () => {
      let msg
      try {
        msg = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      } catch {
        return send(400, { error: "invalid JSON" })
      }
      const { method, params = {}, caller = null } = msg || {}
      const fn = typeof method === "string" && Object.hasOwn(methods, method) ? methods[method] : null
      if (!fn) return send(400, { error: `unknown method ${String(method).slice(0, 40)}` })
      const started = Date.now()
      try {
        const result = await fn(params || {})
        if (method !== "health" && method !== "health_report" && !(method === "offer_env" && !result?.changed)) audit("rpc", { method, caller, params: sanitizeParams(method, params), ok: true, ms: Date.now() - started, task_id: params?.task_id || result?.task_id })
        send(200, { result })
      } catch (e) {
        const user = e instanceof UserError
        audit("rpc", { method, caller, params: sanitizeParams(method, params), ok: false, error: e.message, ms: Date.now() - started })
        send(user ? 400 : 500, { error: e.message, kind: user ? "invalid_request" : "internal" })
      }
    })
  })

  try {
    fs.unlinkSync(SOCKET_PATH)
  } catch {}
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    const old = process.umask(0o177)
    server.listen(SOCKET_PATH, () => {
      process.umask(old)
      resolve()
    })
  })
  fs.chmodSync(SOCKET_PATH, 0o600)
  audit("daemon", { event: "started", pid: process.pid, credentials: Object.keys(mgr.secretEnv()), credential_sources: mgr.credentialSources() })

  const stop = async (sig) => {
    audit("daemon", { event: "stopping", signal: sig })
    server.close()
    await mgr.shutdown()
    try {
      fs.unlinkSync(SOCKET_PATH)
    } catch {}
    process.exit(0)
  }
  process.on("SIGTERM", () => stop("SIGTERM"))
  process.on("SIGINT", () => stop("SIGINT"))
  process.on("uncaughtException", (e) => audit("error", { where: "uncaught", error: e.stack?.slice(0, 1000) }))
  process.on("unhandledRejection", (e) => audit("error", { where: "unhandledRejection", error: String(e?.stack || e).slice(0, 1000) }))
  return { server, mgr }
}
