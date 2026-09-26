// Adapter factory for Kilo CLI and OpenCode (Kilo is an OpenCode fork: same `run --format json` event
// stream, same config/plugin system, different env-var prefix and data dir name).
import fs from "node:fs"
import path from "node:path"
import { kiloProviderOverlay } from "../lib/config.mjs"
import { ensureDir } from "../lib/util.mjs"
import { deepMerge, repoRuleFiles, symlinkTargets, preview } from "./common.mjs"

export function opencodeFamily({ name, status, summary, prefix, dataName, overlayKey, extraEnv = () => ({}), innerSandbox, notes = [] }) {
  const P = (k) => `${prefix}_${k}`
  const toolOutput = (home) => path.join(home, ".local/share", dataName, "tool-output")
  return {
    name,
    status,
    summary,
    notes,
    capabilities: { resume: true, review_agent: true, inner_sandbox: innerSandbox, guard: "plugin", providers: "openai-compatible (profiles.json providers)" },

    validate() {
      return []
    },

    // Per-task data (session DB, snapshots, tool output) + state live in <dataDir>/{share,state}; inside
    // the outer sandbox they are mounted over the shared HOME's .local/{share,state}, so a worker sees only
    // its own task's session history. Kept for continue_task; removed with the worktree.
    prepare(ctx) {
      for (const d of [path.join(ctx.dataDir, "share"), path.join(ctx.dataDir, "state")]) ensureDir(d, 0o755)
      if (ctx.sandboxed) for (const d of [path.join(ctx.home, ".local/share"), path.join(ctx.home, ".local/state")]) ensureDir(d, 0o755)
    },

    command(ctx) {
      const args = ["run", "--format", "json", "--agent", ctx.agent, "--model", ctx.profile.model, "--title", `workhorse ${ctx.t.id}`, "--dir", ctx.t.worktree_path]
      if (ctx.resumeSession) args.push("--session", ctx.resumeSession)
      args.push(ctx.message)
      return args
    },

    env(ctx) {
      const { profile, pc, t, repo, home } = ctx
      // Provider definitions (profiles.json providers) + raw <backend>_overlay + per-task model choice.
      // The CLI's own tool-output dir is the only path outside the worktree its file tools may touch.
      const overlay = deepMerge(deepMerge(kiloProviderOverlay(pc), pc[overlayKey] || {}), {
        model: profile.model,
        small_model: profile.small_model || profile.explore_model || profile.model,
        agent: { explore: { model: profile.explore_model || profile.model } },
        permission: { external_directory: { [path.join(toolOutput(home), "*")]: "allow" } },
      })
      const env = {
        WH_GUARD_EXTRA_ROOTS: JSON.stringify([toolOutput(home)]),
        [P("CONFIG_DIR")]: ctx.bc.config_dir,
        [P("DISABLE_AUTOUPDATE")]: "1",
        [P("DISABLE_SHARE")]: "1",
        [P("DISABLE_CLAUDE_CODE")]: "1",
        [P("DISABLE_LSP_DOWNLOAD")]: "1",
        ...extraEnv(ctx),
      }
      if (!repo?.trust_project_config) {
        // Project config (repo kilo.json/opencode.json, .kilo/.opencode agents/plugins/MCP) is disabled for
        // untrusted repos because plugins run as unsandboxed host code. Rule files are plain text: load them.
        env[P("DISABLE_PROJECT_CONFIG")] = "1"
        const rules = repoRuleFiles(t.worktree_path)
        if (rules.length) overlay.instructions = rules
      }
      env[P("CONFIG_CONTENT")] = JSON.stringify(overlay)
      if (!ctx.sandboxed) {
        // Without the outer sandbox, per-task isolation falls back to XDG dirs (weaker). Keep it enabled.
        env.XDG_DATA_HOME = path.join(ctx.dataDir, "share")
        env.XDG_STATE_HOME = path.join(ctx.dataDir, "state")
      }
      return env
    },

    sandbox(ctx) {
      const cd = ctx.bc.config_dir
      return {
        roBinds: [cd, ...symlinkTargets(cd)].filter((p) => p && fs.existsSync(p)),
        rwBinds: [ctx.home],
        mounts: [
          { src: path.join(ctx.dataDir, "share"), dst: path.join(ctx.home, ".local/share") },
          { src: path.join(ctx.dataDir, "state"), dst: path.join(ctx.home, ".local/state") },
        ],
      }
    },

    // `run --format json` lines -> normalized events (see index.mjs).
    parse(ev) {
      const out = []
      if (ev.sessionID) out.push({ type: "session", id: ev.sessionID })
      const part = ev.part || {}
      switch (ev.type) {
        case "step_finish": {
          const tk = part.tokens || {}
          out.push({ type: "step", turns: 1, tokens: { input: tk.input || 0, output: tk.output || 0, reasoning: tk.reasoning || 0, cache_read: tk.cache?.read || 0, cache_write: tk.cache?.write || 0 }, cost: part.cost || 0 })
          break
        }
        case "tool_use": {
          const tool = part.tool || "?"
          const st = part.state || {}
          const input = st.input || {}
          const exit = st.metadata?.exit ?? st.metadata?.exitCode
          out.push({
            type: "tool", tool, shell: tool === "bash",
            input: preview(tool === "bash" ? input.command || "" : input.filePath || input.path || input.pattern || JSON.stringify(input)),
            ok: st.status !== "error", error: st.status === "error" ? String(st.error || "") : null, output: st.output || "",
            exit: typeof exit === "number" ? exit : null,
          })
          break
        }
        case "text":
          if (part.text?.trim()) out.push({ type: "text", text: part.text })
          break
        case "error": {
          const e = ev.error || {}
          const msg = typeof e === "string" ? e : e.data?.message || e.message || e.name || JSON.stringify(e).slice(0, 300)
          const statusCode = typeof e === "object" ? e.data?.statusCode : undefined
          const retryable = typeof e === "object" && (e.data?.isRetryable === true || statusCode === 429 || (statusCode >= 500 && statusCode < 600))
          out.push({ type: "error", message: String(msg), statusCode: statusCode ?? null, retryable: !!retryable })
          break
        }
      }
      return out
    },
  }
}
