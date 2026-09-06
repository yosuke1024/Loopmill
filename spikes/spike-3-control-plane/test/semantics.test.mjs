/**
 * SPIKE-3 - state-machine semantics against the local directory store.
 *
 * Proves: exit-code mapping, idempotency by eventId, stale/out-of-order
 * rejection, the retry edge, MAX_ITERATIONS_EXCEEDED, NODE_FAILED and that
 * snapshot.json is a pure fold of the event log.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { mkTmp, cli, localArgs, startedEvent, step, driveStepwise } from './helpers.mjs';
import { EXIT, foldEvents, canonicalJson } from '../step.mjs';

function eventsDir(dir, runId) {
  return path.join(dir, 'runs', runId, 'events');
}
function listEvents(dir, runId) {
  const d = eventsDir(dir, runId);
  return fs.existsSync(d) ? fs.readdirSync(d).sort() : [];
}
function snapshotText(dir, runId) {
  return fs.readFileSync(path.join(dir, 'runs', runId, 'snapshot.json'), 'utf8');
}

test('happy path: retry edge is exercised and the run completes (exit 10)', () => {
  const dir = path.join(mkTmp(), 'state');
  const S = localArgs(dir);
  const results = driveStepwise(S, startedEvent('run-a', 'retry-then-pass'));

  const last = results.at(-1);
  assert.equal(last.code, EXIT.OK_RUN_COMPLETED, 'terminal step exits 10');
  assert.equal(last.json.outcome, 'COMPLETED');
  const snap = last.json.snapshot;
  assert.equal(snap.status, 'SUCCEEDED');
  assert.equal(snap.iterations, 1, 'exactly one retry-edge traversal');
  assert.equal(snap.cycle, 2);
  // node-level retry happened too (implement attempt 2 in cycle 1)
  assert.ok(snap.completed.some((c) => c.nodeId === 'implement' && c.cycle === 1 && c.attempt === 2));
  // observe runs once, review runs once per cycle
  assert.equal(snap.completed.filter((c) => c.nodeId === 'observe').length, 1);
  assert.equal(snap.completed.filter((c) => c.nodeId === 'review').length, 2);
  assert.equal(snap.ignored.length, 0);
});

test('retry edge budget: MAX_ITERATIONS_EXCEEDED (exit 11) after maxIterations cycles', () => {
  const dir = path.join(mkTmp(), 'state');
  const S = localArgs(dir);
  const results = driveStepwise(S, startedEvent('run-b', 'always-fail'));
  const last = results.at(-1);
  assert.equal(last.code, EXIT.OK_MAX_ITERATIONS_EXCEEDED);
  assert.equal(last.json.outcome, 'MAX_ITERATIONS_EXCEEDED');
  assert.equal(last.json.snapshot.status, 'FAILED');
  assert.equal(last.json.snapshot.cycle, 3, 'stops at maxIterations = 3 cycles');
  assert.equal(last.json.snapshot.iterations, 2, 'two retry-edge traversals: c1->c2, c2->c3');
  assert.equal(last.json.nextEvent, null, 'no further event is dispatched');
});

test('node-level attempts are bounded: NODE_FAILED (exit 12)', () => {
  const dir = path.join(mkTmp(), 'state');
  const S = localArgs(dir);
  const results = driveStepwise(S, startedEvent('run-c', 'node-always-error'));
  const last = results.at(-1);
  assert.equal(last.code, EXIT.OK_RUN_FAILED);
  assert.equal(last.json.outcome, 'NODE_FAILED');
  assert.equal(last.json.snapshot.completed.filter((c) => c.nodeId === 'observe').length, 2);
});

test('duplicate delivery: the same eventId twice is a strict no-op (exit 20)', () => {
  const dir = path.join(mkTmp(), 'state');
  const S = localArgs(dir);
  const started = startedEvent('run-d', 'retry-then-pass');

  const r1 = step(S, started);
  assert.equal(r1.code, EXIT.OK_CONTINUE);
  const filesBefore = listEvents(dir, 'run-d');
  const snapBefore = snapshotText(dir, 'run-d');

  const r2 = step(S, started); // byte-identical redelivery
  assert.equal(r2.code, EXIT.NOOP_DUPLICATE);
  assert.equal(r2.json.classification, 'DUPLICATE');
  assert.equal(r2.json.reason, 'EVENT_ALREADY_SEEN');
  assert.deepEqual(listEvents(dir, 'run-d'), filesBefore, 'no new event file');
  assert.equal(snapshotText(dir, 'run-d'), snapBefore, 'snapshot byte-identical');

  // and a duplicate node-completed behaves the same way
  const c1 = step(S, r1.json.nextEvent);
  assert.equal(c1.code, EXIT.OK_CONTINUE);
  const files2 = listEvents(dir, 'run-d');
  const snap2 = snapshotText(dir, 'run-d');
  const c2 = step(S, r1.json.nextEvent);
  assert.equal(c2.code, EXIT.NOOP_DUPLICATE);
  assert.deepEqual(listEvents(dir, 'run-d'), files2);
  assert.equal(snapshotText(dir, 'run-d'), snap2);
});

test('out-of-order: a completion for attempt 1 after attempt 2 was dispatched is ignored (exit 21)', () => {
  const dir = path.join(mkTmp(), 'state');
  const S = localArgs(dir);
  const started = startedEvent('run-e', 'retry-then-pass');

  const r1 = step(S, started);                 // -> dispatch observe c1a1
  const r2 = step(S, r1.json.nextEvent);       // observe pass -> dispatch implement c1a1
  const r3 = step(S, r2.json.nextEvent);       // implement c1a1 ERROR -> dispatch implement c1a2
  assert.equal(r3.json.snapshot.current.nodeId, 'implement');
  assert.equal(r3.json.snapshot.current.attempt, 2);
  assert.equal(r3.json.snapshot.current.state, 'RUNNING');

  // a slow/duplicated backend reports attempt 1 again under a NEW eventId
  const stale = { ...r2.json.nextEvent, eventId: 'evt_stale_attempt_1', result: { status: 'pass', exitCode: 0 } };
  const rs = step(S, stale);
  assert.equal(rs.code, EXIT.NOOP_STALE);
  assert.equal(rs.json.classification, 'STALE');
  assert.equal(rs.json.reason, 'STALE_ATTEMPT');
  assert.equal(rs.json.nextEvent, null, 'a stale event never dispatches anything');

  const snap = rs.json.snapshot;
  assert.equal(snap.current.attempt, 2, 'in-flight attempt is untouched');
  assert.equal(snap.current.state, 'RUNNING');
  assert.ok(!snap.appliedEventIds.includes('evt_stale_attempt_1'), 'never applied');
  assert.ok(snap.seenEventIds.includes('evt_stale_attempt_1'), 'but recorded for idempotency');
  assert.equal(snap.ignored.at(-1).reason, 'STALE_ATTEMPT');
  // redelivering the same stale event is now a plain duplicate
  assert.equal(step(S, stale).code, EXIT.NOOP_DUPLICATE);

  // the run still converges normally afterwards
  const rest = driveStepwise(S, r3.json.nextEvent);
  assert.equal(rest.at(-1).code, EXIT.OK_RUN_COMPLETED);
});

test('out-of-order: a completion for a node that is not in flight is ignored (exit 21)', () => {
  const dir = path.join(mkTmp(), 'state');
  const S = localArgs(dir);
  const r1 = step(S, startedEvent('run-f', 'retry-then-pass')); // observe c1a1 in flight
  const wrongNode = {
    ...r1.json.nextEvent,
    eventId: 'evt_wrong_node',
    nodeId: 'review',
    result: { status: 'pass', exitCode: 0 },
  };
  const rs = step(S, wrongNode);
  assert.equal(rs.code, EXIT.NOOP_STALE);
  assert.equal(rs.json.reason, 'NOT_CURRENT_NODE');
  assert.equal(rs.json.snapshot.current.nodeId, 'observe');
});

test('events after a terminal run are ignored (exit 22)', () => {
  const dir = path.join(mkTmp(), 'state');
  const S = localArgs(dir);
  const results = driveStepwise(S, startedEvent('run-g', 'retry-then-pass'));
  assert.equal(results.at(-1).code, EXIT.OK_RUN_COMPLETED);

  const late = {
    schemaVersion: 1, eventId: 'evt_late', loopId: 'spike3-review-loop', runId: 'run-g',
    cycle: 2, nodeId: 'review', attempt: 1, eventType: 'node-completed',
    result: { status: 'pass', exitCode: 0 }, artifactRefs: [], usage: null,
    occurredAt: '2026-09-06T00:00:00.000Z', producer: 'test', causationId: null,
  };
  const r = step(S, late);
  assert.equal(r.code, EXIT.NOOP_TERMINAL);
  assert.equal(r.json.reason, 'RUN_ALREADY_TERMINAL');
  assert.equal(r.json.snapshot.status, 'SUCCEEDED');
});

test('invalid envelopes are rejected without touching state (exit 30)', () => {
  const dir = path.join(mkTmp(), 'state');
  const S = localArgs(dir);
  const started = startedEvent('run-h', 'retry-then-pass');

  // unknown run
  const orphan = { ...started, runId: 'run-does-not-exist', eventType: 'node-completed', nodeId: 'observe', cycle: 1, attempt: 1, result: { status: 'pass' }, eventId: 'evt_orphan' };
  assert.equal(step(S, orphan).code, EXIT.ERR_INVALID_EVENT);

  step(S, started);
  const before = snapshotText(dir, 'run-h');

  for (const [name, patch] of [
    ['bad schemaVersion', { schemaVersion: 99, eventId: 'evt_v' }],
    ['unknown node', { eventType: 'node-completed', nodeId: 'nope', cycle: 1, attempt: 1, result: { status: 'pass' }, eventId: 'evt_n' }],
    ['bad result status', { eventType: 'node-completed', nodeId: 'observe', cycle: 1, attempt: 1, result: { status: 'weird' }, eventId: 'evt_s' }],
    ['unknown loop', { loopId: 'other-loop', eventId: 'evt_l' }],
    ['emitted type as inbound', { eventType: 'node-dispatched', eventId: 'evt_d' }],
  ]) {
    const r = step(S, { ...started, ...patch });
    assert.equal(r.code, EXIT.ERR_INVALID_EVENT, `${name} must exit 30`);
    assert.equal(r.json.classification, 'INVALID');
  }
  assert.equal(snapshotText(dir, 'run-h'), before, 'invalid events leave the snapshot untouched');
});

test('snapshot.json is exactly the fold of the event log (rebuild-snapshot)', () => {
  const dir = path.join(mkTmp(), 'state');
  const S = localArgs(dir);
  driveStepwise(S, startedEvent('run-i', 'retry-then-pass'));

  const r = cli(['rebuild-snapshot', ...S, '--run-id', 'run-i']);
  assert.equal(r.code, 0);
  assert.equal(r.json.equal, true);
  assert.equal(r.json.storedSha256, r.json.rebuiltSha256);

  // and again in-process, byte for byte
  const records = fs.readdirSync(eventsDir(dir, 'run-i')).sort()
    .map((n) => JSON.parse(fs.readFileSync(path.join(eventsDir(dir, 'run-i'), n), 'utf8')));
  assert.equal(canonicalJson(foldEvents(records)), snapshotText(dir, 'run-i'));

  // deleting the cache and refolding reproduces it
  const stored = snapshotText(dir, 'run-i');
  fs.rmSync(path.join(dir, 'runs', 'run-i', 'snapshot.json'));
  assert.equal(canonicalJson(foldEvents(records)), stored);
});

test('usage-reported is an order-independent inbound event', () => {
  const dir = path.join(mkTmp(), 'state');
  const S = localArgs(dir);
  const r1 = step(S, startedEvent('run-j', 'retry-then-pass'));
  const usage = {
    schemaVersion: 1, eventId: 'evt_usage_1', loopId: 'spike3-review-loop', runId: 'run-j',
    cycle: 1, nodeId: 'observe', attempt: 1, eventType: 'usage-reported',
    result: null, artifactRefs: [], usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    occurredAt: '2026-09-06T00:00:00.000Z', producer: 'test', causationId: null,
  };
  const r = step(S, usage);
  assert.equal(r.code, EXIT.OK_CONTINUE);
  assert.equal(r.json.classification, 'APPLIED');
  assert.equal(r.json.nextEvent, null, 'usage does not advance the loop');
  assert.equal(r.json.snapshot.usage.totalTokens, 15);
  assert.equal(r.json.snapshot.current.nodeId, 'observe', 'the in-flight node is unchanged');
  assert.equal(r.json.snapshot.current.state, 'RUNNING');
  // the loop still advances afterwards
  assert.equal(step(S, r1.json.nextEvent).code, EXIT.OK_CONTINUE);
});
