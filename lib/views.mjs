// Compact views of task results, to keep what the supervisor model reads (and pays for) small.
//
//   full  (default, backward compatible): the whole result with the complete handoff record.
//   brief: only what the supervisor needs to decide the next step (~0.5-1 KB): verdict, a short
//         summary, changed files, test outcome, top concerns, the handoff's next action + resume
//         call, auto-review verdict, automatic follow-up trail and token totals.
import { head } from "./util.mjs"

export const VIEWS = ["full", "brief"]

const tokensOf = (u) => {
  const t = u?.tokens || {}
  return { input: t.input || 0, output: t.output || 0, reasoning: t.reasoning || 0, cache_read: t.cache_read || 0 }
}

// "path" for modified files, "A path" / "D path" / "R100 path" otherwise.
const fileLabel = (f) => (f && typeof f === "object" ? (f.status && f.status !== "M" ? `${f.status} ${f.path}` : f.path) : String(f))

export function briefResult(r, h, { maxFiles = 20, maxConcerns = 5, summaryChars = 300 } = {}) {
  if (!r) return null
  const files = Array.isArray(r.files_changed) ? r.files_changed : []
  const tr = r.test_results || {}
  const tests = tr.executed
    ? { passed: !!tr.passed, command: tr.command, counts: tr.counts && Object.keys(tr.counts).length ? tr.counts : undefined, ...(tr.passed ? {} : { failing: (tr.failing_tests || []).slice(0, 5), exit_code: tr.exit_code }) }
    : { executed: false, reason: tr.reason || null }
  const concerns = (r.remaining_concerns || []).slice(0, maxConcerns).map((c) => head(c, 200))
  const tk = tokensOf(r.usage)
  const out = {
    task_id: r.task_id,
    status: r.status,
    verdict: r.verdict,
    mode: r.mode,
    profile: r.profile,
    summary: head(r.summary || "", summaryChars),
    files: files.slice(0, maxFiles).map(fileLabel).concat(files.length > maxFiles ? [`… ${files.length - maxFiles} more`] : []),
    diffstat: r.diffstat,
    tests,
    ...(concerns.length ? { concerns } : {}),
    ...(r.errors?.length && !["success", "success_untested"].includes(r.verdict) ? { errors: r.errors.slice(-2).map((e) => head(e, 200)) } : {}),
    branch: r.branch,
    next: h
      ? {
          state: h.state,
          owner: h.owner,
          action: head(h.next_action || "", 500),
          ...(h.resume?.tool ? { tool: h.resume.tool, args: h.resume.args } : {}),
        }
      : null,
    usage: { tokens: tk.input + tk.output + tk.reasoning, cache_read: tk.cache_read || undefined, est_cost_usd: r.usage?.estimated_list_cost_usd ?? undefined },
  }
  if (r.review) out.review = { verdict: r.review.verdict, profile: r.review.profile, task_id: r.review.task_id, findings: (r.review.findings || []).slice(0, 3).map((f) => head(f, 200)), advisory: true }
  if (r.auto?.trail?.length) out.auto = { runs: r.auto.runs ?? r.auto.trail.filter((e) => e.next).length, trail: r.auto.trail.map((e) => `${e.profile}:${e.verdict}${e.next ? `->${e.next}` : ""}`), stopped: r.auto.stopped_reason || undefined }
  if (r.approval_request) out.approval_request = r.approval_request
  return out
}
