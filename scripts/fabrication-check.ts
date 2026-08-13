#!/usr/bin/env bun
/**
 * Fabrication guard — three regex patterns the CLAUDE.md hard constraints require
 * to be absent from all TypeScript source files under src/.
 *
 * Run before every commit:
 *   bun scripts/fabrication-check.ts
 *
 * Exits 0 when clean. Exits 1 and prints every matching line when any pattern
 * fires, so the CI gate is a simple || exit 1 after this command.
 *
 * Patterns (verbatim from CLAUDE.md):
 *
 *   1. `x || new Date()` — stamps NOW onto an undated record.
 *   2. A string literal fallback that renders as a measurement.
 *   3. `?? 0` / `|| 0` — flattens unreported into measured zero.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { existsSync } from "node:fs";

const SRC = "src";

if (!existsSync(SRC)) {
  console.error(`fabrication-check: '${SRC}' directory not found. Run from repo root.`);
  process.exit(1);
}

interface Check {
  name: string;
  regex: RegExp;
  note: string;
}

const CHECKS: Check[] = [
  {
    name: "timestamp-invention",
    regex: /\|\| new Date\(\)/,
    note: "stamps NOW onto an undated record — use null instead",
  },
  {
    name: "string-literal-as-measurement",
    // Matches || "UpperCase..." — looks like data but is an invented default.
    // Honest absence markers (|| "—", || "not reported") are lowercase or punctuation.
    regex: /\|\|\s*"[A-Z]/,
    note: "string literal fallback renders as a measurement — use null or a lowercase absence marker",
  },
  {
    name: "numeric-zero-flattening",
    regex: /\?\?\s*0\b|\|\|\s*0\b/,
    note: "numeric zero flattens unreported into measured zero — use null for unmeasured values",
  },
];

/** Recursively collect all .ts / .tsx files under a directory. */
function collectFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...collectFiles(full));
    } else if (full.endsWith(".ts") || full.endsWith(".tsx")) {
      results.push(full);
    }
  }
  return results;
}

const files = collectFiles(SRC);
let totalMatches = 0;

for (const check of CHECKS) {
  const matchingLines: string[] = [];

  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    const lines = content.split("\n");
    lines.forEach((line, idx) => {
      if (check.regex.test(line)) {
        matchingLines.push(`${relative(".", file)}:${idx + 1}: ${line.trim()}`);
      }
    });
  }

  if (matchingLines.length > 0) {
    totalMatches += matchingLines.length;
    console.error(`\n\u274c  [${check.name}] ${matchingLines.length} match(es) — ${check.note}`);
    for (const line of matchingLines) {
      console.error(`   ${line}`);
    }
  } else {
    console.log(`\u2705  [${check.name}] clean`);
  }
}

console.log("");
if (totalMatches > 0) {
  console.error(
    `fabrication-check FAILED — ${totalMatches} match(es) across ${CHECKS.length} patterns.\n` +
      `Fix the listed lines before committing. See CLAUDE.md for the rationale.`,
  );
  process.exit(1);
} else {
  console.log("fabrication-check passed — all patterns clean.");
  process.exit(0);
}
