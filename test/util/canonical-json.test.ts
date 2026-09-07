import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, parseJson } from "../../src/util/canonical-json.ts";
import { isLoopmillError } from "../../src/util/errors.ts";

test("canonicalJson: key order is sorted recursively", () => {
  const out = canonicalJson({ b: 1, a: { d: 2, c: 3 } });
  assert.equal(out, '{\n  "a": {\n    "c": 3,\n    "d": 2\n  },\n  "b": 1\n}\n');
});

test("canonicalJson: arrays keep their given order, elements indented", () => {
  const out = canonicalJson({ list: [3, 1, 2] });
  assert.equal(out, '{\n  "list": [\n    3,\n    1,\n    2\n  ]\n}\n');
});

test("canonicalJson: nested objects and arrays combine", () => {
  const out = canonicalJson({ b: [{ z: 1, y: 2 }], a: 1 });
  assert.equal(
    out,
    '{\n  "a": 1,\n  "b": [\n    {\n      "y": 2,\n      "z": 1\n    }\n  ]\n}\n',
  );
});

test("canonicalJson: empty object and empty array render compactly", () => {
  assert.equal(canonicalJson({}), "{}\n");
  assert.equal(canonicalJson([]), "[]\n");
  assert.equal(canonicalJson({ e: {}, a: [] }), '{\n  "a": [],\n  "e": {}\n}\n');
});

test("canonicalJson: unicode strings are preserved and escaped like JSON.stringify", () => {
  const out = canonicalJson({ greeting: "こんにちは 🎉" });
  assert.equal(out, '{\n  "greeting": "こんにちは 🎉"\n}\n');
});

test("canonicalJson: scalars, booleans and null round-trip", () => {
  assert.equal(canonicalJson(null), "null\n");
  assert.equal(canonicalJson(true), "true\n");
  assert.equal(canonicalJson(false), "false\n");
  assert.equal(canonicalJson(42), "42\n");
  assert.equal(canonicalJson("hi"), '"hi"\n');
});

test("canonicalJson: trailing newline is always present, exactly once", () => {
  const out = canonicalJson({ a: 1 });
  assert.ok(out.endsWith("\n"));
  assert.ok(!out.endsWith("\n\n"));
});

test("canonicalJson: rejects undefined at the top level", () => {
  assert.throws(() => canonicalJson(undefined), (err: unknown) => {
    if (!isLoopmillError(err)) return false;
    assert.equal(err.code, "canonical_json_unsupported");
    return true;
  });
});

test("canonicalJson: rejects undefined nested in an object or array", () => {
  assert.throws(() => canonicalJson({ a: undefined }));
  assert.throws(() => canonicalJson([1, undefined, 3]));
});

test("canonicalJson: rejects functions, symbols and bigints", () => {
  assert.throws(() => canonicalJson(() => 1));
  assert.throws(() => canonicalJson(Symbol("x")));
  assert.throws(() => canonicalJson(1n));
});

test("canonicalJson: rejects NaN and Infinity", () => {
  assert.throws(() => canonicalJson(NaN));
  assert.throws(() => canonicalJson(Infinity));
  assert.throws(() => canonicalJson(-Infinity));
  assert.throws(() => canonicalJson({ n: NaN }));
});

test("canonicalJson: idempotent under parse-and-reserialize", () => {
  const value = { z: 1, a: [3, 2, 1], m: { y: "x", x: "y" }, u: "こんにちは" };
  const once = canonicalJson(value);
  const twice = canonicalJson(JSON.parse(once) as unknown);
  assert.equal(once, twice);
});

test("canonicalJson: idempotent regardless of input key order", () => {
  const a = canonicalJson({ a: 1, b: 2, c: 3 });
  const b = canonicalJson({ c: 3, b: 2, a: 1 });
  assert.equal(a, b);
});

test("parseJson: wraps JSON.parse", () => {
  assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
});
