// Claude Code backend (UNTESTED: implemented from the documented CLI; not installed or run in CI).
//   claude -p <msg> --output-format stream-json --verbose --model <id> [--resume <session>]
// Guard: a per-task settings.json registers adapters/claude-code/pretooluse-guard.mjs as a PreToolUse
// hook; it applies the same rules as the Kilo/OpenCode guard plugin (exit code 2 blocks the call).
// Claude Code's own sandbox (bubblewrap on Linux) is enabled in the generated settings for Bash.
// Provider: profiles.json provider with "kind": "anthropic" (api_key_env, optional base_url for an
// Anthropic-compatible gateway); the model id comes from providers.<p>.models.<m>.id.
// Known limitation: the API key is in the CLI's environment, which Claude Code passes to Bash; the hook
// blocks commands naming the key or dumping the environment, but that is a pattern check.
import fs from "node:fs"
import path from "node:path"
import { ensureDir } from "../../lib/util.mjs"
import { contractText, modelId, preview, retryableText } from "../common.mjs"

const WRITE_TOOLS = ["Edit", "MultiEdit", "Write", "NotebookEdit"]

export default {
  name: "claude-code",
  status: "untested",
  summary: "Claude Code (`claude -p --output-format stream-json`), PreToolUse hook guard + Claude's bash sandbox",
  notes: ["untested: requires the claude CLI and an Anthropic API key", "API key is visible to Bash in the CLI env (hook blocks obvious reads only)"],
  capabilities: { resume: true, review_agent: true, inner_sandbox: true, guard: "PreToolUse hook", providers: "anthropic (kind: anthropic)" },

  validate({ profile, pc }) {
    const m = modelId(pc, profile.model)
    if (m.provider.kind !== "anthropic") return [`backend claude-code needs a provider with "kind": "anthropic" (profile model ${profile.model})`]
    return []
  },

  prepare(ctx) {
    const cdir = path.join(ctx.dataDir, "claude")
    ensureDir(cdir, 0o700)
    const hook = path.join(ctx.bc.config_dir, "pretooluse-guard.mjs")
    const settings = {
      hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `${JSON.stringify(process.execPath)} ${JSON.stringify(hook)}` }] }] },
      permissions: {
        allow: ["Bash", "Read", "Glob", "Grep", "LS", "TodoWrite", ...(ctx.agent === "review" ? [] : WRITE_TOOLS)],
        deny: ["WebFetch", "WebSearch", ...(ctx.agent === "review" ? WRITE_TOOLS : [])],
      },
      sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false },
      includeCoAuthoredBy: false,
    }
    fs.writeFileSync(path.join(cdir, "settings.json"), JSON.stringify(settings, null, 2))
  },

  command(ctx) {
    const m = modelId(ctx.pc, ctx.profile.model)
    const args = ["-p", ctx.message, "--output-format", "stream-json", "--verbose", "--model", m.id,
      "--settings", path.join(ctx.dataDir, "claude", "settings.json"), "--setting-sources", ctx.repo?.trust_project_config ? "user,project" : "user",
      "--permission-mode", ctx.agent === "review" ? "default" : "acceptEdits", "--append-system-prompt", contractText()]
    if (ctx.resumeSession) args.push("--resume", ctx.resumeSession)
    return args
  },

  env(ctx) {
    const m = modelId(ctx.pc, ctx.profile.model)
    const env = {
      CLAUDE_CONFIG_DIR: path.join(ctx.dataDir, "claude"),
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      WH_GUARD_EXTRA_ROOTS: "[]",
    }
    const key = m.provider.api_key_env
    if (key && ctx.secrets[key]) env.ANTHROPIC_API_KEY = ctx.secrets[key]
    if (m.provider.base_url) env.ANTHROPIC_BASE_URL = m.provider.base_url
    return env
  },

  sandbox(ctx) {
    // The hook imports the guard plugin from the kilo adapter's config dir.
    const guardPlugin = path.join(ctx.cfg.backends.kilo?.config_dir || path.join(ctx.bc.config_dir, "../kilo/config"), "plugin")
    return { roBinds: [ctx.bc.config_dir, guardPlugin].filter((p) => p && fs.existsSync(p)), rwBinds: [ctx.home], mounts: [] }
  },

  // stream-json: system/init, assistant (text + tool_use blocks), user (tool_result blocks), result.
  parse(ev, st) {
    const out = []
    st.pending ||= {}
    if (ev.session_id) out.push({ type: "session", id: ev.session_id })
    if (ev.type === "assistant") {
      for (const b of ev.message?.content || []) {
        if (b.type === "text" && b.text?.trim()) out.push({ type: "text", text: b.text })
        if (b.type === "tool_use") st.pending[b.id] = { tool: b.name, input: b.input || {} }
      }
    } else if (ev.type === "user") {
      for (const b of ev.message?.content || []) {
        if (b.type !== "tool_result") continue
        const p = st.pending[b.tool_use_id] || { tool: "?", input: {} }
        delete st.pending[b.tool_use_id]
        const text = Array.isArray(b.content) ? b.content.map((c) => c.text || "").join("\n") : String(b.content ?? "")
        const i = p.input
        out.push({ type: "tool", tool: p.tool, shell: p.tool === "Bash", input: preview(i.command || i.file_path || i.path || i.pattern || JSON.stringify(i)), ok: !b.is_error, error: b.is_error ? text : null, output: b.is_error ? "" : text, exit: null })
      }
    } else if (ev.type === "result") {
      const u = ev.usage || {}
      out.push({ type: "step", turns: ev.num_turns || 1, tokens: { input: u.input_tokens || 0, output: u.output_tokens || 0, reasoning: 0, cache_read: u.cache_read_input_tokens || 0, cache_write: u.cache_creation_input_tokens || 0 }, cost: ev.total_cost_usd || 0 })
      if (ev.is_error || (ev.subtype && ev.subtype !== "success")) {
        const msg = String(ev.result || ev.subtype || "claude run failed")
        out.push({ type: "error", message: msg, statusCode: null, retryable: retryableText(msg) })
      }
    }
    return out
  },
}
