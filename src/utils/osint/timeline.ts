/**
 * Investigation-wide evidence timeline (2026-08-30, ported from the teammate's fork).
 *
 * The design here closes on three words: **"Do not invent dates."**
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CENTRAL DISTINCTION: RETRIEVED-AT IS NOT OBSERVED-AT.
 *
 * `CollectorEvidence.collectedAt` is mandatory and always present — it is when
 * *Sentinel* fetched the record. It is NOT when the thing happened. A Wayback
 * capture from 2014 retrieved today has `collectedAt` of today and a real
 * observation time of 2014; an article has a publication date; a DNS answer has
 * no meaningful observation time at all.
 *
 * The tempting implementation — plot everything by `collectedAt` — produces a
 * timeline where every event in an investigation happened in the last five
 * seconds. It would be perfectly consistent, entirely useless, and quietly
 * false. The equally tempting fix — silently falling back to `collectedAt` when
 * the real date is missing — is worse, because it *looks* like a finding.
 *
 * So every event carries BOTH times plus a `basis` field naming which one it is
 * ordered by. `basis: "retrieved"` means "we do not know when this happened and
 * are positioning it by when we fetched it". That is a caveat the UI must show,
 * not a detail it may drop, and `summary.undated` exists so a reader is told how
 * much of the timeline rests on it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NO SECOND EVIDENCE MODEL. This module reads `CollectorEvidence` and adds
 * nothing to it. The only contract change this required was one optional
 * `evidenceId` field on the existing schema.
 *
 * WHY OBSERVED-AT IS EXTRACTED FROM A FIXED KEY LIST. The contract types
 * `normalizedValue`/`metadata` as `unknown` on purpose — collector provenance
 * data is genuinely heterogeneous. Rather than widen the frozen contract, this
 * module reads a short, explicit, documented list of keys (`OBSERVED_AT_KEYS`)
 * and validates each candidate is a real ISO instant before using it. A key that
 * is absent, empty, malformed or not a string yields `null` — never a guess,
 * never a partial parse. Adding a collector that carries its observation time
 * under a new key means adding that key here, deliberately, with a test.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NOT THE MEDIA/STORY TIMELINE. `analysis.ts`'s `buildTimeline()` is a different
 * object entirely: per news-story cluster, over `Article.pubDate`, part of PS-18
 * Module 2. It is untouched, and the two must not be merged — one describes how
 * a story was covered, this one describes when an investigation's evidence was
 * observed. Two things called "timeline" that mean different things stay apart.
 */

import type { ClaimClass, ConfidenceBand, ConfidenceScore, CollectorEvidence } from "../collectors/result";
import { confidenceBandOf } from "../collectors/result";

// ─── Reading an observation time out of heterogeneous evidence ──────────────

/**
 * Keys checked, in priority order, on `normalizedValue` then `metadata`.
 *
 * Every entry is here because a real collector in this repo emits it:
 *   - `capturedAt`    — Wayback (`collectors/existing/wayback.ts`)
 *   - `publishedTime` — Jina Reader
 *   - `publishedAt` / `pubDate` — the news/article family
 *   - `observedAt`    — the generic name a future collector should prefer
 *   - `date`          — last resort, and only when it parses as a full ISO instant
 */
export const OBSERVED_AT_KEYS = [
  "observedAt",
  "capturedAt",
  "publishedAt",
  "publishedTime",
  "pubDate",
  "date",
] as const;

/**
 * True only for a string that is a real, fully-specified ISO 8601 date or instant.
 *
 * Deliberately strict. `Date.parse` accepts "2020", "March 2020" and a pile of
 * locale formats, happily turning a partial or non-date into a confident
 * timestamp — the exact fabrication this module exists to prevent. A bare year is
 * not an instant, and a timeline that places it on 1 January is asserting a day
 * it was never told.
 */
export function isIsoInstant(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 10) return false;
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/.test(value)) {
    return false;
  }
  return !Number.isNaN(Date.parse(value));
}

function readBag(bag: unknown): string | null {
  if (!bag || typeof bag !== "object" || Array.isArray(bag)) return null;
  const record = bag as Record<string, unknown>;
  for (const key of OBSERVED_AT_KEYS) {
    const candidate = record[key];
    if (isIsoInstant(candidate)) return new Date(candidate).toISOString();
  }
  return null;
}

/**
 * The real-world time this evidence describes, or `null` when the collector did
 * not supply one. **Never falls back to `collectedAt`.**
 */
export function observedAtOf(evidence: CollectorEvidence): string | null {
  return readBag(evidence.normalizedValue) ?? readBag(evidence.metadata);
}

// ─── Reading the subject and the assertion ──────────────────────────────────

/** The thing this evidence is about, or null when the collector did not name one. */
export function entityOf(evidence: CollectorEvidence): string | null {
  const bag = evidence.normalizedValue;
  if (typeof bag === "string" && bag.trim()) return bag.trim();
  if (!bag || typeof bag !== "object" || Array.isArray(bag)) return null;
  const record = bag as Record<string, unknown>;
  for (const key of ["entity", "url", "value", "domain", "host", "ip"]) {
    const v = record[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

const CLAIM_MAX = 160;

/**
 * A compact rendering of what the evidence asserts.
 *
 * A faithful projection of `normalizedValue`, never a generated description — it
 * prints the collector's own scalars. Returns the honest marker
 * `"(no normalized value reported)"` rather than an invented summary when there
 * is nothing to render; that string is an absence marker, not a measurement.
 */
export function claimOf(evidence: CollectorEvidence): string {
  const bag = evidence.normalizedValue;
  if (typeof bag === "string" && bag.trim()) return bag.trim().slice(0, CLAIM_MAX);
  if (bag === null || bag === undefined) return "(no normalized value reported)";
  if (typeof bag !== "object") return String(bag).slice(0, CLAIM_MAX);
  if (Array.isArray(bag)) return `${bag.length} item(s)`;

  const record = bag as Record<string, unknown>;
  if (typeof record.claim === "string" && record.claim.trim()) {
    return record.claim.trim().slice(0, CLAIM_MAX);
  }
  const parts: string[] = [];
  for (const [k, v] of Object.entries(record)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "object") continue;
    parts.push(`${k}=${String(v)}`);
    if (parts.join(" · ").length >= CLAIM_MAX) break;
  }
  return parts.length ? parts.join(" · ").slice(0, CLAIM_MAX) : "(no normalized value reported)";
}

// ─── Events ─────────────────────────────────────────────────────────────────

export type TimestampType = "observed" | "retrieved";

export interface TimelineEvent {
  /**
   * Positional reference back to the source record: `${collector}#${index}`.
   * A reference key, not a claim about the record — distinct from `evidenceId`,
   * which is only present when the collector actually supplied one.
   */
  eventRef: string;
  /** A stable per-record handle, when the collector supplied one. Null otherwise — never minted. */
  evidenceId: string | null;
  /** Index into the evidence array this came from. */
  evidenceIndex: number;

  /** The subject of the observation. Null when the collector named none. */
  entity: string | null;
  /** What the evidence asserts, projected from its normalized value. */
  claim: string;

  source: string;
  sourceUrl: string | null;
  collector: string;

  /** The timestamp this event is ordered by. */
  at: string;
  /**
   * Which field `at` came from. `"retrieved"` means the real date is unknown and
   * this is a retrieval time standing in for position only — a UI must say so.
   */
  timestampType: TimestampType;
  /** When the thing actually happened. Null when the collector did not report it. */
  observedAt: string | null;
  /** When Sentinel fetched the record. Always present. */
  retrievedAt: string;

  claimClass: ClaimClass | null;
  confidence: ConfidenceScore | null;
  /** Derived band. Null when confidence was never measured — never flattened to LOW. */
  confidenceBand: ConfidenceBand | null;
}

export interface TimelineSummary {
  total: number;
  /** Events positioned by a real observation time. */
  dated: number;
  /**
   * Events with no known observation time, positioned by retrieval time. Reported
   * because a timeline that is 90% retrieval stamps is a different object from one
   * that is 90% real dates, and the reader must be able to tell.
   */
  undated: number;
  /** Earliest and latest REAL observation times across the investigation. Null when nothing was dated. */
  firstObserved: string | null;
  lastObserved: string | null;
  /** Earliest and latest retrieval times. Always present when there is any evidence. */
  firstRetrieved: string | null;
  lastRetrieved: string | null;
  collectors: string[];
  /** How many events carry no measured confidence. */
  unscored: number;
}

export interface EvidenceTimeline {
  events: TimelineEvent[];
  summary: TimelineSummary;
  /** Surfaced verbatim by any UI that renders this. */
  caveats: string[];
}

export const TIMELINE_CAVEATS: string[] = [
  "Retrieved-at is when Sentinel fetched a record. It is not when the thing happened — events marked RETRIEVED are positioned by it only because no real date was reported.",
  "A missing observation time is a gap in what the source published, not evidence that the event is recent.",
  "First/last seen cover only the evidence in this investigation, and only the part of it that carried a real date.",
  "Collectors that cap their results (Wayback, crt.sh) bound the range they can report — see each collector's own warnings.",
  "Two sources disagreeing at different times are both kept. Ordering is not adjudication — see the contradiction engine for conflicts.",
];

/**
 * Builds the timeline. Pure: same input, same output, and **no clock read** — a
 * function that consults `Date.now()` could not be tested for the very property
 * this module exists to guarantee.
 *
 * Ordering is oldest-first and fully deterministic; ties break on collector then
 * evidence index, so two runs over one investigation cannot produce differently
 * ordered timelines for a reader to diff.
 */
export function buildEvidenceTimeline(evidence: readonly CollectorEvidence[]): EvidenceTimeline {
  const events: TimelineEvent[] = evidence.map((ev, evidenceIndex) => {
    const observedAt = observedAtOf(ev);
    const confidence = ev.confidence ?? null;
    return {
      eventRef: `${ev.collector}#${evidenceIndex}`,
      evidenceId: ev.evidenceId ?? null,
      evidenceIndex,
      entity: entityOf(ev),
      claim: claimOf(ev),
      source: ev.source,
      sourceUrl: ev.sourceUrl,
      collector: ev.collector,
      at: observedAt ?? ev.collectedAt,
      timestampType: observedAt ? ("observed" as const) : ("retrieved" as const),
      observedAt,
      retrievedAt: ev.collectedAt,
      claimClass: ev.claimClass ?? null,
      confidence,
      confidenceBand: confidenceBandOf(confidence, ev.claimClass),
    };
  });

  events.sort(
    (a, b) =>
      a.at.localeCompare(b.at) ||
      a.collector.localeCompare(b.collector) ||
      a.evidenceIndex - b.evidenceIndex,
  );

  const observed = events.filter((e) => e.observedAt !== null).map((e) => e.observedAt!).sort();
  const retrieved = events.map((e) => e.retrievedAt).sort();

  return {
    events,
    summary: {
      total: events.length,
      dated: observed.length,
      undated: events.length - observed.length,
      firstObserved: observed[0] ?? null,
      lastObserved: observed[observed.length - 1] ?? null,
      firstRetrieved: retrieved[0] ?? null,
      lastRetrieved: retrieved[retrieved.length - 1] ?? null,
      collectors: [...new Set(events.map((e) => e.collector))].sort(),
      unscored: events.filter((e) => e.confidenceBand === null).length,
    },
    caveats: TIMELINE_CAVEATS,
  };
}

// ─── Per-entity spans — "first seen" / "last seen" ──────────────────────────

export interface EntitySpan {
  entity: string;
  /** Earliest REAL observation. Null when every observation of this entity was undated. */
  firstSeen: string | null;
  lastSeen: string | null;
  /** Earliest/latest retrieval, which is always known. */
  firstRetrieved: string;
  lastRetrieved: string;
  observations: number;
  /** How many of this entity's observations carried no real date. */
  undated: number;
  collectors: string[];
  /** True when more than one collector reported this entity — a corroboration signal. */
  multiSource: boolean;
}

/**
 * First/last seen per entity.
 *
 * Returns `firstSeen: null` rather than omitting an entity seen only in undated
 * evidence — "we have three observations of this and no dates for any of them" is
 * a real, reportable state, and dropping it would silently shrink the entity list
 * a reader is looking at.
 *
 * Duplicate observations of the same entity are COUNTED, not collapsed: two
 * collectors reporting the same URL is corroboration, and deduplicating here
 * would erase the signal `multiSource` exists to carry.
 */
export function entitySpans(evidence: readonly CollectorEvidence[]): EntitySpan[] {
  const byEntity = new Map<
    string,
    { dates: string[]; retrieved: string[]; undated: number; collectors: Set<string>; total: number }
  >();

  for (const ev of evidence) {
    const key = entityOf(ev);
    if (!key) continue;

    let bucket = byEntity.get(key);
    if (!bucket) {
      bucket = { dates: [], retrieved: [], undated: 0, collectors: new Set(), total: 0 };
      byEntity.set(key, bucket);
    }
    bucket.total += 1;
    bucket.retrieved.push(ev.collectedAt);
    bucket.collectors.add(ev.collector);
    const observedAt = observedAtOf(ev);
    if (observedAt) bucket.dates.push(observedAt);
    else bucket.undated += 1;
  }

  return [...byEntity.entries()]
    .map(([entity, b]) => {
      const dates = [...b.dates].sort();
      const retrieved = [...b.retrieved].sort();
      return {
        entity,
        firstSeen: dates[0] ?? null,
        lastSeen: dates[dates.length - 1] ?? null,
        firstRetrieved: retrieved[0]!,
        lastRetrieved: retrieved[retrieved.length - 1]!,
        observations: b.total,
        undated: b.undated,
        collectors: [...b.collectors].sort(),
        multiSource: b.collectors.size > 1,
      };
    })
    .sort((a, b) => a.entity.localeCompare(b.entity));
}

// ─── Buckets, for a scan-read ───────────────────────────────────────────────

export interface TimelineBucket {
  /** `YYYY`. */
  key: string;
  count: number;
}

/**
 * Yearly counts of DATED events only.
 *
 * Undated events are deliberately excluded rather than bucketed at their
 * retrieval year, which would pile them all into the current year and invent a
 * spike describing our own collection run rather than the target.
 */
export function bucketByYear(timeline: EvidenceTimeline): TimelineBucket[] {
  const counts = new Map<string, number>();
  for (const e of timeline.events) {
    if (e.timestampType !== "observed" || !e.observedAt) continue;
    const year = e.observedAt.slice(0, 4);
    counts.set(year, (counts.get(year) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => a.key.localeCompare(b.key));
}
