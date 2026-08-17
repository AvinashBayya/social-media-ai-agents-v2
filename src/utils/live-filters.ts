/**
 * Date-window filtering for the Live Monitoring feed.
 *
 * Extracted from `routes/live.tsx` so the predicate can be tested. A route file
 * calls `createFileRoute` at module load and so cannot be imported by `bun test`
 * — the same reason `osint-summary.ts` exists.
 *
 * Two things here are deliberate and must not be "tidied away":
 *
 *  1. **An undated item passes every window.** Google News RSS publishes items
 *     with no `pubDate`, and `live.tsx` maps those to `null` rather than
 *     stamping the moment of collection onto them. Dropping them from a date
 *     filter would silently delete real reporting on the grounds of a field the
 *     publisher never supplied — so they are kept, and the card renders "no date
 *     reported" beside them.
 *
 *  2. **"Any time" is a real window, not a missing key.** The previous select
 *     offered 24h / 7d / 30d only, and the predicate happened to no-op for an
 *     unrecognised value. Relying on that meant the widest setting worked by
 *     accident; `hours: null` states it.
 */

export interface DateWindow {
  id: string;
  label: string;
  /** Null means no cutoff at all. */
  hours: number | null;
}

export const DATE_WINDOWS: DateWindow[] = [
  { id: "24h", label: "Last 24 hours", hours: 24 },
  { id: "7d", label: "Last 7 days", hours: 24 * 7 },
  { id: "30d", label: "Last 30 days", hours: 24 * 30 },
  { id: "any", label: "Any time", hours: null },
];

export const DEFAULT_WINDOW_ID = "24h";

/**
 * Cutoff for a window id, in hours.
 *
 * Null for "any time" AND for an unknown id — an id we do not recognise must not
 * silently discard items, so it fails open.
 */
export function windowHours(windowId: string): number | null {
  const w = DATE_WINDOWS.find((x) => x.id === windowId);
  return w ? w.hours : null;
}

/**
 * Does this item fall inside the selected window?
 *
 * `nowMs` is passed in rather than read from `Date.now()` so the predicate is
 * deterministic under test.
 */
export function withinWindow(pubDate: string | null, windowId: string, nowMs: number): boolean {
  const hours = windowHours(windowId);
  if (hours === null) return true;
  if (!pubDate) return true;

  const published = new Date(pubDate).getTime();
  // An unparseable date is not a date. Treat it exactly like an absent one.
  if (!Number.isFinite(published)) return true;

  const age = nowMs - published;
  // A future-dated item is kept. Publishers do post ahead, and dropping it here
  // would hide a real record on the strength of a clock difference.
  if (age < 0) return true;

  return age <= hours * 3_600_000;
}

/**
 * The note shown under the window select.
 *
 * The Google News search feed carries no date parameter and runs roughly a day
 * deep, so widening the window filters what has already been collected — it
 * cannot reach back for older material. Saying so stops "Any time" from reading
 * as a historical search this collector cannot perform.
 */
export const WINDOW_REACH_NOTE =
  "Widening the window filters what has already been collected. The Google News " +
  "search feed carries no date parameter and runs roughly 24 hours deep, so a " +
  "longer window cannot fetch older items.";
