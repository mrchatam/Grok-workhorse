// OpenAI Codex CLI backend (UNTESTED: implemented from the documented CLI; not installed or run in CI).
//   codex exec --json --sandbox workspace-write -C <worktree> -m <id> [-c model_provider...] <msg>
//   codex exec resume <thread_id> --json ... <msg>
// Codex runs model shell commands in its own sandbox (Landlock/seccomp; workspace-write = writes only
// in the worktree, network off by default). There is no pre-tool hook, so the guard plugin rules are NOT
// applied; the outer sandbox (read-only git common dir: commits fail) and Codex's sandbox are the controls.
// Provider: any profiles.json provider with base_url (OpenAI-compatible; wire_api "chat" unless the
// provider sets "wire_api"). CODEX_HOME is per task; the worker contract goes to $CODEX_HOME/AGENTS.md.
import fs from "node:fs"
import path from "node:path"
import { ensureDir } from "../../lib/util.mjs"
import { contractText, modelId, preview, retryableText } from "../common.mjs"

export default {
  name: "codex",
  status: "untested",
  summary: "OpenAI Codex CLI (`codex exec --json`), Codex's own workspace-write sandbox; no guard hook",
  notes: ["untested: requires the codex CLI", "no pre-tool hook: guard rules are not applied (Codex sandbox + outer sandbox only)"],
  capabilities: { resume: true, review_agent: false, inner_sandbox: true, guard: "none (Codex sandbox)", providers: "openai-compatible (profiles.json providers)" },

  validate({ profile, pc }) {
    const m = modelId(pc, profile.model)
    return m.provider.base_url ? [] : [`backend codex needs a provider with base_url (profile model ${profile.model})`]
  },

  prepare(ctx) {
    const home = path.join(ctx.dataDir, "codex")
    ensureDir(home, 0o700)
    const review = ctx.agent === "review" ? "\n\nYou are running as a READ-ONLY reviewer: do not modify, create or delete files.\n" : ""
    fs.writeFileSync(path.join(home, "AGENTS.md"), contractText() + review)
  },

  command(ctx) {
    const m = modelId(ctx.pc, ctx.profile.model)
    const p = m.provider
    const conf = [
      "-c", "model_provider=workhorse",
      "-c", `model_providers.workhorse.name=${JSON.stringify(p.name || m.providerKey)}`,
      "-c", `model_providers.workhorse.base_url=${JSON.stringify(p.base_url)}`,
      "-c", `model_providers.workhorse.wire_api=${JSON.stringify(p.wire_api || "chat")}`,
      ...(p.api_key_env ? ["-c", `model_providers.workhorse.env_key=${JSON.stringify(p.api_key_env)}`] : []),
    ]
    const common = ["--json", "--skip-git-repo-check", "--sandbox", ctx.agent === "review" ? "read-only" : "workspace-write", "-m", m.id, ...conf]
    if (ctx.resumeSession) return ["exec", "resume", ctx.resumeSession, ...common, ctx.message]
    return ["exec", ...common, "-C", ctx.t.worktree_path, ctx.message]
  },

  env(ctx) {
    return { CODEX_HOME: path.join(ctx.dataDir, "codex") }
  },

  sandbox(ctx) {
    return { roBinds: [], rwBinds: [ctx.home], mounts: [] }
  },

  parse(ev) {
    const out = []
    switch (ev.type) {
      case "thread.started":
        if (ev.thread_id) out.push({ type: "session", id: ev.thread_id })
        break
      case "turn.completed": {
        const u = ev.usage || {}
        out.push({ type: "step", turns: 1, tokens: { input: u.input_tokens || 0, output: u.output_tokens || 0, reasoning: 0, cache_read: u.cached_input_tokens || 0, cache_write: 0 }, cost: 0 })
        break
      }
      case "item.completed": {
        const it = ev.item || {}
        if (it.type === "agent_message" && it.text?.trim()) out.push({ type: "text", text: it.text })
        else if (it.type === "command_execution") out.push({ type: "tool", tool: "shell", shell: true, input: preview(it.command), ok: it.status !== "failed" || typeof it.exit_code === "number", error: it.status === "failed" && typeof it.exit_code !== "number" ? "command failed" : null, output: it.aggregated_output || "", exit: typeof it.exit_code === "number" ? it.exit_code : null })
        else if (it.type === "file_change") out.push({ type: "tool", tool: "file_change", shell: false, input: preview((it.changes || []).map((c) => `${c.kind} ${c.path}`).join(", ")), ok: it.status !== "failed", error: it.status === "failed" ? "patch failed" : null, output: "", exit: null })
        else if (it.type === "mcp_tool_call") out.push({ type: "tool", tool: `mcp:${it.tool || "?"}`, shell: false, input: "", ok: it.status !== "failed", error: null, output: "", exit: null })
        else if (it.type === "error") out.push({ type: "error", message: String(it.message || "error"), statusCode: null, retryable: retryableText(it.message) })
        break
      }
      case "turn.failed":
      case "error": {
        const msg = String(ev.error?.message || ev.message || "codex error")
        out.push({ type: "error", message: msg, statusCode: null, retryable: retryableText(msg) })
        break
      }
    }
    return out
  },
}
