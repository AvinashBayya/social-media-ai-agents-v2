import type { CollectorEvidence } from "./collectors/result";
import type { CaseScopeVerdict, SnapshotTruncation } from "./cases/case-scope";
import {
  MAX_SNAPSHOT_EVIDENCE,
  assertSnapshotBelongsToCase,
  capRecords,
  clearEviction,
  evictOldScopedCases,
  evictedCaseIds,
  listScopedCases,
  scopedKey,
} from "./cases/case-scope";

/**
 * Hand-off store for `/timeline`'s evidence section (2026-08-30, ported from
 * the teammate's fork).
 *
 * **Deliberately a copy of `graph-store.ts`'s shape, not a generalisation of it.**
 * That file already solved this exact problem for `/graph`: there is no
 * server-side job id to fetch by (the in-memory, per-process constraint
 * `jobs.ts` documents), so `/recon` hands its poll to another route through
 * localStorage. Refactoring both onto a shared generic would couple two
 * independent hand-offs whose payloads have no reason to evolve together, and
 * would touch working code that `/graph` depends on. Two small parallel stores
 * is the cheaper and safer shape.
 *
 * Stores raw `CollectorEvidence`, NOT a built timeline. The timeline is derived
 * by a pure function (`osint/timeline.ts`), so persisting the derived form would
 * put a computed artefact in storage that could silently go stale against the
 * logic that produced it — and would be a second evidence model.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * CASE SCOPING. Same change as `graph-store.ts`, same reasons:
 *
 *   - `sentinel_timeline_snapshot`           — UNSCOPED slot, written by /recon.
 *   - `sentinel_timeline_snapshot__<caseId>` — one per case.
 *
 * Evidence is the expensive record: **1,124 bytes each**, measured. A busy
 * investigation's worth of evidence alone can approach the ~5 MB origin quota,
 * so the cap here matters more than the graph's. It is recorded in the
 * snapshot and rendered — a capped timeline must never read as a complete one.
 */

export interface TimelineSnapshot {
  investigationId: string;
  target: string;
  savedAt: string;
  evidence: CollectorEvidence[];
  /** Case provenance. Optional so pre-existing snapshots parse and read as UNSCOPED. Never taken from the selected UI case. */
  caseId?: string | null;
  runId?: string | null;
  truncation?: SnapshotTruncation;
}

const STORE_KEY = "sentinel_timeline_snapshot";
/** Bumped if the shape changes — a stale-shaped snapshot is dropped, never coerced. */
const STORE_VERSION_KEY = "sentinel_timeline_snapshot_version";
/**
 * v2 — case scoping added optional caseId/runId/truncation. The reader's strict
 * version check is unchanged: a v1 snapshot is dropped, not coerced.
 */
const STORE_VERSION = "2";

/** Applies the storage cap and records what it did. Exported for the case writer and tests. */
export function capTimelineSnapshot(snapshot: TimelineSnapshot): TimelineSnapshot {
  const { kept, truncation } = capRecords(snapshot.evidence, MAX_SNAPSHOT_EVIDENCE);
  // Attached only when records were actually dropped — see graph-store.ts.
  if (!truncation.truncated) return { ...snapshot };
  return { ...snapshot, evidence: kept, truncation };
}

function write(key: string, snapshot: TimelineSnapshot): void {
  try {
    localStorage.setItem(key, JSON.stringify(capTimelineSnapshot(snapshot)));
    localStorage.setItem(STORE_VERSION_KEY, STORE_VERSION);
  } catch {
    // Quota or private-mode failure — only the hand-off is lost.
  }
}

function read(key: string): TimelineSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.evidence)) return null;
    return parsed as TimelineSnapshot;
  } catch {
    return null;
  }
}

export function saveTimelineSnapshot(snapshot: TimelineSnapshot): void {
  if (typeof window === "undefined") return;
  if (snapshot.caseId) {
    write(scopedKey(STORE_KEY, snapshot.caseId), snapshot);
    // The data is back, so the explanation for its absence is no longer true.
    // Cleared BEFORE eviction runs, so a case that is written and then
    // immediately evicted again ends up correctly marked evicted.
    clearEviction(STORE_KEY, snapshot.caseId);
    evictOldScopedCases(STORE_KEY);
  }
  write(STORE_KEY, snapshot);
}

/** Null when no snapshot exists, its version doesn't match, or it fails to parse — never a partially-repaired object. */
export function readTimelineSnapshot(): TimelineSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    if (localStorage.getItem(STORE_VERSION_KEY) !== STORE_VERSION) return null;
  } catch {
    return null;
  }
  return read(STORE_KEY);
}

export function clearTimelineSnapshot(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    // ignore
  }
}

// ─── Case-scoped API (2026-08-30, ported) ───────────────────────────────────

export interface ScopedTimelineSnapshot {
  snapshot: TimelineSnapshot | null;
  verdict: CaseScopeVerdict;
}

/** See `getGraphForCase` — same contract, same reason the verdict is not optional. */
export function getTimelineForCase(caseId: string): ScopedTimelineSnapshot {
  const scoped = read(scopedKey(STORE_KEY, caseId));
  if (scoped) {
    return { snapshot: scoped, verdict: assertSnapshotBelongsToCase(scoped, caseId) };
  }
  const fallback = read(STORE_KEY);
  return { snapshot: fallback, verdict: assertSnapshotBelongsToCase(fallback, caseId) };
}

/** See `readGraphSnapshotForCase` — same contract, same reason `getTimelineForCase` cannot be reused as a merge base. */
export function readTimelineSnapshotForCase(caseId: string): TimelineSnapshot | null {
  if (typeof window === "undefined" || !caseId) return null;
  return read(scopedKey(STORE_KEY, caseId));
}

/** See `saveGraphSnapshotForCase` — writes ONLY the case slot, refuses a falsy `caseId`. */
export function saveTimelineSnapshotForCase(snapshot: TimelineSnapshot): void {
  if (typeof window === "undefined") return;
  const caseId = snapshot.caseId;
  if (!caseId) return;
  write(scopedKey(STORE_KEY, caseId), snapshot);
  clearEviction(STORE_KEY, caseId);
  evictOldScopedCases(STORE_KEY);
}

export function clearTimelineForCase(caseId: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(scopedKey(STORE_KEY, caseId));
  } catch {
    // ignore
  }
}

/** Case ids currently holding a timeline snapshot, newest first. */
export function timelineScopedCases(): string[] {
  return listScopedCases(STORE_KEY);
}

/**
 * Case ids whose timeline snapshot was evicted to stay under the storage cap.
 *
 * Distinct from "not in `timelineScopedCases()`": that set also contains every case
 * that never ran. Only cases the storage layer actually evicted appear here.
 */
export function timelineEvictedCases(): string[] {
  return evictedCaseIds(STORE_KEY);
}
