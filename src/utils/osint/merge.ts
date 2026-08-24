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
import { UNSCORED } from "../collectors/result";

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

const TARGET_SELF_ENTITY_ID = /^[a-zA-Z0-9.]+:target:(.+)$/;

/**
 * Merges each collector's own placeholder entity for "the literal thing this
 * investigation searched for" (`dorks:target:X`, `identity.websearch:target:X`,
 * `social:target:X`, …) into one canonical node.
 *
 * This is a NARROWER, safer case than `entity-resolution.ts`'s general
 * value-based merging, which deliberately never merges `person`/
 * `organization` entities by value — two different real people can share a
 * name, so an entity independently *discovered* as "John Smith" in one
 * collector's results must never be assumed the same "John Smith" found by
 * another. A collector's own `:target:` entity is a different thing
 * entirely: it is not a discovered mention, it is that collector's citation
 * of the one literal string every job in this investigation was given —
 * unambiguous by construction, never a collision risk. Without this,
 * `/graph` renders one disconnected root-looking node per collector for the
 * same target instead of one root everything else attaches to.
 */
export function mergeTargetSelfEntities(
  entities: CollectorEntity[],
  relationships: CollectorRelationship[],
  targetValue: string,
): { entities: CollectorEntity[]; relationships: CollectorRelationship[] } {
  const normalizedTarget = targetValue.trim().toLowerCase();
  const dupes: CollectorEntity[] = [];
  const rest: CollectorEntity[] = [];
  for (const entity of entities) {
    const match = TARGET_SELF_ENTITY_ID.exec(entity.id);
    if (match && match[1]!.trim().toLowerCase() === normalizedTarget) dupes.push(entity);
    else rest.push(entity);
  }
  if (dupes.length <= 1) return { entities, relationships };

  const canonical = dupes[0]!;
  const idRemap = new Map<string, string>();
  for (const d of dupes) idRemap.set(d.id, `target:${normalizedTarget}`);

  const mergedMetadata: Record<string, unknown> = {};
  for (const d of dupes) Object.assign(mergedMetadata, d.metadata);
  mergedMetadata.mergedFrom = [...new Set(dupes.map((d) => d.source))].sort();

  const mergedEntity: CollectorEntity = {
    id: `target:${normalizedTarget}`,
    type: canonical.type,
    value: canonical.value,
    displayName: canonical.displayName || canonical.value,
    source: canonical.source,
    confidence: UNSCORED,
    metadata: mergedMetadata,
  };

  const remapId = (id: string): string => idRemap.get(id) ?? id;
  const remappedRelationships = relationships
    .map((r) => ({ ...r, sourceEntity: remapId(r.sourceEntity), targetEntity: remapId(r.targetEntity) }))
    .filter((r) => r.sourceEntity !== r.targetEntity);

  return {
    entities: [mergedEntity, ...rest],
    relationships: dedupeRelationships(remappedRelationships),
  };
}
