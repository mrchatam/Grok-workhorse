#!/usr/bin/env node
// Used by scripts/install.sh: writes (or updates) the installed config from config/examples.
//   render-config.mjs daemon <example> <out>   env: R_DATA_DIR R_DATA_DIR_EXPLICIT R_KILO_BIN R_KILO_VERSION R_BWRAP R_ENV_PATH
//                                                     R_SECRET_STORE R_OPENCODE_BIN R_OPENCODE_VERSION
//   render-config.mjs repos  <example> <out>   env: R_DATA_DIR
//   render-config.mjs get    <daemon.json> <key.path>   prints a value (e.g. data_dir)
// On an existing daemon.json only the install-managed keys are updated (backend pins, bwrap, PATH, and
// data_dir / secret_store_path when given explicitly); everything else the owner edited is kept.
// Legacy "kilo" / "kilo_sandbox" sections are migrated to backends.kilo / worker_sandbox.
import fs from "node:fs"

const [mode, src, out] = process.argv.slice(2)
const E = process.env
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"))
const write = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2) + "\n", { mode: 0o644 })

if (mode === "get") {
  let v = read(src)
  for (const k of out.split(".")) v = v?.[k]
  if (v !== undefined && v !== null) console.log(typeof v === "string" ? v : JSON.stringify(v))
} else if (mode === "daemon") {
  const exists = fs.existsSync(out)
  const d = exists ? read(out) : read(src)
  if (!exists || E.R_DATA_DIR_EXPLICIT === "1") d.data_dir = E.R_DATA_DIR
  d.backends ||= {}
  if (d.kilo) {
    const { bwrap, ...k } = d.kilo
    d.backends.kilo = { ...k, ...(d.backends.kilo || {}) }
    delete d.kilo
  }
  if (d.kilo_sandbox) {
    d.worker_sandbox = { ...d.kilo_sandbox, ...(d.worker_sandbox || {}) }
    delete d.kilo_sandbox
  }
  d.backends.kilo = { ...(d.backends.kilo || {}), bin: E.R_KILO_BIN, expected_version: E.R_KILO_VERSION }
  if (E.R_OPENCODE_BIN) d.backends.opencode = { ...(d.backends.opencode || {}), bin: E.R_OPENCODE_BIN, expected_version: E.R_OPENCODE_VERSION || null }
  d.bwrap = E.R_BWRAP
  d.env_path = E.R_ENV_PATH
  if (!exists) d.secret_store_path = E.R_SECRET_STORE || null
  else if (E.R_SECRET_STORE) d.secret_store_path = E.R_SECRET_STORE
  write(out, d)
  console.log(exists ? "updated install-managed keys" : "created")
} else if (mode === "repos") {
  write(out, JSON.parse(fs.readFileSync(src, "utf8").replaceAll("__DATA_DIR__", E.R_DATA_DIR)))
  console.log("created")
} else {
  console.error("usage: render-config.mjs daemon|repos|get ...")
  process.exit(2)
}
