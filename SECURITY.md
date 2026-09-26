# Security policy

Grok Workhorse runs untrusted, model-driven code on your machine. Sandbox escapes and credential leaks
are the bugs we care about most.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private vulnerability
reporting on this repository instead (Security tab → "Report a vulnerability").

Please include:

- the version or commit, OS/kernel, backend and backend version
- what a worker (or a malicious repo or prompt) can do that it should not be able to do
- a minimal reproduction, ideally a mock scenario (`test/mock/scenarios/*.json`) or the tool calls involved

You can expect an acknowledgement within 7 days. Once a fix is available we will publish an advisory
and credit you unless you prefer otherwise.

## Scope

In scope:

- escaping the outer sandbox or reading hidden paths (secret store, daemon token, other tasks' data,
  the main clone's working tree)
- getting a provider key or other secret into worker-visible output, logs or results
- bypassing the repo, test-command or clone-host allowlists through the MCP interface
- making the daemon report a false verdict (for example hiding commits)
- privilege escalation to root or to other users

Known limitations that are documented in [docs/security.md](docs/security.md) (for example network
access for model-run commands on backends without an inner sandbox) are not vulnerabilities by
themselves. Ways to widen their impact are welcome as reports.

## Supported versions

Only the latest release receives security fixes during the 0.x series.
