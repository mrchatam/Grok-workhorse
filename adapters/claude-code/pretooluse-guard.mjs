#!/usr/bin/env node
// Claude Code PreToolUse hook for the claude-code backend (UNTESTED against a real Claude Code run;
// covered by unit tests with synthetic hook input). Reads the hook JSON on stdin, maps the Claude tool
// call onto the Kilo/OpenCode guard plugin (adapters/kilo/config/plugin/workhorse-guard.js) and exits 2 with the
// reason on stderr to block it (Claude Code shows stderr to the model). Exit 0 allows the call.
import { WorkhorseGuard } from "../kilo/config/plugin/workhorse-guard.js"

const TOOL_MAP = { Bash: "bash", Read: "read", Write: "write", Edit: "edit", MultiEdit: "multiedit", NotebookEdit: "edit", Glob: "glob", Grep: "grep", LS: "list" }
// Environment dumps would reveal the provider key that Claude Code passes to Bash.
const ENV_DUMP = /(^|[\s;&|(`])(env|printenv|export\s+-p|declare\s+-x|compgen\s+-v)(\s*$|\s*[;&|)])/

async function main() {
  let raw = ""
  for await (const c of process.stdin) raw += c
  let input
  try {
    input = JSON.parse(raw || "{}")
  } catch {
    process.stderr.write("workhorse guard blocked this call: unreadable hook input\n")
    process.exit(2)
  }
  const tool = TOOL_MAP[input.tool_name]
  if (!tool) process.exit(0) // TodoWrite, Task, ... (WebFetch/WebSearch are denied in settings.json)
  const ti = input.tool_input || {}
  const args = { ...ti }
  if (ti.notebook_path) args.filePath = ti.notebook_path
  try {
    if (tool === "bash" && ENV_DUMP.test(String(ti.command || ""))) throw new Error("workhorse guard blocked this call: dumping the environment is not allowed")
    const guard = await WorkhorseGuard({ directory: process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd() })
    await guard["tool.execute.before"]({ tool }, { args })
  } catch (e) {
    process.stderr.write(String(e.message || e) + "\n")
    process.exit(2)
  }
  process.exit(0)
}
main()
