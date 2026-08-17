/**
 * Guards against the probe/collector drift that made /crawlers lie about GPSJam.
 *
 * THE BUG. `collector-health.ts` probed `https://gpsjam.org/data/latest.json`, a
 * URL that has never existed and answers 404, so the status page rendered
 * "NO RESPONSE · HTTP 404" for a collector that works. `gps-interference.ts`'s
 * own header had ALREADY recorded that `latest.json` 404s and had moved the
 * real collector onto `/data/<YYYY-MM-DD>-h3_4.csv` — only the probe was never
 * updated to match. Found on the deployed app 2026-08-17.
 *
 * WHY THESE ASSERTIONS AND NOT A LIVE PROBE TEST. `probeCollectors()` makes
 * fifteen real network requests; the rest of this suite is offline and must
 * stay that way. What is worth locking down is not "gpsjam.org is up today" —
 * that is the probe's job at runtime — but the two structural properties whose
 * absence caused the bug: the dead URL is gone, and the probe derives its URL
 * from the collector's own builder instead of keeping a second copy.
 *
 * Source-text assertions are used elsewhere in this project for exactly this
 * shape of guarantee (see the Ultralytics/AGPL licence trap asserted against
 * `imaging.ts`).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { gpsJamUrlForDate } from "../src/utils/gps-interference";

const HEALTH_SRC = readFileSync(
  join(import.meta.dir, "..", "src", "utils", "collector-health.ts"),
  "utf-8",
);

/**
 * Assertions must target CODE, not prose.
 *
 * The first version of this test grepped the raw file and failed on its own
 * fix: the doc comment explaining the bug necessarily quotes the dead
 * `latest.json` URL. In a codebase whose comments carry this much of the
 * reasoning, a raw-source guard collides with the documentation every time.
 *
 * The line-comment pattern deliberately refuses to strip a `//` preceded by
 * `:` — otherwise every `https://` in the file truncates its own line and the
 * guard silently stops seeing the code it exists to check.
 */
const HEALTH_CODE = HEALTH_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(
  /(^|[^:])\/\/.*$/gm,
  "$1",
);

describe("gpsJamUrlForDate", () => {
  test("builds the dated daily-CSV path GPSJam actually publishes", () => {
    expect(gpsJamUrlForDate(new Date("2026-08-16T00:00:00Z"))).toBe(
      "https://gpsjam.org/data/2026-08-16-h3_4.csv",
    );
  });

  test("keys on the UTC day, not the local one", () => {
    // 23:30 UTC on the 16th is already the 17th in IST (UTC+5:30). The feed is
    // published per UTC day, so a local-date implementation would ask for a
    // file that does not exist yet for half of every Indian evening.
    expect(gpsJamUrlForDate(new Date("2026-08-16T23:30:00Z"))).toContain("2026-08-16");
  });

  test("zero-pads single-digit months and days", () => {
    expect(gpsJamUrlForDate(new Date("2026-01-05T12:00:00Z"))).toBe(
      "https://gpsjam.org/data/2026-01-05-h3_4.csv",
    );
  });
});

describe("collector-health does not drift from the GPSJam collector", () => {
  test("the dead latest.json endpoint is gone from the code", () => {
    // The exact string that produced a permanent false "HTTP 404" on /crawlers.
    expect(HEALTH_CODE).not.toContain("gpsjam.org/data/latest.json");
  });

  test("the probe reuses the collector's url builder rather than a second copy", () => {
    expect(HEALTH_CODE).toContain("gpsJamUrlForDate");
    // A hand-rolled duplicate of the path would reintroduce the drift while
    // appearing to fix the symptom.
    expect(HEALTH_CODE).not.toContain("-h3_4.csv");
  });

  test("a missing current-day file is not reported as an outage", () => {
    // GPSJam's current-day file legitimately 404s until the day is under way
    // (measured 2026-08-17: today 404, yesterday 200). The probe must fall back
    // rather than invent a fresh false alarm every morning.
    expect(HEALTH_CODE).toMatch(/86_400_000|86400000/);
    expect(HEALTH_CODE).toContain("yesterday");
  });

  test("the shared url module stays dependency-free", () => {
    // THE INVARIANT THAT KEEPS THE FIX SAFE. Importing gpsJamUrlForDate from
    // gps-interference.ts directly made that file a module shared by two
    // chunks, so Rollup hoisted it into a common SSR chunk that transitively
    // reached osint/job-store-sqlite.ts and its `bun:sqlite` import. The
    // runtime image is node:22-alpine, which cannot load a `bun:` specifier, so
    // every collectorHealth call answered HTTP 500 with
    // ERR_UNSUPPORTED_ESM_URL_SCHEME — reproduced against the production build
    // and seen live on v28.
    //
    // A leaf module with zero imports cannot drag anything into a shared chunk.
    // Add an import to gpsjam-url.ts and that protection is gone.
    const urlSrc = readFileSync(
      join(import.meta.dir, "..", "src", "utils", "gpsjam-url.ts"),
      "utf-8",
    );
    const urlCode = urlSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(urlCode).not.toMatch(/^\s*import\s/m);
    expect(urlCode).not.toMatch(/\brequire\s*\(/);
    // And collector-health must reach it directly, not via gps-interference.
    expect(HEALTH_CODE).toContain('from "./gpsjam-url"');
    expect(HEALTH_CODE).not.toContain('from "./gps-interference"');
  });

  test("the comment stripper does not eat code containing a URL", () => {
    // Guards the guard: a naive `//` strip truncates at every `https://`, which
    // would make the assertions above vacuously pass on an empty string.
    expect(HEALTH_CODE).toContain("https://t.me/s/BNONews");
    expect(HEALTH_CODE.length).toBeGreaterThan(2000);
  });
});
