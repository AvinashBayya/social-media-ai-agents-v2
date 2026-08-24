/**
 * Timeline — pure logic for building a chronology from real, already-
 * collected records (adopting sosint's Module 12 in spirit — pattern only,
 * no code). No DOM, no network; the React component that renders this lives
 * in src/components/timeline.tsx, matching this project's imaging.ts /
 * imaging-client.ts split (pure vs DOM-touching).
 *
 * Every entry traces to a real source: a GDELT Events GeoRecord or a
 * NewsItem from news-aggregation.ts. There is no synthetic/canned entry
 * type — an empty input produces an empty timeline, never a placeholder.
 */

import type { GeoRecord } from "./geo";
import type { NewsItem } from "./news-aggregation";

export type TimelineEntryKind = "event" | "news";

export interface TimelineEntry {
  id: string;
  /** Null when the source carried no usable date — sorts after every dated entry, never at "now". */
  timestamp: string | null;
  title: string;
  sourceLabel: string;
  sourceUrl: string;
  kind: TimelineEntryKind;
  detail: string | null;
}

/** GDELT Events records (layer "gdeltEvents") -> timeline entries. */
export function timelineFromGdeltEvents(records: GeoRecord[]): TimelineEntry[] {
  return records
    .filter((r) => r.layer === "gdeltEvents")
    .map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      title: r.title,
      sourceLabel: r.source,
      sourceUrl: r.url,
      kind: "event" as const,
      detail: r.locates,
    }));
}

/** RSS aggregation items -> timeline entries. */
export function timelineFromNewsItems(items: NewsItem[]): TimelineEntry[] {
  return items.map((it) => ({
    id: it.link,
    timestamp: it.publishedAt,
    title: it.title,
    sourceLabel: it.source,
    sourceUrl: it.link,
    kind: "news" as const,
    detail: it.summary,
  }));
}

/**
 * Merges entry lists and sorts newest-first. Undated entries sort after
 * every dated one — the same rule geo.ts's `iso()` and news-aggregation.ts's
 * sort use: null means not measured, never a fabricated instant.
 */
export function mergeTimeline(...entryLists: TimelineEntry[][]): TimelineEntry[] {
  const all = entryLists.flat();
  all.sort((a, b) => {
    if (a.timestamp && b.timestamp) return b.timestamp.localeCompare(a.timestamp);
    if (a.timestamp) return -1;
    if (b.timestamp) return 1;
    return 0;
  });
  return all;
}
