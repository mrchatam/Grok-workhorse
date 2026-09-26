# Contributing

Thanks for helping! Bug reports, adapter implementations, docs and tests are all welcome.

## Ground rules

- Be kind; see the [Code of Conduct](CODE_OF_CONDUCT.md).
- Security issues go through private reporting ([SECURITY.md](SECURITY.md)), not public issues.
- Keep changes focused. Open an issue first for larger changes (new MCP tools, config schema changes,
  new adapters).

## Development setup

Requirements: Linux, Node.js >= 22, git, python3 (mock LLM), bubblewrap-capable kernel, and the Kilo
CLI for the integration suite (`npm i -g @kilocode/cli@7.8.1`, or set `WH_KILO_BIN`).

```bash
npm run setup
npm run test:unit                    # fast; what CI runs
npm test                             # full integration suite (~10 min) against a scripted mock LLM
WH_TEST_BACKEND=opencode WH_OPENCODE_BIN=/path/to/opencode npm test
```

Integration tests are reported as *skipped* (not failed) when the Kilo CLI, bwrap, git or python3 are
missing. Live tests (`npm run test:live`) need `WH_LIVE_TEST=1` and a provider key, and cost a few
cents of tokens.

## Pull requests

- Add or adjust tests. Security-relevant changes (sandbox, guard, allowlists, credentials) need a test
  that fails without the change.
- Mock scenarios live in `test/mock/scenarios/`. The mock LLM replays scripted tool calls, so you can
  reproduce agent behaviour deterministically.
- Update docs (`README.md`, `docs/`) and `CHANGELOG.md` (Unreleased section).
- Never commit secrets, real API keys, personal paths or machine-specific config. `config/*.json`
  (except `config/examples/`) is git-ignored for that reason.
- Style: plain ESM JavaScript, no build step, 2-space indent, no new runtime dependencies without
  discussion.

## Adding a backend adapter

See [docs/adapters.md](docs/adapters.md#adding-an-adapter). Please mark the adapter status honestly:
`tested` requires the mock integration suite to pass with `WH_TEST_BACKEND=<name>`.

## Releases

Maintainers tag `vX.Y.Z` after updating `package.json` and `CHANGELOG.md`.
