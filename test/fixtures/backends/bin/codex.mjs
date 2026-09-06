#!/usr/bin/env node
// Stub `codex` CLI for test/backends/*.test.ts. Prints a `codex exec --json`-shaped JSONL stream
// matching docs/spec/usage-fixtures/codex-recorded-*.json's `input.events`. Selected by
// `STUB_MODE`:
//
//   success       thread.started, turn.started, one agent_message item, turn.completed(usage);
//                 exit 0.
//   structured    same, but the agent_message text is a JSON object (a structured answer).
//   turn-failed   thread.started, turn.started, an error item, an `error` event, `turn.failed`;
//                 exit 1. No `turn.completed` anywhere in the stream.
//   sleep         thread.started + turn.started only, then sleeps until signalled. The measured
//                 SIGTERM contract (SPIKE-4 D5-SIGTERM) is "exit 0, no turn.completed" -- NOT
//                 Node's own default SIGTERM disposition, which would kill the process outright
//                 (exit code null, signal "SIGTERM"). This stub installs an explicit SIGTERM
//                 handler that calls `process.exit(0)` to reproduce the real CLI's measured shape.
//
// stdin must be `/dev/null` per SPIKE-4 D1; this stub does not read stdin at all, so a hung read
// would itself be evidence of a wiring bug in the harness, not something this file checks for.

const mode = process.env.STUB_MODE || "success";

function line(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

const THREAD_ID = "01a076dd-0000-7000-0000-stub00000000";

switch (mode) {
  case "success": {
    line({ type: "thread.started", thread_id: THREAD_ID });
    line({ type: "turn.started" });
    line({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "LOOPMILL-OK" } });
    line({
      type: "turn.completed",
      usage: { input_tokens: 1000, cached_input_tokens: 200, cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0 },
    });
    process.exit(0);
    break;
  }
  case "structured": {
    line({ type: "thread.started", thread_id: THREAD_ID });
    line({ type: "turn.started" });
    // Shaped for examples/daily-content-improvement.loop.yaml's `review-content` node
    // (structuredOutput: { needs_issue: boolean, title: string, summary: string },
    // additionalProperties: false) -- the codex node test/backends/local-codex.test.ts
    // re-validates this stub's output against.
    line({
      type: "item.completed",
      item: {
        id: "item_0",
        type: "agent_message",
        text: JSON.stringify({ needs_issue: true, title: "stub title", summary: "stub summary" }),
      },
    });
    line({
      type: "turn.completed",
      usage: { input_tokens: 1200, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0 },
    });
    process.exit(0);
    break;
  }
  case "turn-failed": {
    line({ type: "thread.started", thread_id: THREAD_ID });
    line({ type: "turn.started" });
    line({ type: "item.completed", item: { id: "item_0", type: "error", message: "stub model error" } });
    line({ type: "error", message: '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"stub failure"}}' });
    line({ type: "turn.failed", error: { message: '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"stub failure"}}' } });
    process.exit(1);
    break;
  }
  case "sleep": {
    line({ type: "thread.started", thread_id: THREAD_ID });
    line({ type: "turn.started" });
    process.on("SIGTERM", () => {
      process.exit(0);
    });
    setTimeout(() => {}, 60_000);
    break;
  }
  default: {
    process.stderr.write(`unknown STUB_MODE: ${mode}\n`);
    process.exit(2);
  }
}
