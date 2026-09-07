// Condition expressions (docs/spec/loop-file.md §11): the grammar of §11.1, and the typed,
// no-coercion evaluation semantics of §11.2. Used by `condition.expr` and by `edges[].when`.

import type { JsonScalar, JsonValue } from "../types/loop.ts";
import { LoopmillError } from "../util/errors.ts";

// -------------------------------------------------------------------------------------------
// AST (§11.1)
// -------------------------------------------------------------------------------------------

export type CompareOp = "==" | "!=" | "<" | "<=" | ">" | ">=";

export type Expr =
  | { type: "literal"; value: JsonScalar }
  | { type: "path"; segments: string[] }
  | { type: "not"; operand: Expr }
  | { type: "and"; left: Expr; right: Expr }
  | { type: "or"; left: Expr; right: Expr }
  | { type: "compare"; op: CompareOp; left: Expr; right: Expr };

// -------------------------------------------------------------------------------------------
// Lexer
// -------------------------------------------------------------------------------------------

type TokenKind =
  | "num"
  | "str"
  | "ident"
  | "("
  | ")"
  | "!"
  | "&&"
  | "||"
  | "=="
  | "!="
  | "<="
  | ">="
  | "<"
  | ">"
  | "."
  | "eof";

interface Token {
  kind: TokenKind;
  text: string;
  pos: number;
}

const IDENT_START_RE = /[A-Za-z_]/;
const IDENT_PART_RE = /[A-Za-z0-9_]/;
const DIGIT_RE = /[0-9]/;

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === "(" || c === ")" || c === ".") {
      tokens.push({ kind: c, text: c, pos: i });
      i++;
      continue;
    }
    if (c === "!") {
      if (src[i + 1] === "=") {
        tokens.push({ kind: "!=", text: "!=", pos: i });
        i += 2;
      } else {
        tokens.push({ kind: "!", text: "!", pos: i });
        i++;
      }
      continue;
    }
    if (c === "&") {
      if (src[i + 1] === "&") {
        tokens.push({ kind: "&&", text: "&&", pos: i });
        i += 2;
        continue;
      }
      throw syntaxError(src, i, `unexpected character "&"`);
    }
    if (c === "|") {
      if (src[i + 1] === "|") {
        tokens.push({ kind: "||", text: "||", pos: i });
        i += 2;
        continue;
      }
      throw syntaxError(src, i, `unexpected character "|"`);
    }
    if (c === "=") {
      if (src[i + 1] === "=") {
        tokens.push({ kind: "==", text: "==", pos: i });
        i += 2;
        continue;
      }
      throw syntaxError(src, i, `unexpected character "="`);
    }
    if (c === "<") {
      if (src[i + 1] === "=") {
        tokens.push({ kind: "<=", text: "<=", pos: i });
        i += 2;
      } else {
        tokens.push({ kind: "<", text: "<", pos: i });
        i++;
      }
      continue;
    }
    if (c === ">") {
      if (src[i + 1] === "=") {
        tokens.push({ kind: ">=", text: ">=", pos: i });
        i += 2;
      } else {
        tokens.push({ kind: ">", text: ">", pos: i });
        i++;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let value = "";
      while (j < n && src[j] !== quote) {
        if (src[j] === "\\" && j + 1 < n) {
          value += src[j + 1];
          j += 2;
          continue;
        }
        value += src[j];
        j++;
      }
      if (j >= n) throw syntaxError(src, i, "unterminated string literal");
      tokens.push({ kind: "str", text: value, pos: i });
      i = j + 1;
      continue;
    }
    if (DIGIT_RE.test(c) || (c === "-" && DIGIT_RE.test(src[i + 1] ?? ""))) {
      let j = c === "-" ? i + 1 : i;
      while (j < n && DIGIT_RE.test(src[j]!)) j++;
      if (src[j] === "." && DIGIT_RE.test(src[j + 1] ?? "")) {
        j++;
        while (j < n && DIGIT_RE.test(src[j]!)) j++;
      }
      tokens.push({ kind: "num", text: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if (IDENT_START_RE.test(c)) {
      let j = i;
      while (j < n && IDENT_PART_RE.test(src[j]!)) j++;
      tokens.push({ kind: "ident", text: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    throw syntaxError(src, i, `unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: "eof", text: "", pos: n });
  return tokens;
}

function syntaxError(src: string, pos: number, why: string): LoopmillError {
  return new LoopmillError("expression_syntax_error", `${why} at offset ${pos} in ${JSON.stringify(src)}`);
}

// -------------------------------------------------------------------------------------------
// Parser: expression = or_expr ; or_expr = and_expr {"||" and_expr} ; and_expr = unary {"&&"
// unary} ; unary = "!" unary | comparison ; comparison = operand [comp_op operand] ; operand =
// "(" expression ")" | literal | path. Comparisons do not chain: `comparison` consumes at most
// one `comp_op`, so a second one left over at the same level fails at the final EOF check (or,
// nested inside `&&`/`||`, is simply not a token either of those loops recognises) -- either way
// a syntax error, per §11.1: "a < b < c is a syntax error".
// -------------------------------------------------------------------------------------------

const COMPARE_OPS: ReadonlySet<TokenKind> = new Set(["==", "!=", "<", "<=", ">", ">="]);

class Parser {
  private readonly tokens: Token[];
  private readonly src: string;
  private pos = 0;

  constructor(tokens: Token[], src: string) {
    this.tokens = tokens;
    this.src = src;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private advance(): Token {
    return this.tokens[this.pos++]!;
  }

  private expect(kind: TokenKind): Token {
    const t = this.advance();
    if (t.kind !== kind) {
      throw syntaxError(this.src, t.pos, `expected "${kind}", got ${JSON.stringify(t.text || t.kind)}`);
    }
    return t;
  }

  parseTop(): Expr {
    const e = this.parseOr();
    const t = this.peek();
    if (t.kind !== "eof") {
      throw syntaxError(this.src, t.pos, `unexpected token ${JSON.stringify(t.text || t.kind)}`);
    }
    return e;
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.peek().kind === "||") {
      this.advance();
      const right = this.parseAnd();
      left = { type: "or", left, right };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseUnary();
    while (this.peek().kind === "&&") {
      this.advance();
      const right = this.parseUnary();
      left = { type: "and", left, right };
    }
    return left;
  }

  private parseUnary(): Expr {
    if (this.peek().kind === "!") {
      this.advance();
      const operand = this.parseUnary();
      return { type: "not", operand };
    }
    return this.parseComparison();
  }

  private parseComparison(): Expr {
    const left = this.parseOperand();
    const t = this.peek();
    if (COMPARE_OPS.has(t.kind)) {
      this.advance();
      const right = this.parseOperand();
      return { type: "compare", op: t.kind as CompareOp, left, right };
    }
    return left;
  }

  private parseOperand(): Expr {
    const t = this.peek();
    if (t.kind === "(") {
      this.advance();
      const e = this.parseOr();
      this.expect(")");
      return e;
    }
    if (t.kind === "num") {
      this.advance();
      return { type: "literal", value: Number(t.text) };
    }
    if (t.kind === "str") {
      this.advance();
      return { type: "literal", value: t.text };
    }
    if (t.kind === "ident") {
      this.advance();
      if (t.text === "true") return { type: "literal", value: true };
      if (t.text === "false") return { type: "literal", value: false };
      if (t.text === "null") return { type: "literal", value: null };
      const segments = [t.text];
      while (this.peek().kind === ".") {
        this.advance();
        segments.push(this.expect("ident").text);
      }
      return { type: "path", segments };
    }
    throw syntaxError(this.src, t.pos, `expected an operand, got ${JSON.stringify(t.text || t.kind)}`);
  }
}

/** Parses `source` per the §11.1 grammar. Throws `LoopmillError` (code
 * `expression_syntax_error`) for anything malformed, including chained comparisons. */
export function parseExpression(source: string): Expr {
  const tokens = tokenize(source);
  return new Parser(tokens, source).parseTop();
}

// -------------------------------------------------------------------------------------------
// Static analysis: every path operand's segments, in the order they appear in the tree. Used by
// `validate.ts` for LM-VAL-017 (the first segment of every path must be a declared input).
// -------------------------------------------------------------------------------------------

export function expressionPaths(expr: Expr): string[][] {
  const out: string[][] = [];
  walk(expr);
  return out;

  function walk(node: Expr): void {
    switch (node.type) {
      case "literal":
        return;
      case "path":
        out.push(node.segments);
        return;
      case "not":
        walk(node.operand);
        return;
      case "and":
      case "or":
      case "compare":
        walk(node.left);
        walk(node.right);
        return;
    }
  }
}

// -------------------------------------------------------------------------------------------
// Evaluation (§11.2)
// -------------------------------------------------------------------------------------------

type ScalarType = "string" | "number" | "boolean" | "null";

function scalarTypeOf(value: JsonScalar): ScalarType {
  if (value === null) return "null";
  return typeof value as ScalarType;
}

function describeValue(value: JsonScalar): string {
  return `${scalarTypeOf(value)} ${JSON.stringify(value)}`;
}

/**
 * Evaluates `expr` against `inputs` (already-resolved local names, §9 -- not references). Every
 * path operand is resolved by looking up its first segment in `inputs` and indexing further
 * segments into that JSON value; a missing path, or one that lands on something that is not a
 * JSON scalar, is a `condition_error`, exactly as much for a branch a real short-circuit would
 * have skipped as for one it would not: this implementation always walks the whole tree (both
 * sides of every `&&`/`||`), so no branch is ever skipped and the "short-circuits, which matters
 * only for cost" rule of §11.2 holds by construction. `==`/`!=` require identical JSON scalar
 * types (no coercion); `<`-family operators require both operands to be numbers; `&&`/`||`/`!`
 * require booleans (no truthiness). Throws `LoopmillError` (code `condition_error`) naming the
 * offending path or operator for every one of those cases, and also if the expression's overall
 * result is not itself a boolean.
 */
export function evaluateExpression(expr: Expr, inputs: Record<string, JsonValue>): boolean {
  const result = evaluate(expr, inputs);
  if (typeof result !== "boolean") {
    throw new LoopmillError("condition_error", `expression does not evaluate to a boolean (got ${describeValue(result)})`);
  }
  return result;
}

function evaluate(node: Expr, inputs: Record<string, JsonValue>): JsonScalar {
  switch (node.type) {
    case "literal":
      return node.value;
    case "path":
      return resolvePath(node.segments, inputs);
    case "not": {
      const v = evaluate(node.operand, inputs);
      if (typeof v !== "boolean") {
        throw new LoopmillError("condition_error", `"!" requires a boolean operand, got ${describeValue(v)}`);
      }
      return !v;
    }
    case "and": {
      const l = evaluate(node.left, inputs);
      const r = evaluate(node.right, inputs);
      if (typeof l !== "boolean") {
        throw new LoopmillError("condition_error", `"&&" requires boolean operands, left is ${describeValue(l)}`);
      }
      if (typeof r !== "boolean") {
        throw new LoopmillError("condition_error", `"&&" requires boolean operands, right is ${describeValue(r)}`);
      }
      return l && r;
    }
    case "or": {
      const l = evaluate(node.left, inputs);
      const r = evaluate(node.right, inputs);
      if (typeof l !== "boolean") {
        throw new LoopmillError("condition_error", `"||" requires boolean operands, left is ${describeValue(l)}`);
      }
      if (typeof r !== "boolean") {
        throw new LoopmillError("condition_error", `"||" requires boolean operands, right is ${describeValue(r)}`);
      }
      return l || r;
    }
    case "compare": {
      const l = evaluate(node.left, inputs);
      const r = evaluate(node.right, inputs);
      return compare(node.op, l, r);
    }
  }
}

function compare(op: CompareOp, l: JsonScalar, r: JsonScalar): boolean {
  if (op === "==" || op === "!=") {
    const lt = scalarTypeOf(l);
    const rt = scalarTypeOf(r);
    if (lt !== rt) {
      throw new LoopmillError(
        "condition_error",
        `"${op}" requires both operands to be the same type, got ${lt} and ${rt} (${describeValue(l)} ${op} ${describeValue(r)})`,
      );
    }
    const eq = l === r;
    return op === "==" ? eq : !eq;
  }
  if (typeof l !== "number" || typeof r !== "number") {
    throw new LoopmillError(
      "condition_error",
      `"${op}" requires numeric operands, got ${describeValue(l)} and ${describeValue(r)}`,
    );
  }
  switch (op) {
    case "<":
      return l < r;
    case "<=":
      return l <= r;
    case ">":
      return l > r;
    case ">=":
      return l >= r;
  }
}

function resolvePath(segments: string[], inputs: Record<string, JsonValue>): JsonScalar {
  const root = segments[0]!;
  const label = segments.join(".");
  if (!Object.prototype.hasOwnProperty.call(inputs, root)) {
    throw new LoopmillError("condition_error", `"${label}" does not resolve: no input named "${root}"`);
  }
  let cur: JsonValue = inputs[root] as JsonValue;
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i]!;
    if (cur === null || typeof cur !== "object" || Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, seg)) {
      throw new LoopmillError("condition_error", `"${label}" does not resolve: "${segments.slice(0, i + 1).join(".")}" is missing`);
    }
    cur = (cur as Record<string, JsonValue>)[seg] as JsonValue;
  }
  if (cur !== null && typeof cur === "object") {
    throw new LoopmillError(
      "condition_error",
      `"${label}" is not a JSON scalar (it is ${Array.isArray(cur) ? "an array" : "an object"})`,
    );
  }
  return cur;
}
