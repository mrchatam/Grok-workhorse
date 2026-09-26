// Kilo CLI backend (tested). Kilo adds its own inner bubblewrap sandbox for model-run shell commands
// (writes only in the worktree, no network), configured in adapters/kilo/config/kilo.jsonc.
import { opencodeFamily } from "../opencode-family.mjs"

export default opencodeFamily({
  name: "kilo",
  status: "tested",
  summary: "Kilo CLI (`kilo run --format json`), guard plugin + Kilo's inner no-network shell sandbox",
  prefix: "KILO",
  dataName: "kilo",
  overlayKey: "kilo_overlay",
  innerSandbox: true,
  extraEnv: (ctx) => ({
    KILO_NO_DAEMON: "1",
    KILO_TELEMETRY_LEVEL: "off",
    KILO_DISABLE_SESSION_INGEST: "1",
    KILO_DISABLE_PRESENCE: "1",
    KILO_DISABLE_CODEBASE_INDEXING: "1",
    KILO_SESSION_RETRY_LIMIT: String(ctx.bc.session_retry_limit ?? 4),
  }),
})
