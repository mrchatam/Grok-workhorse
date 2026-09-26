// Opt-in token savers for worker runs (see docs/token-savings.md). All off by default.
//
// daemon.json (defaults for every profile; a profile in profiles.json may override with its own
// `token_savers` object):
//   "token_savers": {
//     "terse": "off" | "lite" | "full",          // worker prose style: fewer output tokens
//     "minimal_code": "off" | "lite" | "full",   // smallest-diff bias: fewer output tokens, smaller diffs
//     "rtk": { "enabled": false, "bin": null }   // rewrite worker shell commands through RTK
//   }
//
// terse and minimal_code are short instruction fragments appended to the worker's task message. They
// are our own wording, inspired by Caveman (github.com/JuliusBrussee/caveman, MIT outside its BSL engine dirs) and
// Ponytail (github.com/DietrichGebert/ponytail, MIT); no code or text is copied from either project
// (see NOTICE). rtk runs RTK (github.com/rtk-ai/rtk, Apache-2.0) as an external binary: the guard
// plugin asks `rtk rewrite` for a compact equivalent of each bash command the worker runs (e.g.
// `git status` -> `rtk git status`). The daemon's own test run never goes through any of this.
import fs from "node:fs"
import path from "node:path"
import { which } from "./config.mjs"

export const LEVELS = ["off", "lite", "full"]
export const DEFAULT_SAVERS = { terse: "off", minimal_code: "off", rtk: { enabled: false, bin: null } }

const level = (v) => (v === true ? "lite" : v === false || v == null ? "off" : LEVELS.includes(v) ? v : "off")

// Effective savers for a run: daemon.json token_savers, then the profile's token_savers.
export function effectiveSavers(cfg, profile = {}) {
  const d = cfg?.token_savers || {}
  const p = profile?.token_savers || {}
  const rtk = { ...DEFAULT_SAVERS.rtk, ...(typeof d.rtk === "object" ? d.rtk : { enabled: d.rtk === true }), ...(typeof p.rtk === "object" ? p.rtk : p.rtk === undefined ? {} : { enabled: p.rtk === true }) }
  return {
    terse: level(p.terse ?? d.terse),
    minimal_code: level(p.minimal_code ?? d.minimal_code),
    rtk: { enabled: rtk.enabled === true, bin: typeof rtk.bin === "string" && rtk.bin ? rtk.bin : null },
  }
}

// Absolute path of the rtk binary, or null.
export function rtkBin(s, envPath) {
  if (!s?.rtk?.enabled) return null
  const b = s.rtk.bin || which("rtk", envPath || process.env.PATH || "")
  if (!b || !path.isAbsolute(b)) return null
  try {
    fs.accessSync(b, fs.constants.X_OK)
    return b
  } catch {
    return null
  }
}

const TERSE = {
  lite: "Output style (token saver): keep prose short. Do not narrate what you are about to do, do not restate the task or echo tool output back, no pleasantries. Short sentences are fine. Never shorten code, commands, paths, numbers, error messages or negations. The final ## RESULT block keeps its exact format and all fields; its summary stays clear and complete.",
  full: "Output style (token saver): minimal prose. No narration between tool calls, no restating the task, no recap of tool output, no pleasantries; use terse fragments. Never shorten code, commands, paths, numbers, error messages or negations. The final ## RESULT block keeps its exact format and all fields; summary: at most two short, precise sentences.",
}

const MINIMAL = {
  lite: "Code style (token saver): make the smallest change that fully solves the task. Before writing code, check in order: is it needed at all; does the standard library, the platform or an already-installed dependency do it; can it be a one-line change. Reuse existing helpers. Do not add dependencies, abstractions with a single user, configuration for fixed values or scaffolding for later. Prefer deleting code to adding it when that solves the task. Never drop input validation at trust boundaries, error handling that prevents data loss, security checks, tests the task asks for, or anything explicitly requested. The repository's conventions win over these rules.",
  full: "Code style (token saver): shortest correct diff wins. Before writing code, check in order: is it needed at all; does the standard library, the platform or an already-installed dependency do it; can it be a one-line change. Reuse existing helpers; no new dependencies, no single-use abstractions, no configuration for fixed values, no scaffolding for later; delete rather than add where that solves the task. Never drop input validation at trust boundaries, error handling that prevents data loss, security checks, tests the task asks for, or anything explicitly requested. The repository's conventions win over these rules. List anything you deliberately left out under concerns as 'skipped: <what>, add when <condition>'.",
}

// Instruction fragments appended to a worker message (empty string when all prompt savers are off).
// minimal_code does not apply to read-only review tasks.
export function saverFragments(s, mode = "implement") {
  const parts = []
  if (s?.terse && s.terse !== "off") parts.push(TERSE[s.terse])
  if (mode !== "review" && s?.minimal_code && s.minimal_code !== "off") parts.push(MINIMAL[s.minimal_code])
  return parts.length ? `\n\n${parts.join("\n")}` : ""
}

export function saverSummary(s) {
  return { terse: s.terse, minimal_code: s.minimal_code, rtk: s.rtk.enabled }
}
