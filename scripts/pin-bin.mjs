#!/usr/bin/env node
// Usage: node scripts/pin-bin.mjs <install dir> <npm package> <exe>
// Prints the path of <exe> relative to <install dir>/node_modules/<package>, taken from the package's
// own package.json "bin" field (e.g. opencode-ai@1.18.32 maps "opencode" to ./bin/opencode.exe), so
// install.sh links to the file npm actually installed instead of guessing bin/<exe>.
// Exits 1 if the package has no such bin entry, the entry escapes the package dir, or the file is missing.
import fs from "node:fs"
import path from "node:path"

const [dir, pkg, exe] = process.argv.slice(2)
const fail = (msg) => { process.stderr.write(`pin-bin: ${msg}\n`); process.exit(1) }
if (!dir || !pkg || !exe) fail("usage: pin-bin.mjs <install dir> <npm package> <exe>")
const pkgDir = path.resolve(dir, "node_modules", pkg)
let meta
try { meta = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")) } catch (e) { fail(`cannot read ${pkg}/package.json: ${e.message}`) }
const bin = typeof meta.bin === "string" ? (exe === path.basename(meta.name || "") ? meta.bin : null) : meta.bin?.[exe]
if (typeof bin !== "string" || !bin) fail(`${pkg} has no "${exe}" entry in its package.json bin field`)
const rel = path.posix.normalize(bin.replace(/\\/g, "/")).replace(/^\.\//, "")
if (rel.startsWith("../") || path.isAbsolute(rel)) fail(`${pkg} bin "${bin}" points outside the package`)
if (!fs.existsSync(path.join(pkgDir, rel))) fail(`${pkg} bin target ${rel} does not exist`)
process.stdout.write(rel + "\n")
