// Integration tests against a real daemon + real Kilo CLI, with a scripted mock LLM.
import { before, after } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import * as H from "./helpers.mjs"

const env = await H.setupEnv("daemon")
let mock, daemon, rpc
const CANARY = "canary-secret-value-0123456789"

before(async () => {
  if (H.SKIP) return
  mock = H.startMock(env)
  // The mock provider "needs" NVIDIA_API_KEY here (api_key_env) so the daemon injects it into Kilo;
  // the worker shell must still not see it. GITHUB_TOKEN in the daemon env must never reach Kilo at all.
  H.editJson(path.join(env.cfgDir, "profiles.json"), (p) => { p.providers.mock.api_key_env = "NVIDIA_API_KEY" })
  daemon = await H.startDaemon(env, { NVIDIA_API_KEY: CANARY, GITHUB_TOKEN: "ghp_canaryGithubToken0123456789abcdef" })
  ;({ rpc } = await import("../lib/client.mjs"))
})
after(() => {
  if (H.SKIP) return
  try { process.kill(-daemon.pid, "SIGTERM") } catch {}
  mock.kill()
})

const delegate = (p) => rpc("delegate_task", { repo: H.REPO_NAME, ...p })
const R = H.REPO_NAME

H.itest("allowlist and input validation", async () => {
  const bad = [
    [{ repo: "not-allowed", task: "x" }, /not in the allowlist/],
    [{ repo: "../etc", task: "x" }, /invalid repo name/],
    [{ repo: `${R}/../../etc`, task: "x" }, /invalid repo name/],
    [{ repo: "/etc/passwd", task: "x" }, /invalid repo name/],
    [{ repo: "__proto__", task: "x" }, /invalid repo name|not in the allowlist/],
    [{ repo: "constructor", task: "x" }, /not in the allowlist/],
    [{ repo: H.REPO_NAME, task: "x", path: "/tmp" }, /unknown parameter 'path'/],
    [{ repo: H.REPO_NAME, task: "x", env: { A: "1" } }, /unknown parameter 'env'/],
    [{ repo: H.REPO_NAME, task: "x", test_command: "python3 -m unittest; curl evil" }, /test_command not allowed/],
    [{ repo: H.REPO_NAME, task: "x", test_command: "rm -rf ~" }, /test_command not allowed/],
    [{ repo: H.REPO_NAME, task: "x", base_ref: "--upload-pack=touch /tmp/x" }, /invalid base_ref/],
    [{ repo: H.REPO_NAME, task: "x", base_ref: "does-not-exist" }, /not found/],
    [{ repo: H.REPO_NAME, task: "x", profile: "nope" }, /unknown profile/],
    [{ repo: H.REPO_NAME, task: "x", profile: "off" }, /disabled/],
    [{ repo: H.REPO_NAME, task: "x", timeout_minutes: 9999 }, /timeout_minutes/],
    [{ repo: H.REPO_NAME, task: "" }, /required/],
  ]
  for (const [params, re] of bad) {
    await assert.rejects(rpc("delegate_task", params), re, JSON.stringify(params))
  }
  await assert.rejects(rpc("task_status", { task_id: "../../etc/passwd" }), /invalid task_id/)
  await assert.rejects(rpc("task_details", { task_id: "wh-20260101-000000-abcd", kind: "diff" }), /unknown task_id/)
  assert.equal(fs.readdirSync(path.join(env.dataDir, "worktrees")).length, 0, "no worktree created for rejected calls")
})

let doneTask
H.itest("happy path: implement + daemon-run tests + isolation of main clone", async () => {
  const mainHead = H.git(env.repoPath, "rev-parse", "HEAD")
  const r = await delegate({ task: "Implement multiply and divide in calc/core.py. MOCK_SCENARIO=implement_core", test_command: "python3 -m unittest tests.test_core -v" })
  assert.match(r.branch, /^workhorse\/wh-/)
  const st = await H.waitFor(rpc, r.task_id, H.isTerminal)
  const res = await rpc("task_result", { task_id: r.task_id })
  assert.equal(st.status, "completed")
  assert.equal(res.verdict, "success")
  assert.equal(res.backend, H.TEST_BACKEND)
  assert.deepEqual(res.files_changed.map((f) => f.path), ["calc/core.py"])
  assert.equal(res.test_results.passed, true)
  assert.equal(res.test_results.counts.ran, 5)
  assert.equal(res.integrity.commits_made, 0)
  assert.equal(res.integrity.main_clone_unchanged, true)
  assert.ok(res.session_id.startsWith("ses_"))
  assert.equal(H.git(env.repoPath, "rev-parse", "HEAD"), mainHead)
  assert.equal(H.git(env.repoPath, "status", "--porcelain"), "")
  assert.equal(H.git(r.worktree_path, "rev-parse", "HEAD"), mainHead, "no commit on task branch")
  assert.match(H.git(r.worktree_path, "status", "--porcelain"), /calc\/core\.py/)
  const diff = await rpc("task_details", { task_id: r.task_id, kind: "diff" })
  assert.match(diff.content, /return a \* b/)
  const page = await rpc("task_details", { task_id: r.task_id, kind: "activity", max_bytes: 1024 })
  assert.ok(page.content.length <= 1100 && page.next_offset > 0)
  doneTask = r
})

H.itest("escape attempts are blocked and nothing leaves the worktree", async () => {
  H.templateScenario(env, "escape", "escape_t", { __MAIN_CLONE__: env.repoPath })
  for (const f of ["/tmp/escape-test", "/tmp/escape-write", "/tmp/escape-py"]) fs.rmSync(f, { force: true })
  const r = await delegate({ task: "MOCK_SCENARIO=escape_t" })
  await H.waitFor(rpc, r.task_id, H.isTerminal)
  const res = await rpc("task_result", { task_id: r.task_id })
  for (const f of ["/tmp/escape-test", "/tmp/escape-write", "/tmp/escape-py", path.join(env.repoPath, "ESCAPE_MAIN"), path.join(path.dirname(r.worktree_path), "escape"), path.join(path.dirname(r.worktree_path), "escape-write")])
    assert.equal(fs.existsSync(f), false, `${f} must not exist`)
  assert.equal(res.integrity.commits_made, 0)
  assert.equal(res.integrity.main_clone_unchanged, true)
  assert.deepEqual(res.files_changed.map((f) => f.path), ["inside.txt"])
  const act = (await rpc("task_details", { task_id: r.task_id, kind: "activity", max_bytes: 65536 })).content
  assert.match(act, /BLOCKED[^\n]*git commit/)
  assert.match(act, /BLOCKED[^\n]*git push/)
  assert.equal(res.verdict, "blocked")
  if (H.TEST_BACKEND === "kilo") {
    assert.ok(res.activity.blocked_calls >= 8, `blocked_calls=${res.activity.blocked_calls}`)
    assert.match(act, /urlopen[^\n]*(Errno|Network|unreachable|resolution|URLError)/i)
    // Kilo's own bwrap is active even though it now runs nested inside the daemon's outer sandbox
    // (the outer layer gives Kilo a writable private /tmp and keeps the network; the inner one does not).
    assert.match(act, /BLOCKED\(sandbox\)[^\n]*\/tmp\/escape-test/)
  } else {
    // OpenCode has no inner shell sandbox: /tmp writes land in the outer sandbox's private tmpfs (checked
    // above: nothing reached the host) and are not reported as blocked; guard and path checks still are.
    assert.ok(res.activity.blocked_calls >= 5, `blocked_calls=${res.activity.blocked_calls}`)
  }
})

H.itest("worker env: provider key blanked in shells, GitHub token never passed", async () => {
  const r = await delegate({ task: "MOCK_SCENARIO=envcheck" })
  await H.waitFor(rpc, r.task_id, H.isTerminal)
  const act = (await rpc("task_details", { task_id: r.task_id, kind: "raw_events", max_bytes: 65536 })).content
  assert.match(act, /canary_count=0/)
  assert.match(act, /nonempty: [^"]*PATH/)
  assert.doesNotMatch(act, /nonempty:[^"]*(NVIDIA_API_KEY|GITHUB_TOKEN|GH_TOKEN)/)
  assert.doesNotMatch(act, /GITHUB_TOKEN|GH_TOKEN/, "GitHub token variables must not exist in the worker at all")
  assert.ok(!act.includes(CANARY))
  const audit = fs.readFileSync(path.join(env.dataDir, "logs/audit.jsonl"), "utf8")
  assert.ok(!audit.includes(CANARY) && !audit.includes("ghp_canary"))
  for (const id of fs.readdirSync(path.join(env.dataDir, "tasks")))
    for (const f of fs.readdirSync(path.join(env.dataDir, "tasks", id))) assert.ok(!fs.readFileSync(path.join(env.dataDir, "tasks", id, f), "utf8").includes(CANARY), `${id}/${f}`)
})

H.itest("continue_task resumes the same session and worktree", async () => {
  const r = await delegate({ task: "MOCK_SCENARIO=twophase", test_command: "python3 -m unittest tests.test_core -v" })
  await H.waitFor(rpc, r.task_id, H.isTerminal)
  const first = await rpc("task_result", { task_id: r.task_id })
  assert.equal(first.verdict, "success")
  const c = await rpc("continue_task", { task_id: r.task_id, instructions: "Also add NOTES.md" })
  assert.equal(c.session_id, first.session_id)
  await H.waitFor(rpc, r.task_id, H.isTerminal)
  const res = await rpc("task_result", { task_id: r.task_id })
  assert.equal(res.session_id, first.session_id)
  assert.deepEqual(res.files_changed.map((f) => f.path).sort(), ["NOTES.md", "calc/core.py"])
  assert.equal(res.activity.runs, 2)
})

H.itest("review mode works on a copy of another task's diff and cannot modify the original", async () => {
  const r = await rpc("delegate_task", { repo: H.REPO_NAME, mode: "review", review_task_id: doneTask.task_id, task: "Review for correctness. MOCK_SCENARIO=review_try_edit", test_command: "python3 -m unittest tests.test_core -v" })
  assert.notEqual(r.worktree_path, doneTask.worktree_path)
  await H.waitFor(rpc, r.task_id, H.isTerminal)
  const res = await rpc("task_result", { task_id: r.task_id })
  assert.equal(res.mode, "review")
  assert.deepEqual(res.files_changed, [])
  assert.deepEqual(res.reviewed_files.map((f) => f.path), ["calc/core.py"])
  assert.ok(res.remaining_concerns.some((c) => /docstring/.test(c)))
  assert.ok(res.activity.blocked_calls >= 2, "write and rm must be denied for the review agent")
  assert.match(fs.readFileSync(path.join(doneTask.worktree_path, "calc/core.py"), "utf8"), /return a \* b/)
  assert.match(fs.readFileSync(path.join(r.worktree_path, "calc/core.py"), "utf8"), /return a \* b/)
})

H.itest("missing credentials fail fast with a clear error", async () => {
  const r = await delegate({ task: "x", profile: "needskey" })
  const st = await H.waitFor(rpc, r.task_id, H.isTerminal)
  const res = await rpc("task_result", { task_id: r.task_id })
  assert.equal(st.status, "failed")
  assert.match(res.errors.join(" "), /WH_TEST_MISSING_KEY/)
})

H.itest("429s: daemon retries then falls back to the fallback profile", async () => {
  const r = await delegate({ task: "MOCK_SCENARIO=rlfallback" })
  const st = await H.waitFor(rpc, r.task_id, H.isTerminal, 240000)
  const res = await rpc("task_result", { task_id: r.task_id })
  assert.equal(st.status, "completed", JSON.stringify(res.errors))
  assert.equal(res.activity.retries, 1)
  assert.equal(res.activity.fallback_used, true)
  assert.equal(res.worker_model, "mock/coder2")
  assert.equal(res.activity.runs, 3)
  assert.deepEqual(res.activity.fallbacks_tried, ["mock2"])
})

H.itest("per-task backend data: a worker cannot see other tasks' session history; its own session survives for continue", async () => {
  assert.ok(doneTask, "happy-path task exists")
  const first = await rpc("task_result", { task_id: doneTask.task_id })
  const own = path.join(env.dataDir, "backend-data", doneTask.task_id)
  assert.ok(fs.existsSync(own), "per-task backend data dir exists")
  const hit = (dir) => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).some((e) => e.isFile() && fs.readFileSync(path.join(e.parentPath ?? e.path, e.name)).includes(first.session_id))
  assert.ok(hit(own), "the task's own session is stored in its own Kilo data dir")
  assert.equal(hit(path.join(H.TEST_HOME, ".local")), false, "nothing lands in the shared Kilo HOME's data dirs")
  // The id is split in the probe command: the command text itself is stored in the probe's own session.
  const sid = first.session_id
  H.templateScenario(env, "kilodataprobe", "kilodataprobe_t", { __OTHER_A__: sid.slice(0, 8), __OTHER_B__: sid.slice(8), __DATA__: env.dataDir })
  const r = await delegate({ task: "MOCK_SCENARIO=kilodataprobe_t" })
  await H.waitFor(rpc, r.task_id, H.isTerminal)
  const ev = (await rpc("task_details", { task_id: r.task_id, kind: "raw_events", max_bytes: 65536 })).content
  assert.match(ev, /OTHER_SESSION_HITS=0 FILES_SCANNED=[1-9]/, "the probe saw its own Kilo data but no other session")
  assert.match(ev, /KILODATA=\[[^\]]*No such file/, "the backend-data root is hidden")
})

H.itest("no RESULT block and no changes -> no_changes verdict with concern", async () => {
  const r = await delegate({ task: "MOCK_SCENARIO=noresult" })
  await H.waitFor(rpc, r.task_id, H.isTerminal)
  const res = await rpc("task_result", { task_id: r.task_id })
  assert.equal(res.verdict, "no_changes")
  assert.ok(res.remaining_concerns.some((c) => /RESULT block/.test(c)))
})

H.itest("cancel stops the Kilo process tree and keeps the worktree", async () => {
  const r = await delegate({ task: "MOCK_SCENARIO=slowthendone" })
  await H.waitFor(rpc, r.task_id, (s) => s.status === "running" && s.activity.turns >= 0)
  await H.sleep(12000)
  const pid = JSON.parse(fs.readFileSync(path.join(env.dataDir, "tasks", r.task_id, "task.json"), "utf8")).runs[0].pid
  await rpc("cancel_task", { task_id: r.task_id })
  const st = await H.waitFor(rpc, r.task_id, H.isTerminal)
  assert.equal(st.status, "cancelled")
  assert.equal(fs.existsSync(`/proc/${pid}`), false, "kilo process gone")
  assert.ok(fs.existsSync(r.worktree_path))
})

H.itest("stall detection and wall-clock timeout kill the worker", async () => {
  fs.writeFileSync(path.join(env.cfgDir, "daemon.json"), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(env.cfgDir, "daemon.json"), "utf8")), timeouts: { default_min: 5, min_min: 0.05, max_min: 30, stall_min: 0.4, test_min: 2, kill_grace_sec: 3 } }))
  const a = await delegate({ task: "MOCK_SCENARIO=hang" })
  const b = await delegate({ task: "MOCK_SCENARIO=sleepbash", timeout_minutes: 0.3 })
  const sa = await H.waitFor(rpc, a.task_id, H.isTerminal, 120000)
  const sb = await H.waitFor(rpc, b.task_id, H.isTerminal, 120000)
  assert.equal(sa.status, "stalled")
  assert.equal(sb.status, "timeout")
  const tb = JSON.parse(fs.readFileSync(path.join(env.dataDir, "tasks", b.task_id, "task.json"), "utf8"))
  assert.equal(fs.existsSync(`/proc/${tb.runs[0].pid}`), false)
})

H.itest("cleanup refuses unmerged work, archives the patch, honors the explicit flag, allows merged work", async () => {
  await assert.rejects(rpc("cleanup_task", { task_id: doneTask.task_id }), /not present on 'main'/)
  assert.ok(fs.existsSync(doneTask.worktree_path))
  // supervisor "merges" the change into main by applying the patch in the main clone
  const patch = path.join(env.dataDir, "tasks", doneTask.task_id, "diff.patch")
  H.git(env.repoPath, "apply", patch)
  H.git(env.repoPath, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "merge worker change")
  const ok = await rpc("cleanup_task", { task_id: doneTask.task_id })
  assert.equal(ok.merged, true)
  assert.equal(fs.existsSync(doneTask.worktree_path), false)
  assert.doesNotMatch(H.git(env.repoPath, "branch", "--list"), new RegExp(doneTask.task_id))
  // unmerged + explicit discard
  const t2 = (await rpc("list_tasks", { status: "terminal", limit: 50 })).tasks.find((t) => t.task.includes("twophase"))
  await assert.rejects(rpc("cleanup_task", { task_id: t2.task_id }), /discard_unmerged_changes/)
  const forced = await rpc("cleanup_task", { task_id: t2.task_id, discard_unmerged_changes: true })
  assert.equal(forced.merged, false)
  assert.ok(fs.statSync(forced.archived_diff_path).size > 0)
  await assert.rejects(rpc("continue_task", { task_id: t2.task_id, instructions: "more" }), /cleaned up/)
})

H.itest("health_report and retention sweep (cleanup_old): archive diff, remove worktree + backend data, purge old tasks", async () => {
  const h = await rpc("health_report", {})
  assert.equal(h.ok, true)
  assert.equal(h.default_profile, "mock")
  assert.ok(typeof h.stall_min === "number" && h.stall_min > 0) // an earlier test lowers it
  assert.equal(h.default_backend, H.TEST_BACKEND)
  assert.equal(h.backends.find((b) => b.name === H.TEST_BACKEND)?.installed, true)
  assert.equal(h.backends.find((b) => b.name === "gemini")?.status, "skeleton")
  assert.ok(h.profiles.find((p) => p.name === "needskey").available === false)
  // Based on the initial commit: main already contains this change after the cleanup test "merged" it.
  const root = H.git(env.repoPath, "rev-list", "--max-parents=0", "HEAD").trim()
  const r = await delegate({ task: "Implement multiply and divide. MOCK_SCENARIO=implement_core", base_ref: root })
  await H.waitFor(rpc, r.task_id, H.isTerminal)
  const dry = await rpc("cleanup_old", { worktree_days: 0, dry_run: true })
  assert.ok(dry.worktrees_removed.includes(r.task_id))
  assert.ok(fs.existsSync(r.worktree_path), "dry run changes nothing")
  await assert.rejects(rpc("cleanup_old", { worktree_days: -1 }), /worktree_days/)
  const sw = await rpc("cleanup_old", { worktree_days: 0 })
  assert.ok(sw.worktrees_removed.includes(r.task_id))
  assert.equal(fs.existsSync(r.worktree_path), false)
  assert.equal(fs.existsSync(path.join(env.dataDir, "backend-data", r.task_id)), false)
  assert.doesNotMatch(H.git(env.repoPath, "branch", "--list"), new RegExp(r.task_id))
  assert.match(fs.readFileSync(path.join(env.dataDir, "tasks", r.task_id, "diff.patch"), "utf8"), /return a \* b/, "unmerged diff archived before removal")
  await assert.rejects(rpc("continue_task", { task_id: r.task_id, instructions: "more" }), /cleaned up/)
  const purge = await rpc("cleanup_old", { task_days: 0 })
  assert.ok(purge.tasks_deleted.includes(r.task_id))
  assert.equal(fs.existsSync(path.join(env.dataDir, "tasks", r.task_id)), false)
  await assert.rejects(rpc("task_status", { task_id: r.task_id }), /unknown task_id/)
})

H.itest("audit log records tool calls and lifecycle events", async () => {
  const lines = fs.readFileSync(path.join(env.dataDir, "logs/audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
  assert.ok(lines.some((l) => l.kind === "rpc" && l.method === "delegate_task" && l.ok === false))
  assert.ok(lines.some((l) => l.kind === "task" && l.event === "finished"))
  assert.ok(lines.some((l) => l.kind === "task" && l.event === "cleanup"))
})
