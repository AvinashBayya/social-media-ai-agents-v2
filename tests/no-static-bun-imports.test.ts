/**
 * `bun:` specifiers must never be statically imported.
 *
 * THE BUG THIS EXISTS TO PREVENT, WHICH SHIPPED THREE TIMES.
 *
 * `job-store-sqlite.ts` had `import { Database } from "bun:sqlite"` at module
 * scope. The production image is `node:22-alpine` running
 * `node .output/server/index.mjs`, and Node's ESM loader throws
 * ERR_UNSUPPORTED_ESM_URL_SCHEME on a `bun:` specifier at LINK time — before
 * any runtime guard in any caller can run. So every chunk that merely
 * referenced that module took the server function down with it:
 *
 *   1. Into the browser bundle, crashing every route.
 *   2. Via collector-health.ts -> gps-interference.ts, HTTP 500 on /crawlers.
 *   3. Via the OSINT collector barrel, HTTP 500 again.
 *
 * Each time the fix was to move the innocent import. The actual cause was that
 * the cost is paid on IMPORT, not on call, so guarding the call never helped.
 *
 * `bun test` and `tsc --noEmit` are both blind to this — it exists only in the
 * bundle, and `bun test` runs under Bun where `bun:sqlite` resolves fine. That
 * is why this is a source-text assertion.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Strip comments so the prose explaining the hazard does not trip the check. */
function codeOf(file: string): string {
  return readFileSync(file, "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("no module statically imports a bun: builtin", () => {
  const files = walk(SRC);

  test("the sweep actually found source files", () => {
    // Guard the guard: an empty file list would make everything below pass.
    expect(files.length).toBeGreaterThan(50);
  });

  test.each(files.map((f) => [f.replace(SRC, "src"), f] as const))(
    "%s",
    (_label, file) => {
      const code = codeOf(file);
      // A VALUE import. `import type { X } from "bun:sqlite"` is erased at
      // build and is therefore safe — job-store-sqlite.ts relies on exactly
      // that for its typing.
      const staticValueImport = /^\s*import\s+(?!type\s)[^;]*?from\s*["']bun:[^"']+["']/m;
      const bareImport = /^\s*import\s*["']bun:[^"']+["']/m;
      expect(code).not.toMatch(staticValueImport);
      expect(code).not.toMatch(bareImport);
    },
  );
});
