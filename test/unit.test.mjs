import { test } from "node:test"
import assert from "node:assert/strict"
import { parseResultBlock, parseTestOutput, detectTestCommand, sandboxEnv } from "../lib/tasks.mjs"
import { redact, registerSecret } from "../lib/util.mjs"
import { REF_RE } from "../lib/git.mjs"
import { REPO_NAME_RE } from "../lib/config.mjs"
import { WorkhorseGuard } from "../adapters/kilo/config/plugin/workhorse-guard.js"

test("parseResultBlock parses the contract block", () => {
  const r = parseResultBlock("blah\n\n## RESULT\nstatus: done\nsummary: did it\n  across lines\nfiles_changed: a.py, b.py\ntests: pytest -> pass\nconcerns: x; y")
  assert.equal(r.status, "done")
  assert.equal(r.summary, "did it across lines")
  assert.equal(r.files_changed, "a.py, b.py")
  assert.equal(r.concerns, "x; y")
  assert.equal(parseResultBlock("no block"), null)
  assert.equal(parseResultBlock("## RESULT\n- **status**: partial").status, "partial")
})

test("parseTestOutput understands unittest/pytest/node", () => {
  assert.deepEqual(parseTestOutput("Ran 5 tests in 0.1s\n\nFAILED (failures=1, errors=2)"), { ran: 5, failures: 1, errors: 2 })
  assert.equal(parseTestOutput("==== 3 passed, 1 failed in 0.2s ====").failed, 1)
  assert.equal(parseTestOutput("# pass 7\n# fail 0").passed, 7)
})

test("detectTestCommand finds python unittest layout", () => {
  assert.equal(detectTestCommand(new URL("./fixtures/example-repo", import.meta.url).pathname), "python3 -m unittest discover -s tests -v")
})

test("repo name and ref validation reject traversal/injection", () => {
  for (const bad of ["../etc", "a/b", "/etc/passwd", ".hidden", "a b", "x;rm", "", "-rf", "a".repeat(80)]) assert.equal(REPO_NAME_RE.test(bad), false, bad)
  for (const bad of ["--upload-pack=x", "../x", "main;rm", "a..b", "HEAD~1", "x y", "-b"]) assert.equal(REF_RE.test(bad), false, bad)
  for (const ok of ["main", "feature/x-1", "v1.2.3", "f0353bf"]) assert.equal(REF_RE.test(ok), true, ok)
})

test("redact removes registered secrets and token-shaped strings", () => {
  registerSecret("supersecretvalue123")
  assert.equal(redact("key=supersecretvalue123!"), "key=[REDACTED]!")
  assert.equal(redact({ apiKey: "abc", nested: ["nvapi-ABCDEFGHIJKLMNOP"] }).apiKey, "[REDACTED]")
  assert.equal(redact({ nested: ["nvapi-ABCDEFGHIJKLMNOP"] }).nested[0], "[REDACTED]")
})

test("guard plugin blocks git mutation, network, secrets and outside paths", async () => {
  // The daemon passes the configured secret names and the secret-store / run-dir paths via env.
  process.env.WH_SECRET_NAMES = "NVIDIA_API_KEY,MY_PROVIDER_KEY"
  process.env.WH_GUARD_DENY_PATHS = JSON.stringify(["/srv/secrets/store.json", "/srv/secrets", "store.json", "/var/lib/kw/run"])
  const h = await WorkhorseGuard({ directory: "/tmp/wt" })
  const bash = async (c) => h["tool.execute.before"]({ tool: "bash" }, { args: { command: c } }).then(() => "allow", () => "block")
  for (const c of ["git commit -m x", "git -c a=b commit", "sh -c 'git push'", "git checkout main", "git reset --hard", "curl x", "cat /proc/1/environ", "echo $NVIDIA_API_KEY", "printenv MY_PROVIDER_KEY", "echo $GITHUB_TOKEN", "git branch new", "cat /srv/secrets/store.json", "jq . /srv/secrets/*.json", "cat /tmp/x*/store.json", "cat /var/lib/kw/run/token", "cat ~/.ssh/id_rsa"]) assert.equal(await bash(c), "block", c)
  for (const c of ["git status", "git diff tests/config.py", "git checkout -- a.py", "python3 -m unittest -v", "git log --oneline", "grep -r OPENAI_API_KEY src/"]) assert.equal(await bash(c), "allow", c)
  const w = async (f) => h["tool.execute.before"]({ tool: "write" }, { args: { filePath: f } }).then(() => "allow", () => "block")
  assert.equal(await w("a/b.py"), "allow")
  assert.equal(await w("/tmp/wt/a.py"), "allow")
  assert.equal(await w("../x"), "block")
  assert.equal(await w("/etc/x"), "block")
  process.env.NVIDIA_API_KEY = "x-test"
  process.env.MY_PROVIDER_KEY = "y-test"
  const o = { env: {} }
  await h["shell.env"]({}, o)
  delete process.env.NVIDIA_API_KEY
  delete process.env.MY_PROVIDER_KEY
  delete process.env.WH_SECRET_NAMES
  delete process.env.WH_GUARD_DENY_PATHS
  assert.equal(o.env.NVIDIA_API_KEY, "")
  assert.equal(o.env.MY_PROVIDER_KEY, "", "configured secret names are blanked too")
  assert.equal("GITHUB_TOKEN" in o.env, process.env.GITHUB_TOKEN !== undefined)
})

test("guard: git-mutation checks apply to bash command strings only, never to file-tool content", async () => {
  process.env.WH_GUARD_DENY_PATHS = JSON.stringify(["/srv/secrets/store.json"])
  const h = await WorkhorseGuard({ directory: "/tmp/wt" })
  const call = async (tool, args) => h["tool.execute.before"]({ tool }, { args }).then(() => "allow", () => "block")
  const text = "Workers never run `git commit -m x`, git push origin HEAD, git reset --hard or git checkout main.\n"
  // Regression: a write/edit whose CONTENT mentions git commit used to be treated like a command.
  assert.equal(await call("write", { filePath: "NOTES.md", content: text }), "allow")
  assert.equal(await call("edit", { filePath: "/tmp/wt/NOTES.md", oldString: "git commit", newString: text }), "allow")
  assert.equal(await call("multiedit", { filePath: "NOTES.md", edits: [{ filePath: "NOTES.md", oldString: "a", newString: text }] }), "allow")
  assert.equal(await call("apply_patch", { patchText: `*** Begin Patch\n*** Add File: NOTES.md\n+${text}*** End Patch` }), "allow")
  // Path checks still apply to those tools.
  assert.equal(await call("write", { filePath: "/etc/x", content: "hello" }), "block")
  assert.equal(await call("edit", { filePath: "../x.py", oldString: "a", newString: "b" }), "block")
  assert.equal(await call("multiedit", { filePath: "a.py", edits: [{ filePath: "/tmp/other/a.py", oldString: "a", newString: "b" }] }), "block")
  // A heredoc that `cat`/`tee` writes to a file is file content too...
  for (const c of [
    "cat > NOTES.md << 'EOF'\n# Notes\nThe supervisor runs git commit and git push.\nEOF",
    "cat <<EOF > a.md\ngit commit -m x\nEOF",
    "tee a.md >/dev/null <<-'X'\n\tgit push origin\n\tX",
  ]) assert.equal(await call("bash", { command: c }), "allow", c)
  // ...but not when the body is executed, expanded, unterminated, or followed by a real command.
  for (const c of [
    "git commit -m x",
    "bash << 'EOF'\ngit commit -m x\nEOF",
    "cat << 'EOF' | sh\ngit commit -m x\nEOF",
    "cat > a.sh << EOF\n$(git commit -m x)\nEOF",
    "cat > a.md << 'EOF'\ngit commit\nEOF\ngit commit -m y",
    "cat > a.md << 'EOF'\ngit commit\n",
    "python3 - << 'EOF'\nimport os; os.system('git commit -m x')\nEOF",
    "cat > a.md << 'EOF'\nsee /srv/secrets/store.json\nEOF", // secret-path rules still see the whole string
  ]) assert.equal(await call("bash", { command: c }), "block", c)
  delete process.env.WH_GUARD_DENY_PATHS
})

test("outer sandbox args: mounts bind a different source over a path inside a bound dir", async () => {
  const { outerSandboxArgs } = await import("../lib/sandbox.mjs")
  const fsm = await import("node:fs")
  const os = await import("node:os")
  const pathm = await import("node:path")
  const root = fsm.mkdtempSync(pathm.join(os.tmpdir(), "kwt-sbmounts-"))
  for (const d of ["data/kilo-home/.local/share", "data/kilo-data/t1/share", "data/wt"]) fsm.mkdirSync(pathm.join(root, d), { recursive: true })
  const a = outerSandboxArgs({
    hide: [pathm.join(root, "data")],
    rwBinds: [pathm.join(root, "data/kilo-home"), pathm.join(root, "data/wt")],
    mounts: [{ src: pathm.join(root, "data/kilo-data/t1/share"), dst: pathm.join(root, "data/kilo-home/.local/share") }],
  })
  const s = a.join(" ")
  const home = s.indexOf(`--bind ${root}/data/kilo-home ${root}/data/kilo-home`)
  const mount = s.indexOf(`--bind ${root}/data/kilo-data/t1/share ${root}/data/kilo-home/.local/share`)
  assert.ok(home > 0 && mount > home, "per-task data is mounted after (over) the shared Kilo HOME")
  assert.ok(!s.includes(`--bind ${root}/data/kilo-data/t1/share ${root}/data/kilo-data`), "source dir itself is not exposed at its own path")
  fsm.rmSync(root, { recursive: true, force: true })
})

test("outer sandbox args: hide dirs (symlinks resolved), files via /dev/null, bind back parents first", async () => {
  const { outerSandboxArgs } = await import("../lib/sandbox.mjs")
  const fsm = await import("node:fs")
  const os = await import("node:os")
  const pathm = await import("node:path")
  const root = fsm.mkdtempSync(pathm.join(os.tmpdir(), "kwt-sbargs-"))
  for (const d of ["secret", "data/worktrees/r/t1", "data/worktrees/r/t2", "data/run", "repo/.git", "home/.local"]) fsm.mkdirSync(pathm.join(root, d), { recursive: true })
  fsm.symlinkSync(pathm.join(root, "secret"), pathm.join(root, "secret-link"))
  fsm.writeFileSync(pathm.join(root, "store.json"), "{}")
  const a = outerSandboxArgs({
    hide: [pathm.join(root, "data"), pathm.join(root, "data/run"), pathm.join(root, "secret-link"), pathm.join(root, "store.json"), pathm.join(root, "repo"), pathm.join(root, "missing")],
    roBinds: [pathm.join(root, "repo/.git")],
    rwBinds: [pathm.join(root, "data/worktrees/r/t1")],
    chdir: pathm.join(root, "data/worktrees/r/t1"),
  })
  const s = a.join(" ")
  assert.ok(!a.includes("--disable-userns") && !a.includes("--unshare-net") && !a.includes("--new-session"), "must allow Kilo's nested bwrap and network")
  assert.match(s, /--unshare-user --unshare-pid .*--ro-bind \/ \/ --dev \/dev --proc \/proc/)
  assert.ok(s.includes(`--tmpfs ${root}/data`) && !s.includes(`--tmpfs ${root}/data/run`), "covered child hides are dropped")
  assert.ok(s.includes(`--tmpfs ${root}/secret `) && !s.includes("secret-link"), "symlinks resolved")
  assert.ok(s.includes(`--ro-bind /dev/null ${root}/store.json`))
  assert.ok(!s.includes("missing"))
  assert.ok(s.indexOf(`--tmpfs ${root}/repo`) < s.indexOf(`--ro-bind ${root}/repo/.git`))
  assert.ok(s.indexOf(`--tmpfs ${root}/data`) < s.indexOf(`--bind ${root}/data/worktrees/r/t1`))
  assert.ok(!s.includes("t2"))
  assert.ok(s.endsWith(`--chdir ${root}/data/worktrees/r/t1`))
  fsm.rmSync(root, { recursive: true, force: true })
})

test("sandboxEnv merges global + per-sandbox env and refuses PATH/HOME/KILO_*/XDG_*/WH_*/secret names", () => {
  const cfg = {
    secret_env: ["NVIDIA_API_KEY"],
    secret_names: ["MY_PROVIDER_KEY"],
    sandbox_env: { _comment: "x", GOPROXY: "off", GOCACHE: "/tmp/kilo/go-build", PATH: "/evil", HOME: "/x", NVIDIA_API_KEY: "k", MY_PROVIDER_KEY: "k", KILO_CONFIG: "c", XDG_DATA_HOME: "/x", WH_SECRET_NAMES: "", "BAD-NAME": "1" },
    test_sandbox: { env: { GOCACHE: "/tmp/go-build", N: 3 } },
  }
  assert.deepEqual(sandboxEnv(cfg, "test_sandbox"), { GOPROXY: "off", GOCACHE: "/tmp/go-build" })
  assert.deepEqual(sandboxEnv(cfg, "kilo_sandbox"), { GOPROXY: "off", GOCACHE: "/tmp/kilo/go-build" })
  assert.deepEqual(sandboxEnv({}, "test_sandbox"), {})
})
