// RPC client for the daemon + auto-start of the supervisor when the daemon is not running.
import fs from "node:fs"
import os from "node:os"
import http from "node:http"
import path from "node:path"
import { spawn } from "node:child_process"
import { SOCKET_PATH, TOKEN_PATH, APP_DIR, CONFIG_DIR, DATA_DIR, dirs, daemonConfig, secretEnvNames } from "./config.mjs"
import { sleep } from "./util.mjs"

export function rpc(method, params = {}, { timeoutMs = 120000, caller } = {}) {
  return new Promise((resolve, reject) => {
    let token
    try {
      token = fs.readFileSync(TOKEN_PATH, "utf8").trim()
    } catch (e) {
      return reject(Object.assign(new Error("daemon token not found (daemon never started?)"), { code: "NOTOKEN" }))
    }
    const body = JSON.stringify({ method, params, caller })
    const req = http.request(
      { socketPath: SOCKET_PATH, path: "/rpc", method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) }, timeout: timeoutMs },
      (res) => {
        const chunks = []
        res.on("data", (c) => chunks.push(c))
        res.on("end", () => {
          let data
          try {
            data = JSON.parse(Buffer.concat(chunks).toString("utf8"))
          } catch {
            return reject(new Error(`bad daemon response (${res.statusCode})`))
          }
          if (res.statusCode === 200) resolve(data.result)
          else reject(Object.assign(new Error(data.error || `daemon error ${res.statusCode}`), { status: res.statusCode, kind: data.kind }))
        })
      },
    )
    req.on("timeout", () => req.destroy(new Error("daemon request timed out")))
    req.on("error", reject)
    req.end(body)
  })
}

function supervisorAlive() {
  try {
    const pid = Number(fs.readFileSync(path.join(dirs.run, "supervisor.pid"), "utf8"))
    if (!pid) return false
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8")
    return cmd.includes("workhorse-supervisor")
  } catch {
    return false
  }
}

// Start the supervisor detached with a minimal environment: PATH, HOME, LANG and the configured
// secret variables that are present in this process (e.g. the provider API key). Nothing else leaks.
export function startSupervisor() {
  const cfg = daemonConfig()
  const env = { PATH: cfg.env_path, HOME: process.env.HOME || os.homedir(), LANG: "C.UTF-8" }
  Object.assign(env, { WH_CONFIG_DIR: CONFIG_DIR, WH_DATA_DIR: DATA_DIR })
  for (const k of ["WH_APP_DIR", "WH_KILO_BIN"]) if (process.env[k]) env[k] = process.env[k]
  for (const k of secretEnvNames(cfg)) if (process.env[k]) env[k] = process.env[k]
  fs.mkdirSync(dirs.run, { recursive: true, mode: 0o700 })
  fs.mkdirSync(dirs.logs, { recursive: true, mode: 0o700 })
  const child = spawn(path.join(APP_DIR, "bin", "workhorse-supervisor"), [], { env, detached: true, stdio: "ignore" })
  child.unref()
}

export async function ensureDaemon({ waitMs = 15000 } = {}) {
  try {
    return await rpc("health", {}, { timeoutMs: 3000 })
  } catch {}
  if (!supervisorAlive()) startSupervisor()
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    await sleep(300)
    try {
      return await rpc("health", {}, { timeoutMs: 3000 })
    } catch {}
  }
  throw new Error(`workhorse daemon did not come up; see ${path.join(dirs.logs, "daemon.log")}`)
}
