import type { CollectorEntity, CollectorRelationship } from "../collectors/result";
import { resolveEntities } from "../osint/entity-resolution";

/**
 * The authoritative entity projection for case-scoped surfaces (2026-08-30,
 * ported from the teammate's fork).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT WAS WRONG.
 *
 * Two paths produced entities from one collection:
 *
 *   jobs.ts         pollInvestigation      → dedupeEntitiesById  (the CASE path)
 *   orchestrator.ts runOsintInvestigation  → resolveEntities     (ad-hoc)
 *
 * `dedupeEntitiesById` removes byte-identical ids and nothing else. It has no
 * identity semantics: `dns` reporting `ip:203.0.113.14` and `shodan` reporting
 * `shodan:203.0.113.14` stayed TWO entities. So the same evidence produced a
 * different entity set depending on which route the analyst arrived from —
 * and entity resolution was unreachable from the case path entirely.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THIS IS AN ACCESSOR, NOT A THIRD RESOLVER.
 *
 * All identity logic stays in `osint/entity-resolution.ts`. This module calls it,
 * keeps the `idRemap` that resolution normally throws away, and adds the one
 * thing resolution loses — see `contributingSourcesOf`.
 *
 * A test greps this file to prove it contains no normalisation, no grouping and
 * no merge rule of its own.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * READ-TIME, NOT WRITE-TIME.
 *
 * Stored snapshots keep the raw per-collector record. Resolving at the writer
 * would make old (deduped) and new (resolved) snapshots indistinguishable in one
 * store, and would need a version bump and migration for a change that alters no
 * shape. Resolving here keeps storage byte-identical and puts ONE function
 * between the snapshot and every consumer.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ENTITIES AND RELATIONSHIPS MUST TRAVEL TOGETHER.
 *
 * Resolution rewrites entity ids and remaps every relationship endpoint through
 * `idRemap`. Taking the resolved entities while keeping pre-merge relationships
 * would leave every edge pointing at an id that no longer exists — `graph-view`
 * and `maltego-export` both filter edges to known ids, so the graph would
 * silently empty. The return type therefore never separates them.
 */

/** The `source` value `resolveEntities` stamps on a merged entity. */
export const RESOLUTION_SOURCE = "entity-resolution";

/** Prefix `resolveEntities` gives a merged entity's id. */
export const RESOLVED_ID_PREFIX = "resolved:";

export interface ResolvedCaseEntities {
  entities: CollectorEntity[];
  relationships: CollectorRelationship[];
  /**
   * Original entity id → the merged id it now carries.
   *
   * Resolution computes this and discards it by default. Kept here so a caller
   * holding a pre-resolution id (a stored citation, a selected node) can still
   * find the entity rather than silently getting nothing.
   */
  idRemap: Map<string, string>;
  /** How many input entities collapsed into a merged one. Reported, never hidden. */
  mergedCount: number;
}

/** True when this entity was produced by a merge rather than by a collector. */
export function isResolvedEntity(entity: CollectorEntity): boolean {
  return entity.source === RESOLUTION_SOURCE;
}

/**
 * The collectors that actually contributed this entity.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE ONE THING RESOLUTION LOSES, AND WHY IT MATTERS HERE.
 *
 * `resolveEntities` sets a merged entity's `source` to `"entity-resolution"` —
 * honest, since no single collector asserted the merged record. But the
 * discipline breakdown maps entities to SOCMINT/TECHINT/GEOINT/MEDIAINT by
 * `entity.source`, so a merged entity would become **unmapped**: a discipline
 * count silently losing entities to a resolution step.
 *
 * The contributors are already preserved in `metadata.mergedFrom`. This reads
 * them, so a merged entity is attributed to EVERY collector that contributed it.
 * Counts therefore overlap — the same rule already documented for evidence, and
 * for the same reason.
 *
 * Returns `[]` only when the entity names no source at all, which is a defect in
 * the producing collector rather than something to paper over.
 */
export function contributingSourcesOf(entity: CollectorEntity): string[] {
  if (!isResolvedEntity(entity)) return entity.source ? [entity.source] : [];
  const merged = entity.metadata?.mergedFrom;
  if (Array.isArray(merged)) {
    const names = merged.filter((v): v is string => typeof v === "string" && v.length > 0);
    if (names.length > 0) return [...new Set(names)].sort();
  }
  // A merged entity whose contributor list is missing or malformed. Reporting
  // the resolver as the source is the honest fallback — it says "produced by
  // resolution, contributors unknown" rather than inventing a collector.
  return [RESOLUTION_SOURCE];
}

/**
 * Resolves a case's entities and relationships together.
 *
 * Pure: no storage, no network, no clock. The caller supplies snapshot contents
 * already validated against the case's scope verdict, which is what keeps
 * cross-case leakage impossible here — this function has no way to reach
 * another case's data.
 */
export function resolvedCaseEntities(input: {
  entities: readonly CollectorEntity[];
  relationships: readonly CollectorRelationship[];
}): ResolvedCaseEntities {
  const { entities, relationships, idRemap } = resolveEntities(
    [...input.entities],
    [...input.relationships],
  );
  return {
    entities,
    relationships,
    idRemap,
    // Distinct inputs that collapsed — `idRemap.size` counts the ORIGINALS that
    // were remapped, so it is the number of records that stopped being separate.
    mergedCount: idRemap.size,
  };
}

/**
 * Follows an id through resolution.
 *
 * An id that was not remapped is returned unchanged, which is correct: unique
 * entities and non-mergeable types keep their original ids.
 */
export function currentEntityId(idRemap: ReadonlyMap<string, string>, id: string): string {
  return idRemap.get(id) ?? id;
}

/** One line describing what resolution did, for a UI that must not hide it. */
export function resolutionSummary(resolved: ResolvedCaseEntities, originalCount: number): string {
  if (resolved.mergedCount === 0) {
    return `${originalCount} entities, none merged — no two collectors reported the same value for the same entity type.`;
  }
  return (
    `${resolved.entities.length} entities after resolution, from ${originalCount} collector records. ` +
    `${resolved.mergedCount} record(s) were merged into shared identities because different collectors ` +
    `reported the same normalised value for the same entity type.`
  );
}

/**
 * Caveats any surface showing resolved entities must render.
 *
 * The second is the load-bearing one: resolution is deliberately conservative,
 * and its silence is not agreement.
 */
export const RESOLUTION_CAVEATS: string[] = [
  "Entities are merged only when two collectors report the SAME normalised value for the SAME entity type. A domain and an IP are never merged, whatever they resolve to.",
  "People and organisations are never merged by name. Two records both reading 'John Smith' stay two records — a matching string is not an identity.",
  "A merged entity's confidence is recomputed from how many independent collectors reported it. A single-source entity stays unscored rather than being given a placeholder.",
  "Merging is not evidence of a relationship. It says two collectors described the same thing, not that the thing is what either claimed.",
];
