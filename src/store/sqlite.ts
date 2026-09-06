// The SQLite store: `runs` (immutable headers), `events` (the append-only, hash-chained
// journal), `snapshots` (the fold, rebuildable), `attempts` (usage/refs, insert-only) and
// `locks` (one row per active Run: owner pid, host, heartbeat, lease). Transcribed from
// docs/design/mvp-design.md §7.4-§7.5, §9, §13.4 and docs/spec/state-machine.md §10, D-29, D-30.
//
// Uses `node:sqlite`'s `DatabaseSync`. It logs an `ExperimentalWarning` on import — that is left
// to whichever process imports this module (the CLI entry point, or a test runner) to see and
// accept; this module does not suppress it, per this milestone's own instruction not to hide an
// upstream experimental-API warning from the operator.
//
// Every `StateStore` method here is synchronous, not `Promise`-returning — see the decision
// note at the top of `src/types/interfaces.ts` for why (in short: `DatabaseSync` already is,
// and every method body is one transaction that must not yield mid-flight).

import { DatabaseSync } from "node:sqlite";
import type { SQLOutputValue } from "node:sqlite";
import { hostname } from "node:os";

import { canonicalJson, parseJson } from "../util/canonical-json.ts";
import { sha256Hex } from "../util/hash.ts";
import { parseRfc3339 } from "../util/time.ts";
import { looksLikeCredential } from "../util/redact.ts";
import { LoopmillError } from "../util/errors.ts";
import type { Envelope } from "../types/envelope.ts";
import type { AttemptRecord, Outcome, RunSnapshot, RunState } from "../types/state.ts";
import type {
  AppendInput,
  AppendResult,
  LeaseExpired,
  LockHolder,
  StateStore,
} from "../types/interfaces.ts";

// -------------------------------------------------------------------------------------------
// Row helpers. node:sqlite hands back `Record<string, SQLOutputValue>` (SQLOutputValue = null |
// number | bigint | string | Uint8Array); these narrow a column to the JS type its declared SQL
// type always produces here, throwing loudly (rather than silently coercing) on a shape this
// store never itself writes — evidence of a corrupt or hand-edited database file.
// -------------------------------------------------------------------------------------------

type SqlRow = Record<string, SQLOutputValue>;

function corrupt(column: string, expected: string, row: SqlRow): never {
  throw new LoopmillError(
    "store_corrupt_row",
    `expected column ${column} to be ${expected}, got ${JSON.stringify(row[column])}`,
  );
}

function textCol(row: SqlRow, column: string): string {
  const v = row[column];
  if (typeof v !== "string") return corrupt(column, "text", row);
  return v;
}

function textOrNullCol(row: SqlRow, column: string): string | null {
  const v = row[column];
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return corrupt(column, "text or null", row);
  return v;
}

function intCol(row: SqlRow, column: string): number {
  const v = row[column];
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  return corrupt(column, "an integer", row);
}

// -------------------------------------------------------------------------------------------
// The envelope wire form this store persists. Identical to `util/canonical-json.ts`'s
// `canonicalJson` (recursively key-sorted, 2-space indent, trailing newline) at every nesting
// level except the root: the root object's `schemaVersion` key is placed first rather than
// falling wherever it sorts alphabetically, matching the convention docs/design/mvp-design.md
// §8.2 already names for a GitHub handoff comment's fenced block ("schemaVersion first, parsed
// strictly"). `canonical-json.ts`'s recursive renderer is not exported (deliberately: it is
// private to that module), so it is duplicated here rather than imported, as instructed. This
// is a stopgap: `src/envelope/wire.ts`, this milestone's normative owner of the wire form, is
// being written concurrently by another module; once it exists, `append` below should call it
// instead of `envelopeJson`.
// -------------------------------------------------------------------------------------------

function renderCanonical(value: unknown, indent: number): string {
  if (value === undefined) {
    throw new LoopmillError("canonical_json_unsupported", "undefined is not representable in canonical JSON");
  }
  if (value === null) return "null";
  const type = typeof value;
  if (type === "boolean") return String(value);
  if (type === "number") {
    const n = value as number;
    if (!Number.isFinite(n)) {
      throw new LoopmillError("canonical_json_unsupported", `${String(n)} is not representable in canonical JSON`);
    }
    return String(n);
  }
  if (type === "string") return JSON.stringify(value);
  if (type === "function" || type === "symbol" || type === "bigint") {
    throw new LoopmillError(
      "canonical_json_unsupported",
      `values of type ${type} are not representable in canonical JSON`,
    );
  }
  if (Array.isArray(value)) return renderCanonicalArray(value, indent);
  return renderCanonicalObject(value as Record<string, unknown>, indent);
}

function renderCanonicalArray(items: unknown[], indent: number): string {
  if (items.length === 0) return "[]";
  const innerIndent = indent + 1;
  const pad = "  ".repeat(innerIndent);
  const closePad = "  ".repeat(indent);
  const body = items.map((item) => pad + renderCanonical(item, innerIndent)).join(",\n");
  return `[\n${body}\n${closePad}]`;
}

function renderCanonicalObject(obj: Record<string, unknown>, indent: number, keyOrder?: string[]): string {
  const keys = keyOrder ?? Object.keys(obj).sort();
  if (keys.length === 0) return "{}";
  const innerIndent = indent + 1;
  const pad = "  ".repeat(innerIndent);
  const closePad = "  ".repeat(indent);
  const body = keys
    .map((key) => `${pad}${JSON.stringify(key)}: ${renderCanonical(obj[key], innerIndent)}`)
    .join(",\n");
  return `{\n${body}\n${closePad}}`;
}

function envelopeJson(envelope: Envelope): string {
  const record = envelope as unknown as Record<string, unknown>;
  if (record.schemaVersion === undefined) {
    throw new LoopmillError("canonical_json_unsupported", "envelope is missing schemaVersion");
  }
  const keyOrder = ["schemaVersion", ...Object.keys(record).filter((k) => k !== "schemaVersion").sort()];
  return `${renderCanonicalObject(record, 0, keyOrder)}\n`;
}

// -------------------------------------------------------------------------------------------
// Redaction: the store's last-line defence (mvp-design.md §13.4). Decision (not in sheet):
// callers (envelope/, engine/, backends/ — wherever a stream is captured or a payload is built)
// are responsible for running `redact` from `util/redact.ts` on every free-text field *before*
// calling `append`; this store never transforms the text it is given. Two reasons: (1) applying
// `redact` here would risk `rebuildSnapshot`'s byte-for-byte equality (P-8) diverging if the
// redaction rules are ever revised after a record was written — a rebuild must reproduce
// exactly the bytes this store stored, not a re-redacted version of them; (2) redaction is
// specified as a persistence-time transform at the point a stream is captured (§13.4), which is
// upstream of the store. What this store *does* do is assert: every envelope, snapshot and
// attempt JSON blob it is about to write is checked against `looksLikeCredential` (the same
// boundary-aware backstop `envelope.schema.json`'s `secretFree` $def uses), and a match throws
// `LoopmillError('secret_in_record', ...)`, aborting the whole transaction. A credential that
// reaches this point is a caller bug; the store's job is to fail loudly instead of persisting it.
// -------------------------------------------------------------------------------------------

function assertNoSecret(text: string, where: string): void {
  if (looksLikeCredential(text)) {
    throw new LoopmillError("secret_in_record", `credential-shaped text found in ${where}; refusing to persist it`);
  }
}

function isUniqueViolation(err: unknown, columnHint: string): boolean {
  return (
    err instanceof Error &&
    (err as NodeJS.ErrnoException).code === "ERR_SQLITE_ERROR" &&
    err.message.includes("UNIQUE constraint failed") &&
    err.message.includes(columnHint)
  );
}

function safeRollback(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // Nothing to roll back — e.g. BEGIN IMMEDIATE itself never completed. Safe to ignore: the
    // caller is about to see (and propagate, or has already returned) the real failure.
  }
}

function firstDifferingLine(a: string, b: string): number {
  const linesA = a.split("\n");
  const linesB = b.split("\n");
  const max = Math.max(linesA.length, linesB.length);
  for (let i = 0; i < max; i++) {
    if (linesA[i] !== linesB[i]) return i + 1;
  }
  return max;
}

// -------------------------------------------------------------------------------------------
// Public shapes beyond the three `StateStore` needs (`AppendInput`/`AppendResult`/`LeaseExpired`
// live in src/types/interfaces.ts since the port refers to them too). Everything below is
// `SqliteStore`-specific operational surface: CLI tooling (`rebuild-snapshot`, `runs`,
// `status`), gc, and the lock lifecycle the driver's "one Run per loop" rule (mvp-design.md
// §7.5) needs directly against the concrete store.
// -------------------------------------------------------------------------------------------

export interface OpenStoreOptions {
  host?: string;
  pid?: number;
}

export interface CreateRunInput {
  runId: string;
  loopId: string;
  loopVersion: string;
  loopDigest: string;
  trigger: RunSnapshot["trigger"];
  dedupeKey?: string;
  createdAt: string;
}

export interface RunHeader {
  runId: string;
  loopId: string;
  loopVersion: string;
  loopDigest: string;
  trigger: RunSnapshot["trigger"];
  dedupeKey: string | null;
  createdAt: string;
}

export interface RunListEntry extends RunHeader {
  status: RunState | null;
  outcome: Outcome | null;
  updatedAt: string | null;
}

export interface ListRunsOptions {
  loopId?: string;
  since?: string;
  limit?: number;
}

export interface ReadEventsOptions {
  fromSeq?: number;
}

export interface StoredEvent {
  seq: number;
  kind: "applied" | "ignored" | "emitted";
  eventId: string;
  eventType: string;
  envelope: Envelope;
  prevHash: string;
  hash: string;
  recordedAt: string;
}

export interface RebuildResult {
  identical: boolean;
  stored: string;
  rebuilt: string;
  firstDifferingLine?: number;
}

export interface VerifyChainResult {
  ok: boolean;
  brokenAtSeq?: number;
}

export interface AcquireLockInput {
  loopId: string;
  runId: string;
  ownerPid: number;
  host: string;
  now: string;
  leaseUntil: string;
}

export type AcquireLockResult =
  | { acquired: true; tookOverFrom?: LockHolder }
  | { acquired: false; holder: LockHolder };

export interface LockRecord extends LockHolder {
  loopId: string;
  acquiredAt: string;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  loop_id TEXT NOT NULL,
  loop_version TEXT NOT NULL,
  loop_digest TEXT NOT NULL,
  trigger_json TEXT NOT NULL,
  dedupe_key TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('applied', 'ignored', 'emitted')),
  envelope_json TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (run_id, seq),
  UNIQUE (run_id, event_id),
  FOREIGN KEY (run_id) REFERENCES runs(run_id)
);

CREATE TABLE IF NOT EXISTS snapshots (
  run_id TEXT PRIMARY KEY,
  snapshot_of INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(run_id)
);

CREATE TABLE IF NOT EXISTS attempts (
  run_id TEXT NOT NULL,
  cycle INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  record_json TEXT NOT NULL,
  PRIMARY KEY (run_id, cycle, node_id, attempt),
  FOREIGN KEY (run_id) REFERENCES runs(run_id)
);

CREATE TABLE IF NOT EXISTS locks (
  loop_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  owner_pid INTEGER NOT NULL,
  host TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  lease_until TEXT NOT NULL
);
`;

/**
 * The SQLite implementation of `StateStore`, plus the operational surface described in the
 * header comment above. One instance owns one `node:sqlite` connection; `close()` when done.
 */
export class SqliteStore implements StateStore {
  private readonly db: DatabaseSync;
  readonly host: string;
  readonly pid: number;

  constructor(dbPath: string, opts: OpenStoreOptions = {}) {
    this.host = opts.host ?? hostname();
    this.pid = opts.pid ?? process.pid;
    // A 5s busy timeout lets a second connection's BEGIN IMMEDIATE wait out a concurrent
    // writer's transaction instead of failing immediately with SQLITE_BUSY (mvp-design.md §9.2:
    // "two processes cannot both hold a live row"; A10's two-process race relies on this).
    this.db = new DatabaseSync(dbPath, { timeout: 5000 });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA_SQL);
    this.db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1')").run();
  }

  // -- runs ---------------------------------------------------------------------------------

  createRun(header: CreateRunInput): void {
    const triggerJson = canonicalJson(header.trigger);
    try {
      this.db
        .prepare(
          `INSERT INTO runs (run_id, loop_id, loop_version, loop_digest, trigger_json, dedupe_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          header.runId,
          header.loopId,
          header.loopVersion,
          header.loopDigest,
          triggerJson,
          header.dedupeKey ?? null,
          header.createdAt,
        );
    } catch (err) {
      if (isUniqueViolation(err, "runs.run_id")) {
        throw new LoopmillError("run_exists", `a run with id ${header.runId} already exists`, { cause: err });
      }
      throw err;
    }
  }

  private rowToRunHeader(row: SqlRow): RunHeader {
    return {
      runId: textCol(row, "run_id"),
      loopId: textCol(row, "loop_id"),
      loopVersion: textCol(row, "loop_version"),
      loopDigest: textCol(row, "loop_digest"),
      trigger: parseJson(textCol(row, "trigger_json")) as RunSnapshot["trigger"],
      dedupeKey: textOrNullCol(row, "dedupe_key"),
      createdAt: textCol(row, "created_at"),
    };
  }

  readRunHeader(runId: string): RunHeader | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId);
    return row ? this.rowToRunHeader(row) : null;
  }

  listRuns(opts: ListRunsOptions = {}): RunListEntry[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (opts.loopId !== undefined) {
      clauses.push("r.loop_id = ?");
      params.push(opts.loopId);
    }
    if (opts.since !== undefined) {
      clauses.push("r.created_at >= ?");
      params.push(opts.since);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    let sql = `
      SELECT r.*, s.snapshot_json AS snapshot_json
      FROM runs r
      LEFT JOIN snapshots s ON s.run_id = r.run_id
      ${where}
      ORDER BY r.created_at DESC
    `;
    if (opts.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(opts.limit);
    }
    const rows = this.db.prepare(sql).all(...params);
    return rows.map((row) => {
      const header = this.rowToRunHeader(row);
      const snapshotJson = textOrNullCol(row, "snapshot_json");
      const snapshot = snapshotJson !== null ? (parseJson(snapshotJson) as RunSnapshot) : null;
      return {
        ...header,
        status: snapshot?.status ?? null,
        outcome: snapshot?.outcome ?? null,
        updatedAt: snapshot?.updatedAt ?? null,
      };
    });
  }

  // -- events / snapshot ----------------------------------------------------------------------

  read(runId: string): RunSnapshot | null {
    const row = this.db.prepare("SELECT snapshot_json FROM snapshots WHERE run_id = ?").get(runId);
    return row ? (parseJson(textCol(row, "snapshot_json")) as RunSnapshot) : null;
  }

  private rowToStoredEvent(row: SqlRow): StoredEvent {
    const kind = textCol(row, "kind");
    if (kind !== "applied" && kind !== "ignored" && kind !== "emitted") {
      throw new LoopmillError("store_corrupt_row", `unexpected events.kind value ${JSON.stringify(kind)}`);
    }
    return {
      seq: intCol(row, "seq"),
      kind,
      eventId: textCol(row, "event_id"),
      eventType: textCol(row, "event_type"),
      envelope: parseJson(textCol(row, "envelope_json")) as Envelope,
      prevHash: textCol(row, "prev_hash"),
      hash: textCol(row, "hash"),
      recordedAt: textCol(row, "recorded_at"),
    };
  }

  readEvents(runId: string, opts: ReadEventsOptions = {}): StoredEvent[] {
    const fromSeq = opts.fromSeq ?? 0;
    const rows = this.db
      .prepare("SELECT * FROM events WHERE run_id = ? AND seq >= ? ORDER BY seq ASC")
      .all(runId, fromSeq);
    return rows.map((row) => this.rowToStoredEvent(row));
  }

  readAttempts(runId: string): AttemptRecord[] {
    const rows = this.db
      .prepare("SELECT record_json FROM attempts WHERE run_id = ? ORDER BY cycle ASC, node_id ASC, attempt ASC")
      .all(runId);
    return rows.map((row) => parseJson(textCol(row, "record_json")) as AttemptRecord);
  }

  /**
   * ONE transaction. Inserts `applied` (if given) then each of `emitted`, as consecutive `seq`
   * values continuing from this run's stored max `seq` (across both kinds — `events.seq` is one
   * counter per run). The conflict check: `input.snapshot.snapshotOf` must equal
   * `storedMaxSeqBeforeThisCall + (applied ? 1 : 0) + emitted.length` — i.e. the caller's belief
   * about the new high-water mark this call will produce. A mismatch means another append
   * already advanced this run's journal past what the caller's snapshot was folded from (a
   * lost optimistic-concurrency race); nothing is written and the result is `seq_conflict`. A
   * `UNIQUE(run_id, event_id)` violation on any row rolls back everything written so far in
   * this call and returns `duplicate_event_id` naming the colliding id (P-4 at store level).
   * On success the snapshot is upserted (`snapshot_of` = the last seq this call wrote — the
   * store's own bookkeeping value, not copied from `input.snapshot.snapshotOf`'s JSON), the
   * given attempt records are inserted (an identical re-write of an existing `(cycle, nodeId,
   * attempt)` key is a no-op; a differing one is `attempt_record_conflict`), and — when `lease`
   * is given — the loop's `locks` row is heartbeat-refreshed.
   */
  append(runId: string, input: AppendInput): AppendResult {
    const db = this.db;
    const rowsToInsert: Array<{ kind: "applied" | "ignored" | "emitted"; envelope: Envelope }> = [];
    if (input.applied) rowsToInsert.push({ kind: input.appliedKind ?? "applied", envelope: input.applied });
    for (const emitted of input.emitted) rowsToInsert.push({ kind: "emitted", envelope: emitted });

    db.exec("BEGIN IMMEDIATE");
    try {
      const maxRow = db.prepare("SELECT seq, hash FROM events WHERE run_id = ? ORDER BY seq DESC LIMIT 1").get(runId);
      const priorMaxSeq = maxRow ? intCol(maxRow, "seq") : 0;
      const priorHash = maxRow ? textCol(maxRow, "hash") : "";

      const expectedNewMax = priorMaxSeq + rowsToInsert.length;
      if (input.snapshot.snapshotOf !== expectedNewMax) {
        db.exec("ROLLBACK");
        return { ok: false, reason: "seq_conflict" };
      }

      const insertEvent = db.prepare(
        `INSERT INTO events (run_id, seq, event_id, event_type, kind, envelope_json, prev_hash, hash, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      let seq = priorMaxSeq;
      let prevHash = priorHash;
      let firstSeq: number | null = null;

      for (const { kind, envelope } of rowsToInsert) {
        seq += 1;
        firstSeq ??= seq;
        const envJson = envelopeJson(envelope);
        assertNoSecret(envJson, `event ${envelope.eventId} (${envelope.eventType})`);
        const hash = sha256Hex(prevHash + envJson);
        try {
          insertEvent.run(runId, seq, envelope.eventId, envelope.eventType, kind, envJson, prevHash, hash, input.now);
        } catch (err) {
          if (isUniqueViolation(err, "events.event_id")) {
            db.exec("ROLLBACK");
            return { ok: false, reason: "duplicate_event_id", eventId: envelope.eventId };
          }
          throw err;
        }
        prevHash = hash;
      }

      const snapshotJson = canonicalJson(input.snapshot);
      assertNoSecret(snapshotJson, `the snapshot for run ${runId}`);
      db.prepare(
        `INSERT INTO snapshots (run_id, snapshot_of, snapshot_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           snapshot_of = excluded.snapshot_of, snapshot_json = excluded.snapshot_json, updated_at = excluded.updated_at`,
      ).run(runId, seq, snapshotJson, input.now);

      for (const record of input.attempts ?? []) {
        const recordJson = canonicalJson(record);
        assertNoSecret(recordJson, `attempt ${record.cycleIndex}:${record.nodeId}:${record.attempt}`);
        const existing = db
          .prepare("SELECT record_json FROM attempts WHERE run_id = ? AND cycle = ? AND node_id = ? AND attempt = ?")
          .get(runId, record.cycleIndex, record.nodeId, record.attempt);
        if (existing) {
          if (textCol(existing, "record_json") !== recordJson) {
            throw new LoopmillError(
              "attempt_record_conflict",
              `attempt record for ${record.cycleIndex}:${record.nodeId}:${record.attempt} already exists ` +
                "with different content",
            );
          }
          // Identical re-write of an existing key: a no-op, per spec.
        } else {
          db.prepare(
            "INSERT INTO attempts (run_id, cycle, node_id, attempt, record_json) VALUES (?, ?, ?, ?, ?)",
          ).run(runId, record.cycleIndex, record.nodeId, record.attempt, recordJson);
        }
      }

      if (input.lease) {
        db.prepare("UPDATE locks SET heartbeat_at = ?, lease_until = ? WHERE loop_id = ? AND run_id = ?").run(
          input.lease.heartbeatAt,
          input.lease.expiresAt,
          input.snapshot.loopId,
          runId,
        );
      }

      db.exec("COMMIT");
      return { ok: true, firstSeq: firstSeq ?? seq, lastSeq: seq, snapshotOf: seq };
    } catch (err) {
      safeRollback(db);
      throw err;
    }
  }

  // -- audit: rebuild and verify --------------------------------------------------------------

  /** Refolds every stored event (applied + emitted, seq order) through `fold` and compares the
   * result to the stored snapshot as canonical JSON, byte for byte (A4, P-8). */
  rebuildSnapshot(runId: string, fold: (events: Envelope[]) => RunSnapshot): RebuildResult {
    const rows = this.db.prepare("SELECT envelope_json FROM events WHERE run_id = ? ORDER BY seq ASC").all(runId);
    const events = rows.map((row) => parseJson(textCol(row, "envelope_json")) as Envelope);
    const rebuilt = canonicalJson(fold(events));
    const storedRow = this.db.prepare("SELECT snapshot_json FROM snapshots WHERE run_id = ?").get(runId);
    const stored = storedRow ? textCol(storedRow, "snapshot_json") : "";
    if (stored === rebuilt) {
      return { identical: true, stored, rebuilt };
    }
    return { identical: false, stored, rebuilt, firstDifferingLine: firstDifferingLine(stored, rebuilt) };
  }

  /** Recomputes the `prevHash`/`hash` chain from an empty seed and compares it to what is
   * stored, in seq order, stopping at the first row that does not match. */
  verifyChain(runId: string): VerifyChainResult {
    const rows = this.db
      .prepare("SELECT seq, envelope_json, prev_hash, hash FROM events WHERE run_id = ? ORDER BY seq ASC")
      .all(runId);
    let expectedPrev = "";
    for (const row of rows) {
      const seq = intCol(row, "seq");
      const prevHash = textCol(row, "prev_hash");
      const hash = textCol(row, "hash");
      const envJson = textCol(row, "envelope_json");
      if (prevHash !== expectedPrev || hash !== sha256Hex(expectedPrev + envJson)) {
        return { ok: false, brokenAtSeq: seq };
      }
      expectedPrev = hash;
    }
    return { ok: true };
  }

  // -- locks ------------------------------------------------------------------------------------

  private rowToLockHolder(row: SqlRow): LockHolder {
    return {
      runId: textCol(row, "run_id"),
      ownerPid: intCol(row, "owner_pid"),
      host: textCol(row, "host"),
      heartbeatAt: textCol(row, "heartbeat_at"),
      leaseUntil: textCol(row, "lease_until"),
    };
  }

  /** Atomic: succeeds when no row exists for `loopId`, or the existing row's lease has expired
   * (an expired lease is taken over — reported as `tookOverFrom`). Otherwise fails, reporting
   * the live holder. "Expired" matches state-machine.md §10.1's boundary exactly:
   * `now >= leaseUntil` (not strictly greater than) — the same condition the sweep uses. */
  acquireLock(input: AcquireLockInput): AcquireLockResult {
    const db = this.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const existingRow = db.prepare("SELECT * FROM locks WHERE loop_id = ?").get(input.loopId);
      const existing = existingRow ? this.rowToLockHolder(existingRow) : null;
      const isLive = existing !== null && parseRfc3339(input.now) < parseRfc3339(existing.leaseUntil);
      if (existing && isLive) {
        db.exec("ROLLBACK");
        return { acquired: false, holder: existing };
      }
      db.prepare(
        `INSERT INTO locks (loop_id, run_id, owner_pid, host, acquired_at, heartbeat_at, lease_until)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(loop_id) DO UPDATE SET
           run_id = excluded.run_id, owner_pid = excluded.owner_pid, host = excluded.host,
           acquired_at = excluded.acquired_at, heartbeat_at = excluded.heartbeat_at,
           lease_until = excluded.lease_until`,
      ).run(input.loopId, input.runId, input.ownerPid, input.host, input.now, input.now, input.leaseUntil);
      db.exec("COMMIT");
      return existing ? { acquired: true, tookOverFrom: existing } : { acquired: true };
    } catch (err) {
      safeRollback(db);
      throw err;
    }
  }

  /** Extends the lease iff `runId` currently owns the `loopId` row; a no-op (returns `false`)
   * otherwise — e.g. a stale process heartbeating after its lease was already taken over. */
  heartbeat(loopId: string, runId: string, input: { now: string; leaseUntil: string }): boolean {
    const result = this.db
      .prepare("UPDATE locks SET heartbeat_at = ?, lease_until = ? WHERE loop_id = ? AND run_id = ?")
      .run(input.now, input.leaseUntil, loopId, runId);
    return Number(result.changes) > 0;
  }

  /** Deletes the `loopId` row iff it is still owned by `runId`. */
  releaseLock(loopId: string, runId: string): void {
    this.db.prepare("DELETE FROM locks WHERE loop_id = ? AND run_id = ?").run(loopId, runId);
  }

  readLock(loopId: string): LockRecord | null {
    const row = this.db.prepare("SELECT * FROM locks WHERE loop_id = ?").get(loopId);
    if (!row) return null;
    return { ...this.rowToLockHolder(row), loopId: textCol(row, "loop_id"), acquiredAt: textCol(row, "acquired_at") };
  }

  /** Every `locks` row whose `lease_until` has passed `now`: reports it (from the run's own
   * `snapshot.current`, or nulls when the snapshot has no attempt in flight) and deletes the
   * row. The store never emits events itself — turning each result into a `lease-expired`
   * envelope is the driver's job (state-machine.md §10.2). Idempotent: a row already swept is
   * simply gone, so a second call in the same or a later process finds nothing left to report. */
  sweep(now: string): LeaseExpired[] {
    const db = this.db;
    const nowMs = parseRfc3339(now);
    db.exec("BEGIN IMMEDIATE");
    try {
      const rows = db.prepare("SELECT * FROM locks").all();
      const results: LeaseExpired[] = [];
      for (const row of rows) {
        const leaseUntil = textCol(row, "lease_until");
        // state-machine.md §10.1: expired is `ctx.now >= lease.expiresAt` (inclusive) — the
        // same boundary `acquireLock`'s takeover check uses.
        if (nowMs < parseRfc3339(leaseUntil)) continue;
        const runId = textCol(row, "run_id");
        const loopId = textCol(row, "loop_id");
        const snapshotRow = db.prepare("SELECT snapshot_json FROM snapshots WHERE run_id = ?").get(runId);
        const snapshot = snapshotRow ? (parseJson(textCol(snapshotRow, "snapshot_json")) as RunSnapshot) : null;
        const current = snapshot?.current ?? null;
        results.push({
          runId,
          loopId,
          nodeId: current?.nodeId ?? null,
          cycleIndex: current?.cycleIndex ?? null,
          attempt: current?.attempt ?? null,
          leaseUntil,
          holder: this.rowToLockHolder(row),
        });
        db.prepare("DELETE FROM locks WHERE loop_id = ?").run(loopId);
      }
      db.exec("COMMIT");
      return results;
    } catch (err) {
      safeRollback(db);
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}

export function openStore(dbPath: string, opts: OpenStoreOptions = {}): SqliteStore {
  return new SqliteStore(dbPath, opts);
}
