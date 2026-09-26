// Process-tree helpers based on /proc (Linux only).
import fs from "node:fs"

export function procStart(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
    if (rest[0] === "Z" || rest[0] === "X") return null // zombie/dead
    return rest[19] // field 22 (starttime) counted after "pid (comm)"
  } catch {
    return null
  }
}

export function alive(pid, start) {
  if (!pid) return false
  const s = procStart(pid)
  return s !== null && (start == null || String(s) === String(start))
}

function children() {
  const map = new Map()
  for (const d of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue
    try {
      const stat = fs.readFileSync(`/proc/${d}/stat`, "utf8")
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1])
      if (!map.has(ppid)) map.set(ppid, [])
      map.get(ppid).push(Number(d))
    } catch {}
  }
  return map
}

export function descendants(pid) {
  const map = children()
  const out = []
  const stack = [pid]
  while (stack.length) {
    const p = stack.pop()
    for (const c of map.get(p) || []) {
      out.push(c)
      stack.push(c)
    }
  }
  return out
}

function signalAll(pids, sig) {
  for (const p of pids) {
    try {
      process.kill(p, sig)
    } catch {}
  }
}

// SIGTERM the whole tree (process group + all descendants, including bwrap sessions that
// called setsid), then SIGKILL whatever survives after graceMs.
export async function killTree(pid, graceMs = 10000) {
  if (!pid) return
  const tree = [pid, ...descendants(pid)]
  try {
    process.kill(-pid, "SIGTERM")
  } catch {}
  signalAll(tree, "SIGTERM")
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) {
    if (!tree.some((p) => procStart(p) !== null)) return
    await new Promise((r) => setTimeout(r, 200))
  }
  const again = [...new Set([...tree, ...descendants(pid)])]
  try {
    process.kill(-pid, "SIGKILL")
  } catch {}
  signalAll(again, "SIGKILL")
}
