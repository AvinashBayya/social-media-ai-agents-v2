/**
 * Wayback Machine adapter — OSINT-INTEGRATION-PLAN.md's existing collector pattern,
 * ported from a teammate's parallel fork (`social-media-ai-agents-2.3-main/`) which
 * had built this and `passive-policy.ts` against a "Passive OSINT Platform" spec this
 * project's own `docs/` does not carry. Ported for the collector itself, which stands
 * on its own merits regardless of that spec's adoption status here.
 *
 * WHAT IT READS. The CDX index (`web.archive.org/cdx/search/cdx`) — a public,
 * keyless query over the Internet Archive's own capture records. Nothing here
 * contacts the target directly; the archive already crawled these pages, and
 * Sentinel only reads the index of what exists. This is the highest-value free
 * source this project had zero occurrences of before this port.
 *
 * THE SAMPLING HONESTY PROBLEM, AND HOW IT IS HANDLED.
 *
 * A busy domain has millions of captures, so any real query is capped. That makes
 * `firstSeen`/`lastSeen` computed over the RETURNED ROWS, not over all history —
 * and reporting a sample's earliest capture as "first seen" would be a fabricated
 * measurement of exactly the kind this project polices. So:
 *
 *   - the metadata field is `sampleCapped`, set when the row count hits the limit;
 *   - a capped run emits a `warning` saying so in plain words;
 *   - `firstSeen`/`lastSeen` are named `firstSeenInSample`/`lastSeenInSample`
 *     whenever `sampleCapped` is true, so a reader cannot mistake one for the other.
 *
 * TIMESTAMPS. CDX returns `YYYYMMDDhhmmss` in UTC. `waybackTimestampToIso()`
 * returns `null` for anything it cannot parse — never `new Date()`. An unparseable
 * capture time is an unknown capture time.
 *
 * `claimClass` (the source fork's OBSERVED/DERIVED/CORRELATED/INFERRED taxonomy)
 * was NOT ported — that's a separate, larger subsystem on `CollectorEvidence` this
 * project's `result.ts` does not have, and porting one field without the type it
 * belongs to would either fail `tsc` or get silently stripped by zod. `ARCHIVED_AS`
 * WAS ported onto `RELATIONSHIP_TYPES` (additive, per that enum's own note) since
 * the edge itself needs no supporting subsystem.
 */

import type { Collector, CollectorRunOutcome, CollectorTarget } from "../types";
import { CollectorError } from "../errors";
import type {
  CollectorEntity,
  CollectorEvidence,
  CollectorRelationship,
  InvestigationResult,
} from "../result";
import { UNSCORED, emptyInvestigationResult } from "../result";
import { classifyError, finishExecution, normalizeGuard, startExecution } from "./shared";

const CDX_BASE = "https://web.archive.org/cdx/search/cdx";
const TIMEOUT_MS = 20_000;

/** Cap on rows requested. Not a finding limit — a request-size limit, always disclosed when reached. */
export const WAYBACK_ROW_LIMIT = 200;

export interface WaybackCapture {
  /** Raw CDX timestamp, `YYYYMMDDhhmmss`. Kept alongside the ISO form so the original is never lost. */
  timestamp: string;
  /** ISO 8601, or null when the raw timestamp could not be parsed. Never defaulted to now. */
  capturedAt: string | null;
  originalUrl: string;
  statusCode: string | null;
  mimeType: string | null;
  digest: string | null;
  /** The replay URL an analyst can open. Deterministic from timestamp + original. */
  snapshotUrl: string;
}

export interface WaybackRaw {
  query: string;
  captures: WaybackCapture[];
  sampleCapped: boolean;
}

// ─── Pure helpers (exported for direct testing) ─────────────────────────────

/**
 * `YYYYMMDDhhmmss` → ISO 8601 UTC, or `null`.
 *
 * Returns null rather than a partial guess on a short or malformed value. A
 * timestamp that cannot be read is unknown, and unknown must stay distinguishable
 * from a real date — the same rule the collector layer applies everywhere else.
 */
export function waybackTimestampToIso(raw: string): string | null {
  if (!/^\d{14}$/.test(raw)) return null;
  const [y, mo, d, h, mi, s] = [
    raw.slice(0, 4),
    raw.slice(4, 6),
    raw.slice(6, 8),
    raw.slice(8, 10),
    raw.slice(10, 12),
    raw.slice(12, 14),
  ];
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;
  // Guard against values that parse but roll over (month 13, day 32). Round-tripping
  // proves the components were real rather than merely numeric.
  return new Date(parsed).toISOString() === iso ? iso : null;
}

export function snapshotUrlFor(timestamp: string, originalUrl: string): string {
  return `https://web.archive.org/web/${timestamp}/${originalUrl}`;
}

/**
 * CDX JSON is a header row followed by value rows. Parsed positionally against the
 * header rather than by fixed index, so a column order change upstream does not
 * silently shift every field by one.
 */
export function parseCdxRows(payload: unknown): WaybackCapture[] {
  if (!Array.isArray(payload) || payload.length < 2) return [];
  const header = payload[0];
  if (!Array.isArray(header)) return [];

  const col = (name: string) => header.findIndex((h) => String(h) === name);
  const iTimestamp = col("timestamp");
  const iOriginal = col("original");
  const iStatus = col("statuscode");
  const iMime = col("mimetype");
  const iDigest = col("digest");

  // Without these two there is no capture to speak of. Refuse rather than emit
  // rows with invented positions.
  if (iTimestamp === -1 || iOriginal === -1) return [];

  const out: WaybackCapture[] = [];
  for (const row of payload.slice(1)) {
    if (!Array.isArray(row)) continue;
    const timestamp = String(row[iTimestamp] ?? "");
    const originalUrl = String(row[iOriginal] ?? "");
    if (!timestamp || !originalUrl) continue;

    const cell = (i: number): string | null => {
      if (i === -1) return null;
      const v = row[i];
      if (v === undefined || v === null) return null;
      const s = String(v).trim();
      // CDX writes "-" for an absent value. Rendering that as a measurement
      // would be a string literal standing in for a fact.
      return s && s !== "-" ? s : null;
    };

    out.push({
      timestamp,
      capturedAt: waybackTimestampToIso(timestamp),
      originalUrl,
      statusCode: cell(iStatus),
      mimeType: cell(iMime),
      digest: cell(iDigest),
      snapshotUrl: snapshotUrlFor(timestamp, originalUrl),
    });
  }
  return out;
}

export interface CaptureSpan {
  firstSeen: string | null;
  lastSeen: string | null;
  /** Captures whose timestamp could not be parsed — counted, never dropped silently. */
  undatedCount: number;
}

/** Min/max over the captures that actually carry a readable date. */
export function captureSpan(captures: readonly WaybackCapture[]): CaptureSpan {
  const dated = captures.map((c) => c.capturedAt).filter((v): v is string => v !== null);
  const undatedCount = captures.length - dated.length;
  if (dated.length === 0) return { firstSeen: null, lastSeen: null, undatedCount };
  const sorted = [...dated].sort();
  return { firstSeen: sorted[0]!, lastSeen: sorted[sorted.length - 1]!, undatedCount };
}

function cdxUrlFor(target: CollectorTarget): string {
  const value = target.value.trim();
  // A domain query covers the host and every path beneath it; a URL query is exact.
  const urlParam = target.type === "domain" ? `${value}/*` : value;
  const params = new URLSearchParams({
    url: urlParam,
    output: "json",
    fl: "timestamp,original,statuscode,mimetype,digest",
    collapse: "urlkey",
    limit: String(WAYBACK_ROW_LIMIT),
  });
  return `${CDX_BASE}?${params.toString()}`;
}

// ─── Collector ──────────────────────────────────────────────────────────────

export const waybackCollector: Collector<WaybackRaw> = {
  id: "wayback",
  name: "Wayback Machine (CDX)",
  category: "search",
  supportedTargetTypes: ["domain", "url"],
  requiresCredentials: false,
  isOptional: true,

  /** Historical coverage of published pages is a media-intelligence input, and the same index answers a domain's past technical footprint. */
  disciplines: ["MEDIAINT", "TECHINT"],

  capability: {
    sourceId: "wayback",
    name: "Wayback Machine",
    collectionMode: "PASSIVE_DATASET",
    activeCapable: false,
    allowed: true,
    requiresAuth: false,
    requiresManualAction: false,
    apiAvailable: true,
    notes:
      "Reads the Internet Archive's own capture index (CDX). Keyless and free. Sentinel never contacts the target — the archive already crawled it. Results are capped and the cap is disclosed, so first/last seen are over the returned sample when sampleCapped is true.",
  },

  async execute(target: CollectorTarget): Promise<CollectorRunOutcome<WaybackRaw>> {
    const clock = startExecution();
    const value = target.value.trim();

    if (!value) {
      const err = new CollectorError("wayback", "invalid-target", "No target supplied.");
      return { execution: finishExecution(clock, "failed", 0, err.toInfo()), raw: null };
    }

    let res: Response;
    try {
      res = await fetch(cdxUrlFor(target), {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const classified = classifyError("wayback", err);
      return { execution: finishExecution(clock, "failed", 0, classified.toInfo()), raw: null };
    }

    if (!res.ok) {
      // archive.org throttles aggressively under load. A 429 is a rate limit and
      // must never surface as "no captures found" — that would read as evidence
      // of absence.
      const reason = res.status === 429 ? "rate-limited" : "upstream-error";
      const err = new CollectorError(
        "wayback",
        reason,
        `Wayback CDX returned HTTP ${res.status} for "${value}".`,
      );
      return { execution: finishExecution(clock, "failed", 0, err.toInfo()), raw: null };
    }

    const text = await res.text();

    // CDX answers a genuine zero-result query with an EMPTY BODY, not `[]`. That
    // is a real "nothing archived", distinct from a failure, and must complete
    // rather than throw.
    if (!text.trim()) {
      return {
        execution: finishExecution(clock, "completed", 0),
        raw: { query: value, captures: [], sampleCapped: false },
      };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch (err) {
      const classified = new CollectorError(
        "wayback",
        "upstream-error",
        "Wayback CDX returned a non-empty body that is not valid JSON.",
        err,
      );
      return { execution: finishExecution(clock, "failed", 0, classified.toInfo()), raw: null };
    }

    const captures = parseCdxRows(payload);
    return {
      execution: finishExecution(clock, "completed", captures.length),
      raw: {
        query: value,
        captures,
        sampleCapped: captures.length >= WAYBACK_ROW_LIMIT,
      },
    };
  },

  normalize(outcome: CollectorRunOutcome<WaybackRaw>): InvestigationResult {
    const guarded = normalizeGuard(outcome);
    if (guarded) return guarded;

    const raw = outcome.raw!;
    const result = emptyInvestigationResult(outcome.execution);
    const span = captureSpan(raw.captures);

    if (raw.sampleCapped) {
      result.warnings.push(
        `Capped at ${WAYBACK_ROW_LIMIT} captures. firstSeenInSample/lastSeenInSample describe the returned sample only, not the target's full archive history.`,
      );
    }
    if (span.undatedCount > 0) {
      result.warnings.push(
        `${span.undatedCount} of ${raw.captures.length} captures carry an unparseable timestamp and are reported without a date.`,
      );
    }

    const spanKey = raw.sampleCapped ? "InSample" : "";
    const subjectId = `wayback:subject:${raw.query}`;

    const subject: CollectorEntity = {
      id: subjectId,
      type: raw.query.startsWith("http") ? "url" : "domain",
      value: raw.query,
      displayName: raw.query,
      source: "wayback",
      confidence: UNSCORED,
      metadata: {
        captureCount: raw.captures.length,
        sampleCapped: raw.sampleCapped,
        [`firstSeen${spanKey}`]: span.firstSeen,
        [`lastSeen${spanKey}`]: span.lastSeen,
        undatedCaptures: span.undatedCount,
      },
    };

    const entities: CollectorEntity[] = [subject];
    const relationships: CollectorRelationship[] = [];
    const evidence: CollectorEvidence[] = [];
    const seenUrls = new Set<string>();

    for (const capture of raw.captures) {
      const urlId = `wayback:url:${capture.originalUrl}`;
      if (!seenUrls.has(urlId)) {
        seenUrls.add(urlId);
        entities.push({
          id: urlId,
          type: "url",
          value: capture.originalUrl,
          displayName: capture.originalUrl,
          source: "wayback",
          confidence: UNSCORED,
          metadata: {
            snapshotUrl: capture.snapshotUrl,
            capturedAt: capture.capturedAt,
            statusCode: capture.statusCode,
            mimeType: capture.mimeType,
          },
        });
        relationships.push({
          sourceEntity: subjectId,
          relationshipType: "ARCHIVED_AS",
          targetEntity: urlId,
          confidence: UNSCORED,
          source: "wayback",
        });
      }

      evidence.push({
        source: "Internet Archive Wayback Machine",
        sourceUrl: capture.snapshotUrl,
        collector: "wayback",
        // WHEN SENTINEL RETRIEVED THE RECORD — always the run's start, never the
        // archive's capture time. These are two different facts and the schema's
        // `collectedAt` means the former. The archive's own observation time lives
        // in `normalizedValue.capturedAt` and stays `null` when unreadable, so an
        // unknown capture date can never borrow this timestamp and read as known.
        collectedAt: outcome.execution.startedAt,
        rawValue: capture,
        normalizedValue: {
          url: capture.originalUrl,
          capturedAt: capture.capturedAt,
          statusCode: capture.statusCode,
        },
        confidence: UNSCORED,
        metadata: {
          waybackTimestamp: capture.timestamp,
          digest: capture.digest,
          // States plainly that the archive's own capture time was unreadable,
          // rather than letting a substituted time pass as an observation time.
          capturedAtUnavailable: capture.capturedAt === null,
        },
      });
    }

    result.entities = entities;
    result.relationships = relationships;
    result.evidence = evidence;
    result.metadata = {
      query: raw.query,
      [`firstSeen${spanKey}`]: span.firstSeen,
      [`lastSeen${spanKey}`]: span.lastSeen,
      sampleCapped: raw.sampleCapped,
    };
    return result;
  },

  async healthCheck() {
    const checkedAt = new Date().toISOString();
    try {
      const res = await fetch(`${CDX_BASE}?url=example.com&output=json&limit=1`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) {
        return { state: "ready" as const, detail: "Wayback CDX reachable (keyless).", checkedAt };
      }
      if (res.status === 429) {
        return { state: "degraded" as const, detail: "Wayback CDX rate limited (HTTP 429).", checkedAt };
      }
      return {
        state: "unavailable" as const,
        detail: `Wayback CDX returned HTTP ${res.status}.`,
        checkedAt,
      };
    } catch (err) {
      return {
        state: "unavailable" as const,
        detail: `Wayback CDX unreachable: ${err instanceof Error ? err.message : String(err)}`,
        checkedAt,
      };
    }
  },
};
