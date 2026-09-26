// Outer sandbox for every worker run (any backend): a bwrap mount + PID namespace that hides everything
// a worker has no business reading (the secret store, the daemon token, other tasks' worktrees, task
// dirs and session data, repo main clones, the rest of /home and /workspace, host sockets under /run).
// Backends with their own sandbox (Kilo's bwrap for model-run shells) nest inside it and see "/" as seen
// HERE, so hidden paths are invisible to the agent and every command it spawns, however spelled.
//
// Nesting requirements (tested in test/sandbox.test.mjs):
//  - no --disable-userns here: Kilo's inner bwrap needs to create its own user namespace;
//  - --unshare-pid + --proc: the inner bwrap can only mount a fresh /proc if a fully visible procfs
//    exists in its mount namespace (the ro-bound host /proc fails with "setting up uid map: Read-only
//    file system"); it also hides the daemon's and other tasks' processes;
//  - no --unshare-net: the agent must reach the model API (Kilo's inner sandbox denies shells the network);
//  - no --new-session / --die-with-parent: the daemon kills the process group and the tree via /proc,
//    and recovery after a daemon crash kills orphans itself.
// The API key still reaches the agent through the environment (bwrap passes env through; argv has no secrets).
import fs from "node:fs"
import path from "node:path"

const real = (p) => {
  if (!p) return null
  try { return fs.realpathSync(p) } catch { return null }
}
const within = (child, parent) => child === parent || child.startsWith(parent === "/" ? "/" : parent + "/")

const isDir = (p) => {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}
// Hide one path: an empty tmpfs over a directory, /dev/null over a file.
const hideArgs = (h) => (isDir(h) ? ["--tmpfs", h] : ["--ro-bind", "/dev/null", h])

// Returns the bwrap argv prefix (without "--" and the command).
// hide: paths to make empty/invisible; roBinds / rwBinds: paths to bind back (read-only / read-write)
// at the same location; mounts: [{src, dst, ro}] binds to a different location (e.g. a per-task
// backend data dir mounted over the shared backend HOME's .local/share).
export function outerSandboxArgs({ hide = [], roBinds = [], rwBinds = [], mounts = [], chdir }) {
  const binds = [
    ...roBinds.map((p) => ({ src: real(p), p: real(p), ro: true })),
    ...rwBinds.map((p) => ({ src: real(p), p: real(p), ro: false })),
    ...mounts.map((m) => ({ src: real(m.src), p: real(m.dst), ro: m.ro === true })),
  ].filter((b) => b.src && b.p && b.p !== "/")
  // Resolve symlinks (e.g. a store dir that is a symlink, /var/run -> /run), drop missing paths and
  // paths already covered by a hidden ancestor.
  const resolved = [...new Set(hide.map(real).filter((h) => h && h !== "/"))].sort((a, b) => a.length - b.length)
  const hides = resolved.filter((h, i) => !resolved.slice(0, i).some((o) => within(h, o)))
  const args = [
    "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
    "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc",
  ]
  for (const h of hides) args.push(...hideArgs(h))
  // Parents before children so a nested bind is not shadowed by its parent's bind.
  binds.sort((a, b) => a.p.length - b.p.length)
  for (const b of binds) args.push(b.ro ? "--ro-bind" : "--bind", b.src, b.p)
  // A hidden path strictly inside a bound path would be re-exposed by that bind: hide it again.
  for (const h of resolved) if (binds.some((b) => h !== b.p && within(h, b.p))) args.push(...hideArgs(h))
  if (chdir) args.push("--chdir", real(chdir) || chdir)
  return args
}
