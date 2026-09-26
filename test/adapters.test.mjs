// Backend adapter unit tests: registry, event parsing into the common schema, command/env building and
// the Claude Code PreToolUse guard hook. No backend CLI is needed.
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { BACKENDS, getBackend, backendProblems, profileBackend } from "../adapters/index.mjs"

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const pc = {
  providers: {
    oa: { base_url: "https://api.example.test/v1", api_key_env: "EXAMPLE_KEY", requires_env: ["EXAMPLE_KEY"], models: { m1: { id: "vendor/model-1" } } },
    an: { kind: "anthropic", api_key_env: "ANTH_KEY", requires_env: ["ANTH_KEY"], models: { sonnet: { id: "claude-sonnet-x" } } },
  },
}
const cfg = (installed = true) => ({
  default_backend: "kilo",
  backends: Object.fromEntries(Object.keys(BACKENDS).map((n) => [n, { name: n, installed, bin: `/opt/${n}`, config_dir: path.join(APP, "adapters", n === "kilo" || n === "opencode" ? `${n}/config` : n), home: `/data/${n}-home` }])),
})
const t = { id: "wh-20260101-000000-abcd", worktree_path: "/data/worktrees/r/wh-20260101-000000-abcd" }

test("registry: statuses and interface shape", () => {
  const status = Object.fromEntries(Object.entries(BACKENDS).map(([k, a]) => [k, a.status]))
  assert.deepEqual(status, { kilo: "tested", opencode: "tested", "claude-code": "untested", codex: "untested", gemini: "skeleton", aider: "skeleton" })
  for (const a of Object.values(BACKENDS)) for (const f of ["validate", "prepare", "command", "env", "sandbox", "parse"]) assert.equal(typeof a[f], "function", `${a.name}.${f}`)
  assert.throws(() => getBackend("nope"), /unknown backend/)
  assert.equal(profileBackend({}, { default_backend: "opencode" }), "opencode")
  assert.equal(profileBackend({ backend: "codex" }, { default_backend: "opencode" }), "codex")
})

test("backendProblems: skeletons, missing CLI, provider kind", () => {
  assert.match(backendProblems({ backend: "gemini", model: "oa/m1" }, pc, cfg()).join(), /skeleton/)
  assert.match(backendProblems({ backend: "kilo", model: "oa/m1" }, pc, cfg(false)).join(), /CLI not found/)
  assert.deepEqual(backendProblems({ backend: "kilo", model: "oa/m1" }, pc, cfg()), [])
  assert.match(backendProblems({ backend: "claude-code", model: "oa/m1" }, pc, cfg()).join(), /kind.*anthropic/)
  assert.deepEqual(backendProblems({ backend: "claude-code", model: "an/sonnet" }, pc, cfg()), [])
  assert.match(backendProblems({ backend: "codex", model: "an/sonnet" }, pc, cfg()).join(), /base_url/)
  assert.match(backendProblems({ backend: "bogus", model: "oa/m1" }, pc, cfg()).join(), /unknown backend/)
})

test("kilo/opencode: command, env prefix, sandbox binds and event parsing", () => {
  for (const [name, P] of [["kilo", "KILO"], ["opencode", "OPENCODE"]]) {
    const a = BACKENDS[name]
    const c = cfg()
    const ctx = { t, profile: { model: "oa/m1" }, pc, cfg: c, bc: c.backends[name], agent: "worker", message: "do it", resumeSession: "ses_1", dataDir: "/data/backend-data/x", home: c.backends[name].home, sandboxed: true, secrets: {}, repo: null }
    const args = a.command(ctx)
    assert.deepEqual(args.slice(0, 7), ["run", "--format", "json", "--agent", "worker", "--model", "oa/m1"])
    assert.ok(args.includes("--session") && args.at(-1) === "do it")
    const env = a.env(ctx)
    assert.equal(env[`${P}_CONFIG_DIR`], c.backends[name].config_dir)
    assert.equal(env[`${P}_DISABLE_PROJECT_CONFIG`], "1", "project config off for untrusted repos")
    const overlay = JSON.parse(env[`${P}_CONFIG_CONTENT`])
    assert.equal(overlay.provider.oa.options.apiKey, "{env:EXAMPLE_KEY}", "key only as an env reference")
    assert.equal(overlay.model, "oa/m1")
    assert.ok(!JSON.stringify(env).includes("secret-value"))
    const sb = a.sandbox(ctx)
    assert.ok(sb.roBinds.includes(c.backends[name].config_dir), "config dir bound read-only")
    assert.deepEqual(sb.mounts.map((m) => m.dst), [`${ctx.home}/.local/share`, `${ctx.home}/.local/state`])
  }
  // opencode's config dir reuses the kilo contract/skills/guard through symlinks; the sandbox binds their targets
  const oc = path.join(APP, "adapters/opencode/config")
  const sb = BACKENDS.opencode.sandbox({ bc: { config_dir: oc }, home: "/h", dataDir: "/d" })
  assert.ok(sb.roBinds.some((p) => p.endsWith(path.join("adapters/kilo/config/plugin"))))
  const st = {}
  const p = (ev) => BACKENDS.kilo.parse(ev, st)
  assert.deepEqual(p({ type: "step_finish", sessionID: "s1", part: { tokens: { input: 10, output: 5, cache: { read: 2 } }, cost: 0.01 } }), [
    { type: "session", id: "s1" },
    { type: "step", turns: 1, tokens: { input: 10, output: 5, reasoning: 0, cache_read: 2, cache_write: 0 }, cost: 0.01 },
  ])
  const tool = p({ type: "tool_use", part: { tool: "bash", state: { status: "completed", input: { command: "ls" }, output: "x", metadata: { exit: 1 } } } })[0]
  assert.equal(tool.shell, true)
  assert.equal(tool.exit, 1)
  const err = p({ type: "error", error: { data: { message: "rate limited", statusCode: 429 } } })[0]
  assert.deepEqual(err, { type: "error", message: "rate limited", statusCode: 429, retryable: true })
})

test("claude-code: settings with PreToolUse hook, command, env and stream-json parsing", () => {
  const a = BACKENDS["claude-code"]
  const c = cfg()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kwt-claude-"))
  const ctx = { t, profile: { model: "an/sonnet" }, pc, cfg: c, bc: c.backends["claude-code"], agent: "review", message: "review it", resumeSession: null, dataDir, home: "/h", sandboxed: true, secrets: { ANTH_KEY: "secret-value" }, repo: null }
  a.prepare(ctx)
  const settings = JSON.parse(fs.readFileSync(path.join(dataDir, "claude/settings.json"), "utf8"))
  assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /pretooluse-guard\.mjs/)
  assert.ok(settings.permissions.deny.includes("Write"), "review agent cannot write")
  const args = a.command(ctx)
  assert.deepEqual(args.slice(0, 7), ["-p", "review it", "--output-format", "stream-json", "--verbose", "--model", "claude-sonnet-x"])
  assert.equal(args[args.indexOf("--setting-sources") + 1], "user", "project settings off for untrusted repos")
  assert.ok(!args.includes("secret-value"), "no secret in argv")
  assert.equal(a.env(ctx).ANTHROPIC_API_KEY, "secret-value")
  const st = {}
  const ev = [
    { type: "system", subtype: "init", session_id: "cs1" },
    { type: "assistant", session_id: "cs1", message: { content: [{ type: "text", text: "hi" }, { type: "tool_use", id: "tu1", name: "Bash", input: { command: "git commit -m x" } }] } },
    { type: "user", session_id: "cs1", message: { content: [{ type: "tool_result", tool_use_id: "tu1", is_error: true, content: "workhorse guard blocked this call: git" }] } },
    { type: "result", subtype: "success", session_id: "cs1", num_turns: 3, total_cost_usd: 0.2, usage: { input_tokens: 100, output_tokens: 20 } },
  ].flatMap((e) => a.parse(e, st))
  const tool = ev.find((e) => e.type === "tool")
  assert.equal(tool.tool, "Bash")
  assert.equal(tool.ok, false)
  assert.match(tool.error, /guard blocked/)
  assert.equal(ev.find((e) => e.type === "step").turns, 3)
  assert.equal(ev.filter((e) => e.type === "error").length, 0)
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test("claude-code PreToolUse hook: blocks git/network/env dumps/outside paths, allows worktree work", () => {
  const hook = path.join(APP, "adapters/claude-code/pretooluse-guard.mjs")
  const wt = "/data/worktrees/r/wh-1"
  const run = (tool_name, tool_input) => spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_name, tool_input, cwd: wt }), encoding: "utf8", env: { PATH: process.env.PATH, WH_SECRET_NAMES: "ANTH_KEY", WH_GUARD_EXTRA_ROOTS: "[]" } })
  const blocked = [
    ["Bash", { command: "git commit -am x" }],
    ["Bash", { command: "curl https://example.com" }],
    ["Bash", { command: "env" }],
    ["Bash", { command: "echo $ANTH_KEY" }],
    ["Read", { file_path: "/etc/passwd" }],
    ["Write", { file_path: "../escape", content: "x" }],
    ["Edit", { file_path: "/tmp/x", old_string: "a", new_string: "b" }],
  ]
  for (const [n, i] of blocked) {
    const r = run(n, i)
    assert.equal(r.status, 2, `${n} ${JSON.stringify(i)} should be blocked`)
    assert.match(r.stderr, /workhorse guard blocked/)
  }
  for (const [n, i] of [["Bash", { command: "python3 -m unittest -v" }], ["Read", { file_path: `${wt}/a.py` }], ["Write", { file_path: "b.py", content: "git commit in content is fine" }], ["TodoWrite", {}]]) {
    const r = run(n, i)
    assert.equal(r.status, 0, `${n} ${JSON.stringify(i)} should be allowed: ${r.stderr}`)
  }
})

test("codex: exec/resume commands, provider config via -c, JSON events", () => {
  const a = BACKENDS.codex
  const c = cfg()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kwt-codex-"))
  const ctx = { t, profile: { model: "oa/m1" }, pc, cfg: c, bc: c.backends.codex, agent: "worker", message: "go", resumeSession: null, dataDir, home: "/h", sandboxed: true, secrets: {}, repo: null }
  a.prepare(ctx)
  assert.match(fs.readFileSync(path.join(dataDir, "codex/AGENTS.md"), "utf8"), /## RESULT/)
  const args = a.command(ctx)
  assert.equal(args[0], "exec")
  assert.ok(args.includes("workspace-write"))
  assert.ok(args.includes('model_providers.workhorse.env_key="EXAMPLE_KEY"'))
  assert.deepEqual(a.command({ ...ctx, resumeSession: "th1" }).slice(0, 3), ["exec", "resume", "th1"])
  assert.equal(a.env(ctx).CODEX_HOME, path.join(dataDir, "codex"))
  const ev = [
    { type: "thread.started", thread_id: "th1" },
    { type: "item.completed", item: { type: "command_execution", command: "pytest", aggregated_output: "1 failed", exit_code: 1, status: "completed" } },
    { type: "item.completed", item: { type: "agent_message", text: "## RESULT\nstatus: done" } },
    { type: "turn.completed", usage: { input_tokens: 50, cached_input_tokens: 10, output_tokens: 5 } },
    { type: "turn.failed", error: { message: "429 Too Many Requests" } },
  ].flatMap((e) => a.parse(e, {}))
  assert.deepEqual(ev.map((e) => e.type), ["session", "tool", "text", "step", "error"])
  assert.equal(ev[1].exit, 1)
  assert.equal(ev[4].retryable, true)
  fs.rmSync(dataDir, { recursive: true, force: true })
})
