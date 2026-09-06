// `canonical.ts`: RFC 8785 JSON Canonicalization Scheme serialisation and `loopVersion`
// (docs/spec/loop-file.md §3.1).

import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalizeLoopFile, loopVersionOf } from "../../src/loop-file/canonical.ts";
import { sha256Prefixed } from "../../src/util/hash.ts";
import type { LoopFile } from "../../src/types/loop.ts";

// A minimal, deliberately schema-shaped-but-untyped-enough value: canonicalizeLoopFile only
// serialises what it is given, so a partial object is fine for these lower-level tests.
function minimal(overrides: Record<string, unknown> = {}): LoopFile {
  return {
    schemaVersion: "0.6.0",
    slug: "x",
    name: "X",
    trigger: { kind: "manual" },
    repos: [{ id: "a", path: ".", defaultBase: "main" }],
    nodes: { done: { kind: "end", outcome: "success" } },
    ...overrides,
  } as unknown as LoopFile;
}

test("canonicalizeLoopFile: object keys are sorted, no insignificant whitespace", () => {
  const out = canonicalizeLoopFile(minimal());
  assert.equal(
    out,
    '{"name":"X","nodes":{"done":{"kind":"end","outcome":"success"}},"repos":[{"defaultBase":"main","id":"a","path":"."}],"schemaVersion":"0.6.0","slug":"x","trigger":{"kind":"manual"}}',
  );
});

test("canonicalizeLoopFile: key order at every nesting depth is insignificant", () => {
  const a = minimal({ description: "d" });
  const b = {
    trigger: { kind: "manual" },
    description: "d",
    nodes: { done: { outcome: "success", kind: "end" } },
    schemaVersion: "0.6.0",
    name: "X",
    repos: [{ defaultBase: "main", id: "a", path: "." }],
    slug: "x",
  } as unknown as LoopFile;
  assert.equal(canonicalizeLoopFile(a), canonicalizeLoopFile(b));
});

test("canonicalizeLoopFile: array order and membership ARE significant", () => {
  const a = minimal({ env: { preserve: ["ONE", "TWO"] } });
  const b = minimal({ env: { preserve: ["TWO", "ONE"] } });
  assert.notEqual(canonicalizeLoopFile(a), canonicalizeLoopFile(b));
});

test("canonicalizeLoopFile: numbers render in shortest round-trip form", () => {
  const withNumber = minimal({ budget: { maxAttempts: 2, maxMeasuredTokens: 2000000 } });
  const out = canonicalizeLoopFile(withNumber);
  assert.match(out, /"maxAttempts":2/);
  assert.match(out, /"maxMeasuredTokens":2000000/);
});

test("canonicalizeLoopFile: booleans and null render as bare literals", () => {
  const withScalars = minimal({ description: null, approval: { policy: "gated" } });
  const out = canonicalizeLoopFile(withScalars);
  assert.match(out, /"description":null/);
});

test("canonicalizeLoopFile: strings escape exactly like JSON", () => {
  const out = canonicalizeLoopFile(minimal({ name: 'quote " and back\\slash' }));
  assert.match(out, /"name":"quote \\" and back\\\\slash"/);
});

test("loopVersionOf: sha256 over the canonical bytes, prefixed", () => {
  const file = minimal();
  const canonical = canonicalizeLoopFile(file);
  assert.equal(loopVersionOf(file), sha256Prefixed(canonical));
  assert.match(loopVersionOf(file), /^sha256:[0-9a-f]{64}$/);
});

test("loopVersionOf: a comment-only / whitespace-only distinction never reaches this layer -- two structurally identical documents hash identically", () => {
  const a = minimal();
  const b = JSON.parse(JSON.stringify(minimal())) as LoopFile; // a fresh, deep clone
  assert.equal(loopVersionOf(a), loopVersionOf(b));
});

test("loopVersionOf: any semantic value change changes the hash", () => {
  const a = minimal();
  const b = minimal({ name: "Y" });
  assert.notEqual(loopVersionOf(a), loopVersionOf(b));
});

test("canonicalizeLoopFile: rejects values it cannot represent (NaN, Infinity)", () => {
  assert.throws(() => canonicalizeLoopFile(minimal({ budget: { maxAttempts: Number.NaN } })));
  assert.throws(() => canonicalizeLoopFile(minimal({ budget: { maxAttempts: Number.POSITIVE_INFINITY } })));
});
