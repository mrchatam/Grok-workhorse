// Worker backend registry.
//
// A backend adapter teaches the daemon how to drive one coding-agent CLI. Everything else (MCP API,
// queue, per-task git worktrees, outer bwrap sandbox, repo/test allowlists, credentials, audit log,
// daemon-run tests and the structured result) is shared by all backends.
//
// Adapter interface (plain object, see kilo/adapter.mjs, claude-code/adapter.mjs):
//   name, status ("tested" | "untested" | "skeleton"), summary, notes[], capabilities{}
//   validate({profile, pc, cfg, bc})  -> string[]   problems with using this profile on this backend
//   prepare(ctx)                      -> void       per run: create per-task dirs/settings/hook config
//   command(ctx)                      -> string[]   argv after the binary (ctx.resumeSession set on resume)
//   env(ctx)                          -> object     backend env, merged over the daemon's base env
//                                                   (PATH, HOME=bc.home, LANG, sandbox_env, the profile's
//                                                   provider secrets, WH_SECRET_NAMES, WH_GUARD_DENY_PATHS)
//   sandbox(ctx)                      -> {roBinds, rwBinds, mounts}  extra outer-sandbox binds
//   parse(eventObject, state)         -> normalized events[] (one JSON line of the CLI's stdout)
// Cancel/timeout/stall handling is common (the daemon kills the process tree).
//
// ctx = { t (task), profile, pc (profiles config), cfg (daemon config), bc (resolved backend config:
//         bin, bin_real, config_dir, home, ...), repo, agent ("worker"|"review"), message,
//         resumeSession, dataDir (per-task backend data dir), home, sandboxed, secrets (provider secrets) }
//
// Normalized events:
//   { type: "session", id }
//   { type: "step", turns, tokens: {input, output, reasoning, cache_read, cache_write}, cost }
//   { type: "tool", tool, shell (bool), input (preview), ok, error, output, exit (number|null) }
//   { type: "text", text }
//   { type: "error", message, statusCode, retryable }
import kilo from "./kilo/adapter.mjs"
import opencode from "./opencode/adapter.mjs"
import claudeCode from "./claude-code/adapter.mjs"
import codex from "./codex/adapter.mjs"
import gemini from "./gemini/adapter.mjs"
import aider from "./aider/adapter.mjs"
import stub, { stubEnabled } from "./stub/adapter.mjs"

export const BACKENDS = { kilo, opencode, "claude-code": claudeCode, codex, gemini, aider }
// Test-only scripted backend: registered only when the daemon process has WH_ENABLE_STUB_BACKEND=1
// (see adapters/stub/adapter.mjs for why production can never select it).
if (stubEnabled()) BACKENDS.stub = stub

export function backendNames() {
  return Object.keys(BACKENDS)
}

export function getBackend(name) {
  if (!Object.hasOwn(BACKENDS, name)) throw new Error(`unknown backend '${name}' (known: ${backendNames().join(", ")})`)
  return BACKENDS[name]
}

// Effective backend name of a profile.
export function profileBackend(profile, cfg) {
  return profile.backend || cfg.default_backend || "kilo"
}

// Problems with running `profile` on its backend (unknown backend, skeleton, not installed, adapter checks).
export function backendProblems(profile, pc, cfg) {
  const name = profileBackend(profile, cfg)
  if (!Object.hasOwn(BACKENDS, name)) return [`unknown backend '${name}' (known: ${backendNames().join(", ")})`]
  const a = BACKENDS[name]
  const bc = cfg.backends?.[name] || {}
  const out = [...(a.validate({ profile, pc, cfg, bc }) || [])]
  if (a.status !== "skeleton" && !bc.installed) out.push(`backend '${name}' CLI not found (${bc.bin || bc.exe}); install it or set daemon.json backends.${name}.bin`)
  return out
}

export function backendSummary(cfg) {
  return Object.entries(BACKENDS).map(([name, a]) => ({
    name, status: a.status, summary: a.summary, installed: !!cfg.backends?.[name]?.installed, bin: cfg.backends?.[name]?.installed ? cfg.backends[name].bin : null,
    capabilities: a.capabilities, notes: a.notes || [],
  }))
}
