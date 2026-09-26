// OpenCode backend (sst/opencode; `opencode run --format json`). Same config/plugin approach as Kilo
// (adapters/opencode/config/ reuses the guard plugin, contract and skills via symlinks into
// adapters/kilo/config/).
// Difference: OpenCode has no inner OS sandbox for shell commands, so model-run commands keep the
// network access of the outer sandbox. The guard plugin still blocks network clients by name, but that
// is a pattern check, not isolation.
import { opencodeFamily } from "../opencode-family.mjs"

export default opencodeFamily({
  name: "opencode",
  status: "tested",
  summary: "OpenCode (`opencode run --format json`), guard plugin; no inner shell sandbox (commands keep network)",
  prefix: "OPENCODE",
  dataName: "opencode",
  overlayKey: "opencode_overlay",
  innerSandbox: false,
  notes: ["no inner no-network shell sandbox: model-run commands can reach the network (guard blocks common network clients by name only)"],
  extraEnv: () => ({
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "1",
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
  }),
})
