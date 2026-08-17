/**
 * Merging multiple collectors' results into one combined view. Shared
 * between `orchestrator.ts` (synchronous, single-call) and `jobs.ts`
 * (async, job-tracked polling) so both dedupe identically rather than
 * drifting into two slightly different notions of "duplicate."
 *
 * Exact-id / exact-edge dedup only. Does NOT merge "dns:domain:example.com"
 * and "rdap:domain:example.com" into one entity even though both name the
 * same real domain — collectors mint their own namespaced ids, and
 * cross-collector semantic merging is §17 Entity Resolution's job, a
 * separate, not-yet-built task. See `orchestrator.ts`'s header for the full
 * rationale.
 */

import type { CollectorEntity, CollectorRelationship } from "../collectors/result";

export function dedupeEntitiesById(items: CollectorEntity[]): CollectorEntity[] {
  const seen = new Map<string, CollectorEntity>();
  for (const item of items) if (!seen.has(item.id)) seen.set(item.id, item);
  return [...seen.values()];
}

/** Relationships carry no id of their own; the natural key is the edge itself. */
export function dedupeRelationships(items: CollectorRelationship[]): CollectorRelationship[] {
  const seen = new Map<string, CollectorRelationship>();
  for (const item of items) {
    const key = `${item.sourceEntity}|${item.relationshipType}|${item.targetEntity}|${item.source}`;
    if (!seen.has(key)) seen.set(key, item);
  }
  return [...seen.values()];
}
