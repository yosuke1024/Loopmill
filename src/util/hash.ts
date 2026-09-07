// sha256 helpers. Used wherever the spec calls for a `sha256:<hex>` digest: `loopVersion`
// (docs/spec/loop-file.md §3), artifact and subject digests (docs/spec/state-machine.md §8.2),
// and the deterministic ULID entropy of D-16 (docs/spec/state-machine.md §5.2).

import { createHash } from "node:crypto";

/** Lowercase hex sha256 digest of `input`. */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/** `sha256:<hex>`, the prefixed form used throughout the spec (e.g. `loopVersion`). */
export function sha256Prefixed(input: string | Uint8Array): string {
  return `sha256:${sha256Hex(input)}`;
}
