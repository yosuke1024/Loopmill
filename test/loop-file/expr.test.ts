// `expr.ts`: the §11.1 grammar and the §11.2 evaluation semantics.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseExpression, expressionPaths, evaluateExpression } from "../../src/loop-file/expr.ts";
import { isLoopmillError, LoopmillError } from "../../src/util/errors.ts";
import type { JsonValue } from "../../src/types/loop.ts";

function assertSyntaxError(source: string): void {
  assert.throws(() => parseExpression(source), (err: unknown) => {
    assert.ok(isLoopmillError(err));
    assert.equal((err as LoopmillError).code, "expression_syntax_error");
    return true;
  });
}

function assertConditionError(fn: () => unknown): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(isLoopmillError(err));
    assert.equal((err as LoopmillError).code, "condition_error");
    return true;
  });
}

// --- precedence -----------------------------------------------------------------------------------

test("precedence: && binds tighter than ||", () => {
  // a || (b && c): false || (true && true) = true; if || bound tighter this would need
  // different inputs to distinguish -- check both groupings explicitly via evaluation.
  const expr = parseExpression("a || b && c");
  assert.equal(evaluateExpression(expr, { a: false, b: true, c: false }), false); // false || (true&&false)
  assert.equal(evaluateExpression(expr, { a: false, b: false, c: true }), false); // false || (false&&true)
  assert.equal(evaluateExpression(expr, { a: true, b: false, c: false }), true); // true || (...)
});

test("precedence: () groups explicitly, overriding default grouping", () => {
  const expr = parseExpression("(a || b) && c");
  assert.equal(evaluateExpression(expr, { a: true, b: false, c: false }), false); // (true) && false
  assert.equal(evaluateExpression(expr, { a: true, b: false, c: true }), true);
});

test("precedence: comparison binds tighter than && and ||", () => {
  const expr = parseExpression("a == 1 && b == 2");
  assert.equal(evaluateExpression(expr, { a: 1, b: 2 }), true);
  assert.equal(evaluateExpression(expr, { a: 1, b: 3 }), false);
});

test("precedence: ! applies to the nearest full comparison, per the §11.1 grammar (unary wraps comparison, not a bare operand)", () => {
  // `!a == b` parses as `!(a == b)` under `unary = "!" unary | comparison` (comparison already
  // consumes its own comp_op), not as `(!a) == b` -- operand has no "!"-prefixed alternative, so
  // there is no grammatically valid parse that applies "!" to a single operand of a comparison.
  const expr = parseExpression("!approved == false");
  // approved == false  ->  false == false -> true; !(true) -> false
  assert.equal(evaluateExpression(expr, { approved: false }), false);
  // approved == false  ->  true == false -> false; !(false) -> true
  assert.equal(evaluateExpression(expr, { approved: true }), true);
});

test("precedence: !a && b applies ! to the bare operand a, since a alone (no comp_op following) IS the whole comparison", () => {
  const expr = parseExpression("!a && b");
  assert.equal(evaluateExpression(expr, { a: false, b: true }), true);
  assert.equal(evaluateExpression(expr, { a: true, b: true }), false);
});

// --- comparisons do not chain --------------------------------------------------------------------

test("chaining: a < b < c is a syntax error", () => {
  assertSyntaxError("a < b < c");
});

test("chaining: a == b == c is a syntax error", () => {
  assertSyntaxError("a == b == c");
});

// --- other syntax errors --------------------------------------------------------------------------

test("syntax errors: empty operand, unterminated string, unbalanced parens, stray operator", () => {
  assertSyntaxError("");
  assertSyntaxError("a &&");
  assertSyntaxError("(a");
  assertSyntaxError('"unterminated');
  assertSyntaxError("a === b");
});

// --- literals and paths ----------------------------------------------------------------------------

test("literals: numbers, strings (both quote styles), true/false/null", () => {
  assert.equal(evaluateExpression(parseExpression("1 == 1"), {}), true);
  assert.equal(evaluateExpression(parseExpression("-1.5 == -1.5"), {}), true);
  assert.equal(evaluateExpression(parseExpression('"a" == "a"'), {}), true);
  assert.equal(evaluateExpression(parseExpression("'a' == 'a'"), {}), true);
  assert.equal(evaluateExpression(parseExpression("true == true"), {}), true);
  assert.equal(evaluateExpression(parseExpression("null == null"), {}), true);
});

test("paths: a dotted path indexes into the value bound to its first segment", () => {
  const expr = parseExpression("result.status == 1");
  const inputs: Record<string, JsonValue> = { result: { status: 1 } };
  assert.equal(evaluateExpression(expr, inputs), true);
});

// --- expressionPaths (LM-VAL-017's static analysis) -------------------------------------------------

test("expressionPaths: collects every path operand's segments, literals excluded", () => {
  const expr = parseExpression("approved == true && (tests_exit == 0 || retries.count < 3)");
  assert.deepEqual(expressionPaths(expr), [["approved"], ["tests_exit"], ["retries", "count"]]);
});

test("expressionPaths: true/false/null are literals, never path roots", () => {
  const expr = parseExpression("flag == true");
  assert.deepEqual(expressionPaths(expr), [["flag"]]);
});

// --- §11.2 error kinds -----------------------------------------------------------------------------

test("§11.2: a missing path is an error even under a branch a real short-circuit would skip", () => {
  // `false && missing.field` -- with true short-circuiting the right side would never be looked
  // at; this implementation always walks both sides, so the error still surfaces.
  assertConditionError(() => evaluateExpression(parseExpression("false && missing == 1"), {}));
  assertConditionError(() => evaluateExpression(parseExpression("true || missing == 1"), {}));
});

test("§11.2: indexing past a non-object, or into a missing field, is an error", () => {
  assertConditionError(() => evaluateExpression(parseExpression("a.b == 1"), { a: 5 }));
  assertConditionError(() => evaluateExpression(parseExpression("a.b == 1"), { a: { c: 1 } }));
});

test("§11.2: a path that resolves to an array or object (not a scalar) is an error", () => {
  assertConditionError(() => evaluateExpression(parseExpression("a == 1"), { a: [1, 2] }));
  assertConditionError(() => evaluateExpression(parseExpression("a == 1"), { a: { b: 1 } }));
});

test('§11.2: == / != require identical JSON scalar types -- no coercion ("0" == 0 is an error)', () => {
  assertConditionError(() => evaluateExpression(parseExpression('a == 0'), { a: "0" }));
  assertConditionError(() => evaluateExpression(parseExpression("a == b"), { a: true, b: 1 }));
  assertConditionError(() => evaluateExpression(parseExpression("a == b"), { a: null, b: false }));
});

test("§11.2: <, <=, >, >= require both operands to be numbers", () => {
  assertConditionError(() => evaluateExpression(parseExpression('a < "5"'), { a: 3 }));
  assertConditionError(() => evaluateExpression(parseExpression("a < b"), { a: true, b: 1 }));
});

test("§11.2: &&, ||, ! require booleans -- no truthiness", () => {
  assertConditionError(() => evaluateExpression(parseExpression("!count"), { count: 5 }));
  assertConditionError(() => evaluateExpression(parseExpression("a && b"), { a: 1, b: true }));
  assertConditionError(() => evaluateExpression(parseExpression("a || b"), { a: true, b: "x" }));
});

test("§11.2: an expression that does not itself evaluate to a boolean is an error", () => {
  assertConditionError(() => evaluateExpression(parseExpression("count"), { count: 5 }));
});

// --- the reference loop's own expressions -----------------------------------------------------------

test("the reference loop's expressions evaluate against sample inputs", () => {
  const needsIssue = parseExpression("needs_issue == true");
  assert.equal(evaluateExpression(needsIssue, { needs_issue: true }), true);
  assert.equal(evaluateExpression(needsIssue, { needs_issue: false }), false);

  const verdict = parseExpression("approved == true && tests_exit == 0");
  assert.equal(evaluateExpression(verdict, { approved: true, tests_exit: 0 }), true);
  assert.equal(evaluateExpression(verdict, { approved: true, tests_exit: 1 }), false);
  assert.equal(evaluateExpression(verdict, { approved: false, tests_exit: 0 }), false);

  const retryWhen = parseExpression("approved == false || tests_exit != 0");
  assert.equal(evaluateExpression(retryWhen, { approved: false, tests_exit: 0 }), true);
  assert.equal(evaluateExpression(retryWhen, { approved: true, tests_exit: 1 }), true);
  assert.equal(evaluateExpression(retryWhen, { approved: true, tests_exit: 0 }), false);
});
