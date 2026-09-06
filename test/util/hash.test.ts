import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256Hex, sha256Prefixed } from "../../src/util/hash.ts";

test("sha256Hex: known vector", () => {
  // sha256("abc") — a standard test vector.
  assert.equal(
    sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("sha256Hex: accepts Uint8Array input", () => {
  const bytes = new TextEncoder().encode("abc");
  assert.equal(sha256Hex(bytes), sha256Hex("abc"));
});

test("sha256Prefixed: sha256:<hex> form matches envelope.schema.json's pattern", () => {
  const out = sha256Prefixed("abc");
  assert.equal(out, `sha256:${sha256Hex("abc")}`);
  assert.match(out, /^sha256:[0-9a-f]{64}$/);
});
