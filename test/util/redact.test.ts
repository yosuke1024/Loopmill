import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeCredential, redact } from "../../src/util/redact.ts";

// docs/spec/envelope.md §13, TV-5 — the credential backstop must not fire on ordinary prose.
const TV5: Array<[string, "accepted" | "rejected"]> = [
  ["a risk-averse approach to tokens", "accepted"],
  ["the task-12345678901234567890 finished", "accepted"],
  ["briskly-1234567890123456789012", "accepted"],
  ["sk-ant-EXAMPLENOTAREALKEY000000000000", "rejected"],
  ["CLAUDE_CODE_OAUTH_TOKEN=oat01_EXAMPLEEXAMPLE", "rejected"],
  ["ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123", "rejected"],
];

test("looksLikeCredential: TV-5 table, verbatim", () => {
  for (const [s, expected] of TV5) {
    const flagged = looksLikeCredential(s);
    assert.equal(flagged, expected === "rejected", `${JSON.stringify(s)} should be ${expected}`);
  }
});

test("looksLikeCredential: PEM private-key headers are flagged", () => {
  assert.ok(looksLikeCredential("-----BEGIN RSA PRIVATE KEY-----"));
  assert.ok(looksLikeCredential("-----BEGIN PRIVATE KEY-----"));
});

test("looksLikeCredential: an ordinary sentence with digits and hyphens is never flagged", () => {
  assert.ok(!looksLikeCredential("issue-12345 was closed after PR-6789 merged"));
});

test("redact: the three TV-5 accepted prose strings pass through unchanged", () => {
  for (const [s, expected] of TV5) {
    if (expected !== "accepted") continue;
    assert.equal(redact(s), s);
  }
});

test("redact: sk-ant- keys keep their prefix and redact the rest", () => {
  const out = redact("key is sk-ant-EXAMPLENOTAREALKEY000000000000 in the log");
  assert.ok(out.includes("sk-ant-***REDACTED***"));
  assert.ok(!out.includes("EXAMPLENOTAREALKEY"));
});

test("redact: oat01 (Claude Code OAuth) tokens are redacted", () => {
  const out = redact("CLAUDE_CODE_OAUTH_TOKEN=oat01_EXAMPLEEXAMPLE and more text");
  assert.ok(out.includes("oat01-***REDACTED***"));
  assert.ok(!out.includes("EXAMPLEEXAMPLE"));
});

test("redact: generic sk- keys are redacted", () => {
  const out = redact("OPENAI_API_KEY=sk-EXAMPLEEXAMPLEEXAMPLEEXAMPLE trailing");
  assert.ok(out.includes("sk-***REDACTED***"));
  assert.ok(!out.includes("EXAMPLEEXAMPLEEXAMPLEEXAMPLE"));
});

test("redact: GitHub tokens (ghp_/github_pat_) are redacted", () => {
  const out1 = redact("token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123 done");
  assert.ok(out1.includes("***REDACTED***"));
  assert.ok(!out1.includes("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123"));

  const out2 = redact("token: github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 done");
  assert.ok(out2.includes("***REDACTED***"));
  assert.ok(!out2.includes("11ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"));
});

test("redact: Bearer tokens keep the 'Bearer ' prefix and redact the token", () => {
  const out = redact("Authorization: Bearer abcDEF123456789012345678901234567890");
  assert.ok(out.includes("Bearer ***REDACTED***"));
  assert.ok(!out.includes("abcDEF123456789012345678901234567890"));
});

test("redact: JSON Web Tokens are redacted", () => {
  const jwt =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQ6iCX9GZ7RchcvVHXCV-o9nQlvGGiwzGA";
  const out = redact(`token=${jwt}`);
  assert.ok(out.includes("***REDACTED***"));
  assert.ok(!out.includes(jwt));
});

test("redact: is idempotent on its own output", () => {
  const once = redact("sk-ant-EXAMPLENOTAREALKEY000000000000");
  assert.equal(redact(once), once);
});
