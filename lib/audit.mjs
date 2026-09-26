// Append-only JSONL audit log of every RPC/tool call and task lifecycle event. Never contains secrets:
// task text is truncated and hashed, everything passes through redact().
import fs from "node:fs"
import path from "node:path"
import { dirs } from "./config.mjs"
import { now, redact, sha256, head } from "./util.mjs"

const AUDIT = () => path.join(dirs.logs, "audit.jsonl")

export function audit(kind, data) {
  try {
    fs.appendFileSync(AUDIT(), JSON.stringify(redact({ ts: now(), kind, ...data })) + "\n", { mode: 0o600 })
  } catch {
    /* audit must never crash the daemon */
  }
}

export function sanitizeParams(method, params) {
  if (method === "offer_env") return { names: Object.keys(params?.env || {}) }
  const p = { ...(params || {}) }
  for (const k of ["task", "instructions"]) {
    if (typeof p[k] === "string") {
      p[`${k}_sha256`] = sha256(p[k])
      p[`${k}_chars`] = p[k].length
      p[k] = head(p[k], 200)
    }
  }
  return p
}
