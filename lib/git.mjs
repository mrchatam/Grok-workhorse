// Git helpers. All commands use execFile with argument arrays (no shell) and a minimal env.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { run } from "./util.mjs"
import { daemonConfig } from "./config.mjs"

function gitEnv(extra = {}) {
  const cfg = daemonConfig()
  return {
    PATH: cfg.env_path,
    HOME: process.env.HOME || os.homedir(), // needed only for clone/fetch credential helpers
    LANG: "C.UTF-8",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    ...extra,
  }
}

export async function git(cwd, args, opts = {}) {
  const r = await run("git", ["-C", cwd, ...args], { env: gitEnv(opts.env), timeout: opts.timeout || 120000 })
  if (r.code !== 0 && !opts.allowFail) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim() || r.stdout.trim()}`)
  return r
}

export const REF_RE = /^(?!-)(?!.*\.\.)(?!.*[\\~^:?*\[\s])[A-Za-z0-9._\/@{}-]{1,200}$/

// https://<host>/<owner>/<repo>[.git] (nested groups allowed) or git@<host>:<owner>/<repo>[.git],
// with <host> in the allowlist. No credentials in the URL, no options, no local/file transports.
export function cloneUrlAllowed(url, hosts = ["github.com"]) {
  if (typeof url !== "string" || url.length > 300) return false
  const seg = "[A-Za-z0-9._-]+"
  const m =
    new RegExp(`^https://([A-Za-z0-9.-]+)/(${seg}(?:/${seg})+?)(?:\\.git)?/?$`).exec(url) ||
    new RegExp(`^git@([A-Za-z0-9.-]+):(${seg}(?:/${seg})+?)(?:\\.git)?$`).exec(url)
  if (!m || m[2].split("/").some((p) => p === "." || p === "..")) return false
  return (hosts || []).map((h) => String(h).toLowerCase()).includes(m[1].toLowerCase())
}

export async function ensureRepo(repo) {
  const isRepo = fs.existsSync(path.join(repo.path, ".git"))
  if (!isRepo) {
    if (!repo.url) throw new Error(`repo '${repo.name}' has no local clone at ${repo.path} and no url to clone from`)
    if (!cloneUrlAllowed(repo.url, daemonConfig().allowed_clone_hosts))
      throw new Error(`repo '${repo.name}' url is not an https/ssh git URL on an allowed host (daemon.json allowed_clone_hosts)`)
    fs.mkdirSync(path.dirname(repo.path), { recursive: true })
    const r = await run("git", ["clone", "--", repo.url, repo.path], { env: gitEnv(), timeout: 600000 })
    if (r.code !== 0) throw new Error(`clone failed: ${r.stderr.trim()}`)
  } else if (repo.url && repo.fetch_before_task) {
    await git(repo.path, ["fetch", "--prune", "origin"], { timeout: 300000, allowFail: true })
  }
}

export async function resolveCommit(repoPath, ref) {
  if (!REF_RE.test(ref)) throw new Error(`invalid base_ref '${ref}'`)
  const cands = [ref, `origin/${ref}`]
  for (const c of cands) {
    const r = await git(repoPath, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${c}^{commit}`], { allowFail: true })
    if (r.code === 0) return r.stdout.trim()
  }
  throw new Error(`base_ref '${ref}' not found in repo`)
}

export async function addWorktree(repoPath, wtPath, branch, commit) {
  fs.mkdirSync(path.dirname(wtPath), { recursive: true })
  await git(repoPath, ["worktree", "add", "-b", branch, "--", wtPath, commit])
}

export async function mainCloneFingerprint(repoPath) {
  const head = (await git(repoPath, ["rev-parse", "HEAD"], { allowFail: true })).stdout.trim()
  const status = (await git(repoPath, ["status", "--porcelain=v1", "--untracked-files=all"], { allowFail: true })).stdout
  const branches = (await git(repoPath, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "--exclude=refs/heads/workhorse/*"], { allowFail: true })).stdout
  return { head, status, branches }
}

// Diff of everything in the worktree (tracked + untracked, respecting .gitignore) against the base
// commit, computed with a throwaway index so the worktree's own index is untouched.
export async function collectDiff(wtPath, baseCommit, tmpIndex) {
  const env = { GIT_INDEX_FILE: tmpIndex }
  try {
    await git(wtPath, ["read-tree", "HEAD"], { env })
    await git(wtPath, ["add", "-A", "--", "."], { env })
    const patch = (await git(wtPath, ["diff", "--cached", "--binary", "--no-color", baseCommit], { env })).stdout
    const numstat = (await git(wtPath, ["diff", "--cached", "--numstat", baseCommit], { env })).stdout
    const namestatus = (await git(wtPath, ["diff", "--cached", "--name-status", baseCommit], { env })).stdout
    const shortstat = (await git(wtPath, ["diff", "--cached", "--shortstat", baseCommit], { env })).stdout.trim()
    const statusMap = {}
    for (const line of namestatus.split("\n").filter(Boolean)) {
      const parts = line.split("\t")
      statusMap[parts[parts.length - 1]] = parts[0]
    }
    const files = numstat.split("\n").filter(Boolean).map((line) => {
      const [a, d, ...rest] = line.split("\t")
      const p = rest.join("\t")
      return { path: p, status: statusMap[p] || "M", added: a === "-" ? null : Number(a), deleted: d === "-" ? null : Number(d) }
    })
    return { patch, files, shortstat: shortstat || "no changes" }
  } finally {
    fs.rmSync(tmpIndex, { force: true })
  }
}

export async function commitsSince(wtPath, baseCommit) {
  const r = await git(wtPath, ["rev-list", "--count", `${baseCommit}..HEAD`], { allowFail: true })
  return Number(r.stdout.trim() || 0)
}

export async function removeWorktree(repoPath, wtPath, branch) {
  await git(repoPath, ["worktree", "remove", "--force", "--", wtPath], { allowFail: true })
  if (fs.existsSync(wtPath)) fs.rmSync(wtPath, { recursive: true, force: true })
  await git(repoPath, ["worktree", "prune"], { allowFail: true })
  if (branch) await git(repoPath, ["branch", "-D", "--", branch], { allowFail: true })
}

// True if every changed file in the worktree already has identical content on the repo's
// default branch (i.e. the supervisor merged/applied the work).
export async function changesMergedInto(repoPath, wtPath, files, targetRef) {
  for (const f of files) {
    const r = await git(repoPath, ["show", `${targetRef}:${f.path}`], { allowFail: true })
    const wtFile = path.join(wtPath, f.path)
    const exists = fs.existsSync(wtFile)
    if (f.status.startsWith("D")) {
      if (r.code === 0) return false
      continue
    }
    if (!exists || r.code !== 0) return false
    if (fs.readFileSync(wtFile, "utf8") !== r.stdout) return false
  }
  return true
}
