// TEST-ONLY scripted fake worker ("stub" backend). It lets the integration tests exercise the real
// daemon paths (scheduler -> spawn -> event parsing -> daemon-run tests -> finalize -> handoff ->
// approve/continue/retry/fallback/restart/auto-fix/escalation/review) without a coding-agent CLI or a
// model, e.g. in GitHub Actions.
//
// It can never be selected in production:
//   - adapters/index.mjs registers it only when the DAEMON process has WH_ENABLE_STUB_BACKEND=1. The
//     supervisor/MCP auto-start passes the daemon a minimal env (lib/client.mjs startSupervisor), so a
//     daemon started by the MCP shim or `workhorse start` never has it unless an operator exports it.
//   - validate() refuses again at task start when the flag is missing, and refuses any bin other than
//     the bundled adapters/stub/stub-cli.mjs.
//   - It is not in the config defaults, the installer or `workhorse validate`'s known backends.
// Scenarios: JSON files in daemon.json backends.stub.scenarios_dir (see stub-cli.mjs for the format).
import path from "node:path"
import { fileURLToPath } from "node:url"

export const STUB_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "stub-cli.mjs")
export const stubEnabled = () => process.env.WH_ENABLE_STUB_BACKEND === "1"

export default {
  name: "stub",
  status: "test-only",
  summary: "Scripted fake worker for integration tests (daemon env WH_ENABLE_STUB_BACKEND=1 only)",
  notes: ["test-only; never available in production"],
  capabilities: { resume: true, review_agent: true, inner_sandbox: false, guard: "none", providers: "none" },

  validate({ bc }) {
    const out = []
    if (!stubEnabled()) out.push("backend 'stub' is test-only (the daemon was not started with WH_ENABLE_STUB_BACKEND=1)")
    if (bc?.bin_real && path.resolve(bc.bin_real) !== path.resolve(STUB_CLI)) out.push("backend 'stub' must use the bundled adapters/stub/stub-cli.mjs")
    return out
  },
  prepare() {},
  command(ctx) {
    return ["--model", ctx.profile.model, ...(ctx.resumeSession ? ["--session", ctx.resumeSession] : []), "--", ctx.message]
  },
  env(ctx) {
    return { WH_STUB_STATE: ctx.dataDir, WH_STUB_SCENARIOS: ctx.bc.scenarios_dir || "" }
  },
  sandbox(ctx) {
    return { roBinds: [path.dirname(STUB_CLI), ctx.bc.scenarios_dir].filter(Boolean), rwBinds: [ctx.dataDir] }
  },
  // stub-cli already prints normalized events.
  parse(ev) {
    return ev && typeof ev.type === "string" ? [ev] : []
  },
}
