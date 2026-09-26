# Token savings

Grok Workhorse exists to **reduce supervisor usage**: a strong, expensive model (for example Grok as
the supervisor) plans and reviews, and smaller models you choose do the bounded coding work. v0.3
adds features that cut the supervisor's share further and keep the total spend low. All of them are
backward compatible, and everything that changes worker behaviour is **opt-in**.

| Where tokens go | Feature | Default |
|---|---|---|
| Supervisor: polling round trips | `wait_task` long-poll (single or many ids, `any`/`all`, up to 55 s per call) | available; the skill prefers it |
| Supervisor: reading results | compact JSON from the MCP shim, `view: "brief"` (~0.5-1 KB) | compact: on; brief: opt-in per call (the skill uses it), `wait_task` returns brief |
| Supervisor: fix/escalate/review turns | `auto_fix_rounds`, `escalate` (cheap -> mid -> strong via `escalate_to`), `auto_review` on a cheap profile | off |
| Supervisor: choosing and batching | presets, size routing, `delegate_tasks` (up to 10 per call) | available |
| Worker output | `token_savers.terse` (short prose), `token_savers.minimal_code` (smallest-diff bias) | off |
| Worker input (shell output) | `token_savers.rtk` (RTK rewrites the worker's shell commands) | off |
| Visibility | `usage_report` MCP tool, `workhorse stats` | available |

## Supervisor-side savings

### `wait_task` instead of polling

`wait_task {task_id}` (or `{task_ids: [...], mode: "any" | "all"}`) blocks until the task settles
(finished or parked for approval) or `max_wait_s` passes (default 45, capped at **55 s**), then returns
`{done, waited_s, task}` with the brief result. If `done` is false, call it again. The cap keeps each
MCP call under the 60 s request timeout that many MCP clients use by default (the TypeScript SDK's
`DEFAULT_REQUEST_TIMEOUT_MSEC` is 60000), with margin for the round trip. While it waits, a call
holds one open socket connection to the daemon and a light in-process check every 500 ms (no worker
or model tokens); the loop stops as soon as the client disconnects or the daemon shuts down.

### Compact JSON and the brief view

The MCP shim now returns compact JSON (no indentation; 9-18% fewer characters on typical responses, measured below). `task_result`
takes `view: "full"` (default, unchanged fields) or `view: "brief"`: verdict, a 300-char summary, up to
20 changed files, test outcome (failing test names only on failure), up to 5 concerns, `next` (handoff
state, owner, action and the suggested tool call), the advisory review, the automatic trail and token
totals. The full view keeps every field it had in v0.2, including the complete handoff (its
`context` repeats some top-level fields; they are kept for compatibility). `get_handoff` (RPC) and
`workhorse handoff <id>` show the complete record too.

### Automatic follow-ups on cheap models

Instead of the supervisor reading a failed result, writing a fix request and waiting again, the daemon
can do it (see [configuration.md](configuration.md#presets-size-routing-and-automatic-follow-ups-v03)):

- `auto_fix_rounds` 1..3: fix rounds **per profile** in the same session after failing tests or a
  missing/partial RESULT block (after an escalation the next profile gets its own rounds);
- `escalate: true`: when that is not enough, the next profile of the `escalate_to` chain (fresh
  session, same worktree);
- `auto_review`: a read-only review on a cheap profile; its verdict is advisory.

Hard caps: at most 3 fix rounds per profile, and **in total** at most `auto.max_auto_runs` automatic
runs per task (default 3, never more than 6), whatever mix of fix rounds and escalations that is;
optional `auto.max_tokens` and `auto.max_cost_usd` budgets. The result's `auto.trail` shows every
step, for example `["cheap:tests_failed->auto_fix", "cheap:tests_failed->escalate", "mid:success"]`.

Budget details:

- The budgets count every run of the task (including the first) plus the tokens and estimated cost of
  its automatic review tasks.
- They are checked between runs, so a single run can overshoot them; the next automatic run is then
  not started.
- `0` means an explicit zero budget (no automatic follow-ups at all), not "unlimited". Leave the key
  out (or `null`) for no budget.
- `continue_task` starts a new automatic round: the trail and the fix-round / `max_auto_runs`
  counters restart, but the token and cost budgets keep counting the whole task.

### Presets, size routing, batches

`presets` bundle profile, size, timeout, test command, standing instructions and follow-up flags under
a name, so a supervisor call can be as short as `{repo, task, preset: "quick-fix"}`. `routing` maps
`small | medium | large` to profiles, so the cheapest adequate model is picked by size.
`delegate_tasks` creates up to 10 tasks in one call and `wait_task` with `task_ids` waits for them.

## Worker-side token savers (`token_savers`)

Configured in `daemon.json` (defaults for all profiles) and overridable per profile in
`profiles.json`. Set them with the CLI (config must be unlocked):

```bash
workhorse token-savers                                   # show the effective settings
workhorse token-savers --terse lite --minimal-code lite  # prompt savers
workhorse token-savers --rtk on --rtk-bin /usr/local/bin/rtk
workhorse token-savers off
# installer: --token-savers terse=lite,minimal_code=lite[,rtk] [--rtk-bin PATH]
```

```jsonc
// daemon.json
"token_savers": { "terse": "off", "minimal_code": "off", "rtk": { "enabled": false, "bin": null } }
// profiles.json, per profile:
"cheap": { "backend": "kilo", "model": "...", "token_savers": { "terse": "lite", "minimal_code": "lite" } }
```

- **`terse`** (`lite` | `full`): a short style instruction appended to the worker's first message of
  a fresh session: no narration, no restating the task, no echoing tool output. Code, commands, paths,
  numbers, error messages and negations are never shortened, and the `## RESULT` block keeps its exact
  format (the daemon parses it).
- **`minimal_code`** (`lite` | `full`): a "smallest correct diff" bias: check whether the code is
  needed, whether the standard library or an existing dependency already does it, reuse helpers, no
  new dependencies or single-use abstractions, deletion over addition. It never drops validation at
  trust boundaries, error handling, security checks, requested tests or requested features, and the
  repository's conventions win. `full` also asks the worker to list what it deliberately skipped under
  concerns. Not applied to review tasks.
- **`rtk`**: Kilo and OpenCode only. The guard plugin asks `rtk rewrite <command>` for a compact
  equivalent of each bash command the worker runs (`git status` -> `rtk git status`) and uses it only
  if the rewritten command passes the same guard checks; if it does not (or `rtk rewrite` fails or
  takes longer than 1 s), the original command runs unchanged. The rewrite call gets a minimal
  environment (`PATH`, `HOME`, `RTK_TELEMETRY_DISABLED=1`; no provider keys). It runs synchronously
  in the plugin hook (the hook must return the final command), inside the worker's outer sandbox,
  which has network access; the model-run command itself runs in Kilo's inner sandbox. Multi-line
  commands are left alone. Only the rtk binary itself (resolved path) is bound read-only into the
  sandbox, not its directory. Claude Code and Codex runs ignore it.

Fragments go only into the first message of a fresh session (not into follow-ups, which already have
them in context). **The daemon's own test run is never routed through RTK or any other compression**:
its output feeds the verdict and the failing-test parser.

### Recommended defaults

- Leave everything off on your strongest profile.
- On cheap/mid profiles: `terse: "lite"` and `minimal_code: "lite"`. Use `full` only after checking
  results on your own repos.
- `rtk`: optional; helps mostly when workers run many `git`, `ls`, `grep` or `find` commands through
  bash. Most Kilo/OpenCode reads go through the built-in read/grep/list tools, which RTK does not touch.

## The tools we evaluated

Community feedback suggested four tools used by the 9router project
([decolua/9router](https://github.com/decolua/9router), MIT). We checked each project (September 2026):

| Tool | Project, license | What it is | Decision |
|---|---|---|---|
| RTK | [rtk-ai/rtk](https://github.com/rtk-ai/rtk), Apache-2.0, very active (v0.50.0, ~80k stars) | Rust CLI that runs common commands (git, ls, grep, find, test runners, ...) and prints a compressed version of their output. `rtk rewrite <cmd>` returns an equivalent command (exit 0 allow, 1 no equivalent, 2 deny, 3 rewritten). Ships hooks for Claude Code and a plugin for OpenCode; telemetry is off unless you consent | **Kept, opt-in**, through our own guard-plugin code on Kilo/OpenCode (their plugin is not vendored). Not for Claude Code/Codex yet |
| Headroom | [headroomlabs-ai/headroom](https://github.com/headroomlabs-ai/headroom), Apache-2.0, active | Python library/proxy (`headroom proxy`, `/v1/compress`) that compresses prompts and tool output with heuristics and an ML model, with retrieval of the originals through an MCP tool | **Discarded** as a built-in: a proxy would see all code and the provider key; heavy Python/ML dependency; lossy compression of tool output; retrieval needs a tool our workers don't have. Advanced users can point a provider's `base_url` at their own proxy (unsupported) |
| Caveman | [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman); MIT except engine-linked dirs (engine/, proxy/, ...) under BSL-1.1 | A prompt/skill that makes the model answer in terse "caveman" style to cut output tokens | **Kept as our own `terse` fragment**, written from scratch, with safeguards (code, paths, errors, negations and the RESULT block are never shortened). No code or text vendored; the BSL parts are never used |
| Ponytail | [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail), MIT (9router's adaptation: `open-sse/rtk/ponytailPrompt.js`, MIT) | A "lazy senior dev" prompt: YAGNI, reuse the standard library, deletion over addition, minimal code | **Kept as our own `minimal_code` fragment**, written from scratch. We dropped its code-comment markers and "one runnable self-check" rule and added explicit never-drop rules (validation, error handling, security, requested tests/features) |

Attribution is in [NOTICE](../NOTICE).

Risks we designed around:

- **Tool-output parsing.** RTK changes what the *worker* sees, never what the daemon parses: the daemon
  runs tests itself, without RTK, and reads the diff from git. `rtk git diff` condenses diffs, so a
  worker that needs the exact patch should read the files directly; this is one reason RTK stays off by
  default.
- **Quality loss.** Prompt savers can make a model skip context or cut corners. That is why they are
  off by default, the RESULT format is protected, and `minimal_code` has never-drop rules. The daemon's
  verdict still comes from the tests.
- **Secrets.** No saver sends data anywhere. The `rtk rewrite` call runs with a minimal environment
  (no API keys) and `RTK_TELEMETRY_DISABLED=1`. It runs in the worker's outer sandbox, which does have
  network access; the rewritten command then runs like any model-run command (on Kilo: inner
  sandbox, no network).

## Benchmarks

All numbers are small samples on this repository and its test fixtures. Token counts use the
`o200k_base` tokenizer as a proxy (the real supervisor and worker models use their own tokenizers), so
treat them as **estimates**.

### Supervisor side (stub backend, v0.2 flow vs v0.3 flow)

Measured with the test-only stub backend on the calc fixture. "v0.2" = `delegate_task`, `task_status`
polls, `task_result` (full view, pretty JSON). "v0.3" = `delegate_task` + one `wait_task` (brief,
compact JSON). The v0.3 full view has the same fields as v0.2, only compact JSON.

| Response the supervisor reads | chars | tokens (o200k) |
|---|---|---|
| v0.2 `delegate_task` | 563 | 203 |
| v0.2 `task_status` while running / final | 634 / 935 | 224 / 314 |
| v0.2 `task_result` full, success | 4,318 | 1,427 |
| v0.2 `task_result` full, tests_failed | 7,150 | 2,182 |
| v0.3 `delegate_task` (compact) | 510 | 162 |
| v0.3 `wait_task` with brief result, success | 671 | 198 |

Per task (the number of polls is an assumption: 5 "still running" polls, i.e. about 5-10 minutes at
the old skill's 1-2 minute cadence):

| Scenario | v0.2 | v0.3 | Change |
|---|---|---|---|
| Task succeeds first time | 8 tool calls, ~3,060 tokens read | 2 calls, ~360 tokens | about -88% tokens, -6 turns |
| Same with no polling at all (best case for v0.2) | 3 calls, ~1,940 tokens | 2 calls, ~360 tokens | about -81% |
| Tests fail once, then fixed (v0.2: supervisor sends `continue_task`; v0.3: `auto_fix_rounds: 1`) | ~16 calls, ~6,900 tokens (the `continue_task` response is estimated at ~200) | 2 calls, ~400 tokens | about -94%; the fix round costs worker tokens on the cheap profile instead |

Tasks longer than 55 s need one extra `wait_task` call per 55 s (about 150 tokens each for a
`done: false` response), which is still cheaper than a status poll at the same cadence. Every avoided
tool call also avoids one supervisor turn, which re-reads the whole conversation (usually cached, but
not free); that effect is not included above.

### RTK (worker shell output)

RTK v0.50.0 on this repository, output tokens before and after the rewrite:

| Command | before | after | change |
|---|---|---|---|
| `git status` | 125 | 30 | -76% |
| `git diff` | 208 | 180 | -13% |
| `git log -n 20` | 2,127 | 838 | -61% |
| `ls -la` | 359 | 146 | -59% |
| `grep -rn` | 1,569 | 781 | -50% |
| `find` | 287 | 192 | -33% |
| `python3 -m unittest -v` | not rewritten | | 0% |
| `cat file` (-> `rtk read`) | unchanged | | 0% |
| **total** | **7,127** | **4,619** | **-35%** |

The project's "60-90%" claim holds for some commands (status, log) but not across this mix. The effect
on a real worker bill is smaller still, because Kilo/OpenCode workers read and search files mostly with
built-in tools, not bash. Hence: opt-in, not recommended by default.

### Prompt savers (real model, small sample)

Three A/B pairs on NVIDIA Nemotron 3 Ultra 550B-A55B (NIM) through Kilo, on the calc fixture.
"base" = no savers, "saver" = `terse: "lite"` + `minimal_code: "lite"`; each pair ran the same task
at the same time. Token counts are as reported by the provider.

| Task | profile | verdict | input | output | diff |
|---|---|---|---|---|---|
| implement multiply/divide (run 1) | base / saver | tests_failed / tests_failed * | 54,670 / 55,736 | 1,159 / 996 | +4/-2 / +4/-2 |
| implement multiply/divide (run 2) | base / saver | tests_failed / tests_failed * | 36,688 / 50,481 | 958 / 860 | +4/-2 / +4/-2 |
| make the whole suite pass (several fixes) | base / saver | success / success | 116,987 / 84,809 | 2,968 / 2,704 | +30/-18 / +30/-18 |
| **total** | | | **208,345 / 191,026** | **5,085 / 4,560 (-10%)** | same |

\* The fixture's default test command runs every exercise, including ones the task did not ask for;
the requested `test_core` tests passed in all four runs and the diffs are correct.

Reading: output tokens went down about 10% (the "~65%" claimed for Caveman-style prompts applies to
chatty assistants; a coding worker's output is mostly tool calls and code, which the fragment
deliberately does not shorten). Input tokens vary far more with the number of turns than with the
fragments (which themselves add about 210 tokens to every request of the session: terse lite ~80, minimal_code lite ~130), so the input difference here is noise.
Diff sizes were identical on these small tasks; `minimal_code` should matter more on open-ended work,
which this sample did not measure. Three pairs are not statistically meaningful: treat these as
indicative only, and measure on your own repos with `workhorse stats` before enabling `full`.

## Usage report and the estimate

`usage_report` (MCP) and `workhorse stats [--days N] [--profile P] [--repo R] [--json]` group worker
tokens and estimated list cost by profile and by day (per run, so escalated tasks are split across
profiles). Tasks from before v0.3 count their totals on their last run.

The report also contains `supervisor_estimate`, **labelled ESTIMATE**. It is deliberately
conservative:

```
worker_output_tokens  = output + reasoning tokens of tasks whose final verdict is success or success_untested
supervisor_overhead   = (chars the supervisor sent to workhorse + chars it read back, all tasks) / chars_per_token
est_supervisor_tokens_avoided = max(0, worker_output_tokens - supervisor_overhead)
```

Worker **input** tokens are not counted at all (`worker_input_tokens_not_counted` shows them): most of
them are the same context re-read on every turn, and a supervisor doing the work itself would read a
different amount. Failed tasks count only as overhead. Supervisor characters are recorded by the
daemon for every MCP call made through `workhorse-mcp` (the operator CLI is excluded).
`chars_per_token` defaults to 4 (`daemon.json supervisor.chars_per_token`). With
`supervisor.price_per_mtok: {input, output}` it also gives

```
est_net_usd = worker_output_tokens x price.output
            - supervisor tokens read x price.input - supervisor tokens written x price.output
            - the workers' estimated list cost          (can be negative)
```

The assumption behind it: for work that succeeded, the supervisor would have had to generate about
as many output tokens as the workers did. A stronger model may write less (too high); the input it
would have read and the growth of its own context are ignored (too low). With small tasks the result
is often 0. It is a planning aid, not a measurement.
