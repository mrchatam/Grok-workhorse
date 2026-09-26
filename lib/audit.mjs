// Append-only JSONL audit log of every RPC/tool call and task lifecycle event. Never contains secrets:
// task text is truncated and hashed, everything passes through redact().
import fs from "node:fs"
import path from "node:path"
import { dirs, daemonConfig } from "./config.mjs"
import { now, redact, sha256, head } from "./util.mjs"

const AUDIT = () => path.join(dirs.logs, "audit.jsonl")

// Merge event data into a record whose reserved fields must not be overwritten: the reserved values win
// and a conflicting data key is kept as `data_<key>` (so nothing is lost and nothing is clobbered).
export function withReserved(reserved, data) {
  const out = { ...reserved }
  for (const [k, v] of Object.entries(data || {})) {
    if (!Object.hasOwn(reserved, k)) out[k] = v
    else if (v !== reserved[k]) out[`data_${k}`] = v
  }
  return out
}

// Build one audit record. `ts` and `kind` are reserved.
export function auditRecord(kind, data) {
  return redact(withReserved({ ts: now(), kind }, data))
}

// Size-based rotation: audit.jsonl -> audit.jsonl.1 -> ... -> audit.jsonl.<keep> (the oldest is dropped).
// daemon.json audit: { max_mb (default 20; 0 = never rotate), keep (default 5) }. Checked on the first
// write and then every 200 writes, so the cost is one stat per 200 records.
let writes = 0
export function rotateAudit({ file = AUDIT(), maxBytes, keep } = {}) {
  let lim = maxBytes
  let k = keep
  if (lim === undefined || k === undefined) {
    let a = {}
    try {
      a = daemonConfig().audit || {}
    } catch {}
    if (lim === undefined) lim = (a.max_mb ?? 20) * 1024 * 1024
    if (k === undefined) k = a.keep ?? 5
  }
  k = Math.max(1, Math.min(50, Math.floor(Number(k) || 5)))
  if (!(lim > 0)) return false
  let size = 0
  try {
    size = fs.statSync(file).size
  } catch {
    return false
  }
  if (size < lim) return false
  try {
    fs.rmSync(`${file}.${k}`, { force: true })
  } catch {}
  for (let i = k - 1; i >= 1; i--) {
    try {
      fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`)
    } catch {}
  }
  fs.renameSync(file, `${file}.1`)
  return true
}

export function audit(kind, data) {
  try {
    if (writes++ % 200 === 0) rotateAudit()
  } catch {}
  try {
    fs.appendFileSync(AUDIT(), JSON.stringify(auditRecord(kind, data)) + "\n", { mode: 0o600 })
  } catch {
    /* audit must never crash the daemon */
  }
}

export function sanitizeParams(method, params) {
  if (method === "offer_env") return { names: Object.keys(params?.env || {}) }
  const p = { ...(params || {}) }
  for (const k of ["task", "instructions", "next_action", "note"]) {
    if (typeof p[k] === "string") {
      p[`${k}_sha256`] = sha256(p[k])
      p[`${k}_chars`] = p[k].length
      p[k] = head(p[k], 200)
    }
  }
  if (p.operator_token !== undefined) p.operator_token = "[given]"
  if (Array.isArray(p.tasks)) p.tasks = p.tasks.slice(0, 20).map((t) => (t && typeof t === "object" ? sanitizeParams(method, t) : t))
  return p
}
