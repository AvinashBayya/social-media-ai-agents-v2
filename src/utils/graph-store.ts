import type { CollectorEntity, CollectorRelationship } from "./collectors/result";

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
 * One snapshot at a time, replaced on each "View in Graph" — this is a
 * hand-off, not a history. An analyst wanting to keep multiple investigations
 * around uses `investigations-store.ts`'s pinning instead; that system
 * already exists for exactly that and this file does not duplicate it.
 */

export interface GraphSnapshot {
  investigationId: string;
  target: string;
  savedAt: string;
  entities: CollectorEntity[];
  relationships: CollectorRelationship[];
}

const STORE_KEY = "sentinel_graph_snapshot";
/** Bumped if the shape changes — a stale-shaped snapshot is dropped, never coerced (matches `investigations-store.ts`'s own versioning rationale). */
const STORE_VERSION_KEY = "sentinel_graph_snapshot_version";
const STORE_VERSION = "1";

export function saveGraphSnapshot(snapshot: GraphSnapshot): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(snapshot));
    localStorage.setItem(STORE_VERSION_KEY, STORE_VERSION);
  } catch {
    // Quota or private-mode failure — the analyst stays on /recon with the
    // in-memory result unaffected; only the /graph hand-off is lost.
  }
}

/** Null when no snapshot exists, its version doesn't match, or it fails to parse — never a partially-repaired object. */
export function readGraphSnapshot(): GraphSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    if (localStorage.getItem(STORE_VERSION_KEY) !== STORE_VERSION) return null;
    const raw = localStorage.getItem(STORE_KEY);
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

export function clearGraphSnapshot(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    // ignore
  }
}
