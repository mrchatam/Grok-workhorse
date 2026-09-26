// Config schema (providers/profiles/fallback lists), generated Kilo provider config, validation,
// clone-URL allowlist and the `workhorse add-repo` helper, against a throwaway config dir.
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kwt-config-"))
const cfgDir = path.join(root, "config")
fs.mkdirSync(cfgDir)
process.env.WH_CONFIG_DIR = cfgDir
process.env.WH_DATA_DIR = path.join(root, "data")
const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
for (const f of ["profiles.nvidia.json", "profiles.openrouter.json"]) fs.copyFileSync(path.join(APP, "config/examples", f), path.join(cfgDir, f))
fs.copyFileSync(path.join(APP, "config/examples/profiles.nvidia.json"), path.join(cfgDir, "profiles.json"))
fs.writeFileSync(path.join(cfgDir, "daemon.json"), JSON.stringify({ secret_env: ["EXTRA_TOKEN"], allowed_clone_hosts: ["github.com", "gitlab.example.org"] }))
const C = await import("../lib/config.mjs")
const A = await import("../lib/admin.mjs")
const { cloneUrlAllowed } = await import("../lib/git.mjs")

test("example NVIDIA profiles: provider derived from model, api_key_env becomes a required secret", () => {
  const pc = C.profilesConfig()
  assert.equal(pc.default_profile, "default")
  assert.equal(pc.profiles.default.provider, "nvidia")
  assert.deepEqual(pc.profiles.default.fallback, [])
  assert.deepEqual(pc.providers.nvidia.requires_env, ["NVIDIA_API_KEY"])
  assert.deepEqual(C.secretEnvNames(C.daemonConfig()).sort(), ["EXTRA_TOKEN", "NVIDIA_API_KEY"])
  assert.deepEqual(C.validateConfig(), [])
})

test("generated Kilo provider config: OpenAI-compatible, key only as {env:NAME}, model options kept", () => {
  const o = C.kiloProviderOverlay(C.profilesConfig())
  assert.deepEqual(o.enabled_providers, ["nvidia"])
  const p = o.provider.nvidia
  assert.equal(p.npm, "@ai-sdk/openai-compatible")
  assert.equal(p.options.baseURL, "https://integrate.api.nvidia.com/v1")
  assert.equal(p.options.apiKey, "{env:NVIDIA_API_KEY}")
  const m = p.models["nemotron-ultra"]
  assert.equal(m.id, "nvidia/nemotron-3-ultra-550b-a55b")
  assert.deepEqual(m.limit, { context: 131072, output: 16384 })
  assert.equal(m.options.chat_template_kwargs.enable_thinking, true)
  assert.equal(m.tool_call, true)
})

test("OpenRouter example swaps provider and uses a fallback list", () => {
  fs.copyFileSync(path.join(cfgDir, "profiles.openrouter.json"), path.join(cfgDir, "profiles.json"))
  const pc = C.profilesConfig()
  assert.deepEqual(pc.profiles.default.fallback, ["qwen-coder"])
  assert.deepEqual(C.secretEnvNames(C.daemonConfig()).sort(), ["EXTRA_TOKEN", "OPENROUTER_API_KEY"])
  assert.equal(C.kiloProviderOverlay(pc).provider.openrouter.options.baseURL, "https://openrouter.ai/api/v1")
  assert.deepEqual(C.validateConfig(), [])
})

test("tiered example (v0.3): escalation chain, routing, presets and auto settings validate", () => {
  fs.copyFileSync(path.join(APP, "config/examples/profiles.tiered.json"), path.join(cfgDir, "profiles.json"))
  const pc = C.profilesConfig()
  assert.deepEqual(C.validateConfig(), [])
  assert.deepEqual(pc.routing, { small: "cheap", medium: "mid", large: "strong" })
  assert.equal(pc.profiles.cheap.escalate_to, "mid")
  assert.equal(pc.presets["quick-fix"].auto_fix_rounds, 1)
  assert.equal(pc.auto.max_auto_runs, 3)
  assert.equal(pc.auto.review.profile, "cheap")
})

test("validateConfig reports undefined models, providers and fallbacks; string fallback accepted", () => {
  fs.writeFileSync(path.join(cfgDir, "profiles.json"), JSON.stringify({
    default_profile: "missing",
    profiles: { a: { model: "p/nope", fallback: "b" }, b: { model: "q/x" }, c: { model: "noslash", fallback: ["zzz"] } },
    providers: { p: { base_url: "http://x/v1", api_key_env: null, models: { m: { id: "m" } } } },
  }))
  const pc = C.profilesConfig()
  assert.deepEqual(pc.profiles.a.fallback, ["b"])
  assert.deepEqual(pc.providers.p.requires_env, [])
  const probs = C.validateConfig().join("\n")
  assert.match(probs, /default_profile 'missing'/)
  assert.match(probs, /model 'nope' is not defined under providers\.p\.models/)
  assert.match(probs, /provider 'q' is not defined/)
  assert.match(probs, /profile 'c': model must look like/)
  assert.equal(C.kiloProviderOverlay(pc).provider.p.options.apiKey, "none", "keyless providers (e.g. local Ollama) get a dummy key")
})

test("clone URLs: https/ssh on allowlisted hosts only", () => {
  const hosts = ["github.com", "gitlab.example.org"]
  for (const u of ["https://github.com/o/r.git", "https://github.com/o/r", "git@github.com:o/r.git", "https://gitlab.example.org/g/sub/r.git"]) assert.equal(cloneUrlAllowed(u, hosts), true, u)
  for (const u of ["https://evil.example/o/r", "https://tok@github.com/o/r", "http://github.com/o/r", "file:///etc", "https://github.com/o", "--upload-pack=x", "https://github.com/../r", "ext::sh -c x"]) assert.equal(cloneUrlAllowed(u, hosts), false, u)
})

test("test-command regex policy", () => {
  assert.equal(A.checkTestRegex("^npm test$"), null)
  assert.equal(A.checkTestRegex("^go test( \\./[A-Za-z0-9_/]+)?$"), null)
  assert.match(A.checkTestRegex("npm test"), /anchored/)
  assert.match(A.checkTestRegex("^npm test .*$"), /wildcards/)
  assert.match(A.checkTestRegex("^npm test; curl x$"), /metacharacters/)
  assert.match(A.checkTestRegex("^npm test( [^ ]+)$"), /wildcards/)
})

test("workhorse add-repo / remove-repo edit the allowlist", () => {
  const src = path.join(root, "my-project")
  fs.mkdirSync(path.join(src, "tests"), { recursive: true })
  fs.writeFileSync(path.join(src, "tests/test_x.py"), "")
  execFileSync("git", ["-C", src, "init", "-q", "-b", "trunk"])
  const r = A.addRepo(src, { test: "python3 -m unittest -v", allowTest: ["^python3 -m unittest tests\\.[A-Za-z0-9_]+$"] })
  assert.equal(r.added, "my-project")
  const doc = JSON.parse(fs.readFileSync(path.join(cfgDir, "repos.json"), "utf8"))
  const e = doc.repos["my-project"]
  assert.equal(e.path, fs.realpathSync(src))
  assert.equal(e.default_base, "trunk")
  assert.deepEqual(e.allowed_test_commands, ["^python3 -m unittest -v$", "^python3 -m unittest tests\\.[A-Za-z0-9_]+$"])
  assert.equal(e.trust_project_config, false)
  assert.ok(C.reposConfig().get("my-project").allowed_test_commands[0].test("python3 -m unittest -v"))
  assert.throws(() => A.addRepo(src, {}), /already exists/)
  const r2 = A.addRepo(src, { name: "auto-detect", force: true })
  assert.equal(r2.entry.test_command, "python3 -m unittest discover -s tests -v", "test command auto-detected")
  const u = A.addRepo("https://gitlab.example.org/team/app.git", { test: "npm test" })
  assert.equal(u.added, "app")
  assert.equal(u.entry.url, "https://gitlab.example.org/team/app.git")
  assert.throws(() => A.addRepo("https://evil.example/x/y.git", {}), /not allowed/)
  assert.throws(() => A.addRepo(path.join(root, "nope"), {}), /not a git repository/)
  assert.throws(() => A.addRepo(src, { name: "../x" }), /invalid repo name/)
  assert.throws(() => A.addRepo(src, { name: "bad-regex", allowTest: ["^make .*$"] }), /wildcards/)
  A.removeRepo("app")
  assert.equal(C.reposConfig().has("app"), false)
  assert.throws(() => A.removeRepo("app"), /not in the allowlist/)
})

test("createHelloRepo builds a node --test example repo once", () => {
  const d = path.join(root, "hello")
  assert.equal(A.createHelloRepo(d), true)
  assert.equal(A.createHelloRepo(d), false)
  const r = execFileSync("git", ["-C", d, "log", "--oneline"]).toString()
  assert.match(r, /hello-world example/)
  assert.ok(fs.existsSync(path.join(d, "hello.test.mjs")))
})

test("defaults: 15 min stall timeout, retention on, auto-detected Kilo/bwrap/PATH", () => {
  fs.writeFileSync(path.join(cfgDir, "daemon.json"), "{}")
  const c = C.daemonConfig()
  assert.equal(c.timeouts.stall_min, 15)
  assert.equal(c.retention.enabled, true)
  assert.equal(c.retention.worktree_days, 7)
  assert.ok(c.env_path.includes(path.dirname(fs.realpathSync(process.execPath))))
  assert.equal(c.data_dir, path.join(root, "data"))
})

test("backends: defaults, per-profile backend, legacy kilo/kilo_sandbox keys, unknown backend rejected", () => {
  const daemon = path.join(cfgDir, "daemon.json")
  const saved = fs.readFileSync(daemon, "utf8")
  const profiles = path.join(cfgDir, "profiles.json")
  const savedP = fs.readFileSync(profiles, "utf8")
  try {
    let c = C.daemonConfig()
    assert.equal(c.default_backend, "kilo")
    assert.ok(c.backends.kilo.config_dir.endsWith(path.join("adapters", "kilo", "config")))
    assert.ok(c.backends.opencode.config_dir.endsWith(path.join("adapters", "opencode", "config")))
    assert.equal(c.worker_sandbox.enabled, true)
    fs.writeFileSync(daemon, JSON.stringify({ kilo: { bin: "/opt/legacy/kilo", bwrap: "/opt/legacy/bwrap", home: "/legacy/home" }, kilo_sandbox: { ro_binds: ["/opt/go"] }, backends: { opencode: { bin: "/opt/oc" } } }))
    c = C.daemonConfig()
    assert.equal(c.backends.kilo.bin, "/opt/legacy/kilo")
    assert.equal(c.backends.kilo.home, "/legacy/home")
    assert.equal(c.bwrap, "/opt/legacy/bwrap")
    assert.equal(c.backends.opencode.bin, "/opt/oc")
    assert.deepEqual(c.worker_sandbox.ro_binds, ["/opt/go"])
    assert.ok(c.worker_sandbox.hide.includes("/home"), "legacy section merges over defaults")
    const p = JSON.parse(fs.readFileSync(path.join(APP, "config/examples/profiles.nvidia.json"), "utf8"))
    const dn = p.default_profile
    p.profiles[dn].backend = "opencode"
    p.profiles.bad = { model: p.profiles[dn].model, backend: "nope" }
    fs.writeFileSync(profiles, JSON.stringify(p))
    assert.equal(C.profilesConfig().profiles[dn].backend, "opencode")
    assert.match(C.validateConfig().join(), /unknown backend 'nope'/)
  } finally {
    fs.writeFileSync(daemon, saved)
    fs.writeFileSync(profiles, savedP)
  }
})
