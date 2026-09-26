// Aider backend: TODO skeleton (not implemented, not installed).
// Sketch: `aider --message <msg> --yes-always --no-auto-commits --no-git --model openai/<id>` with
// OPENAI_API_BASE/OPENAI_API_KEY from the profile provider; no structured event stream, so parsing
// would read the chat history file / stdout and report only text + the final RESULT block; no tool
// hooks (aider edits files directly), so the outer sandbox is the only control; resume via
// --restore-chat-history in the same per-task dir.
const notImplemented = () => {
  throw new Error("backend 'aider' is a TODO skeleton and cannot run tasks yet (see adapters/aider/adapter.mjs)")
}

export default {
  name: "aider",
  status: "skeleton",
  summary: "Aider: TODO skeleton",
  notes: ["not implemented"],
  capabilities: { resume: false, review_agent: false, inner_sandbox: false, guard: "none", providers: "n/a" },
  validate: () => ["backend 'aider' is a TODO skeleton and cannot run tasks yet"],
  prepare: notImplemented,
  command: notImplemented,
  env: notImplemented,
  sandbox: notImplemented,
  parse: () => [],
}
