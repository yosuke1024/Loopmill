// m1 acceptance criterion A3 (mvp-design.md §20.3): "`transition(snapshot, event)` is pure: same
// inputs, same outputs, no I/O — proven by a property test." This is that property test.
//
// The three checks and the generated (snapshot, event, ctx) pool they share both live in
// `purity-check.ts` (a plain helper module, not itself matched by `npm test`'s `*.test.ts` glob)
// so `invariants.test.ts`'s own I-12 can run the exact same checks under its own name rather than
// re-deriving them — see that file's own comment on I-12.
//
// The pool is built once per process from a fixed, printed seed (`DEFAULT_SEED`) via a small
// deterministic PRNG (`mulberry32`): the same seed always regenerates the same triples, so a
// failure here is reproducible by construction, and every assertion inside the shared checks
// embeds the seed in its own message as well (the task's own instruction: "print the seed on
// failure").

import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SEED, mulberry32, buildTriplePool, checkDeterminism, checkNoMutation, checkNoIO } from "./purity-check.ts";

const SEED = DEFAULT_SEED;
const POOL = buildTriplePool(mulberry32(SEED));

// A pool this small would defeat the point of "generate inputs rather than hand-listing a couple
// of cases" — this is a build-time sanity check on the generator itself, not on `transition()`.
assert.ok(POOL.length >= 80, `purity-check.ts's generated pool only has ${POOL.length} triples (seed=${SEED}) — expected at least 80; a scenario builder likely regressed`);

test(`I-12 property (determinism): transition() gives byte-identical results for the same (snapshot, event, ctx), across ${POOL.length} generated triples (seed=${SEED})`, () => {
  const { checked } = checkDeterminism(POOL, SEED);
  assert.equal(checked, POOL.length);
});

test(`I-12 property (no mutation): transition() never modifies its snapshot or event inputs, across ${POOL.length} generated triples (seed=${SEED})`, () => {
  const { checked } = checkNoMutation(POOL, SEED);
  assert.equal(checked, POOL.length);
});

test(`I-12 property (no I/O): transition() never touches fs, child_process, Date.now/new Date or Math.random, across ${POOL.length} generated triples (seed=${SEED})`, () => {
  const { checked } = checkNoIO(POOL, SEED);
  assert.equal(checked, POOL.length);
});
