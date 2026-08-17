/**
 * The GPSJam feed URL, and nothing else.
 *
 * WHY THIS IS ITS OWN FILE, AND WHY IT MUST STAY DEPENDENCY-FREE.
 *
 * `collector-health.ts` and `gps-interference.ts` both need this one string, and
 * they must not each keep a copy — a second copy is exactly how the probe came
 * to point at `gpsjam.org/data/latest.json` (a URL that never existed) while the
 * collector had already moved to the dated CSV, so `/crawlers` reported a
 * working collector as a 404.
 *
 * The obvious fix — importing it straight from `gps-interference.ts` — was tried
 * and REVERTED, because it broke the whole page:
 *
 *   Making `gps-interference.ts` a module shared by two chunks caused Rollup to
 *   hoist it into a common SSR chunk, and that chunk transitively reached
 *   `osint/job-store-sqlite.ts`, which imports **`bun:sqlite`**. The runtime
 *   image is `node:22-alpine` running `node .output/server/index.mjs`
 *   (see Dockerfile), and Node cannot load a `bun:` specifier, so every
 *   `collectorHealth` call answered **HTTP 500** with
 *   `ERR_UNSUPPORTED_ESM_URL_SCHEME`. Reproduced locally against the production
 *   build and observed live on the deployed app (v28).
 *
 * A leaf module with **zero imports** cannot drag anything into a shared chunk,
 * which is what makes the single-source-of-truth safe here. Keep it that way:
 * do not add an import to this file. If it needs one, the thing that needs the
 * import belongs somewhere else.
 *
 * This is the same hazard class as the `bun:sqlite` browser-bundle regression
 * recorded in PROJECT_MEMORY — a static edge to a runtime-specific module that
 * only fails once bundling decides to put it somewhere new.
 */

/**
 * GPSJam publishes one aggregate CSV per UTC day, named by date.
 *
 * UTC, not local: the file is keyed to the UTC day, so deriving it from a local
 * date asks for a file that does not exist yet for the whole of an Indian
 * evening (IST is UTC+5:30).
 *
 * The current day's file does not appear until the day is under way, so callers
 * must be prepared to fall back to the previous day — that is a normal state,
 * not a failure. Both `fetchGpsInterference()` and the `/crawlers` probe do so.
 */
export function gpsJamUrlForDate(date: Date): string {
  const iso = date.toISOString().slice(0, 10);
  return `https://gpsjam.org/data/${iso}-h3_4.csv`;
}
