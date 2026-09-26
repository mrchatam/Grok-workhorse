// Shared helpers for worker backend adapters (see ./index.mjs for the adapter interface).
import fs from "node:fs"
import path from "node:path"
import { APP_DIR } from "../lib/config.mjs"
import { head } from "../lib/util.mjs"

// The worker contract (rules + the ## RESULT block format) every backend must receive as instructions.
// It lives in the Kilo config dir because Kilo/OpenCode load AGENTS.md from their config dir; other
// adapters pass its text through their own system-prompt / instructions mechanism.
export const CONTRACT_PATH = path.join(APP_DIR, "adapters", "kilo", "config", "AGENTS.md")
export function contractText() {
  try {
    return fs.readFileSync(CONTRACT_PATH, "utf8")
  } catch {
    return ""
  }
}

export function deepMerge(a, b) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return b === undefined ? a : b
  const out = { ...(a || {}) }
  for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === "object" && !Array.isArray(v) ? deepMerge(out[k], v) : v
  return out
}

// "<providerKey>/<modelKey>" -> the provider-side model id from profiles.json (falls back to modelKey).
export function modelId(pc, model) {
  const [pk, ...rest] = String(model || "").split("/")
  const mk = rest.join("/")
  return { providerKey: pk, modelKey: mk, id: pc.providers?.[pk]?.models?.[mk]?.id || mk, provider: pc.providers?.[pk] || {} }
}

// Repo rule files loaded as plain-text instructions when project config is not trusted.
export function repoRuleFiles(worktree) {
  return ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"].map((f) => path.join(worktree, f)).filter((f) => fs.existsSync(f))
}

// Heuristic for "the model API failed in a way worth retrying" in free-text error messages.
export function retryableText(msg) {
  return /\b(429|5\d\d)\b|rate.?limit|overloaded|temporarily unavailable|timeout|ECONNRESET|socket hang up/i.test(String(msg || ""))
}

// Real paths of symlinked top-level entries of a config dir (e.g. adapters/opencode/config/skills -> ../../kilo/config/skills),
// so the sandbox can bind their targets too.
export function symlinkTargets(dir) {
  const out = []
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isSymbolicLink()) continue
      try {
        out.push(fs.realpathSync(path.join(dir, e.name)))
      } catch {}
    }
  } catch {}
  return out
}

export const preview = (s, n = 200) => head(String(s ?? ""), n)
