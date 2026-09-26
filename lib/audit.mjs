// Append-only JSONL audit log of every RPC/tool call and task lifecycle event. Never contains secrets:
// task text is truncated and hashed, everything passes through redact().
import fs from "node:fs"
import path from "node:path"
import { dirs } from "./config.mjs"
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

export function audit(kind, data) {
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
  return p
}
