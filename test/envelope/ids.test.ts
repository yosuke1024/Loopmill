// docs/spec/envelope.md §6, §8.3, §13 TV-2.
//
// TV-2's seed, sha256 digest, entropy (first 10 bytes) and the final `eventId` are independently
// verified below. The spec's worked example originally stated the id as
// "06G7BXFYZ09DF0AZG7Y0K6EADR": its 16-character entropy half matched this derivation exactly, but
// its 10-character time prefix decoded to 7154741804000 ms (year 2196) — exactly four times the
// stated timestamp 1788685451000 (2026-09-06T09:04:11Z), which Crockford base32 encodes as
// "01M1TZBZQR". The spec was corrected to "01M1TZBZQR9DF0AZG7Y0K6EADR" on 2026-09-06 (editorial);
// `src/util/ulid.ts` needed no change, since it already implements the standard encoding.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deriveDeliveryEventId, newEventId, newRunId, semanticKey } from "../../src/envelope/ids.ts";
import { deterministicEventId, isRunId, isUlid, ulidTimeMs } from "../../src/util/ulid.ts";

const TV2_DELIVERY = {
  githubEvent: "issue_comment",
  naturalKey: "3310042117",
  sourceTimestamp: "2026-09-06T09:04:11Z",
};

test("TV-2: seed and sha256 digest match the spec exactly", () => {
  const seed = "loopmill/ingest/1 issue_comment 3310042117 2026-09-06T09:04:11Z";
  const digest = createHash("sha256").update(seed).digest("hex");
  assert.equal(digest, "4b5e057e07f0266729b8cb3f402568e311c50280b0d9196ffedb63748621e8b3");
  assert.equal(digest.slice(0, 20), "4b5e057e07f0266729b8"); // first 10 bytes = the spec's stated entropy
});

test("TV-2: deriveDeliveryEventId is a well-formed ULID whose entropy half matches the spec", () => {
  const id = deriveDeliveryEventId(TV2_DELIVERY);
  assert.ok(isUlid(id));
  assert.equal(id.length, 26);
  // The last 16 characters are the crockford32 encoding of the spec's own stated entropy bytes.
  assert.equal(id.slice(10), "9DF0AZG7Y0K6EADR");
});

test("TV-2: the correctly-encoded id (verified independently of this implementation) is stable", () => {
  // Correct value: crockford32(1788685451000, 10 chars) || crockford32(entropy, 16 chars).
  // The time half was independently re-derived from scratch (see file header); asserted here as
  // a literal so a future change to the encoding is caught.
  assert.equal(deriveDeliveryEventId(TV2_DELIVERY), "01M1TZBZQR9DF0AZG7Y0K6EADR");
});

test("TV-2: deriving twice from the same delivery gives the same id", () => {
  const a = deriveDeliveryEventId(TV2_DELIVERY);
  const b = deriveDeliveryEventId({ ...TV2_DELIVERY });
  assert.equal(a, b);
});

test("TV-2: changing any byte of the seed changes the entropy half (last 16 chars)", () => {
  const base = deriveDeliveryEventId(TV2_DELIVERY);
  const variants = [
    { ...TV2_DELIVERY, githubEvent: "pull_request_review" },
    { ...TV2_DELIVERY, naturalKey: "3310042118" },
    { ...TV2_DELIVERY, sourceTimestamp: "2026-09-06T09:04:12Z" },
  ];
  for (const variant of variants) {
    const id = deriveDeliveryEventId(variant);
    assert.notEqual(id.slice(10), base.slice(10), `expected different entropy for ${JSON.stringify(variant)}`);
  }
});

test("TV-2: the time half tracks sourceTimestamp, independent of the entropy", () => {
  const id = deriveDeliveryEventId(TV2_DELIVERY);
  assert.equal(ulidTimeMs(id), 1788685451000);
});

// ---------------------------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------------------------

test("re-exports: deterministicEventId and newRunId are the util/ulid.ts functions", () => {
  assert.equal(typeof deterministicEventId, "function");
  assert.ok(isRunId(newRunId(1_700_000_000_000)));
});

test("newEventId: alias of randomUlid", () => {
  const id = newEventId(1_700_000_000_000);
  assert.ok(isUlid(id));
  assert.equal(id.length, 26);
});

// ---------------------------------------------------------------------------------------------
// semanticKey (§6.2)
// ---------------------------------------------------------------------------------------------

test("semanticKey: node-level envelope", () => {
  const key = semanticKey({ cycle: 1, nodeId: "implement", attempt: 2, eventType: "node-completed" });
  assert.equal(key, "1:implement:2:node-completed");
});

test("semanticKey: null for a run-level envelope missing node coordinates", () => {
  assert.equal(semanticKey({ eventType: "run-requested" }), null);
  assert.equal(semanticKey({ eventType: "run-started" }), null);
  assert.equal(semanticKey({ eventType: "run-finished" }), null);
  assert.equal(semanticKey({ eventType: "resumed" }), null);
});

test("semanticKey: null for retry-edge-taken (cycle only, no nodeId/attempt)", () => {
  assert.equal(semanticKey({ cycle: 2, eventType: "retry-edge-taken" }), null);
});

test("semanticKey: null for an ignored-stale that declined a run-level envelope", () => {
  assert.equal(semanticKey({ eventType: "ignored-stale" }), null);
});

test("semanticKey: attempt 0 (control-plane-local node execution) still produces a key", () => {
  const key = semanticKey({ cycle: 0, nodeId: "review-passed", attempt: 0, eventType: "human-requested" });
  assert.equal(key, "0:review-passed:0:human-requested");
});
