import type { CollectorEntity, CollectorRelationship } from "./collectors/result";
import type { CaseScopeVerdict, SnapshotTruncation } from "./cases/case-scope";
import {
  MAX_SNAPSHOT_ENTITIES,
  MAX_SNAPSHOT_RELATIONSHIPS,
  assertSnapshotBelongsToCase,
  capRecords,
  clearEviction,
  evictOldScopedCases,
  evictedCaseIds,
  listScopedCases,
  scopedKey,
} from "./cases/case-scope";

/**
 * Hand-off store for `/graph` — OSINT-INTEGRATION-PLAN.md §31 P2 "Graph".
 *
 * `/graph` previously rendered a fixed, explicitly-disclosed 10-node fictional
 * topology ("Vector-17", "Aster Motors" — a `SampleDataBanner` said so on the
 * page). This is the mechanism that lets `/recon`'s investigation panel hand
 * a REAL entity/relationship set to it: "View in Graph" saves the current
 * poll's data here, `/graph` reads it on load. There is no server-side job
 * id to fetch by — the same in-memory-only, per-process constraint `jobs.ts`
 * already documents — so this is a client-side hand-off, matching
 * `active-target.ts`'s and `investigations-store.ts`'s existing localStorage
 * pattern rather than inventing a different mechanism.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * CASE SCOPING (2026-08-30, ported). The unsuffixed key is no longer the only slot.
 *
 * It WAS single-slot and last-write-wins, and that produced the worst failure
 * this project can have: run case A then case B, and `/graph` showed B's data
 * while the analyst believed they were looking at A. Silently.
 *
 * Now there are two kinds of slot:
 *
 *   - `sentinel_graph_snapshot`            — the UNSCOPED slot. `/recon` writes
 *     here because it runs outside any case. Still single-slot, still
 *     last-write-wins, and that is correct: it is a scratch hand-off.
 *   - `sentinel_graph_snapshot__<caseId>`  — one per case, written by a case run.
 *     Running case B no longer destroys case A.
 *
 * The legacy functions below are unchanged and still address the unscoped slot,
 * so every existing caller keeps working. Case-aware callers use the `*ForCase`
 * functions, which return a `CaseScopeVerdict` alongside the data so a mismatch
 * cannot be read as this case's data.
 *
 * Snapshots are CAPPED and the cap is recorded. A busy domain can legitimately
 * return thousands of entities, more than the whole origin quota, and every
 * write here swallows quota errors silently, so an uncapped write would vanish
 * and leave the PREVIOUS snapshot on screen.
 */

export interface GraphSnapshot {
  investigationId: string;
  target: string;
  savedAt: string;
  entities: CollectorEntity[];
  relationships: CollectorRelationship[];
  /**
   * Case provenance (2026-08-30, ported). Optional so pre-existing snapshots
   * still parse — their absence is exactly what marks them LEGACY / UNSCOPED.
   *
   * **Never populated from the currently-selected UI case.** The run carries the
   * authoritative relationship; the case being viewed is not provenance.
   */
  caseId?: string | null;
  runId?: string | null;
  /** Set when the snapshot was capped, so a truncated graph cannot read as complete. */
  truncation?: SnapshotTruncation;
}

const STORE_KEY = "sentinel_graph_snapshot";
/** Bumped if the shape changes — a stale-shaped snapshot is dropped, never coerced (matches `investigations-store.ts`'s own versioning rationale). */
const STORE_VERSION_KEY = "sentinel_graph_snapshot_version";
/**
 * v2 — case scoping added optional caseId/runId/truncation.
 *
 * The strict version check in the reader is DELIBERATELY unchanged: a v1
 * snapshot is dropped rather than read as UNSCOPED. Relaxing it would silently
 * alter a guarantee `tests/graph-store.test.ts` asserts, and this is a scratch
 * hand-off — losing one costs nothing, whereas coercing stale-shaped data is
 * the class of bug this store's own header warns about.
 */
const STORE_VERSION = "2";

/** Applies the storage cap and records what it did. Exported for the case writer and tests. */
export function capGraphSnapshot(snapshot: GraphSnapshot): GraphSnapshot {
  const entities = capRecords(snapshot.entities, MAX_SNAPSHOT_ENTITIES);
  const relationships = capRecords(snapshot.relationships, MAX_SNAPSHOT_RELATIONSHIPS);
  const truncated = entities.truncation.truncated || relationships.truncation.truncated;
  // `truncation` is attached ONLY when something was actually dropped. Stamping
  // `truncated: false` onto every snapshot would be noise, and it would change
  // the round-trip shape of a normal snapshot for no benefit — its ABSENCE is
  // the honest statement that nothing was cut.
  if (!truncated) return { ...snapshot };
  return {
    ...snapshot,
    entities: entities.kept,
    relationships: relationships.kept,
    truncation: {
      truncated: true,
      totalRecords: snapshot.entities.length,
      storedRecords: entities.kept.length,
    },
  };
}

function write(key: string, snapshot: GraphSnapshot): void {
  try {
    localStorage.setItem(key, JSON.stringify(capGraphSnapshot(snapshot)));
    localStorage.setItem(STORE_VERSION_KEY, STORE_VERSION);
  } catch {
    // Quota or private-mode failure — the analyst stays on the current page with
    // the in-memory result unaffected; only the hand-off is lost.
  }
}

function read(key: string): GraphSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray(parsed.entities) ||
      !Array.isArray(parsed.relationships)
    ) {
      return null;
    }
    return parsed as GraphSnapshot;
  } catch {
    return null;
  }
}

export function saveGraphSnapshot(snapshot: GraphSnapshot): void {
  if (typeof window === "undefined") return;
  // A snapshot carrying a caseId is written to that case's slot AND kept in the
  // unscoped slot, so `/graph`'s existing single-slot reader still shows the most
  // recent run while case-aware readers get correctly scoped data.
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
export function readGraphSnapshot(): GraphSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    // Strict version check, unchanged from before case scoping and asserted by
    // `tests/graph-store.test.ts`. A stale-shaped snapshot is DROPPED, never
    // coerced — and this is a scratch hand-off, so losing one costs nothing.
    // Relaxing it to keep v1 data would have silently changed a tested guarantee.
    if (localStorage.getItem(STORE_VERSION_KEY) !== STORE_VERSION) return null;
  } catch {
    return null;
  }
  return read(STORE_KEY);
}

export function clearGraphSnapshot(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    // ignore
  }
}

// ─── Case-scoped API (2026-08-30, ported) ───────────────────────────────────

export interface ScopedGraphSnapshot {
  snapshot: GraphSnapshot | null;
  verdict: CaseScopeVerdict;
}

/**
 * Reads the graph snapshot belonging to a case.
 *
 * Returns the verdict ALONGSIDE the data rather than returning null on a
 * mismatch, because "there is nothing" and "there is something and it belongs to
 * a different case" need different words on screen. A caller that renders
 * `snapshot` without reading `verdict` is a bug the type cannot prevent, so the
 * verdict is not optional.
 */
export function getGraphForCase(caseId: string): ScopedGraphSnapshot {
  const scoped = read(scopedKey(STORE_KEY, caseId));
  if (scoped) {
    return { snapshot: scoped, verdict: assertSnapshotBelongsToCase(scoped, caseId) };
  }
  // No per-case slot. Fall back to the unscoped slot so a legacy or Recon
  // snapshot is still VISIBLE — but the verdict says plainly it is not this
  // case's data, and the UI must not render it as such.
  const fallback = read(STORE_KEY);
  return { snapshot: fallback, verdict: assertSnapshotBelongsToCase(fallback, caseId) };
}

/**
 * The case's OWN slot, with NO unscoped fallback. Null means this case has no
 * graph snapshot, which for a merge is an EMPTY BASE, never a reason to refuse.
 *
 * `getGraphForCase` is deliberately not reusable here. It falls back to the
 * unscoped slot so a legacy or `/recon` snapshot stays VISIBLE — correct for
 * display, since the verdict says plainly it is not this case's data. As a merge
 * base it would be catastrophic: on the first attach to a case it returns
 * another target's snapshot, and writing the merge back would stamp those
 * records with this `caseId`, after which they read as verdict MATCH. That is
 * exactly the cross-scope laundering this module exists to prevent.
 */
export function readGraphSnapshotForCase(caseId: string): GraphSnapshot | null {
  if (typeof window === "undefined" || !caseId) return null;
  return read(scopedKey(STORE_KEY, caseId));
}

/**
 * Writes ONLY the case's slot.
 *
 * `saveGraphSnapshot` additionally writes the unscoped slot unconditionally, so
 * a case-scoped attach through it would silently replace whatever `/recon` last
 * handed to `/graph`. That is right for a run hand-off and wrong for an attach,
 * so the two are separate functions rather than a flag.
 *
 * Refuses a falsy `caseId` outright — there is no unscoped form of this write.
 * Eviction bookkeeping is identical to `saveGraphSnapshot`'s, in the same order.
 */
export function saveGraphSnapshotForCase(snapshot: GraphSnapshot): void {
  if (typeof window === "undefined") return;
  const caseId = snapshot.caseId;
  if (!caseId) return;
  write(scopedKey(STORE_KEY, caseId), snapshot);
  // The data is back, so the recorded explanation for its absence is no longer
  // true. Cleared BEFORE eviction runs — see `saveGraphSnapshot`.
  clearEviction(STORE_KEY, caseId);
  evictOldScopedCases(STORE_KEY);
}

export function clearGraphForCase(caseId: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(scopedKey(STORE_KEY, caseId));
  } catch {
    // ignore
  }
}

/** Case ids currently holding a graph snapshot, newest first. */
export function graphScopedCases(): string[] {
  return listScopedCases(STORE_KEY);
}

/**
 * Case ids whose graph snapshot was evicted to stay under the storage cap.
 *
 * Distinct from "not in `graphScopedCases()`": that set also contains every case
 * that never ran. Only cases the storage layer actually evicted appear here.
 */
export function graphEvictedCases(): string[] {
  return evictedCaseIds(STORE_KEY);
}
