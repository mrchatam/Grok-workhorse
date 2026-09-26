// Operator confirmation for approvals (daemon.json approvals.require_operator).
//
// With require_operator on, approve_task from the MCP supervisor only RECORDS an approval request; a
// human confirms it with `sudo workhorse approve <task_id>`, which reads the operator token file and
// sends the token along. The daemon stores only the token's SHA-256 (approvals.operator_token_sha256),
// so neither the supervisor (which never sees the file) nor the daemon config can produce it.
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { CONFIG_DIR } from "./config.mjs"

export const TOKEN_RE = /^[0-9a-f]{64}$/

export function operatorTokenPath(cfg) {
  return cfg?.approvals?.operator_token_path || path.join(CONFIG_DIR, "operator.token")
}

export function hashToken(tok) {
  return crypto.createHash("sha256").update(String(tok).trim()).digest("hex")
}

export function newOperatorToken() {
  return crypto.randomBytes(32).toString("hex")
}

// True when `given` hashes to the configured sha256 (constant-time compare).
export function checkOperatorToken(cfg, given) {
  const want = String(cfg?.approvals?.operator_token_sha256 || "").toLowerCase()
  if (!TOKEN_RE.test(want) || typeof given !== "string" || !given) return false
  const a = Buffer.from(hashToken(given), "hex")
  const b = Buffer.from(want, "hex")
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export function requireOperator(cfg) {
  return cfg?.approvals?.require_operator === true
}

// Read the operator token file (CLI side). Returns null when absent/unreadable.
export function readOperatorToken(cfg) {
  try {
    const v = fs.readFileSync(operatorTokenPath(cfg), "utf8").trim()
    return TOKEN_RE.test(v) ? v : null
  } catch {
    return null
  }
}
