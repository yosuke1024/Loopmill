# Loopmill

Loopmill is a local-first, daemonless workflow runner for orchestrating subscription-authenticated AI
coding agents. Run repeatable AI engineering loops with the coding-agent subscriptions you already have.

You define a loop once — observe, implement, test, review, retry, gate, ship — and Loopmill runs it on a
machine you control, driving the official CLIs (`claude`, `codex`) that are already logged in there.
Loopmill keeps the loop bounded and observable: one run identity, one retry budget, one usage account
across vendors, and a record you can read afterwards.

- **Local-first.** Starts on your laptop; the same setup runs on an always-on machine you manage.
- **Daemonless.** `loopmill run` starts, does its work, exits. No resident process, no Loopmill cloud.
- **Subscription-native.** The CLIs use their own login. No API keys are required for the supported
  subscription providers, and Loopmill never copies or forwards a credential.
- **Multi-provider.** One loop can mix Claude Code and Codex behind one provider abstraction.
- **Observable.** Outcome, retries, duration, normalized token usage and quota signals per run, cycle
  and node.

What Loopmill does not do: it does not run while the host is off (24/7 execution needs an always-on
machine you manage), it does not host or relay vendor credentials, and it is not a managed cloud.

Status: m1 implementation underway (v0.6); the m0 contract freeze is recorded in `docs/design/m0-contract-freeze.md`
(2026-09-06). Runtime code lives under `src/` (CLI, driver, store, local backend), registered as the
`loopmill` executable in `package.json`; spike prototypes remain under `spikes/`.

## Documents

| Path | What it is |
|---|---|
| `docs/design/mvp-design.md` | MVP design v0.6 (contracts, schemas, state transitions) |
| `docs/design/CHANGELOG-v0.6.md` | What changed from v0.5 and why |
| `docs/design/m0-contract-freeze.md` | The m0 contract freeze (2026-09-06): what is frozen, at which version, on what evidence; the STOP evaluations; the five decisions, confirmed by the maintainer on 2026-09-06; the amendment rule |
| `docs/adr/ADR-002-local-self-hosted-execution.md` | The architecture decision: execute on a user-managed host; GitHub is the repository and collaboration surface, not the control plane |
| `docs/adr/ADR-001-event-driven-control-plane.md` | The superseded v0.5 decision (GitHub-hosted control plane); kept for its context and its still-valid parts |
| `docs/spec/loop-file.md`, `docs/spec/loop-file.schema.json` | Loop definition format and JSON Schema |
| `docs/spec/state-machine.md`, `docs/spec/state-machine.json` | Run, Node Execution and Attempt state machines, events, invariants |
| `docs/spec/envelope.md`, `docs/spec/envelope.schema.json` | The machine-readable event record (the journal entry) |
| `docs/spec/usage-normalization.md` | Token usage buckets, provenance, usage coverage, budget |
| `docs/spikes/README.md` | Spike plan, harnesses and measured results (SPIKE-1, SPIKE-2, SPIKE-3, SPIKE-4) |
| `examples/daily-content-improvement.loop.yaml` | The reference loop |

## Spikes

- `spikes/spike-1-claude-subscription/`: the Claude Code CLI contract under subscription OAuth, measured
  on a GitHub-hosted runner (run by the maintainer; needs the `CLAUDE_CODE_OAUTH_TOKEN` secret).
- `spikes/spike-3-control-plane/`: a minimal event-driven `step` with an event-sourced state branch and
  its tests — the measured reference for a future remote integration.

## License

Apache License 2.0. Third-party notices are in `THIRD-PARTY-NOTICES.md`.
