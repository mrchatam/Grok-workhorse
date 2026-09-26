// Optional credential fallback: fills secret names (provider api_key_env + daemon.json secret_env)
// that are missing from the environment from a local JSON secret store (daemon.json
// secret_store_path, mode 0600). Platform-dependent: e.g. an agent platform that keeps user secrets
// in a JSON file on the machine (Grok Bot's box secret store uses {version, card:{NAME: value}, ...}).
// The primary and recommended source is still the environment (or the MCP connector's env).
// - Only the requested names are extracted; the rest of the parsed store is dropped immediately.
// - Values stay in daemon memory only; callers must registerSecret() them for redaction.
// - Nothing here ever returns store content in an error message (JSON.parse messages can quote
//   the input, so they are never propagated).
import fs from "node:fs"

// Sections searched (in this order) when the name is not a top-level string. "card" is the Grok Bot
// store layout ({version, desktop:{}, card:{NAME: value}, generation}); the others cover common
// layouts ({NAME: value}, {secrets:{...}}, [{name, value}], {NAME: {value}}).
const SECTIONS = ["card", "secrets", "env", "credentials", "values", "desktop"]
const VALUE_KEYS = ["value", "secret", "key", "token"]
const MAX_STORE_BYTES = 1024 * 1024

function asValue(v) {
  if (typeof v === "string") return v.trim() || null
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const k of VALUE_KEYS) if (typeof v[k] === "string" && v[k].trim()) return v[k].trim()
  }
  return null
}

function fromArray(arr, name) {
  for (const e of arr) {
    if (!e || typeof e !== "object" || ![e.name, e.id, e.key].includes(name)) continue
    for (const k of ["value", "secret", "token"]) if (typeof e[k] === "string" && e[k].trim()) return e[k].trim()
  }
  return null
}

// Returns { value, location } or null. location is a names-only path like "card.MY_API_KEY".
export function extractSecret(store, name, depth = 0) {
  if (!store || typeof store !== "object" || depth > 3) return null
  if (Array.isArray(store)) {
    const v = fromArray(store, name)
    return v ? { value: v, location: `[name=${name}]` } : null
  }
  if (Object.hasOwn(store, name)) {
    const v = asValue(store[name])
    if (v) return { value: v, location: name }
  }
  const keys = [...SECTIONS.filter((s) => Object.hasOwn(store, s)), ...Object.keys(store).filter((k) => !SECTIONS.includes(k))]
  for (const k of keys) {
    const child = store[k]
    if (!child || typeof child !== "object") continue
    const r = extractSecret(child, name, depth + 1)
    if (r) return { value: r.value, location: `${k}.${r.location}` }
  }
  return null
}

// Load the given names from the store. Returns { values: {name: value}, missing: {name: reason}, warnings: [] }.
export function loadFromStore(storePath, names) {
  const out = { values: {}, missing: {}, warnings: [] }
  const fail = (reason) => {
    for (const n of names) out.missing[n] = reason
    return out
  }
  if (!storePath) return fail("no secret_store_path configured")
  let st
  try {
    st = fs.statSync(storePath)
  } catch (e) {
    return fail(e.code === "ENOENT" ? `secret store ${storePath} does not exist` : `secret store ${storePath} is not accessible (${e.code || "error"})`)
  }
  if (!st.isFile()) return fail(`secret store ${storePath} is not a regular file`)
  if (st.size > MAX_STORE_BYTES) return fail(`secret store ${storePath} is larger than ${MAX_STORE_BYTES} bytes`)
  if (st.mode & 0o077) out.warnings.push(`secret store ${storePath} is readable/writable by group or others (mode ${(st.mode & 0o777).toString(8)}); expected 0600`)
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(storePath, "utf8"))
  } catch (e) {
    // Never include e.message: it can quote store content.
    return fail(e.code ? `secret store ${storePath} is not readable (${e.code})` : `secret store ${storePath} is not valid JSON`)
  }
  for (const n of names) {
    const r = extractSecret(parsed, n)
    if (r && r.value.length < 4096) out.values[n] = r.value
    else out.missing[n] = `entry ${n} not present in secret store ${storePath}`
  }
  parsed = null
  return out
}
