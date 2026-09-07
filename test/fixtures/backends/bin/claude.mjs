#!/usr/bin/env node
// Stub `claude` CLI for test/backends/*.test.ts. Never talks to any network or vendor -- it only
// prints a claude-code-shaped result object matching docs/spec/usage-fixtures/
// claude-recorded-success.json's `input.terminalEvent` shape. Selected by the `STUB_MODE` env
// var so tests never depend on real argv parsing:
//
//   success          exit 0, a normal terminal result.
//   structured        exit 0, the result also carries `structured_output`.
//   max_turns         exit 1, `subtype: "error_max_turns"`, `is_error: true` -- still carries
//                     usage (measured, per SPIKE-1's finding).
//   sleep-then-exit   installs a SIGINT handler (the measured claude-code cancel signal) that
//                     prints an `aborted_streaming` result and exits 0, then sleeps well past any
//                     test's own deadline so the timeout/cancel path is what actually ends it.
//   print-env         prints `process.env` as JSON so an env-scrubbing test can read it back.
//
// Every mode also reports a `stdin_check` field: whether the CLI's own stdin looks like a TTY,
// and whether a synchronous read immediately sees EOF -- the shape `local/spawn.ts`'s
// `stdio: ["ignore", "pipe", "pipe"]` (mapping to `/dev/null` on Unix) must produce, matching the
// SPIKE-1/SPIKE-4 "stdin must be /dev/null or closed" requirement.

import { readSync, writeFileSync } from "node:fs";

const mode = process.env.STUB_MODE || "success";

// "success" and "structured" simulate the agent editing a file in its own working directory
// (always the Run's worktree per `local/executor.ts`'s `cwd`), so a test can exercise the
// `changedFiles()`-sourced `artifactRefs` path without a real CLI.
if (mode === "success" || mode === "structured") {
  try {
    writeFileSync("stub-agent-output.txt", "written by the claude stub\n");
  } catch {
    // A read-only permission profile test may run this against a directory the stub cannot
    // write to; that is itself a legitimate scenario, not a stub bug.
  }
}

function checkStdin() {
  const check = { isTTY: Boolean(process.stdin.isTTY) };
  try {
    const buf = Buffer.alloc(1);
    const bytesRead = readSync(0, buf, 0, 1, null);
    check.bytesRead = bytesRead;
  } catch (err) {
    check.errorCode = err && err.code ? err.code : String(err);
  }
  return check;
}

function baseResult(overrides) {
  return Object.assign(
    {
      type: "result",
      subtype: "success",
      is_error: false,
      terminal_reason: "completed",
      duration_ms: 120,
      duration_api_ms: 100,
      num_turns: 1,
      result: "LOOPMILL-OK",
      session_id: "stub-session-0000000000000000",
      total_cost_usd: 0.01,
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 5,
        output_tokens: 3,
      },
      modelUsage: {
        "stub-model": {
          inputTokens: 2,
          outputTokens: 3,
          cacheReadInputTokens: 5,
          cacheCreationInputTokens: 10,
          thinkingTokens: 0,
          costUSD: 0.01,
          costBasis: "list",
        },
      },
      stdin_check: checkStdin(),
    },
    overrides,
  );
}

function printAndExit(obj, code) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
  process.exit(code);
}

switch (mode) {
  case "success": {
    printAndExit(baseResult({}), 0);
    break;
  }
  case "structured": {
    // Shaped for examples/daily-content-improvement.loop.yaml's `implement` node
    // (structuredOutput: { changed: boolean, summary: string }, additionalProperties: false) --
    // the only claude-code agent node in the reference loop, and therefore the only schema
    // test/backends/local-claude-code.test.ts ever re-validates this stub's output against.
    printAndExit(baseResult({ structured_output: { changed: true, summary: "stub changed something" } }), 0);
    break;
  }
  case "max_turns": {
    printAndExit(
      baseResult({
        subtype: "error_max_turns",
        is_error: true,
        terminal_reason: "max_turns",
        result: null,
        errors: ["Reached maximum number of turns (1)"],
      }),
      1,
    );
    break;
  }
  case "sleep-then-exit": {
    let handled = false;
    process.on("SIGINT", () => {
      if (handled) return;
      handled = true;
      // Matches docs/spec/usage-fixtures/claude-recorded-sigint.json: `usage` (result.usage) is
      // entirely zeroed (the interrupted main-model response never completed), but `modelUsage`
      // still carries the ALREADY-COMPLETED helper-model call -- an empty `modelUsage: {}` would
      // instead trip the §2.1 zeroed-crash rule and normalize to `unavailable`, which is not what
      // a real SIGINT abort measures.
      printAndExit(
        baseResult({
          is_error: true,
          subtype: "error_during_execution",
          terminal_reason: "aborted_streaming",
          result: null,
          usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
          modelUsage: {
            "stub-haiku-helper": {
              inputTokens: 912,
              outputTokens: 16,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              thinkingTokens: 0,
              costUSD: 0.000992,
              costBasis: "list",
            },
          },
        }),
        0,
      );
    });
    // Far longer than any test's own deadline -- the test is expected to signal this process,
    // not wait it out.
    setTimeout(() => {}, 60_000);
    break;
  }
  case "print-env": {
    process.stdout.write(`${JSON.stringify(process.env)}\n`);
    process.exit(0);
    break;
  }
  default: {
    process.stderr.write(`unknown STUB_MODE: ${mode}\n`);
    process.exit(2);
  }
}
