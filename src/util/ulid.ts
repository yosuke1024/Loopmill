// ULIDs: 48-bit millisecond timestamp + 80 bits of entropy, Crockford base32 (26 chars, `I`,
// `L`, `O` and `U` excluded), lexicographically sortable in generation order
// (docs/spec/envelope.md §3.1, §6.1; docs/spec/envelope.schema.json `$defs.ulid`/`runId`).

import { LoopmillError } from "./errors.ts";
import { sha256Hex } from "./hash.ts";
import { parseRfc3339 } from "./time.ts";

// Crockford base32: digits 0-9 plus A-Z minus I, L, O, U (32 symbols for 5 bits each).
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const RUN_ID_RE = /^run_[0-9A-HJKMNP-TV-Z]{26}$/;

const MAX_TIME_MS = 0xffffffffffff; // 2^48 - 1

function encodeTime(timeMs: number): string {
  if (!Number.isInteger(timeMs) || timeMs < 0 || timeMs > MAX_TIME_MS) {
    throw new LoopmillError(
      "invalid_ulid_time",
      `ULID time must be an integer in [0, 2^48-1] milliseconds, got ${String(timeMs)}`,
    );
  }
  let value = BigInt(timeMs);
  let out = "";
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD_ALPHABET[Number(value & 0x1fn)] + out;
    value >>= 5n;
  }
  return out;
}

function encodeEntropy(entropy: Uint8Array): string {
  if (entropy.length !== 10) {
    throw new LoopmillError(
      "invalid_ulid_entropy",
      `ULID entropy must be exactly 10 bytes, got ${String(entropy.length)}`,
    );
  }
  let value = 0n;
  for (const byte of entropy) {
    value = (value << 8n) | BigInt(byte);
  }
  let out = "";
  for (let i = 0; i < 16; i++) {
    out = CROCKFORD_ALPHABET[Number(value & 0x1fn)] + out;
    value >>= 5n;
  }
  return out;
}

function decodeCrockfordChar(c: string): number {
  const index = CROCKFORD_ALPHABET.indexOf(c.toUpperCase());
  if (index === -1) {
    throw new LoopmillError("invalid_ulid", `not a valid Crockford base32 character: ${JSON.stringify(c)}`);
  }
  return index;
}

/** Encodes a 48-bit millisecond timestamp and 10 bytes of entropy as a 26-char ULID. */
export function ulidFromParts(timeMs: number, entropy: Uint8Array): string {
  return encodeTime(timeMs) + encodeEntropy(entropy);
}

/** A fresh, randomly generated ULID for time `timeMs` (default: now). Not deterministic. */
export function randomUlid(timeMs: number = Date.now()): string {
  const entropy = new Uint8Array(10);
  globalThis.crypto.getRandomValues(entropy);
  return ulidFromParts(timeMs, entropy);
}

/** True iff `s` is a syntactically valid ULID (26 Crockford base32 characters). */
export function isUlid(s: string): boolean {
  return typeof s === "string" && ULID_RE.test(s);
}

/** Decodes the 48-bit millisecond timestamp encoded in the first 10 characters of a ULID. */
export function ulidTimeMs(ulid: string): number {
  if (!isUlid(ulid)) {
    throw new LoopmillError("invalid_ulid", `not a valid ULID: ${JSON.stringify(ulid)}`);
  }
  let value = 0n;
  for (const c of ulid.slice(0, 10)) {
    value = (value << 5n) | BigInt(decodeCrockfordChar(c));
  }
  return Number(value);
}

export interface DeterministicEventIdParts {
  nowRfc3339: string;
  runId: string;
  eventType: string;
  cycle: number | null;
  nodeId: string | null;
  attempt: number | null;
  emitIndex: number;
  causationEventId: string | null;
}

/**
 * A deterministic ULID `eventId` for an envelope `transition()` emits, per
 * docs/spec/state-machine.md §5.2 decision D-16:
 *
 *     eventId = ulid(timeMs = parseRfc3339(ctx.now), entropy80 = sha256(
 *         runId | eventType | cycle | nodeId | attempt | emitIndex | causationEventId
 *     ).slice(0, 10 bytes))
 *
 * Decision (not in sheet): D-16 names the field list but not its exact serialisation. Fields
 * are joined with the literal separator `|` in the fixed order above; a `null` field renders
 * as the empty string rather than the string `"null"`, so the seed stays a plain, readable
 * string. Because every field occupies a fixed position in the join, changing any one field
 * (including from a real value to `null`, or vice versa) changes the seed and therefore the
 * id — except that `null` and the literal empty string `""` are indistinguishable for the
 * string-valued fields (`nodeId`, `causationEventId`), which is harmless in practice since a
 * `nodeId` is always either a valid identifier or genuinely absent.
 */
export function deterministicEventId(parts: DeterministicEventIdParts): string {
  const timeMs = parseRfc3339(parts.nowRfc3339);
  const seed = [
    parts.runId,
    parts.eventType,
    parts.cycle === null ? "" : String(parts.cycle),
    parts.nodeId === null ? "" : parts.nodeId,
    parts.attempt === null ? "" : String(parts.attempt),
    String(parts.emitIndex),
    parts.causationEventId === null ? "" : parts.causationEventId,
  ].join("|");
  const digestHex = sha256Hex(seed);
  const entropy = new Uint8Array(10);
  for (let i = 0; i < 10; i++) {
    entropy[i] = parseInt(digestHex.slice(i * 2, i * 2 + 2), 16);
  }
  return ulidFromParts(timeMs, entropy);
}

/** `run_` followed by a fresh random ULID, matching `envelope.schema.json`'s `runId` pattern. */
export function newRunId(timeMs: number = Date.now()): string {
  return `run_${randomUlid(timeMs)}`;
}

/** True iff `s` matches the `run_<ULID>` shape. */
export function isRunId(s: string): boolean {
  return typeof s === "string" && RUN_ID_RE.test(s);
}
