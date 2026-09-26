// Gemini CLI backend: TODO skeleton (not implemented, not installed).
// Sketch: `gemini -p <msg> --output-format stream-json -m <model>`; per-task GEMINI_CLI_HOME / settings
// with the contract as system instructions; guard via its BeforeTool hooks (settings "hooks") running
// adapters/claude-code/pretooluse-guard.mjs-style checks; parse init/message/tool_use/tool_result/result
// events into the normalized schema; Gemini API key via GEMINI_API_KEY from a provider "kind": "gemini".
const notImplemented = () => {
  throw new Error("backend 'gemini' is a TODO skeleton and cannot run tasks yet (see adapters/gemini/adapter.mjs)")
}

export default {
  name: "gemini",
  status: "skeleton",
  summary: "Gemini CLI: TODO skeleton",
  notes: ["not implemented"],
  capabilities: { resume: false, review_agent: false, inner_sandbox: false, guard: "none", providers: "n/a" },
  validate: () => ["backend 'gemini' is a TODO skeleton and cannot run tasks yet"],
  prepare: notImplemented,
  command: notImplemented,
  env: notImplemented,
  sandbox: notImplemented,
  parse: () => [],
}
