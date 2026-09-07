/**
 * SPIKE-3 - the git-branch state store, using a local BARE repository as the
 * remote. Proves the durability / concurrency properties that the local
 * directory store cannot show: one commit per step, compare-and-swap pushes,
 * retry after a lost race, and crash-safety of an interrupted job.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  mkTmp, cli, cliAsync, gitArgs, startedEvent, step, driveStepwise,
  makeBareRemote, remoteSha, remoteFile, remoteSubjects, remoteCommitCount,
  remoteTree, waitFor, sleep, git,
} from './helpers.mjs';
import { EXIT } from '../step.mjs';

const BRANCH = 'loopmill/state-spike';
const FIXED_NOW = { LOOPMILL_NOW: '2026-09-06T00:00:00.000Z' };

function setup(name = 'r') {
  const root = mkTmp();
  const bare = makeBareRemote(root);
  const wd = path.join(root, `wd-${name}`);
  return { root, bare, wd, S: gitArgs(bare, BRANCH, wd) };
}

function remoteEventFiles(bare, runId) {
  return remoteTree(bare, BRANCH)
    .filter((p) => p.startsWith(`runs/${runId}/events/`))
    .sort();
}

function remoteRecords(bare, runId) {
  return remoteEventFiles(bare, runId).map((p) => JSON.parse(remoteFile(bare, BRANCH, p)));
}

test('audit trail: one commit per applied event, eventId in the commit subject', () => {
  const { bare, S } = setup('audit');
  assert.equal(remoteSha(bare, BRANCH), null, 'branch does not exist yet');

  const results = driveStepwise(S, startedEvent('run-1', 'retry-then-pass'));
  assert.equal(results.at(-1).code, EXIT.OK_RUN_COMPLETED);

  const persisted = results.filter((r) => r.json.classification !== 'DUPLICATE');
  assert.equal(remoteCommitCount(bare, BRANCH), persisted.length,
    'exactly one commit per step that changed state');

  const subjects = remoteSubjects(bare, BRANCH).reverse(); // oldest first
  const appliedIds = results.map((r) => r.json.appliedEventId);
  assert.equal(subjects.length, appliedIds.length);
  subjects.forEach((s, i) => {
    assert.match(s, /^loopmill: /);
    assert.ok(s.includes(`eventId=${appliedIds[i]}`), `commit ${i} names its applied eventId`);
  });

  // the orphan branch carries state only - no source tree
  const tree = remoteTree(bare, BRANCH);
  assert.ok(tree.length > 0);
  assert.ok(tree.every((p) => p.startsWith('runs/')), `state branch holds only runs/: ${tree.join(',')}`);
  assert.ok(tree.includes('runs/run-1/run.json'));
  assert.ok(tree.includes('runs/run-1/snapshot.json'));
});

test('duplicate delivery over the git store creates no commit at all', () => {
  const { bare, S } = setup('dup');
  const started = startedEvent('run-2', 'retry-then-pass');
  const r1 = step(S, started);
  assert.equal(r1.code, EXIT.OK_CONTINUE);

  const shaBefore = remoteSha(bare, BRANCH);
  const filesBefore = remoteEventFiles(bare, 'run-2');
  const snapBefore = remoteFile(bare, BRANCH, 'runs/run-2/snapshot.json');

  const r2 = step(S, started);
  assert.equal(r2.code, EXIT.NOOP_DUPLICATE);
  assert.equal(r2.json.pushAttempts, 0, 'a duplicate never even attempts a push');
  assert.equal(remoteSha(bare, BRANCH), shaBefore, 'remote head unchanged');
  assert.deepEqual(remoteEventFiles(bare, 'run-2'), filesBefore, 'no new event file');
  assert.equal(remoteFile(bare, BRANCH, 'runs/run-2/snapshot.json'), snapBefore, 'same snapshot');
});

test('stale event over the git store is recorded as ignored, never applied', () => {
  const { bare, S } = setup('stale');
  const r1 = step(S, startedEvent('run-3', 'retry-then-pass'));
  const r2 = step(S, r1.json.nextEvent);      // observe pass -> implement c1a1
  const r3 = step(S, r2.json.nextEvent);      // implement c1a1 error -> implement c1a2
  assert.equal(r3.json.snapshot.current.attempt, 2);

  const stale = { ...r2.json.nextEvent, eventId: 'evt_stale_git', result: { status: 'pass', exitCode: 0 } };
  const commitsBefore = remoteCommitCount(bare, BRANCH);
  const rs = step(S, stale);

  assert.equal(rs.code, EXIT.NOOP_STALE);
  assert.equal(remoteCommitCount(bare, BRANCH), commitsBefore + 1, 'the ignore is auditable');

  const recs = remoteRecords(bare, 'run-3');
  const ignored = recs.filter((r) => r.kind === 'ignored');
  assert.equal(ignored.length, 1);
  assert.equal(ignored[0].reason, 'STALE_ATTEMPT');
  assert.equal(ignored[0].envelope.eventId, 'evt_stale_git');
  assert.ok(!recs.some((r) => r.kind === 'applied' && r.envelope.eventId === 'evt_stale_git'));

  const snap = JSON.parse(remoteFile(bare, BRANCH, 'runs/run-3/snapshot.json'));
  assert.equal(snap.current.nodeId, 'implement');
  assert.equal(snap.current.attempt, 2, 'the in-flight attempt is untouched');
  assert.equal(snap.current.state, 'RUNNING');
});

test('compare-and-swap: a push whose base moved is rejected, re-read and re-applied', async () => {
  const { root, bare, S } = setup('cas');
  const r1 = step(S, startedEvent('run-4', 'retry-then-pass'));
  const inFlight = r1.json.nextEvent;
  const baseSha = remoteSha(bare, BRANCH);

  const barrier = path.join(root, 'barrier-cas');
  const wdEvents = path.join(root, 'wd-cas', 'runs', 'run-4', 'events');
  const before = fs.readdirSync(wdEvents).length;

  const p = cliAsync(['step', ...S, '--event', JSON.stringify(inFlight), '--barrier-file', barrier]);
  // wait until the step has read state and written its files, then move the remote underneath it
  await waitFor(() => fs.existsSync(wdEvents) && fs.readdirSync(wdEvents).length > before, 10000, 'staged files');

  const foreign = path.join(root, 'foreign');
  git(root, ['clone', '-q', '--branch', BRANCH, bare, foreign]);
  fs.writeFileSync(path.join(foreign, 'runs', 'FOREIGN.txt'), 'written by another writer\n');
  git(foreign, ['add', '-A']);
  git(foreign, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'foreign writer']);
  git(foreign, ['push', '-q', 'origin', `HEAD:refs/heads/${BRANCH}`]);
  const foreignSha = remoteSha(bare, BRANCH);
  assert.notEqual(foreignSha, baseSha);

  fs.writeFileSync(barrier, 'go');
  const r = await p;

  assert.equal(r.code, EXIT.OK_CONTINUE);
  assert.equal(r.json.conflicts, 1, 'the stale push was rejected exactly once');
  assert.equal(r.json.pushAttempts, 2, 'and retried once');
  assert.equal(r.json.planAttempts, 2, 're-read and re-planned on top of the new base');

  // the foreign commit survived: the retry rebased on it instead of overwriting it
  assert.equal(remoteFile(bare, BRANCH, 'runs/FOREIGN.txt'), 'written by another writer');
  const recs = remoteRecords(bare, 'run-4');
  assert.ok(recs.some((x) => x.kind === 'applied' && x.envelope.eventId === inFlight.eventId));
  assert.equal(git(bare, ['rev-list', '--count', `${foreignSha}..refs/heads/${BRANCH}`]), '1');
});

test('concurrent steps: exactly one push wins, the loser retries, both events end up applied in order', async () => {
  const { root, bare } = setup('conc');
  const wd0 = path.join(root, 'wd-0');
  const S0 = gitArgs(bare, BRANCH, wd0);
  const r1 = step(S0, startedEvent('run-5', 'retry-then-pass'));
  const completion = r1.json.nextEvent;                     // observe c1a1 completion
  const usage = {
    schemaVersion: 1, eventId: 'evt_conc_usage', loopId: 'spike3-review-loop', runId: 'run-5',
    cycle: 1, nodeId: 'observe', attempt: 1, eventType: 'usage-reported',
    result: null, artifactRefs: [], usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
    occurredAt: '2026-09-06T00:00:00.000Z', producer: 'test', causationId: null,
  };
  const baseSha = remoteSha(bare, BRANCH);
  const commitsBefore = remoteCommitCount(bare, BRANCH);

  const wdA = path.join(root, 'wd-a');
  const wdB = path.join(root, 'wd-b');
  const barrier = path.join(root, 'barrier-conc');
  const pa = cliAsync(['step', ...gitArgs(bare, BRANCH, wdA), '--event', JSON.stringify(completion), '--barrier-file', barrier]);
  const pb = cliAsync(['step', ...gitArgs(bare, BRANCH, wdB), '--event', JSON.stringify(usage), '--barrier-file', barrier]);

  // both processes read state at the same base sha, then block on the barrier
  const evA = path.join(wdA, 'runs', 'run-5', 'events');
  const evB = path.join(wdB, 'runs', 'run-5', 'events');
  await waitFor(() => fs.existsSync(evA) && fs.readdirSync(evA).length >= 3, 10000, 'A staged');
  await waitFor(() => fs.existsSync(evB) && fs.readdirSync(evB).length >= 3, 10000, 'B staged');
  assert.equal(remoteSha(bare, BRANCH), baseSha, 'nothing pushed while both are blocked');
  fs.writeFileSync(barrier, 'go');

  const [ra, rb] = await Promise.all([pa, pb]);
  assert.equal(ra.code, EXIT.OK_CONTINUE);
  assert.equal(rb.code, EXIT.OK_CONTINUE);

  const winners = [ra, rb].filter((r) => r.json.conflicts === 0);
  const losers = [ra, rb].filter((r) => r.json.conflicts > 0);
  assert.equal(winners.length, 1, 'exactly one step pushed without a conflict');
  assert.equal(losers.length, 1, 'the other lost the compare-and-swap');
  assert.equal(winners[0].json.pushAttempts, 1);
  assert.equal(losers[0].json.pushAttempts, 2, 'the loser needed exactly one extra push');
  assert.equal(losers[0].json.planAttempts, 2, 'and re-planned against the winner state');

  assert.equal(remoteCommitCount(bare, BRANCH), commitsBefore + 2, 'two commits, serialized');

  const recs = remoteRecords(bare, 'run-5');
  const applied = recs.filter((r) => r.kind === 'applied').map((r) => r.envelope.eventId);
  assert.ok(applied.includes(completion.eventId), 'node-completed applied');
  assert.ok(applied.includes('evt_conc_usage'), 'usage-reported applied');
  const seqs = recs.map((r) => r.seq);
  assert.deepEqual(seqs, seqs.slice().sort((a, b) => a - b), 'sequence numbers are monotonic');
  assert.deepEqual(seqs, Array.from({ length: seqs.length }, (_, i) => i + 1), 'no gaps, no collisions');

  const snap = JSON.parse(remoteFile(bare, BRANCH, 'runs/run-5/snapshot.json'));
  assert.equal(snap.usage.totalTokens > 10, true, 'both usage contributions are folded in');
  assert.equal(snap.current.nodeId, 'implement', 'the loop advanced past observe');
});

test('interrupted job: killed after the local commit, before the push', () => {
  const { bare, S, root } = setup('crash-commit');
  const r1 = step(S, startedEvent('run-6', 'retry-then-pass', FIXED_NOW), [], FIXED_NOW);
  const next = r1.json.nextEvent;
  const shaBefore = remoteSha(bare, BRANCH);
  const commitsBefore = remoteCommitCount(bare, BRANCH);

  const crashed = step(S, next, ['--crash-point', 'after-commit'], FIXED_NOW);
  assert.equal(crashed.code, 97, 'the step died between commit and push');
  assert.equal(remoteSha(bare, BRANCH), shaBefore, 'the remote is byte-for-byte unchanged');
  assert.equal(remoteCommitCount(bare, BRANCH), commitsBefore);
  // the doomed commit does exist locally in the abandoned work dir
  assert.equal(git(path.join(root, 'wd-crash-commit'), ['rev-list', '--count', 'HEAD']), String(commitsBefore + 1));

  // rerunning the very same event in the very same work dir converges
  const rerun = step(S, next, [], FIXED_NOW);
  assert.equal(rerun.code, EXIT.OK_CONTINUE);
  assert.equal(remoteCommitCount(bare, BRANCH), commitsBefore + 1, 'exactly one commit, not two');

  // and the result is identical to a run that never crashed
  const clean = setup('clean');
  step(clean.S, startedEvent('run-6', 'retry-then-pass', FIXED_NOW), [], FIXED_NOW);
  step(clean.S, next, [], FIXED_NOW);
  assert.equal(
    remoteFile(bare, BRANCH, 'runs/run-6/snapshot.json'),
    remoteFile(clean.bare, BRANCH, 'runs/run-6/snapshot.json'),
    'converged state equals the uninterrupted state',
  );
  assert.deepEqual(remoteEventFiles(bare, 'run-6'), remoteEventFiles(clean.bare, 'run-6'));
});

test('interrupted job: killed after writing files, before the commit', () => {
  const { bare, S } = setup('crash-stage');
  const r1 = step(S, startedEvent('run-7', 'retry-then-pass', FIXED_NOW), [], FIXED_NOW);
  const next = r1.json.nextEvent;
  const shaBefore = remoteSha(bare, BRANCH);

  const crashed = step(S, next, ['--crash-point', 'after-stage'], FIXED_NOW);
  assert.equal(crashed.code, 98);
  assert.equal(remoteSha(bare, BRANCH), shaBefore, 'remote unchanged');

  const rerun = step(S, next, [], FIXED_NOW);
  assert.equal(rerun.code, EXIT.OK_CONTINUE);
  assert.equal(rerun.json.classification, 'APPLIED', 'the leftover work tree did not poison the rerun');
  const recs = remoteRecords(bare, 'run-7');
  assert.equal(recs.filter((r) => r.envelope.eventId === next.eventId).length, 1, 'applied exactly once');
});

test('rebuild-snapshot over the git store equals the stored snapshot', () => {
  const { bare, S } = setup('rebuild');
  driveStepwise(S, startedEvent('run-8', 'always-fail'));
  const r = cli(['rebuild-snapshot', ...S, '--run-id', 'run-8']);
  assert.equal(r.code, 0);
  assert.equal(r.json.equal, true);
  assert.equal(r.json.storedSha256, r.json.rebuiltSha256);
  assert.equal(r.json.rebuilt.outcome, 'MAX_ITERATIONS_EXCEEDED');
  assert.equal(r.json.rebuilt.status, 'FAILED');
  // the fold matches what is actually on the branch
  assert.equal(JSON.parse(remoteFile(bare, BRANCH, 'runs/run-8/snapshot.json')).outcome, 'MAX_ITERATIONS_EXCEEDED');
});

test('two runs share one state branch without interfering', () => {
  const { bare, S } = setup('multi');
  driveStepwise(S, startedEvent('run-x', 'retry-then-pass'));
  driveStepwise(S, startedEvent('run-y', 'always-fail'));
  assert.equal(JSON.parse(remoteFile(bare, BRANCH, 'runs/run-x/snapshot.json')).outcome, 'COMPLETED');
  assert.equal(JSON.parse(remoteFile(bare, BRANCH, 'runs/run-y/snapshot.json')).outcome, 'MAX_ITERATIONS_EXCEEDED');
  assert.equal(remoteEventFiles(bare, 'run-x').length, 14);
});

test('a lost compare-and-swap race never half-persists: exit 40 leaves the branch clean', async () => {
  const { root, bare } = setup('exhaust');
  const wd0 = path.join(root, 'wd-0');
  const r1 = step(gitArgs(bare, BRANCH, wd0), startedEvent('run-9', 'retry-then-pass'));
  const completion = r1.json.nextEvent;
  const usage = {
    schemaVersion: 1, eventId: 'evt_exhaust_usage', loopId: 'spike3-review-loop', runId: 'run-9',
    cycle: 1, nodeId: 'observe', attempt: 1, eventType: 'usage-reported',
    result: null, artifactRefs: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    occurredAt: '2026-09-06T00:00:00.000Z', producer: 'test', causationId: null,
  };
  const commitsBefore = remoteCommitCount(bare, BRANCH);

  // --max-push-retries 1 means "one push attempt, no retry": the loser must give up cleanly.
  const barrier = path.join(root, 'barrier-exhaust');
  const wdA = path.join(root, 'wd-a');
  const wdB = path.join(root, 'wd-b');
  const mk = (wd, ev) => cliAsync(['step', ...gitArgs(bare, BRANCH, wd), '--event', JSON.stringify(ev),
    '--barrier-file', barrier, '--max-push-retries', '1']);
  const pa = mk(wdA, completion);
  const pb = mk(wdB, usage);
  const evA = path.join(wdA, 'runs', 'run-9', 'events');
  const evB = path.join(wdB, 'runs', 'run-9', 'events');
  await waitFor(() => fs.existsSync(evA) && fs.readdirSync(evA).length >= 3, 10000, 'A staged');
  await waitFor(() => fs.existsSync(evB) && fs.readdirSync(evB).length >= 3, 10000, 'B staged');
  fs.writeFileSync(barrier, 'go');
  const [ra, rb] = await Promise.all([pa, pb]);

  const winner = [ra, rb].find((r) => r.code === EXIT.OK_CONTINUE);
  const loser = [ra, rb].find((r) => r.code === EXIT.ERR_CONFLICT);
  assert.ok(winner, 'one step won');
  assert.ok(loser, 'the other exhausted its CAS budget and exited 40');
  assert.equal(loser.json.classification, 'CONFLICT');
  assert.equal(loser.json.reason, 'CAS_RETRIES_EXHAUSTED');

  assert.equal(remoteCommitCount(bare, BRANCH), commitsBefore + 1, 'only the winner was persisted');
  const applied = remoteRecords(bare, 'run-9').filter((r) => r.kind === 'applied').map((r) => r.envelope.eventId);
  assert.equal(applied.includes(winner.json.appliedEventId), true);
  // the loser's event left no trace at all - it is safe to redeliver it
  const loserEventId = loser === ra ? completion.eventId : 'evt_exhaust_usage';
  assert.equal(applied.includes(loserEventId), false, 'a failed CAS persists nothing');

  const redelivered = step(gitArgs(bare, BRANCH, wdB), loser === ra ? completion : usage);
  assert.equal(redelivered.json.classification, 'APPLIED', 'redelivery after exit 40 succeeds');
});
