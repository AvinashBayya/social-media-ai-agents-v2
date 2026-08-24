import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The client bundle must never contain a live secret.
 *
 * Vite replaces `process.env` with `{}` in the client graph, so `llm.ts`'s
 * provider lookup compiles to `{}.LLM_API_KEY` and no key value survives. That
 * is a property of the BUILD, not of the source, and it holds only for as long
 * as nobody reads a secret through `import.meta.env` — which Vite DOES inline,
 * verbatim, into the shipped JavaScript. One `VITE_`-prefixed rename is all it
 * would take.
 *
 * ── WHY THIS SCANS FOR REAL VALUES AND NOT FOR PATTERNS ───────────────────
 *
 * A naive `/sk_[a-z0-9]{8,}|gsk_[A-Za-z0-9]{20,}/` sweep over `.output/public`
 * reports two hits on a clean build. Both are random byte runs inside
 * `toolkit_bg.wasm` and `c2pa.worker.min.js` — the Content Credentials engine,
 * a vendored binary. A check that cries wolf on every run is a check people
 * learn to ignore, so this compares against the ACTUAL configured secrets
 * instead. Zero false positives, and it catches the case that matters: a real
 * key reaching the browser.
 */

const BUILD_DIR = join(import.meta.dir, "..", ".output", "public");

/** Env vars whose values must never appear in client-side code. */
const SECRET_ENV_VARS = [
  "LLM_API_KEY",
  "LLM_FALLBACK_KEY",
  "REDDIT_CLIENT_SECRET",
  "BLUESKY_APP_PASSWORD",
  "MASTODON_ACCESS_TOKEN",
  "GITHUB_TOKEN",
  "UCDP_API_TOKEN",
  "YOUTUBE_API_KEY",
  "WORLDMONITOR_API_KEY",
  "SENTINEL_OPERATOR_TOKEN",
  "SESSION_SECRET",
  "DATABASE_URL",
];

/** Text assets only — a WASM blob is not something a secret hides in usefully. */
const TEXT_EXTENSIONS = [".js", ".mjs", ".css", ".html", ".json", ".map"];

function collectTextFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) collectTextFiles(full, acc);
    else if (TEXT_EXTENSIONS.some((e) => name.endsWith(e))) acc.push(full);
  }
  return acc;
}

/**
 * Secrets configured in THIS environment. A value shorter than 12 characters is
 * skipped — a short placeholder like "test" would match half the bundle and
 * tell us nothing.
 */
function configuredSecrets(): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  for (const name of SECRET_ENV_VARS) {
    const value = (process.env[name] ?? "").trim();
    if (value.length >= 12) out.push({ name, value });
  }

  // The repo's own .env is not loaded into `process.env` by `bun test`, but it
  // is exactly the file whose values would leak on a local build, so read it
  // directly when present.
  const envFile = join(import.meta.dir, "..", ".env");
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf-8").split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
      if (!m) continue;
      const [, name, raw] = m;
      const value = raw.replace(/^["']|["']$/g, "").trim();
      if (SECRET_ENV_VARS.includes(name) && value.length >= 12) out.push({ name, value });
    }
  }

  return out;
}

describe("built client bundle", () => {
  const files = collectTextFiles(BUILD_DIR);

  it.skipIf(files.length === 0)("contains no configured secret value", () => {
    const secrets = configuredSecrets();
    const leaks: string[] = [];

    for (const file of files) {
      const contents = readFileSync(file, "utf-8");
      for (const { name, value } of secrets) {
        // Never put the secret itself in the failure message.
        if (contents.includes(value)) leaks.push(`${name} appears in ${file}`);
      }
    }

    expect(leaks).toEqual([]);
  });

  it.skipIf(files.length === 0)(
    "reads server-only env through process.env, which Vite neutralises to {}",
    () => {
      // `llm.ts` ships to the browser because six client modules import it. That
      // is tolerable only while its env access compiles away. If this fails,
      // something switched to `import.meta.env`, which Vite INLINES.
      const withEnvAccess = files.filter((f) => {
        const c = readFileSync(f, "utf-8");
        return c.includes("LLM_API_KEY") || c.includes("LLM_FALLBACK_KEY");
      });

      for (const file of withEnvAccess) {
        const contents = readFileSync(file, "utf-8");
        expect(contents).not.toMatch(/import\.meta\.env\.LLM_/);
        expect(contents).not.toMatch(/import\.meta\.env\.VITE_LLM/);
      }
    },
  );
});
