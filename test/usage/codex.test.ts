// parseCodexJsonl: the JSONL-parsing half of codex.ts (normalizeCodexStream itself is exhaustively
// exercised by the fixture corpus in test/usage/fixtures.test.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCodexJsonl } from "../../src/usage/codex.ts";

test("parseCodexJsonl: parses well-formed newline-delimited JSON", () => {
  const text = '{"type":"thread.started","thread_id":"t1"}\n{"type":"turn.started"}\n{"type":"turn.completed","usage":{"input_tokens":10}}\n';
  const result = parseCodexJsonl(text);
  assert.equal(result.events.length, 3);
  assert.equal(result.parseErrors, 0);
  assert.equal(result.lastLineTruncated, false);
});

test("parseCodexJsonl: a malformed line is counted as a parse error and excluded from events, not partially salvaged", () => {
  const text = '{"type":"thread.started","thread_id":"t1"}\nnot json at all\n{"type":"turn.started"}\n';
  const result = parseCodexJsonl(text);
  assert.equal(result.events.length, 2);
  assert.equal(result.parseErrors, 1);
});

test("parseCodexJsonl: a truncated final line (no trailing newline, cut off mid-object) is flagged", () => {
  const text = '{"type":"thread.started","thread_id":"t1"}\n{"type":"turn.completed","usage":{"input_to';
  const result = parseCodexJsonl(text);
  assert.equal(result.events.length, 1);
  assert.equal(result.parseErrors, 1);
  assert.equal(result.lastLineTruncated, true);
});

test("parseCodexJsonl: a malformed line that is NOT the last line is not flagged as truncated", () => {
  const text = 'garbage\n{"type":"turn.started"}\n';
  const result = parseCodexJsonl(text);
  assert.equal(result.parseErrors, 1);
  assert.equal(result.lastLineTruncated, false);
});

test("parseCodexJsonl: blank lines are skipped without counting as parse errors", () => {
  const text = '{"type":"turn.started"}\n\n\n{"type":"turn.completed","usage":{}}\n';
  const result = parseCodexJsonl(text);
  assert.equal(result.events.length, 2);
  assert.equal(result.parseErrors, 0);
});

test("parseCodexJsonl: empty input parses to zero events with no errors", () => {
  const result = parseCodexJsonl("");
  assert.equal(result.events.length, 0);
  assert.equal(result.parseErrors, 0);
  assert.equal(result.lastLineTruncated, false);
});
