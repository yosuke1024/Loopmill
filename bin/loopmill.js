#!/usr/bin/env node
// Entry point. During development the CLI runs from the TypeScript sources through Node's type
// stripping (Node >= 22.18); a built package points this at dist/ instead.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist", "cli", "main.js");
const src = join(here, "..", "src", "cli", "main.ts");
const target = existsSync(dist) ? dist : src;
const { main } = await import(target);
process.exitCode = await main(process.argv.slice(2));
