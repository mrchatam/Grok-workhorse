#!/usr/bin/env node
// TEST-ONLY fake coding-agent CLI for the "stub" backend (see adapter.mjs). Prints normalized workhorse
// events (JSON lines) on stdout, following a scripted scenario.
//
//   stub-cli.mjs --model <provider/model> [--session <id>] -- <message>
//   env: WH_STUB_STATE (per-task state dir), WH_STUB_SCENARIOS (scenario dir)
//
// The scenario is named by `MOCK_SCENARIO=<name>` in a message (remembered for later runs of the task):
//   { "runs": [ [action, ...], [action, ...], ... ] }
// Run i of the task (counted across sessions, failed attempts excluded) plays runs[i] (the last entry
// repeats). Actions:
//   {"write": {"path": "rel/path", "content": "..."}}   write a file in the worktree (cwd)
//   {"bash": "command"}                                  run it with /bin/sh in the worktree
//   {"text": "..."}                                      assistant message (end a run with the RESULT block)
//   {"tokens": {"input": N, "output": N, ...}}           token usage (default per run: 1000 in / 200 out)
//   {"error": {"status": 429, "message": "...", "times": 1, "models": ["p/m"]}}
//                                                        fail this attempt (exit 1) the first `times` times
//   {"sleep": seconds}                                   stay silent (stall/timeout/restart tests)
//   {"if_model": "p/m", "then": [...], "else": [...]}    branch on --model
//   {"exit": code}
// "count_at_start": true (top level) counts a run when it starts, so a run killed midway (restart tests)
// is not replayed by the next one.
// Every received message is appended to <state>/messages.jsonl (tests inspect it).
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { spawnSync } from "node:child_process"

const argv = process.argv.slice(2)
let model = "stub/model"
let session = null
let message = ""
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--model") model = argv[++i]
  else if (argv[i] === "--session") session = argv[++i]
  else if (argv[i] === "--") {
    message = argv.slice(i + 1).join(" ")
    break
  }
}
const stateDir = process.env.WH_STUB_STATE || process.cwd()
const scenDir = process.env.WH_STUB_SCENARIOS || ""
fs.mkdirSync(stateDir, { recursive: true })
const stateFile = path.join(stateDir, "stub-state.json")
let st = { scenario: null, runs_done: 0, errors: {}, sessions: [] }
try {
  st = { ...st, ...JSON.parse(fs.readFileSync(stateFile, "utf8")) }
} catch {}
const save = () => fs.writeFileSync(stateFile, JSON.stringify(st))
const emit = (ev) => process.stdout.write(JSON.stringify(ev) + "\n")

const m = /MOCK_SCENARIO=([A-Za-z0-9_-]+)/.exec(message)
if (m) st.scenario = m[1]
if (!session || !st.sessions.includes(session)) {
  session = `stub-${crypto.randomBytes(4).toString("hex")}`
  st.sessions.push(session)
}
fs.appendFileSync(path.join(stateDir, "messages.jsonl"), JSON.stringify({ run: st.runs_done, model, session, message }) + "\n")
save()
emit({ type: "session", id: session })

let scenario = { runs: [[{ text: "Nothing to do.\n\n## RESULT\nstatus: done\nsummary: stub default run, no changes\nfiles_changed: none\ntests: none\nconcerns: none" }]] }
if (st.scenario && scenDir) {
  try {
    scenario = JSON.parse(fs.readFileSync(path.join(scenDir, `${st.scenario}.json`), "utf8"))
  } catch (e) {
    emit({ type: "error", message: `stub: cannot read scenario ${st.scenario}: ${e.message}`, statusCode: null, retryable: false })
    process.exit(1)
  }
}
const runs = scenario.runs || []
const actions = runs.length ? runs[Math.min(st.runs_done, runs.length - 1)] : []
let tokensSent = false
if (scenario.count_at_start) {
  st.runs_done++
  save()
}

async function play(list, path0) {
  for (const [i, a] of list.entries()) {
    const key = `${st.runs_done}:${path0}${i}`
    if (a.error) {
      const e = a.error
      if (e.models && !e.models.includes(model)) continue
      const n = st.errors[key] || 0
      if (n >= (e.times ?? 1)) continue
      st.errors[key] = n + 1
      save()
      const status = e.status ?? 500
      emit({ type: "error", message: e.message || `stub provider error ${status}`, statusCode: status, retryable: [408, 429, 500, 502, 503, 504].includes(status) })
      process.exit(1)
    } else if (a.if_model !== undefined) {
      await play(a.if_model === model ? a.then || [] : a.else || [], `${path0}${i}.`)
    } else if (a.write) {
      const p = path.resolve(process.cwd(), a.write.path)
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, a.write.content ?? "")
      emit({ type: "tool", tool: "write", shell: false, input: a.write.path, ok: true, output: "", exit: null })
    } else if (a.bash !== undefined) {
      const r = spawnSync("/bin/sh", ["-c", a.bash], { cwd: process.cwd(), encoding: "utf8" })
      emit({ type: "tool", tool: "bash", shell: true, input: a.bash, ok: true, output: String(r.stdout || "") + String(r.stderr || ""), exit: r.status })
    } else if (a.text !== undefined) {
      emit({ type: "text", text: a.text })
    } else if (a.tokens) {
      tokensSent = true
      emit({ type: "step", turns: 1, tokens: a.tokens, cost: a.cost || 0 })
    } else if (a.sleep !== undefined) {
      await new Promise((r) => setTimeout(r, a.sleep * 1000))
    } else if (a.exit !== undefined) {
      process.exit(a.exit)
    }
  }
}

await play(actions, "")
if (!tokensSent) emit({ type: "step", turns: 1, tokens: { input: 1000, output: 200, reasoning: 0, cache_read: 0, cache_write: 0 }, cost: 0 })
if (!scenario.count_at_start) {
  st.runs_done++
  save()
}
process.exit(0)
