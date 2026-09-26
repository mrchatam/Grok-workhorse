// Outer sandbox around `kilo run` (lib/sandbox.mjs) + guard content false-positive regression, end to end
// through a real daemon and the real Kilo CLI (scripted mock LLM).
// Proves: a worker shell command that builds the secret-store path at runtime (so no guard/permission
// pattern matches) still cannot read it, because the path does not exist in the worker's mount namespace;
// neither do the daemon token, other tasks' worktrees/task dirs/Kilo data, the main clone's working tree,
// the rest of $HOME and /run. Kilo's inner bwrap still works when nested (read-only /tmp, no network).
// The probe never prints file contents, only OK/FAIL.
import { before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import * as H from "./helpers.mjs"

const env = await H.setupEnv("sandbox")
let mock, daemon, rpc, STORE, DECOY, cfg

before(async () => {
  if (H.SKIP) return
  STORE = path.join(env.root, "store", "wh-test-secret-store.json")
  fs.mkdirSync(path.dirname(STORE), { mode: 0o700 })
  fs.writeFileSync(STORE, JSON.stringify({ card: { SOME_TOKEN: "fake-token-value-not-a-secret" } }), { mode: 0o600 })
  DECOY = path.join(env.root, "decoy-secrets.json")
  fs.writeFileSync(DECOY, JSON.stringify({ X: "decoy-value-not-a-secret" }), { mode: 0o600 })
  H.editJson(path.join(env.cfgDir, "daemon.json"), (d) => { d.secret_store_path = STORE })
  mock = H.startMock(env)
  daemon = await H.startDaemon(env)
  ;({ rpc } = await import("../lib/client.mjs"))
  cfg = (await import("../lib/config.mjs")).daemonConfig()
})
after(() => {
  if (H.SKIP) return
  try { process.kill(-daemon.pid, "SIGTERM") } catch {}
  mock.kill()
})

H.itest("outer sandbox hides secret store, token, other worktrees and main clone; inner sandbox (if any) and git still work", async () => {
  const R = H.REPO_NAME
  // Another task's worktree that the probe must not see.
  const other = await rpc("delegate_task", { repo: R, task: "Nothing to do." })
  await H.waitFor(rpc, other.task_id, H.isTerminal)
  assert.ok(fs.existsSync(path.join(other.worktree_path, "calc/core.py")))
  assert.ok(fs.existsSync(path.join(env.dataDir, "run/token")))
  const home = os.homedir()
  H.templateScenario(env, "sandboxprobe", "sandboxprobe_t", {
    __STORE_REV__: [...STORE].reverse().join(""), __DATA__: env.dataDir, __REPO_NAME__: R, __REPO__: env.repoPath,
    __OTHER_WT__: other.worktree_path, __DECOY__: DECOY, __HOME__: home,
  })
  const r = await rpc("delegate_task", { repo: R, task: "MOCK_SCENARIO=sandboxprobe_t" })
  const st = await H.waitFor(rpc, r.task_id, H.isTerminal)
  const res = await rpc("task_result", { task_id: r.task_id })
  const ev = (await rpc("task_details", { task_id: r.task_id, kind: "raw_events", max_bytes: 65536 })).content
  const act = (await rpc("task_details", { task_id: r.task_id, kind: "activity", max_bytes: 65536 })).content
  assert.equal(st.status, "completed", JSON.stringify(res.errors))

  // 1. runtime-built reads of the configured store (file and dir), a decoy in the test dir and the daemon token all fail
  for (const label of ["store", "storedir", "decoy", "token"]) assert.match(ev, new RegExp(`PROBE ${label} read=FAIL:(FileNotFoundError|NotADirectoryError|PermissionError)`), label)
  assert.doesNotMatch(ev, /PROBE \w+ read=OK/)
  assert.doesNotMatch(ev, /guard blocked this call: access to the secret store/, "probe must not have been stopped by the guard (it has to prove the sandbox)")
  // 2. only this task's worktree is visible; no task dirs, main clone has only its .git, /run is empty,
  //    the data dir shows only worktrees/ and repos/ (no run/, tasks/, logs/, backend-data/)
  assert.match(ev, new RegExp(`WT=\\[${r.task_id} \\]`))
  assert.match(ev, new RegExp(`PYLIST=${r.task_id}(\\\\n|")`))
  assert.ok(!new RegExp(`WT=\\[[^\\]]*${other.task_id}`).test(ev), "other task's worktree must be hidden")
  assert.match(ev, /OTHER=hidden/)
  assert.match(ev, /TASKS=\[[^\]]*No such file/)
  assert.match(ev, /MAIN=\[\.git \]/)
  assert.match(ev, /RUNDIR=\[\]/)
  assert.match(ev, /DATADIR=\[repos worktrees \]/) // repos/ holds only the bound .git of this repo (MAIN above)
  // $HOME shows only the parents of read-only toolchain binds (auto-detected Node/Kilo dirs + ro_binds).
  const binds = cfg.toolchain_binds.filter((p) => p.startsWith(home + "/"))
  const expected = [...new Set(binds.map((p) => p.slice(home.length + 1).split("/")[0]))].sort()
  const seen = (ev.match(/HOMEDIR=\[(?!\$\()([^\]]*)\]/) || [])[1] // the probe's output, not its command text
  assert.ok(seen !== undefined, "HOMEDIR probe ran")
  assert.deepEqual(seen.trim().split(/\s+/).filter(Boolean).sort(), expected)
  // 3. backends with an inner sandbox (Kilo's nested bwrap) keep /tmp read-only for shells; backends
  //    without one (opencode) rely on the outer sandbox alone. git works on the ro git dir either way.
  if (H.TEST_BACKEND === "kilo") assert.match(act, /BLOCKED\(sandbox\)[^\n]*probe-ro/)
  else assert.match(ev, /ro_rc=0/, "no inner sandbox: the write lands in the outer sandbox's private /tmp")
  assert.match(ev, /git_rc=0/)
  // 4. guard regression: write/edit whose CONTENT mentions git commit/push are allowed (paths are still checked)
  assert.deepEqual(res.files_changed.map((f) => f.path).sort(), ["NOTES.md"])
  const notes = fs.readFileSync(path.join(r.worktree_path, "NOTES.md"), "utf8")
  assert.match(notes, /git commit -m 'x' is forbidden/)
  assert.match(notes, /never run git commit or git push/)
  assert.doesNotMatch(ev, /guard blocked/, "the guard itself blocks nothing here (not even the cat heredoc)")
  // Known remaining layer: kilo.jsonc's catch-all bash rules ("*git commit*", "*git push*") match the whole
  // command text, so a cat heredoc whose BODY mentions git push is still denied by Kilo's permission layer.
  assert.match(act, /BLOCKED: cat > DOCS\.md[^\n]*rule which prevents you/)
  assert.equal(fs.existsSync(path.join(r.worktree_path, "DOCS.md")), false)
  const expectedBlocked = H.TEST_BACKEND === "kilo" ? 2 : 1 // without an inner sandbox the /tmp write is not a blocked call
  assert.equal(res.activity.blocked_calls, expectedBlocked, "only the deliberate /tmp write (inner sandbox only) and the heredoc are blocked")
  assert.equal(res.integrity.commits_made, 0)
})
