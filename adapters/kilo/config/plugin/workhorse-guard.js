// workhorse guard plugin (defense in depth; cheap, no per-edit work).
// 1. shell.env: blank credential variables in every model-run shell. Kilo scrubs its own
//    server/config vars but otherwise passes its full environment to shells, including the
//    model provider key.
// 2. tool.execute.before:
//    - bash: reject git history/remote mutation, network clients and secret access by matching
//      the COMMAND STRING. Heredoc bodies that a plain `cat`/`tee` writes to a file are file
//      content (like the write tool's content) and skip the git-mutation rules.
//    - file tools (read/write/edit/apply_patch/...): only the PATH is checked (must stay inside the
//      task worktree). File CONTENT is never pattern-matched: a README or script that merely
//      mentions `git commit` is fine.
//    These run before Kilo's permission rules and the OS sandboxes (Kilo's bwrap + workhorse's
//    outer sandbox, which hides the secret store and other tasks' files entirely).
// The daemon passes env vars: WH_SECRET_NAMES (comma-separated secret variable names, e.g. the
// provider's api_key_env), WH_GUARD_DENY_PATHS (JSON array of literal substrings such as the
// secret-store path and the daemon's run dir; both extend the static lists below) and
// WH_GUARD_EXTRA_ROOTS (JSON array of dirs outside the worktree file tools may use, e.g. the CLI's own
// tool-output dir).
// Used by the kilo and opencode backends as a plugin, and by the claude-code backend through
// adapters/claude-code/pretooluse-guard.mjs (which maps Claude tool names onto these).
// NOTE: Kilo/OpenCode call every export of this module as a plugin, so helpers must stay unexported.
import path from "node:path"

const STATIC_SECRET_VARS = [
  "NVIDIA_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GITHUB_TOKEN", "GH_TOKEN",
  "GITHUB_PAT", "KILO_API_KEY", "OPENROUTER_API_KEY", "XAI_API_KEY", "GEMINI_API_KEY",
  "GROQ_API_KEY", "TOGETHER_API_KEY", "DEEPSEEK_API_KEY", "MISTRAL_API_KEY",
]
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
function configuredSecretVars() {
  return String(process.env.WH_SECRET_NAMES || "").split(",").map((s) => s.trim()).filter((s) => NAME_RE.test(s))
}
// Blanked in every model-run shell.
function secretVars() {
  return [...new Set([...STATIC_SECRET_VARS, ...configuredSecretVars()])]
}
// Bash commands that mention these names are refused (only the configured ones + GitHub tokens, so
// that e.g. `grep -r OPENAI_API_KEY src/` in an unrelated project still works).
function blockedNames() {
  return [...new Set(["GITHUB_TOKEN", "GH_TOKEN", ...configuredSecretVars()])]
}
function jsonList(name, min = 1) {
  try {
    const v = JSON.parse(process.env[name] || "[]")
    return Array.isArray(v) ? v.filter((p) => typeof p === "string" && p.length >= min) : []
  } catch {
    return []
  }
}
function denyPaths() {
  return jsonList("WH_GUARD_DENY_PATHS", 6)
}

// git <global options> <subcommand>: match the subcommand, not words appearing in file names.
const GIT = "(?:^|[\\s;&|(`\"'])git(?:\\s+(?:-c\\s+\\S+|-C\\s+\\S+|--[a-z-]+(?:=\\S+)?|-[a-zA-Z]))*\\s+"
// Checked against the command with file-writing heredoc bodies removed.
const GIT_RULES = [
  [new RegExp(GIT + "(commit|push|reset|rebase|merge|pull|fetch|clone|remote|stash|worktree|update-ref|cherry-pick|revert|filter-branch|filter-repo|submodule|gc|prune|am|tag|config|clean|symbolic-ref|replace|notes)\\b"), "git history/remote/config mutation is not allowed; leave changes uncommitted"],
  [new RegExp(GIT + "(switch|checkout)\\b(?!\\s+--\\s)"), "switching branches is not allowed (git checkout -- <file> is fine)"],
  [new RegExp(GIT + "branch\\s+(?!--show-current|--list|-l\\b|-a\\b|-v\\b)\\S"), "creating/deleting branches is not allowed"],
]
// Checked against the full command string.
const BASH_RULES = [
  [/(^|[\s;&|(`$])(curl|wget|ssh|scp|sftp|rsync|nc|ncat|socat|telnet|ftp|gh|sudo|su|doas|docker|podman|kilo)(\s|$)/, "network clients, privilege escalation and nested agents are not allowed"],
  [/\/proc\/[^\s]*\/(environ|mem|cmdline)|\/proc\/self/, "access to process environments is not allowed"],
  [/(~|\$HOME|\/home\/[^/\s]+|\/root)\/\.(ssh|aws|config\/gh|gnupg|netrc|git-credentials|docker)/, "access to credential directories is not allowed"],
]

// Remove the bodies of heredocs whose only job is writing a file: the line that opens the heredoc
// starts with `cat` or `tee`, has exactly one `<<`, and no pipe, `;`, `&`, backtick or `$(` (so the
// body is not fed to a shell or interpreter). An unquoted delimiter expands `$(...)`/backticks in the
// body, so such a body is only removed when it contains neither. Everything else stays checked.
function stripFileHeredocs(cmd) {
  const lines = cmd.split("\n")
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    out.push(line)
    const m = /(?<!<)<<(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_.-]*)\2/.exec(line)
    if (!m) continue
    const dash = m[1] === "-"
    let j = i + 1
    while (j < lines.length && (dash ? lines[j].replace(/^\t+/, "") : lines[j]) !== m[3]) j++
    if (j >= lines.length) continue // unterminated: keep checking everything
    const body = lines.slice(i + 1, j).join("\n")
    const fileWriter = /^\s*(cat|tee)(\s|$)/.test(line) && (line.match(/<</g) || []).length === 1 && !/[|;&`]|\$\(/.test(line)
    const inert = m[2] !== "" || !/`|\$\(/.test(body)
    if (fileWriter && inert) {
      out.push(lines[j])
      i = j
    }
  }
  return out.join("\n")
}

function checkBash(cmd, deny) {
  const stripped = stripFileHeredocs(cmd)
  for (const [re, why] of GIT_RULES) if (re.test(stripped)) deny(why)
  for (const [re, why] of BASH_RULES) if (re.test(cmd)) deny(why)
  for (const name of blockedNames()) if (cmd.includes(name)) deny("access to credentials is not allowed")
  for (const p of denyPaths()) if (cmd.includes(p)) deny("access to the secret store or daemon token is not allowed")
}

const FILE_TOOLS = new Set(["read", "write", "edit", "multiedit", "apply_patch", "patch", "glob", "grep", "list", "lsp"])
const PATH_KEYS = ["filePath", "path", "file_path"]

export const WorkhorseGuard = async ({ directory, worktree }) => {
  const root = path.resolve(directory || worktree || process.cwd())
  const extra = process.env.WH_GUARD_EXTRA_ROOTS
    ? jsonList("WH_GUARD_EXTRA_ROOTS").filter((p) => path.isAbsolute(p)).map((p) => path.resolve(p))
    : [path.join(process.env.HOME || "/nonexistent", ".local/share/kilo/tool-output")]
  const inside = (p) => {
    const abs = path.resolve(root, p)
    return abs === root || abs.startsWith(root + path.sep) || extra.some((e) => abs.startsWith(e + path.sep))
  }
  const deny = (msg) => { throw new Error(`workhorse guard blocked this call: ${msg}`) }
  return {
    "shell.env": async (_input, output) => {
      for (const k of secretVars()) if (process.env[k] !== undefined) output.env[k] = ""
    },
    "tool.execute.before": async (input, output) => {
      const args = output?.args ?? {}
      if (input.tool === "bash") {
        checkBash(String(args.command ?? ""), deny)
        if (args.workdir && !inside(String(args.workdir))) deny("workdir outside the task worktree")
        return
      }
      if (FILE_TOOLS.has(input.tool)) {
        // Paths only; content/oldString/newString/patchText are deliberately not inspected.
        for (const key of PATH_KEYS) {
          const v = args[key]
          if (typeof v === "string" && v && !inside(v)) deny(`path outside the task worktree: ${v}`)
        }
        for (const e of Array.isArray(args.edits) ? args.edits : []) {
          for (const key of PATH_KEYS) {
            const v = e?.[key]
            if (typeof v === "string" && v && !inside(v)) deny(`path outside the task worktree: ${v}`)
          }
        }
      }
    },
  }
}
