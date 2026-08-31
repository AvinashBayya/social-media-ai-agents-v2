/**
 * Entity resolution — OSINT-INTEGRATION-PLAN.md §17 (normalization,
 * deduplication, relationship creation) + §18 (confidence).
 *
 * This is the piece `orchestrator.ts` and `jobs.ts` both explicitly said
 * they don't do: merging entities that are the SAME real-world thing but
 * arrived from different collectors under different namespaced ids —
 * `dns:domain:example.com`, `rdap:domain:example.com` and
 * `crtsh:domain:example.com` becoming one canonical "example.com" entity,
 * per plan §17's own worked example (three collectors reporting
 * `john@example.com` → ONE email entity, THREE evidence items, never three
 * duplicate entities). Evidence is never touched by anything in this file —
 * merging collapses the entity list an analyst browses, not the provenance
 * trail behind it (§17: "preserve source provenance"; Rule 6).
 *
 * Deliberately NOT wired into `orchestrator.ts`/`jobs.ts` automatically —
 * both stay exact-id-only, as documented. Call `resolveInvestigationEntities()`
 * on the result of `runInvestigation()`/`pollInvestigation()` when semantic
 * merging is wanted; nothing forces it.
 *
 * **§18's central rule, applied structurally, not just as advice:**
 * "Do not infer identity merely from a matching name." A shared email,
 * domain, IP, URL or username is a precise identifier — exact match after
 * normalization is a real signal. A shared *name* is not: two different
 * real people can both be "John Smith". `person` and `organization`
 * entities are therefore **never merged by value equality here, at all** —
 * not merged-with-a-low-confidence-score, genuinely kept as separate
 * entities. A low score attached to an already-merged entity is a weaker
 * safeguard than not merging in the first place, because the merge itself
 * — one row instead of two — is the part a reader is likely to skim past a
 * caveat on.
 */

import type {
  CollectorEntity,
  CollectorRelationship,
  ConfidenceScore,
  EntityType,
} from "../collectors/result";
import { UNSCORED } from "../collectors/result";
import { dedupeRelationships } from "./merge";

// ─── Normalization ──────────────────────────────────────────────────────────

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** Lowercase + strip a trailing dot. Does NOT strip a leading "www." — `www.example.com` and `example.com` are different DNS names, and collapsing them would over-merge (matches `toHostname`'s convention in `attack-surface.ts`, not `toDomain`'s). */
export function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

/** Trim, strip a leading "@" (common across social handles), lowercase for the matching key — the original casing is preserved in `displayName`, only the merge key is canonicalized. */
export function normalizeUsername(value: string): string {
  return value.trim().replace(/^@/, "").toLowerCase();
}

/** Scheme + host lowercased, fragment dropped, a bare trailing slash dropped. Query string is deliberately KEPT — stripping it could conflate genuinely different resources on sites that route by query param. Falls back to a trimmed/lowercased string for a value the URL parser rejects, rather than throwing. */
export function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    let pathname = url.pathname;
    if (pathname.endsWith("/")) pathname = pathname.slice(0, -1);
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${pathname}${url.search}`;
  } catch {
    return trimmed.toLowerCase();
  }
}

/** IP/phone/location/article/social_account/image/video and anything else with no dedicated rule: trim + lowercase — safe and reversible, no semantic assumptions about the value's structure. */
export function normalizeGeneric(value: string): string {
  return value.trim().toLowerCase();
}

const NORMALIZERS: Partial<Record<EntityType, (value: string) => string>> = {
  email: normalizeEmail,
  domain: normalizeDomain,
  username: normalizeUsername,
  url: normalizeUrl,
};

export function normalizeEntityValue(type: EntityType, value: string): string {
  return (NORMALIZERS[type] ?? normalizeGeneric)(value);
}

// ─── Merge eligibility ──────────────────────────────────────────────────────

/** See the file header — the one rule this whole module exists to enforce. */
export const NOT_MERGEABLE_BY_VALUE: ReadonlySet<EntityType> = new Set(["person", "organization"]);

// ─── Confidence — plan §18 ──────────────────────────────────────────────────

/**
 * The only signal this function can honestly claim is "multiple independent
 * sources" (§18's own list) — it has no access to cross-entity-type checks
 * (same organization, same location) that would require correlating
 * DIFFERENT entities about the same subject, a larger undertaking than
 * merging same-type same-value entities. A single source has nothing to
 * corroborate it, so it stays `UNSCORED` rather than defaulting to a
 * placeholder confidence. Every score carries its reasons — never a bare
 * number, per §18's explicit requirement.
 */
export function computeMergeConfidence(
  entityType: EntityType,
  contributingSources: string[],
  /**
   * The contributors' OWN confidence scores (2026-08-30, ported).
   *
   * Optional so every pre-existing caller and test keeps its behaviour. When
   * supplied, it BOUNDS the corroboration score; see the two rules below.
   */
  contributorScores?: readonly (ConfidenceScore | null | undefined)[],
): ConfidenceScore {
  const sources = [...new Set(contributingSources)].sort();
  if (sources.length <= 1) return UNSCORED;

  const corroboration = Math.min(0.5 + 0.15 * (sources.length - 1), 0.95);
  const reasons = [
    // "distinct", not "independent": the module has no representation of shared
    // upstream sources, so two collectors reading the same dataset would count
    // as two here. Claiming independence would assert something unverified.
    `same normalized ${entityType} reported by ${sources.length} distinct collectors (independence not verified — two collectors may share an upstream source)`,
    `sources: ${sources.join(", ")}`,
  ];

  if (!contributorScores) {
    return { value: corroboration, reasons };
  }

  const measured = contributorScores
    .map((c) => c?.value)
    .filter((v): v is number => typeof v === "number");

  // WHEN NO CONTRIBUTOR MEASURED ANYTHING, the corroboration score STANDS.
  //
  // An existing, tested methodology already establishes the relationship and
  // its reasoning is sound: two collectors independently reporting the same
  // address is real evidence that the address EXISTS, whether or not either
  // scored its own record. That is a different question from how reliable
  // either observation was.
  //
  // The ambiguity it creates — a number in `confidence` that is corroboration,
  // not observation reliability — is fixed by NAMING it apart wherever it
  // renders ("Identity confidence (resolution)", with the contributors listed),
  // not by deleting the signal. The reasons below say so explicitly.
  if (measured.length === 0) {
    return {
      value: corroboration,
      reasons: [
        ...reasons,
        "No contributing collector measured its own confidence. This score reflects CORROBORATION — that independent collectors reported the same value — not any collector's confidence in its observation.",
      ],
    };
  }

  // THE BOUND — corroboration never exceeds the strongest single contributor.
  //
  // Three collectors each at 0.30 previously merged to 0.80, i.e. LOW+LOW+LOW
  // became the HIGH band. Agreement between weak observations is still weak:
  // three username string-matches do not become a proven identity, which is
  // exactly what `sherlock.ts`'s own caveat says. The corroboration signal is
  // kept — it can raise a score TOWARD the best contributor — but it cannot
  // manufacture reliability no source ever supplied.
  const strongest = Math.max(...measured);
  const value = Math.min(corroboration, strongest);
  if (value < corroboration) {
    reasons.push(
      `Bounded by the strongest contributing collector (${strongest}). Corroboration raises confidence toward the best single source, never beyond it.`,
    );
  }
  reasons.push(
    `contributor confidences: ${contributorScores
      .map((c) => (typeof c?.value === "number" ? String(c.value) : "unmeasured"))
      .join(", ")}`,
  );
  return { value, reasons };
}

// ─── Resolution ─────────────────────────────────────────────────────────────

export interface ResolvedEntities {
  entities: CollectorEntity[];
  relationships: CollectorRelationship[];
  /** Old entity id → the merged id it now maps to. An id absent from this map was kept as-is (unique, or a non-mergeable type). */
  idRemap: Map<string, string>;
}

/**
 * Groups entities by `(type, normalizedValue)`, merging every group with
 * more than one member into a single canonical entity (id prefixed
 * `resolved:`, so it's visibly distinct from any collector's own
 * namespace), then rewrites every relationship's `sourceEntity`/
 * `targetEntity` to the merged id and re-runs `./merge.ts`'s exact-edge
 * dedup (merging entities can turn two previously-distinct relationships
 * into duplicates of each other). A relationship that would become a
 * self-loop after remapping (both ends resolve to the same entity) is
 * dropped — it asserts nothing.
 */
export function resolveEntities(
  entities: CollectorEntity[],
  relationships: CollectorRelationship[],
): ResolvedEntities {
  const groups = new Map<string, CollectorEntity[]>();
  const passthrough: CollectorEntity[] = [];

  for (const entity of entities) {
    if (NOT_MERGEABLE_BY_VALUE.has(entity.type)) {
      passthrough.push(entity);
      continue;
    }
    const key = `${entity.type}:${normalizeEntityValue(entity.type, entity.value)}`;
    const group = groups.get(key);
    if (group) group.push(entity);
    else groups.set(key, [entity]);
  }

  const idRemap = new Map<string, string>();
  const resolved: CollectorEntity[] = [...passthrough];

  for (const [key, group] of groups) {
    const first = group[0]!;
    if (group.length === 1) {
      resolved.push(first);
      continue;
    }

    const normalizedValue = normalizeEntityValue(first.type, first.value);
    const mergedId = `resolved:${key}`;
    const sources = group.map((e) => e.source);

    const mergedMetadata: Record<string, unknown> = {};
    for (const e of group) Object.assign(mergedMetadata, e.metadata);
    mergedMetadata.mergedFrom = [...new Set(sources)].sort();
    mergedMetadata.mergedEntityCount = group.length;
    /**
     * The contributors' OWN scores, retained rather than discarded (2026-08-30, ported).
     *
     * The merged `confidence` is a corroboration measure. It is NOT the same
     * quantity as any contributor's evidence confidence, and previously the
     * contributors' numbers were dropped entirely, leaving no way to see that a
     * 0.65 merged score sat on two 0.30 observations. `unmeasured` is recorded
     * as null, never as 0.
     */
    mergedMetadata.contributorConfidences = group
      .map((e) => ({
        source: e.source,
        value: typeof e.confidence?.value === "number" ? e.confidence.value : null,
      }))
      .sort((a, b) => a.source.localeCompare(b.source));

    resolved.push({
      id: mergedId,
      type: first.type,
      value: normalizedValue,
      displayName: first.displayName || first.value,
      source: "entity-resolution",
      confidence: computeMergeConfidence(
        first.type,
        sources,
        group.map((e) => e.confidence),
      ),
      metadata: mergedMetadata,
    });

    for (const e of group) idRemap.set(e.id, mergedId);
  }

  const remapId = (id: string): string => idRemap.get(id) ?? id;
  const remappedRelationships = relationships
    .map((r) => ({
      ...r,
      sourceEntity: remapId(r.sourceEntity),
      targetEntity: remapId(r.targetEntity),
    }))
    .filter((r) => r.sourceEntity !== r.targetEntity);

  return { entities: resolved, relationships: dedupeRelationships(remappedRelationships), idRemap };
}

export interface MergeableInvestigation {
  entities: CollectorEntity[];
  relationships: CollectorRelationship[];
}

/** Convenience wrapper for `Investigation` (`orchestrator.ts`) or `InvestigationPoll` (`jobs.ts`) — applies `resolveEntities()` and returns the same shape with `entities`/`relationships` replaced; every other field (evidence, warnings, errors, ids, timestamps) passes through untouched. */
export function resolveInvestigationEntities<T extends MergeableInvestigation>(
  investigation: T,
): T {
  const { entities, relationships } = resolveEntities(
    investigation.entities,
    investigation.relationships,
  );
  return { ...investigation, entities, relationships };
}
