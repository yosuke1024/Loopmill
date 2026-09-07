#!/usr/bin/env node
// Validates docs/spec/envelope-examples/*.json against docs/spec/envelope.schema.json.
//
// Files named invalid-*.json MUST fail validation; every other file MUST pass.
// Every eventType in the schema enum must be covered by at least one valid example.
//
// ajv and ajv-formats are not dependencies of this repository. Point the script at an
// installation:
//   node docs/spec/validate-envelopes.mjs /path/to/dir-containing-node_modules
//   NODE_PATH=/path/to/node_modules node docs/spec/validate-envelopes.mjs
// A node_modules directory found by walking up from this file is used as a fallback.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(HERE, 'envelope.schema.json');
const EXAMPLES_DIR = join(HERE, 'envelope-examples');
const MAX_ENVELOPE_BYTES = 32 * 1024;

function candidateRoots() {
  const roots = [];
  const push = (p) => {
    if (p && !roots.includes(p)) roots.push(p);
  };
  for (const arg of process.argv.slice(2)) {
    const abs = resolve(arg);
    push(abs);
    push(join(abs, 'node_modules'));
  }
  for (const entry of (process.env.NODE_PATH ?? '').split(':').filter(Boolean)) {
    const abs = resolve(entry);
    push(abs);
    push(join(abs, 'node_modules'));
  }
  let dir = HERE;
  for (;;) {
    push(join(dir, 'node_modules'));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return roots;
}

async function loadPackage(pkg, subpath) {
  for (const root of candidateRoots()) {
    const file = join(root, pkg, subpath);
    if (existsSync(file)) {
      const mod = await import(pathToFileURL(file).href);
      return mod.default?.default ?? mod.default ?? mod;
    }
  }
  throw new Error(
    `cannot find ${pkg}/${subpath}. Install it outside the repository and pass the ` +
      `directory that contains node_modules as an argument, or set NODE_PATH.`
  );
}

const Ajv2020 = await loadPackage('ajv', 'dist/2020.js');
const addFormats = await loadPackage('ajv-formats', 'dist/index.js');

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
// strictRequired is off because the conditional rules deliberately declare `required`
// in `then` subschemas whose properties are declared once, at the top level.
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
const validate = ajv.compile(schema);

const files = readdirSync(EXAMPLES_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort();

let passed = 0;
let failed = 0;
let maxBytes = 0;
let maxEscapedBytes = 0;
const coveredTypes = new Set();
const problems = [];

for (const file of files) {
  const path = join(EXAMPLES_DIR, file);
  const raw = readFileSync(path, 'utf8');
  const bytes = Buffer.byteLength(raw, 'utf8');
  const shouldFail = file.startsWith('invalid-');

  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch (err) {
    failed += 1;
    problems.push(`${file}: not valid JSON (${err.message})`);
    continue;
  }

  const firstKey = Object.keys(envelope)[0];
  const ok = validate(envelope);
  const errors = ok ? [] : validate.errors.map((e) => `${e.instancePath || '/'} ${e.message}`);

  if (ok === shouldFail) {
    failed += 1;
    problems.push(
      shouldFail
        ? `${file}: expected validation to FAIL, but it passed`
        : `${file}: expected validation to PASS, but it failed: ${errors.join('; ')}`
    );
    continue;
  }

  if (!shouldFail) {
    if (firstKey !== 'schemaVersion') {
      failed += 1;
      problems.push(`${file}: first key is "${firstKey}", must be "schemaVersion"`);
      continue;
    }
    if (bytes > MAX_ENVELOPE_BYTES) {
      failed += 1;
      problems.push(`${file}: ${bytes} bytes exceeds the 32 KiB envelope limit`);
      continue;
    }
    coveredTypes.add(envelope.eventType);
    maxBytes = Math.max(maxBytes, bytes);
    maxEscapedBytes = Math.max(maxEscapedBytes, Buffer.byteLength(JSON.stringify(raw), 'utf8'));
  }

  passed += 1;
  const verdict = shouldFail ? `rejected as expected (${errors[0] ?? 'no error'})` : 'valid';
  console.log(`ok   ${file.padEnd(34)} ${verdict}`);
}

const allTypes = schema.$defs.eventType.enum;
const missing = allTypes.filter((t) => !coveredTypes.has(t));
if (missing.length > 0) {
  failed += 1;
  problems.push(`event types with no valid example: ${missing.join(', ')}`);
}

for (const problem of problems) console.error(`FAIL ${problem}`);

console.log(
  `\n${passed} checked, ${failed} problem(s); ${coveredTypes.size}/${allTypes.length} event types covered; ` +
    `largest example ${maxBytes} B (${maxEscapedBytes} B when JSON-string escaped for a dispatch payload).`
);

process.exit(failed === 0 ? 0 : 1);
