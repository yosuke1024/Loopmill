#!/usr/bin/env node
/**
 * Loopmill SPIKE-3 - event-driven, non-resident control plane step.
 *
 * One invocation == one inbound Envelope event ==
 *   read state -> validate -> apply transition -> decide next node ->
 *   dispatch backend (if needed) -> persist state -> exit.
 *
 * No process stays resident between events. All durable state is event-sourced
 * under runs/<runId>/ in a state store (local directory or a git branch).
 *
 * Node built-ins only. No npm dependencies.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const SCHEMA_VERSION = 1;

/* ------------------------------------------------------------------ *
 * Exit codes (see README for the authoritative table)
 * ------------------------------------------------------------------ */
export const EXIT = {
  OK_CONTINUE: 0,               // event applied, run continues (nextEvent may be dispatched)
  OK_RUN_COMPLETED: 10,         // terminal: outcome COMPLETED
  OK_MAX_ITERATIONS_EXCEEDED: 11, // terminal: outcome MAX_ITERATIONS_EXCEEDED
  OK_RUN_FAILED: 12,            // terminal: outcome NODE_FAILED
  NOOP_DUPLICATE: 20,           // eventId already seen -> nothing written
  NOOP_STALE: 21,               // stale / out-of-order -> recorded as ignored, never applied
  NOOP_TERMINAL: 22,            // run already terminal -> recorded as ignored
  ERR_INVALID_EVENT: 30,        // envelope rejected by validation
  ERR_CONFLICT: 40,             // compare-and-swap push kept losing; state NOT persisted
  ERR_INTERNAL: 50,             // unexpected error
};

export const EXIT_NAME = Object.fromEntries(
  Object.entries(EXIT).map(([k, v]) => [v, k]),
);

/* ------------------------------------------------------------------ *
 * Loop definition (hard-coded for the spike)
 *
 *   observe -> implement -> review -> pass ? end : retry edge -> implement
 *   maxIterations = 3 cycles
 * ------------------------------------------------------------------ */
export const LOOP = {
  loopId: 'spike3-review-loop',
  loopVersion: 1,
  maxIterations: 3,
  entryNodeId: 'observe',
  nodes: {
    observe: { id: 'observe', backend: 'sim/observe', maxAttempts: 2, next: 'implement' },
    implement: { id: 'implement', backend: 'sim/implement', maxAttempts: 2, next: 'review' },
    review: {
      id: 'review',
      backend: 'sim/review',
      maxAttempts: 2,
      next: null, // pass -> end of loop
      retryEdge: { to: 'implement' }, // fail -> back to implement, cycle + 1
    },
  },
};

/* ------------------------------------------------------------------ *
 * Simulated backend: deterministic pass/fail schedules.
 * key = "<nodeId>:<cycle>:<attempt>", default "pass".
 *   pass  -> node succeeded, verdict positive
 *   fail  -> node succeeded, verdict negative (review rejects -> retry edge)
 *   error -> node execution failed (transient) -> node-level retry (attempt + 1)
 * ------------------------------------------------------------------ */
export const SCHEDULES = {
  // exercises node-level retry (attempt 2), the retry edge (cycle 2) and success
  'retry-then-pass': {
    'observe:1:1': 'pass',
    'implement:1:1': 'error',
    'implement:1:2': 'pass',
    'review:1:1': 'fail',
    'implement:2:1': 'pass',
    'review:2:1': 'pass',
  },
  // review never passes -> MAX_ITERATIONS_EXCEEDED after cycle 3
  'always-fail': {
    'review:1:1': 'fail',
    'review:2:1': 'fail',
    'review:3:1': 'fail',
  },
  // node keeps erroring -> NODE_FAILED after maxAttempts
  'node-always-error': {
    'observe:1:1': 'error',
    'observe:1:2': 'error',
  },
  'happy': {},
};

export const DEFAULT_SCHEDULE = 'retry-then-pass';

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */
export function nowIso() {
  return process.env.LOOPMILL_NOW || new Date().toISOString();
}

function sha256hex(s) {
  return createHash('sha256').update(s).digest('hex');
}

export function deterministicEventId(parts) {
  return 'evt_' + sha256hex(parts.map(String).join('|')).slice(0, 24);
}

/** Stable, key-sorted JSON so that byte comparison of snapshots is meaningful. */
export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value), null, 2) + '\n';
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

function pad6(n) {
  return String(n).padStart(6, '0');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * Envelope
 * ------------------------------------------------------------------ */
export const EVENT_TYPES = new Set([
  'run-started',     // inbound  - starts a run
  'node-completed',  // inbound  - a backend reports a node execution result
  'usage-reported',  // inbound  - out-of-band token usage report (order independent)
  'node-dispatched', // emitted  - control plane dispatched a backend
  'run-finished',    // emitted  - control plane closed the run
]);

const INBOUND_TYPES = new Set(['run-started', 'node-completed', 'usage-reported']);

export function makeEnvelope(e) {
  return {
    schemaVersion: SCHEMA_VERSION,
    eventId: e.eventId,
    loopId: e.loopId ?? LOOP.loopId,
    runId: e.runId,
    cycle: e.cycle ?? null,
    nodeId: e.nodeId ?? null,
    attempt: e.attempt ?? null,
    eventType: e.eventType,
    result: e.result ?? null,
    artifactRefs: e.artifactRefs ?? [],
    usage: e.usage ?? null,
    occurredAt: e.occurredAt ?? nowIso(),
    producer: e.producer ?? 'unknown',
    causationId: e.causationId ?? null,
    params: e.params ?? null,
    reason: e.reason ?? null,
  };
}

export function validateEnvelope(env) {
  if (!env || typeof env !== 'object') return { ok: false, reason: 'ENVELOPE_NOT_AN_OBJECT' };
  if (env.schemaVersion !== SCHEMA_VERSION) return { ok: false, reason: 'UNSUPPORTED_SCHEMA_VERSION' };
  for (const f of ['eventId', 'runId', 'loopId', 'eventType']) {
    if (typeof env[f] !== 'string' || env[f].length === 0) {
      return { ok: false, reason: `MISSING_FIELD:${f}` };
    }
  }
  if (!EVENT_TYPES.has(env.eventType)) return { ok: false, reason: 'UNKNOWN_EVENT_TYPE' };
  if (!INBOUND_TYPES.has(env.eventType)) return { ok: false, reason: 'NOT_AN_INBOUND_EVENT' };
  if (env.loopId !== LOOP.loopId) return { ok: false, reason: 'UNKNOWN_LOOP' };
  if (env.eventType === 'node-completed') {
    if (!LOOP.nodes[env.nodeId]) return { ok: false, reason: 'UNKNOWN_NODE' };
    if (!Number.isInteger(env.cycle) || env.cycle < 1) return { ok: false, reason: 'BAD_CYCLE' };
    if (!Number.isInteger(env.attempt) || env.attempt < 1) return { ok: false, reason: 'BAD_ATTEMPT' };
    const st = env.result && env.result.status;
    if (!['pass', 'fail', 'error'].includes(st)) return { ok: false, reason: 'BAD_RESULT_STATUS' };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Event records on disk
 *   runs/<runId>/events/<seq>-<name>.json
 *
 *   kind: applied  - an inbound event that changed state
 *         emitted  - an event produced by the control plane in the same step
 *         ignored  - an inbound event deliberately NOT applied (audit trail)
 * ------------------------------------------------------------------ */
function makeRecord({ seq, kind, envelope, reason = null, recordedAt }) {
  return { schemaVersion: SCHEMA_VERSION, seq, kind, reason, recordedAt, envelope };
}

function recordFileName(rec) {
  const label = rec.kind === 'ignored' ? `ignored-${rec.envelope.eventType}` : rec.envelope.eventType;
  return `${pad6(rec.seq)}-${label}.json`;
}

/* ------------------------------------------------------------------ *
 * fold: events -> snapshot  (pure; snapshot.json is only a cache)
 * ------------------------------------------------------------------ */
export function foldEvents(records) {
  const snap = {
    schemaVersion: SCHEMA_VERSION,
    runId: null,
    loopId: null,
    loopVersion: null,
    schedule: null,
    status: 'PENDING', // PENDING | RUNNING | SUCCEEDED | FAILED
    outcome: null,     // null | COMPLETED | MAX_ITERATIONS_EXCEEDED | NODE_FAILED
    cycle: 0,
    maxIterations: LOOP.maxIterations,
    iterations: 0,     // retry-edge traversals
    current: null,     // { nodeId, cycle, attempt, state }
    completed: [],
    lastSeq: 0,
    seenEventIds: [],  // idempotency index: applied + ignored inbound eventIds
    appliedEventIds: [],
    emittedEventIds: [],
    ignored: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    startedAt: null,
    updatedAt: null,
    finishedAt: null,
  };

  for (const rec of records) {
    const env = rec.envelope;
    snap.lastSeq = rec.seq;
    snap.updatedAt = rec.recordedAt;

    if (rec.kind === 'ignored') {
      snap.seenEventIds.push(env.eventId);
      snap.ignored.push({ seq: rec.seq, eventId: env.eventId, eventType: env.eventType, reason: rec.reason });
      continue;
    }
    if (rec.kind === 'applied') {
      snap.seenEventIds.push(env.eventId);
      snap.appliedEventIds.push(env.eventId);
    } else {
      snap.emittedEventIds.push(env.eventId);
    }

    switch (env.eventType) {
      case 'run-started': {
        snap.runId = env.runId;
        snap.loopId = env.loopId;
        snap.loopVersion = LOOP.loopVersion;
        snap.schedule = (env.params && env.params.schedule) || DEFAULT_SCHEDULE;
        snap.status = 'RUNNING';
        snap.cycle = 1;
        snap.startedAt = env.occurredAt;
        break;
      }
      case 'node-dispatched': {
        snap.cycle = env.cycle;
        snap.current = { nodeId: env.nodeId, cycle: env.cycle, attempt: env.attempt, state: 'RUNNING' };
        if (env.reason === 'retry-edge') snap.iterations += 1;
        break;
      }
      case 'node-completed': {
        const state =
          env.result.status === 'pass' ? 'SUCCEEDED'
            : env.result.status === 'fail' ? 'REJECTED'
              : 'FAILED';
        snap.current = { nodeId: env.nodeId, cycle: env.cycle, attempt: env.attempt, state };
        snap.completed.push({
          seq: rec.seq, nodeId: env.nodeId, cycle: env.cycle, attempt: env.attempt,
          status: env.result.status,
        });
        addUsage(snap.usage, env.usage);
        break;
      }
      case 'usage-reported': {
        addUsage(snap.usage, env.usage);
        break;
      }
      case 'run-finished': {
        snap.outcome = env.result.outcome;
        snap.status = env.result.outcome === 'COMPLETED' ? 'SUCCEEDED' : 'FAILED';
        snap.finishedAt = env.occurredAt;
        break;
      }
      default:
        throw new Error(`fold: unhandled eventType ${env.eventType}`);
    }
  }
  return snap;
}

function addUsage(total, usage) {
  if (!usage) return;
  total.inputTokens += usage.inputTokens || 0;
  total.outputTokens += usage.outputTokens || 0;
  total.totalTokens += usage.totalTokens || 0;
}

export function isTerminal(snap) {
  return snap.status === 'SUCCEEDED' || snap.status === 'FAILED';
}

/* ------------------------------------------------------------------ *
 * Simulated backend
 * ------------------------------------------------------------------ */
export function simulateBackend(dispatchEnv, scheduleId) {
  const table = SCHEDULES[scheduleId] || SCHEDULES[DEFAULT_SCHEDULE];
  const key = `${dispatchEnv.nodeId}:${dispatchEnv.cycle}:${dispatchEnv.attempt}`;
  const status = table[key] || 'pass';
  const seed = sha256hex(key + '|' + dispatchEnv.runId);
  const inputTokens = 1000 + (parseInt(seed.slice(0, 4), 16) % 500);
  const outputTokens = 200 + (parseInt(seed.slice(4, 8), 16) % 300);
  return makeEnvelope({
    eventId: deterministicEventId([dispatchEnv.runId, 'node-completed', dispatchEnv.cycle, dispatchEnv.nodeId, dispatchEnv.attempt]),
    loopId: dispatchEnv.loopId,
    runId: dispatchEnv.runId,
    cycle: dispatchEnv.cycle,
    nodeId: dispatchEnv.nodeId,
    attempt: dispatchEnv.attempt,
    eventType: 'node-completed',
    result: {
      status,
      exitCode: status === 'error' ? 1 : 0,
      summary: `simulated ${dispatchEnv.nodeId} -> ${status}`,
    },
    artifactRefs: [`sim://${dispatchEnv.runId}/${dispatchEnv.nodeId}/c${dispatchEnv.cycle}a${dispatchEnv.attempt}`],
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, source: 'simulated' },
    producer: LOOP.nodes[dispatchEnv.nodeId].backend,
    causationId: dispatchEnv.eventId,
  });
}

/* ------------------------------------------------------------------ *
 * Decision: given the post-apply snapshot, what happens next?
 * ------------------------------------------------------------------ */
function decide(snap, appliedEnv) {
  if (appliedEnv.eventType === 'run-started') {
    return { action: 'dispatch', nodeId: LOOP.entryNodeId, cycle: 1, attempt: 1, reason: 'entry' };
  }
  if (appliedEnv.eventType === 'usage-reported') {
    return { action: 'none' };
  }
  // node-completed
  const node = LOOP.nodes[appliedEnv.nodeId];
  const status = appliedEnv.result.status;
  const cycle = appliedEnv.cycle;
  const attempt = appliedEnv.attempt;

  if (status === 'error') {
    if (attempt < node.maxAttempts) {
      return { action: 'dispatch', nodeId: node.id, cycle, attempt: attempt + 1, reason: 'node-retry' };
    }
    return { action: 'finish', outcome: 'NODE_FAILED' };
  }
  if (status === 'pass') {
    if (node.next) return { action: 'dispatch', nodeId: node.next, cycle, attempt: 1, reason: 'edge' };
    return { action: 'finish', outcome: 'COMPLETED' };
  }
  // status === 'fail'
  if (node.retryEdge) {
    const nextCycle = cycle + 1;
    if (nextCycle > LOOP.maxIterations) {
      return { action: 'finish', outcome: 'MAX_ITERATIONS_EXCEEDED' };
    }
    return { action: 'dispatch', nodeId: node.retryEdge.to, cycle: nextCycle, attempt: 1, reason: 'retry-edge' };
  }
  return { action: 'finish', outcome: 'NODE_FAILED' };
}

/* ------------------------------------------------------------------ *
 * planStep: PURE. (existing records, inbound envelope) -> plan
 * ------------------------------------------------------------------ */
export function planStep({ records, envelope, recordedAt }) {
  const before = foldEvents(records);
  const at = recordedAt || nowIso();

  const v = validateEnvelope(envelope);
  if (!v.ok) {
    return { classification: 'INVALID', reason: v.reason, exitCode: EXIT.ERR_INVALID_EVENT, persist: false, snapshot: before, nextEvent: null };
  }

  // 1. idempotency: same eventId delivered twice is a strict no-op.
  if (before.seenEventIds.includes(envelope.eventId)) {
    return { classification: 'DUPLICATE', reason: 'EVENT_ALREADY_SEEN', exitCode: EXIT.NOOP_DUPLICATE, persist: false, snapshot: before, nextEvent: null };
  }

  const hasRun = records.length > 0;

  if (envelope.eventType === 'run-started') {
    if (hasRun) {
      return ignoredPlan(records, before, envelope, at, 'RUN_ALREADY_STARTED', EXIT.NOOP_STALE);
    }
  } else {
    if (!hasRun) {
      return { classification: 'INVALID', reason: 'UNKNOWN_RUN', exitCode: EXIT.ERR_INVALID_EVENT, persist: false, snapshot: before, nextEvent: null };
    }
    if (envelope.runId !== before.runId) {
      return { classification: 'INVALID', reason: 'RUN_ID_MISMATCH', exitCode: EXIT.ERR_INVALID_EVENT, persist: false, snapshot: before, nextEvent: null };
    }
    if (isTerminal(before)) {
      return ignoredPlan(records, before, envelope, at, 'RUN_ALREADY_TERMINAL', EXIT.NOOP_TERMINAL);
    }
    if (envelope.eventType === 'node-completed') {
      const cur = before.current;
      if (!cur || cur.state !== 'RUNNING') {
        return ignoredPlan(records, before, envelope, at, 'NO_NODE_IN_FLIGHT', EXIT.NOOP_STALE);
      }
      if (cur.nodeId !== envelope.nodeId || cur.cycle !== envelope.cycle) {
        return ignoredPlan(records, before, envelope, at, 'NOT_CURRENT_NODE', EXIT.NOOP_STALE);
      }
      if (cur.attempt !== envelope.attempt) {
        // completion for an attempt that has already been superseded
        return ignoredPlan(records, before, envelope, at, 'STALE_ATTEMPT', EXIT.NOOP_STALE);
      }
    }
  }

  // 2. apply
  const newRecords = [];
  let seq = before.lastSeq;
  const applied = makeRecord({ seq: ++seq, kind: 'applied', envelope, recordedAt: at });
  newRecords.push(applied);

  const afterApply = foldEvents([...records, ...newRecords]);
  const decision = decide(afterApply, envelope);

  let nextEvent = null;
  if (decision.action === 'dispatch') {
    const dispatchEnv = makeEnvelope({
      eventId: deterministicEventId([envelope.runId, 'node-dispatched', decision.cycle, decision.nodeId, decision.attempt]),
      loopId: envelope.loopId,
      runId: envelope.runId,
      cycle: decision.cycle,
      nodeId: decision.nodeId,
      attempt: decision.attempt,
      eventType: 'node-dispatched',
      result: { backend: LOOP.nodes[decision.nodeId].backend },
      occurredAt: at,
      producer: 'loopmill/step',
      causationId: envelope.eventId,
      reason: decision.reason,
    });
    newRecords.push(makeRecord({ seq: ++seq, kind: 'emitted', envelope: dispatchEnv, recordedAt: at }));
    nextEvent = simulateBackend(dispatchEnv, afterApply.schedule);
    nextEvent.occurredAt = at;
  } else if (decision.action === 'finish') {
    const finishEnv = makeEnvelope({
      eventId: deterministicEventId([envelope.runId, 'run-finished', decision.outcome, afterApply.cycle]),
      loopId: envelope.loopId,
      runId: envelope.runId,
      cycle: afterApply.cycle,
      eventType: 'run-finished',
      result: { outcome: decision.outcome },
      occurredAt: at,
      producer: 'loopmill/step',
      causationId: envelope.eventId,
    });
    newRecords.push(makeRecord({ seq: ++seq, kind: 'emitted', envelope: finishEnv, recordedAt: at }));
  }

  const snapshot = foldEvents([...records, ...newRecords]);
  const exitCode =
    decision.action !== 'finish' ? EXIT.OK_CONTINUE
      : decision.outcome === 'COMPLETED' ? EXIT.OK_RUN_COMPLETED
        : decision.outcome === 'MAX_ITERATIONS_EXCEEDED' ? EXIT.OK_MAX_ITERATIONS_EXCEEDED
          : EXIT.OK_RUN_FAILED;

  const files = [];
  if (envelope.eventType === 'run-started') {
    files.push({
      relPath: `runs/${envelope.runId}/run.json`,
      content: canonicalJson({
        schemaVersion: SCHEMA_VERSION,
        runId: envelope.runId,
        loopId: envelope.loopId,
        loopVersion: LOOP.loopVersion,
        maxIterations: LOOP.maxIterations,
        schedule: snapshot.schedule,
        createdAt: envelope.occurredAt,
        startedByEventId: envelope.eventId,
        params: envelope.params || {},
      }),
    });
  }
  for (const rec of newRecords) {
    files.push({ relPath: `runs/${envelope.runId}/events/${recordFileName(rec)}`, content: canonicalJson(rec) });
  }
  files.push({ relPath: `runs/${envelope.runId}/snapshot.json`, content: canonicalJson(snapshot) });

  return {
    classification: 'APPLIED',
    reason: decision.action === 'finish' ? decision.outcome : decision.reason || 'APPLIED',
    exitCode,
    persist: true,
    files,
    newRecords,
    snapshot,
    nextEvent,
    outcome: decision.action === 'finish' ? decision.outcome : null,
    commitMessage: commitMessage(envelope, newRecords, decision),
  };
}

function ignoredPlan(records, before, envelope, at, reason, exitCode) {
  const seq = before.lastSeq + 1;
  const rec = makeRecord({ seq, kind: "ignored", envelope, reason, recordedAt: at });
  const snapshot = foldEvents([...records, rec]);
  const files = [
    { relPath: `runs/${before.runId}/events/${recordFileName(rec)}`, content: canonicalJson(rec) },
    { relPath: `runs/${before.runId}/snapshot.json`, content: canonicalJson(snapshot) },
  ];
  const classification = exitCode === EXIT.NOOP_TERMINAL ? "TERMINAL" : "STALE";
  return {
    classification,
    reason,
    exitCode,
    persist: true,
    files,
    newRecords: [rec],
    snapshot,
    nextEvent: null,
    outcome: snapshot.outcome,
    commitMessage: commitMessage(envelope, [rec], null),
  };
}

function commitMessage(envelope, newRecords, decision) {
  const head = `loopmill: ${envelope.eventType} ${envelope.runId}` +
    (envelope.nodeId ? ` ${envelope.nodeId}#c${envelope.cycle}a${envelope.attempt}` : '') +
    ` (eventId=${envelope.eventId})`;
  const lines = [head, ''];
  for (const r of newRecords) {
    lines.push(`${r.kind}: seq=${r.seq} ${r.envelope.eventType} eventId=${r.envelope.eventId}` + (r.reason ? ` reason=${r.reason}` : ''));
  }
  lines.push(`decision: ${decision ? decision.action : 'none'}${decision && decision.outcome ? ' ' + decision.outcome : ''}`);
  return lines.join('\n') + '\n';
}

/* ------------------------------------------------------------------ *
 * State store abstraction
 *
 *   begin(runId)  -> view { dir, baseRef, records }   (read current state)
 *   publish(view) -> { ok, head, reason }             (persist, CAS)
 *
 * The step never mutates state in place: it reads, plans purely, writes the
 * whole file set, and then tries to publish. A lost CAS simply re-reads and
 * re-plans, so the retry is safe by construction.
 * ------------------------------------------------------------------ */

export function writeFiles(dir, files) {
  for (const f of files) {
    const abs = path.join(dir, f.relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.content);
  }
}

export function readRecords(dir, runId) {
  const evDir = path.join(dir, 'runs', runId, 'events');
  if (!fs.existsSync(evDir)) return [];
  const names = fs.readdirSync(evDir).filter((n) => n.endsWith('.json'));
  const recs = names.map((n) => JSON.parse(fs.readFileSync(path.join(evDir, n), 'utf8')));
  recs.sort((a, b) => a.seq - b.seq);
  return recs;
}

export function readSnapshot(dir, runId) {
  const p = path.join(dir, 'runs', runId, 'snapshot.json');
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

export class LocalStore {
  constructor({ dir }) {
    this.kind = 'local';
    this.dir = dir;
  }
  async begin(runId) {
    fs.mkdirSync(this.dir, { recursive: true });
    return { dir: this.dir, baseRef: null, records: readRecords(this.dir, runId) };
  }
  async publish() {
    return { ok: true, head: null };
  }
}

function git(cwd, args, { check = false } = {}) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true' },
  });
  const out = { code: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
  if (check && out.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${out.code}): ${out.stderr || out.stdout}`);
  }
  return out;
}

const PUSH_REJECTED = /rejected|stale info|non-fast-forward|fetch first|cannot lock ref|failed to push/i;

export class GitStore {
  constructor({ remote, branch, workdir, identity = {} }) {
    this.kind = 'git';
    this.remote = remote;
    this.branch = branch;
    this.workdir = workdir;
    this.name = identity.name || 'loopmill-step';
    this.email = identity.email || 'loopmill-step@users.noreply.github.com';
  }

  _ensureRepo() {
    const repo = this.workdir;
    if (!fs.existsSync(path.join(repo, '.git'))) {
      fs.mkdirSync(repo, { recursive: true });
      git(repo, ['init', '-q', '-b', this.branch], { check: true });
    }
    const cur = git(repo, ['remote', 'get-url', 'origin']);
    if (cur.code !== 0) git(repo, ['remote', 'add', 'origin', this.remote], { check: true });
    else if (cur.stdout !== this.remote) git(repo, ['remote', 'set-url', 'origin', this.remote], { check: true });
    return repo;
  }

  async begin(runId) {
    const repo = this._ensureRepo();
    const refspec = `+refs/heads/${this.branch}:refs/remotes/origin/${this.branch}`;
    const fetched = git(repo, ['fetch', '-q', '--no-tags', 'origin', refspec]);
    git(repo, ['symbolic-ref', 'HEAD', `refs/heads/${this.branch}`], { check: true });

    let baseRef = null;
    if (fetched.code === 0) {
      baseRef = git(repo, ['rev-parse', `refs/remotes/origin/${this.branch}`], { check: true }).stdout;
      // discard anything left behind by a crashed step and align with the remote
      git(repo, ['reset', '-q', '--hard', baseRef], { check: true });
    } else {
      // branch does not exist on the remote yet -> start an orphan branch
      git(repo, ['update-ref', '-d', `refs/heads/${this.branch}`]);
      git(repo, ['read-tree', '--empty'], { check: true });
    }
    git(repo, ['clean', '-qfdx']);
    return { dir: repo, baseRef, records: readRecords(repo, runId) };
  }

  async publish(view, message, opts = {}) {
    const repo = view.dir;
    git(repo, ['add', '-A'], { check: true });
    git(repo, ['-c', `user.name=${this.name}`, '-c', `user.email=${this.email}`,
      '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message], { check: true });

    if (opts.crashPoint === 'after-commit') {
      process.stderr.write('[fault-injection] exiting after local commit, before push\n');
      process.exit(97);
    }

    const args = ['push', '-q'];
    if (view.baseRef) args.push(`--force-with-lease=refs/heads/${this.branch}:${view.baseRef}`);
    args.push('origin', `HEAD:refs/heads/${this.branch}`);
    const res = git(repo, args);
    if (res.code === 0) {
      return { ok: true, head: git(repo, ['rev-parse', 'HEAD'], { check: true }).stdout };
    }
    const text = `${res.stderr}\n${res.stdout}`;
    if (PUSH_REJECTED.test(text)) return { ok: false, reason: 'CAS_REJECTED', detail: text.trim() };
    throw new Error(`git push failed unexpectedly: ${text.trim()}`);
  }
}

/* ------------------------------------------------------------------ *
 * The step itself: read -> plan -> write -> compare-and-swap -> exit
 * ------------------------------------------------------------------ */
async function waitForBarrier(file, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`barrier ${file} not released in time`);
    await sleep(5);
  }
}

export async function executeStep(store, envelope, opts = {}) {
  const t0 = Date.now();
  const maxPushRetries = opts.maxPushRetries ?? 5;
  let conflicts = 0;
  let pushAttempts = 0;
  let lastDetail = null;

  for (let attempt = 1; attempt <= maxPushRetries; attempt++) {
    const view = await store.begin(envelope.runId);
    const plan = planStep({ records: view.records, envelope, recordedAt: nowIso() });

    if (!plan.persist) {
      return finalize(plan, { pushAttempts, conflicts, head: view.baseRef, t0, planAttempts: attempt });
    }

    writeFiles(view.dir, plan.files);
    if (opts.crashPoint === 'after-stage') {
      process.stderr.write('[fault-injection] exiting after writing files, before commit/push\n');
      process.exit(98);
    }
    if (opts.barrierFile && attempt === 1) await waitForBarrier(opts.barrierFile);

    pushAttempts += 1;
    const res = await store.publish(view, plan.commitMessage, opts);
    if (res.ok) {
      return finalize(plan, { pushAttempts, conflicts, head: res.head, t0, planAttempts: attempt });
    }
    conflicts += 1;
    lastDetail = res.detail || res.reason;
    await sleep(20 + Math.floor(Math.random() * 60));
  }

  return {
    ok: false,
    classification: 'CONFLICT',
    reason: 'CAS_RETRIES_EXHAUSTED',
    detail: lastDetail,
    exitCode: EXIT.ERR_CONFLICT,
    runId: envelope.runId,
    pushAttempts,
    conflicts,
    nextEvent: null,
    durationMs: Date.now() - t0,
  };
}

function finalize(plan, meta) {
  return {
    ok: plan.exitCode < EXIT.ERR_INVALID_EVENT,
    classification: plan.classification,
    reason: plan.reason,
    exitCode: plan.exitCode,
    exitName: EXIT_NAME[plan.exitCode],
    runId: plan.snapshot ? plan.snapshot.runId : null,
    appliedEventId: plan.classification === 'APPLIED' ? plan.newRecords[0].envelope.eventId : null,
    written: plan.files ? plan.files.map((f) => f.relPath) : [],
    emitted: plan.newRecords ? plan.newRecords.filter((r) => r.kind === 'emitted').map((r) => r.envelope.eventId) : [],
    outcome: plan.outcome ?? (plan.snapshot ? plan.snapshot.outcome : null),
    terminal: plan.snapshot ? isTerminal(plan.snapshot) : false,
    snapshot: plan.snapshot,
    nextEvent: plan.nextEvent,
    head: meta.head,
    pushAttempts: meta.pushAttempts,
    conflicts: meta.conflicts,
    planAttempts: meta.planAttempts,
    durationMs: Date.now() - meta.t0,
  };
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */
export function startedEnvelope({ runId, schedule = DEFAULT_SCHEDULE, loopId = LOOP.loopId }) {
  return makeEnvelope({
    eventId: deterministicEventId([runId, 'run-started']),
    loopId,
    runId,
    eventType: 'run-started',
    params: { schedule },
    producer: 'loopmill/cli',
  });
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inlineV] = a.slice(2).split(/=(.*)/s);
      const key = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (inlineV !== undefined) out[key] = inlineV;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) out[key] = argv[++i];
      else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

function makeStore(args) {
  const kind = args.store || 'local';
  if (kind === 'local') {
    if (!args.dir) throw new Error('--dir is required for --store local');
    return new LocalStore({ dir: path.resolve(args.dir) });
  }
  if (kind === 'git') {
    if (!args.remote) throw new Error('--remote is required for --store git');
    return new GitStore({
      remote: args.remote,
      branch: args.branch || 'loopmill/state-spike',
      workdir: path.resolve(args.workdir || path.join(process.cwd(), '.loopmill-workdir')),
    });
  }
  throw new Error(`unknown store: ${kind}`);
}

function loadEvent(args) {
  let raw = args.event;
  if (args.eventFile) raw = fs.readFileSync(args.eventFile, 'utf8');
  else if (raw === '-') raw = fs.readFileSync(0, 'utf8');
  else if (typeof raw === 'string' && raw.startsWith('@')) raw = fs.readFileSync(raw.slice(1), 'utf8');
  if (!raw || raw === true) throw new Error('--event <json> | --event-file <path> | --event - is required');
  return JSON.parse(raw);
}

function stepOpts(args) {
  return {
    maxPushRetries: args.maxPushRetries ? Number(args.maxPushRetries) : 5,
    crashPoint: args.crashPoint || process.env.LOOPMILL_CRASH_POINT || null,
    barrierFile: args.barrierFile || process.env.LOOPMILL_BARRIER_FILE || null,
  };
}

async function cmdStep(args) {
  const store = makeStore(args);
  const envelope = loadEvent(args);
  const res = await executeStep(store, envelope, stepOpts(args));
  process.stdout.write(JSON.stringify(res, null, 2) + '\n');
  process.stderr.write(
    `[step] ${res.classification} ${res.reason} exit=${res.exitCode}(${res.exitName || ''}) ` +
    `pushAttempts=${res.pushAttempts} conflicts=${res.conflicts} ${res.durationMs}ms\n`,
  );
  return res.exitCode;
}

async function cmdDrive(args) {
  const store = makeStore(args);
  const runId = args.runId || `run-${Date.now()}`;
  const schedule = args.schedule || DEFAULT_SCHEDULE;
  const maxSteps = Number(args.maxSteps || 12);
  let event = startedEnvelope({ runId, schedule });
  const steps = [];
  let last = null;
  for (let i = 0; i < maxSteps && event; i++) {
    const res = await executeStep(store, event, stepOpts(args));
    steps.push({
      n: i + 1,
      eventType: event.eventType,
      eventId: event.eventId,
      classification: res.classification,
      reason: res.reason,
      exitCode: res.exitCode,
      pushAttempts: res.pushAttempts,
      conflicts: res.conflicts,
      durationMs: res.durationMs,
    });
    last = res;
    if (res.terminal || !res.nextEvent) break;
    event = res.nextEvent;
  }
  const out = {
    runId,
    schedule,
    steps,
    stepCount: steps.length,
    hitStepCap: steps.length >= maxSteps && last && !last.terminal,
    outcome: last ? last.outcome : null,
    terminal: last ? last.terminal : false,
    snapshot: last ? last.snapshot : null,
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  return last ? last.exitCode : EXIT.ERR_INTERNAL;
}

async function cmdRebuildSnapshot(args) {
  const store = makeStore(args);
  const runId = args.runId;
  if (!runId) throw new Error('--run-id is required');
  const view = await store.begin(runId);
  if (view.records.length === 0) throw new Error(`no events for run ${runId}`);
  const rebuilt = canonicalJson(foldEvents(view.records));
  const stored = readSnapshot(view.dir, runId);
  const equal = stored !== null && stored === rebuilt;
  const out = {
    runId,
    eventCount: view.records.length,
    storedSnapshotPresent: stored !== null,
    equal,
    rebuiltSha256: sha256hex(rebuilt),
    storedSha256: stored === null ? null : sha256hex(stored),
    rebuilt: JSON.parse(rebuilt),
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  if (!equal) {
    process.stderr.write('[rebuild-snapshot] MISMATCH between folded events and stored snapshot.json\n');
    return 1;
  }
  process.stderr.write(`[rebuild-snapshot] OK - snapshot.json is reproducible from ${view.records.length} events\n`);
  return 0;
}

async function cmdShow(args) {
  const store = makeStore(args);
  const runId = args.runId;
  if (!runId) throw new Error('--run-id is required');
  const view = await store.begin(runId);
  process.stdout.write(JSON.stringify({
    runId,
    events: view.records.map((r) => ({ seq: r.seq, kind: r.kind, type: r.envelope.eventType, eventId: r.envelope.eventId, reason: r.reason })),
    snapshot: foldEvents(view.records),
  }, null, 2) + '\n');
  return 0;
}

function cmdStarted(args) {
  const runId = args.runId || `run-${Date.now()}`;
  process.stdout.write(JSON.stringify(startedEnvelope({ runId, schedule: args.schedule || DEFAULT_SCHEDULE })) + '\n');
  return 0;
}

const USAGE = `loopmill step (SPIKE-3)

  step               --event <json>|--event-file <p>|--event -   apply one inbound event
  drive              --run-id <id> [--schedule <id>] [--max-steps N]
  rebuild-snapshot   --run-id <id>        fold events and compare with snapshot.json
  show               --run-id <id>
  started-event      --run-id <id> [--schedule <id>]

Store selection:
  --store local --dir <path>
  --store git   --remote <url> --branch <branch> --workdir <path>

Fault injection (tests): --crash-point after-stage|after-commit  --barrier-file <path>

Exit codes: 0 continue | 10 completed | 11 max-iterations | 12 run-failed
            20 duplicate | 21 stale | 22 terminal
            30 invalid | 40 cas-conflict | 50 internal
`;

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const cmd = args._[0];
  try {
    switch (cmd) {
      case 'step': return await cmdStep(args);
      case 'drive': return await cmdDrive(args);
      case 'rebuild-snapshot': return await cmdRebuildSnapshot(args);
      case 'show': return await cmdShow(args);
      case 'started-event': return cmdStarted(args);
      default:
        process.stdout.write(USAGE);
        return cmd ? EXIT.ERR_INTERNAL : 0;
    }
  } catch (err) {
    process.stderr.write(`[step] internal error: ${err && err.stack ? err.stack : err}\n`);
    process.stdout.write(JSON.stringify({ ok: false, classification: 'ERROR', reason: String(err && err.message || err), exitCode: EXIT.ERR_INTERNAL }) + '\n');
    return EXIT.ERR_INTERNAL;
  }
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname);
if (isMain) {
  main().then((code) => process.exit(code));
}
