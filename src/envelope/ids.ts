// eventId allocation and derivation, and the semantic idempotency key (docs/spec/envelope.md
// §6, §8.3).

import { sha256Hex } from "../util/hash.ts";
import { parseRfc3339 } from "../util/time.ts";
import { deterministicEventId, newRunId, randomUlid, ulidFromParts } from "../util/ulid.ts";
import type { EventType } from "../types/envelope.ts";

export { deterministicEventId, newRunId };

/** A fresh, randomly generated `eventId` (envelope.md §6.1: "Producers MUST generate a fresh
 * ULID per event", except polling — see `deriveDeliveryEventId`). Alias of `util/ulid.ts`'s
 * `randomUlid`. */
export const newEventId: (nowMs?: number) => string = randomUlid;

/**
 * The semantic idempotency key of envelope.md §6.2 — `(runId, cycle, nodeId, attempt, eventType)`
 * — restated as `"<cycle>:<nodeId>:<attempt>:<eventType>"`. `runId` is not part of the string
 * since it is the caller's own partitioning key (one Run's events never mix with another's).
 * Returns `null` for a run-level envelope: one that does not carry all three node coordinates —
 * `run-requested`/`run-started`/`run-finished`/`resumed` (which forbid them, §3.2),
 * `retry-edge-taken` (which carries only `cycle`), and an `ignored-stale` for a declined
 * run-level envelope.
 */
export function semanticKey(envelope: {
  cycle?: number;
  nodeId?: string;
  attempt?: number;
  eventType: EventType;
}): string | null {
  const { cycle, nodeId, attempt, eventType } = envelope;
  if (cycle === undefined || nodeId === undefined || attempt === undefined) {
    return null;
  }
  return `${cycle}:${nodeId}:${attempt}:${eventType}`;
}

/**
 * The inputs envelope.md §8.3's derivation actually needs. Deliberately NOT a `deliveryId`: the
 * section is explicit that a poll never sees GitHub's `X-GitHub-Delivery` webhook GUID ("GitHub's
 * `X-GitHub-Delivery` GUID belongs to webhooks and is never seen by a poll") and derives instead
 * from the source object's own natural key, which §8.3's table gives per GitHub event:
 *
 * | Source event | Natural key |
 * |---|---|
 * | `issue_comment` | `comment.id` |
 * | `pull_request_review` | `review.id` |
 * | `issues` | `issue.id + ":" + action` |
 * | `pull_request` | `pull_request.id + ":" + action` |
 * | `workflow_run` (reserved) | `workflow_run.id + ":" + run_attempt` |
 *
 * Callers build `naturalKey` per that table; this type and `deriveDeliveryEventId` implement only
 * the seed/entropy/timestamp construction §8.3 gives in full, alongside a worked example (TV-2).
 */
export interface DeliverySeed {
  /** GitHub's event name, e.g. `"issue_comment"`, `"pull_request_review"`, `"issues"`,
   * `"pull_request"`, `"workflow_run"`. */
  githubEvent: string;
  /** The source object's own natural key (never the webhook delivery GUID) — see the table above. */
  naturalKey: string;
  /** The source object's own timestamp (e.g. `comment.created_at`), RFC 3339. */
  sourceTimestamp: string;
}

/**
 * envelope.md §8.3: derives a stable, time-sortable `eventId` from a polled GitHub delivery, so
 * that polling the same source object twice always yields the same id (and the driver drops the
 * second delivery as a duplicate, exit 0, nothing written).
 *
 * ```text
 * seed      = "loopmill/ingest/1" SP <github event name> SP <natural key> SP <source timestamp>
 * entropy   = sha256(seed)[0..10]                         # first 10 bytes = 80 bits
 * timestamp = source timestamp in milliseconds since the epoch
 * eventId   = crockford32(timestamp, 10 chars) || crockford32(entropy, 16 chars)
 * ```
 *
 * TV-2: `githubEvent: "issue_comment"`, `naturalKey: "3310042117"`,
 * `sourceTimestamp: "2026-09-06T09:04:11Z"` derives `"06G7BXFYZ09DF0AZG7Y0K6EADR"`.
 */
export function deriveDeliveryEventId(delivery: DeliverySeed): string {
  const seed = ["loopmill/ingest/1", delivery.githubEvent, delivery.naturalKey, delivery.sourceTimestamp].join(" ");
  const digestHex = sha256Hex(seed);
  const entropy = new Uint8Array(10);
  for (let i = 0; i < 10; i++) {
    entropy[i] = parseInt(digestHex.slice(i * 2, i * 2 + 2), 16);
  }
  const timeMs = parseRfc3339(delivery.sourceTimestamp);
  return ulidFromParts(timeMs, entropy);
}
