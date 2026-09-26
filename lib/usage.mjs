// usage_report / `workhorse stats`: worker token use and cost by profile and day, plus an ESTIMATE of
// the supervisor (e.g. Grok) tokens the delegation avoided. See docs/token-savings.md#usage-report.
//
// Conservative ESTIMATE:
//   worker_output_tokens    = output + reasoning tokens of tasks whose final verdict is success or
//                             success_untested (what the supervisor would have had to generate itself)
//   supervisor_overhead     = (chars the supervisor sent to workhorse + chars it read back, for every
//                             task in the window) / chars_per_token
//   est_supervisor_tokens_avoided = max(0, worker_output_tokens - supervisor_overhead)
// Worker INPUT tokens are not counted at all: most of them are the same context re-read on every turn,
// and a supervisor doing the work would re-read differently. Failed tasks count only as overhead.
// With daemon.json supervisor.price_per_mtok {input, output}:
//   est_net_usd = worker_output_tokens * price.output - overhead_read * price.input
//                 - overhead_written * price.output - workers' estimated list cost   (may be negative)
const KEYS = ["input", "output", "reasoning", "cache_read", "cache_write"]
const zero = () => Object.fromEntries(KEYS.map((k) => [k, 0]))
const addTo = (a, b) => {
  for (const k of KEYS) a[k] += Number(b?.[k]) || 0
  return a
}
const round = (x, n = 6) => (x === null || x === undefined ? null : Math.round(x * 10 ** n) / 10 ** n)
export const SUCCESS = new Set(["success", "success_untested"])

// Local calendar day of an ISO timestamp.
export function dayOf(ts) {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return "unknown"
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

function listCost(tokens, price) {
  if (!price) return null
  return ((tokens.input + tokens.cache_read) * (price.input || 0) + (tokens.output + tokens.reasoning) * (price.output || 0)) / 1e6
}

// Per-run token records of a task. Runs recorded before v0.3.0 have no per-run tokens: the task total is
// attributed to its last run.
export function runUsage(t) {
  const runs = t.runs || []
  if (runs.some((r) => r.tokens)) return runs.map((r) => ({ profile: r.profile || t.profile, started_at: r.started_at || t.created_at, tokens: addTo(zero(), r.tokens), cost: Number(r.cost) || 0 }))
  const last = runs[runs.length - 1]
  return [{ profile: last?.profile || t.profile, started_at: last?.started_at || t.created_at, tokens: addTo(zero(), t.stats?.tokens), cost: Number(t.stats?.reported_cost ?? t.stats?.kilo_cost ?? 0) || 0, runs: runs.length }]
}

export function usageReport(tasks, { days = 30, profile = null, repo = null, profiles = {}, supervisor = {}, unattributed = null, nowMs = Date.now() } = {}) {
  const d = Math.max(1, Math.min(3650, Number(days) || 30))
  const cutoff = nowMs - d * 86400000
  const cpt = Number(supervisor.chars_per_token) > 0 ? Number(supervisor.chars_per_token) : 4
  const sp = supervisor.price_per_mtok || null
  const byKey = new Map()
  const byProfile = new Map()
  const sup = { calls: 0, request_chars: 0, response_chars: 0 }
  let workIn = 0
  let workOut = 0
  let succeeded = 0
  let overheadTokens = 0
  let overheadIn = 0
  let overheadOut = 0
  let workerCost = 0
  let tasksCounted = 0
  const prof = (name) => {
    if (!byProfile.has(name)) byProfile.set(name, { profile: name, tasks: 0, runs: 0, tokens: zero(), backend_reported_cost_usd: 0, est_list_cost_usd: 0, priced: !!profiles[name]?.price_per_mtok, verdicts: {} })
    return byProfile.get(name)
  }
  for (const t of tasks) {
    if (Date.parse(t.created_at) < cutoff) continue
    if (repo && t.repo !== repo) continue
    const runs = runUsage(t)
    if (profile && !runs.some((r) => r.profile === profile) && t.profile !== profile) continue
    tasksCounted++
    const seen = new Set()
    const taskTok = zero()
    for (const r of runs) {
      if (profile && r.profile !== profile) continue
      const day = dayOf(r.started_at)
      const key = `${day}\u0000${r.profile}`
      if (!byKey.has(key)) byKey.set(key, { day, profile: r.profile, tasks: 0, runs: 0, tokens: zero(), backend_reported_cost_usd: 0, est_list_cost_usd: 0 })
      const row = byKey.get(key)
      const price = profiles[r.profile]?.price_per_mtok || null
      const est = listCost(r.tokens, price) || 0
      row.runs += r.runs || 1
      addTo(row.tokens, r.tokens)
      row.backend_reported_cost_usd += r.cost
      row.est_list_cost_usd += est
      if (!seen.has(key)) {
        seen.add(key)
        row.tasks++
      }
      const p = prof(r.profile)
      p.runs += r.runs || 1
      addTo(p.tokens, r.tokens)
      p.backend_reported_cost_usd += r.cost
      p.est_list_cost_usd += est
      addTo(taskTok, r.tokens)
      workerCost += est
    }
    const finalProfile = t.result?.profile || t.profile
    const fp = prof(finalProfile)
    fp.tasks++
    const v = t.result?.verdict || t.status
    fp.verdicts[v] = (fp.verdicts[v] || 0) + 1
    const io = t.supervisor_io || {}
    sup.calls += io.calls || 0
    sup.request_chars += io.request_chars || 0
    sup.response_chars += io.response_chars || 0
    const ovIn = (io.response_chars || 0) / cpt // what the supervisor read
    const ovOut = (io.request_chars || 0) / cpt // what the supervisor wrote
    overheadIn += ovIn
    overheadOut += ovOut
    overheadTokens += ovIn + ovOut
    if (SUCCESS.has(t.result?.verdict)) {
      succeeded++
      workIn += taskTok.input
      workOut += taskTok.output + taskTok.reasoning
    }
  }
  const fin = (o) => ({ ...o, backend_reported_cost_usd: round(o.backend_reported_cost_usd), est_list_cost_usd: round(o.est_list_cost_usd) })
  const avoided = Math.max(0, Math.round(workOut - overheadTokens))
  const avoidedUsd = sp ? round((workOut * (sp.output || 0) - overheadIn * (sp.input || 0) - overheadOut * (sp.output || 0)) / 1e6 - workerCost, 4) : null
  return {
    window_days: d,
    tasks: tasksCounted,
    by_profile: [...byProfile.values()].map(fin).sort((a, b) => b.tokens.input + b.tokens.output - (a.tokens.input + a.tokens.output)),
    by_day: [...byKey.values()].map(fin).sort((a, b) => (a.day === b.day ? a.profile.localeCompare(b.profile) : a.day < b.day ? 1 : -1)),
    supervisor_estimate: {
      label: "ESTIMATE",
      successful_tasks: succeeded,
      worker_output_tokens: workOut,
      worker_input_tokens_not_counted: workIn,
      supervisor_io: { ...sup, est_tokens: Math.round(overheadTokens), chars_per_token: cpt },
      est_supervisor_tokens_avoided: avoided,
      est_net_usd: avoidedUsd,
      est_worker_list_cost_usd: round(workerCost, 4),
      ...(unattributed ? { unattributed_supervisor_io_since_daemon_start: unattributed } : {}),
      formula: "max(0, worker output+reasoning tokens of successful tasks - (supervisor request chars + response chars of all tasks)/chars_per_token); worker input tokens are not counted" + (sp ? "; est_net_usd = worker output tokens*price.output - supervisor read tokens*price.input - supervisor written tokens*price.output - workers' est. list cost (can be negative)" : "; set daemon.json supervisor.price_per_mtok {input, output} for a USD estimate"),
      caveat: "Conservative planning aid, not a measurement: assumes the supervisor would have generated about as many output tokens as the workers did for work that succeeded, and ignores the input tokens it would have read.",
    },
  }
}
