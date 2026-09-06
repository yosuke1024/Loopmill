# Loopmill

Loopmill is a subscription-native, open-source control plane for AI engineering loops that span
several vendors and several execution backends. You define a loop once; each step runs where it
belongs (Claude Code on GitHub Actions, Codex on OpenAI's cloud, a CLI on your own machine); GitHub
carries the handoffs; Loopmill keeps the loop bounded and observable. Loopmill never needs a
Loopmill-owned always-on server.

Status: design phase (v0.5). No runtime code yet apart from spike prototypes under `spikes/`.

## Documents

| Path | What it is |
|---|---|
| `docs/design/mvp-design.md` | MVP design v0.5 (contracts, schemas, state transitions) |
| `docs/design/CHANGELOG-v0.5.md` | What changed from v0.4 and which review findings each change resolves |
| `docs/adr/ADR-001-event-driven-control-plane.md` | The architecture decision: control plane vs execution backends, GitHub as event bus, state on a git branch, security boundary |
| `docs/spec/loop-file.md`, `docs/spec/loop-file.schema.json` | Loop definition format and JSON Schema |
| `docs/spec/state-machine.md` | Run, Node Execution and Attempt state machines, events, invariants |
| `docs/spec/envelope.md`, `docs/spec/envelope.schema.json` | The machine-readable event envelope exchanged over GitHub |
| `docs/spec/usage-normalization.md` | Token usage buckets, provenance, usage coverage, budget |
| `docs/spikes/README.md` | Spike plan, harnesses and measured results (SPIKE-1, SPIKE-2, SPIKE-3) |
| `examples/daily-content-improvement.loop.yaml` | The reference loop |

## Spikes

- `spikes/spike-1-claude-subscription/`: Claude Code on a GitHub-hosted runner with a subscription OAuth token only (run by the maintainer; needs the `CLAUDE_CODE_OAUTH_TOKEN` secret).
- `spikes/spike-3-control-plane/`: a minimal event-driven `step` with an event-sourced state branch and its tests.

## License

Apache License 2.0. Third-party notices are in `THIRD-PARTY-NOTICES.md`.
