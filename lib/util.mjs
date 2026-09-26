import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { execFile } from "node:child_process"

export const now = () => new Date().toISOString()

export function writeJsonAtomic(file, obj) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString("hex")}`
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

export function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

// Secrets registry: values here are scrubbed from anything we persist or return.
const secretValues = new Set()
export function registerSecret(v) {
  if (typeof v === "string" && v.length >= 8) secretValues.add(v)
}
export function redact(value) {
  if (typeof value === "string") {
    let s = value
    for (const v of secretValues) if (s.includes(v)) s = s.split(v).join("[REDACTED]")
    s = s.replace(/\b(nvapi-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,})/g, "[REDACTED]")
    return s
  }
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === "object") {
    const o = {}
    for (const [k, v] of Object.entries(value)) o[k] = /authorization|api[_-]?key|token|secret|password/i.test(k) && typeof v === "string" ? "[REDACTED]" : redact(v)
    return o
  }
  return value
}

export function sha256(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex")
}

export function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout: opts.timeout || 120000, ...opts }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr), err })
    })
  })
}

export function tail(s, n) {
  if (!s) return ""
  return s.length > n ? "…" + s.slice(-n) : s
}

export function head(s, n) {
  if (!s) return ""
  return s.length > n ? s.slice(0, n) + "…" : s
}

export function readRange(file, offset, maxBytes) {
  let fd
  try {
    fd = fs.openSync(file, "r")
  } catch {
    return { content: "", offset, next_offset: offset, total_bytes: 0, eof: true, missing: true }
  }
  try {
    const total = fs.fstatSync(fd).size
    const start = Math.max(0, Math.min(offset, total))
    const len = Math.max(0, Math.min(maxBytes, total - start))
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, start)
    return { content: buf.toString("utf8"), offset: start, next_offset: start + len, total_bytes: total, eof: start + len >= total }
  } finally {
    fs.closeSync(fd)
  }
}

export function ensureDir(d, mode = 0o700) {
  fs.mkdirSync(d, { recursive: true, mode })
  return d
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
