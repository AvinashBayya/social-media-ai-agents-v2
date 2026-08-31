/**
 * Contradiction engine (2026-08-30, ported from the teammate's fork).
 *
 * When two sources disagree, the platform must surface both claims with their
 * provenance and a LABELLED explanation hypothesis — never resolve the
 * disagreement on the analyst's behalf.
 *
 * WHAT WAS ALREADY HERE, AND WHY IT IS NOT THIS. `analysis-llm.ts`'s
 * `summariseCluster()` asks a model for `disagreements[]` across news sources. That
 * is inference over prose and it is useful, but it is not detection: it cannot be
 * reproduced, it costs a model call, and it can hallucinate a disagreement. This
 * module is deterministic, free, and runs over collector output.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CENTRAL DESIGN PROBLEM: MULTI-VALUED FACTS ARE NOT CONTRADICTIONS.
 *
 * The obvious worked example is "Source A: domain -> IP A / Source B: domain ->
 * IP B". Implemented naively — flag whenever two collectors report different IPs —
 * this fires on essentially every real domain, because `RESOLVES_TO` is genuinely
 * multi-valued: round-robin DNS, CDNs and load balancers all mean one domain
 * legitimately has many addresses. A detector that flags Cloudflare as
 * self-contradictory is worse than no detector, because analysts learn to ignore it.
 *
 * The rule used instead is **disjointness**: two collectors contradict each other
 * only when neither's claim set contains ANY value the other reported. Overlap —
 * even partial — is read as partial coverage, which is the overwhelmingly common
 * case and is not a disagreement. Disjoint sets are the case that actually warrants
 * a human look.
 *
 * This is deliberately conservative: it will miss real contradictions where the sets
 * happen to overlap. That trade is made on purpose and is stated in
 * `CONTRADICTION_LIMITATIONS` below, because a false positive here costs analyst
 * trust in every subsequent signal, exactly as `cib.ts` argues for its own signals.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EXPLANATIONS ARE HYPOTHESES AND ARE TYPED AS SUCH.
 *
 * A plausible explanation like "DNS/infrastructure changed over time" must be
 * labelled as an explanation/hypothesis. `possibleExplanation` is therefore never
 * a bare string: it carries `isHypothesis: true` and the basis it was drawn from,
 * so no renderer can present it as a finding.
 */

import type { CollectorRelationship, RelationshipType } from "../collectors/result";

// ─── Input shape ────────────────────────────────────────────────────────────

/**
 * Deliberately a minimal structural type rather than importing `Investigation`
 * from `orchestrator.ts`. That file imports `createServerFn` from
 * `@tanstack/react-start`; importing it here would drag this pure module into that
 * graph, which is the shape of edge that has twice re-chunked `bun:sqlite` into a
 * bundle that could not load it. Structural typing means `Investigation` satisfies
 * this without an import existing at all.
 */
export interface ContradictionInput {
  collectorId: string;
  relationships: readonly CollectorRelationship[];
  /** When this collector's run started. Null when unknown — never defaulted to now. */
  observedAt?: string | null;
}

// ─── Output shape ────────────────────────────────────────────────────────────

export interface ContradictionClaim {
  /** The collector that made this claim. */
  source: string;
  /** Every value this source reported for the entity/predicate pair. */
  values: string[];
  /** When the claim was observed. `null` means unknown — dates are never invented. */
  observedAt: string | null;
}

export interface ContradictionExplanation {
  text: string;
  /** Always true. Present as a field rather than a convention so a renderer cannot lose it. */
  isHypothesis: true;
  /** What the explanation was drawn from, so a reader can judge it rather than trust it. */
  basis: string;
}

export interface Contradiction {
  /** The entity both sources are making a claim about. */
  entity: string;
  /** The predicate they disagree on. */
  relationshipType: RelationshipType;
  claimA: ContradictionClaim;
  claimB: ContradictionClaim;
  possibleExplanation: ContradictionExplanation;
  /**
   * Never a verdict. Mirrors `cib.ts`'s stance: organised legitimate activity and
   * organised inauthentic activity produce identical patterns, so the signal is
   * always "warrants review".
   */
  status: "warrants-review";
}

/**
 * Stated in the UI wherever contradictions are shown. A detector whose blind spots
 * are undocumented gets read as exhaustive.
 */
export const CONTRADICTION_LIMITATIONS: string[] = [
  "Only DISJOINT claim sets are flagged. If two sources report overlapping values, that is treated as partial coverage, not disagreement — so genuine contradictions with any overlap are missed.",
  "Only claims from DIFFERENT collectors are compared. One collector reporting inconsistent values internally is not detected here.",
  "Timestamps are the collector run times, not the ages of the underlying records. Two sources may disagree simply because one holds older data.",
  "Absence of a flagged contradiction is not evidence that sources agree.",
];

// ─── Detection ──────────────────────────────────────────────────────────────

function claimSets(
  inputs: readonly ContradictionInput[],
): Map<string, Map<string, { values: Set<string>; observedAt: string | null; type: RelationshipType }>> {
  // key: `${sourceEntity} ${relationshipType}` → collectorId → claim
  const byPredicate = new Map<
    string,
    Map<string, { values: Set<string>; observedAt: string | null; type: RelationshipType }>
  >();

  for (const input of inputs) {
    for (const rel of input.relationships) {
      const key = `${rel.sourceEntity} ${rel.relationshipType}`;
      let byCollector = byPredicate.get(key);
      if (!byCollector) {
        byCollector = new Map();
        byPredicate.set(key, byCollector);
      }
      let claim = byCollector.get(input.collectorId);
      if (!claim) {
        claim = {
          values: new Set(),
          observedAt: input.observedAt ?? null,
          type: rel.relationshipType,
        };
        byCollector.set(input.collectorId, claim);
      }
      claim.values.add(rel.targetEntity);
    }
  }
  return byPredicate;
}

function disjoint(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const v of a) if (b.has(v)) return false;
  return true;
}

/**
 * Explanations are chosen from the predicate, and every one is a hypothesis.
 *
 * `RESOLVES_TO` gets the domain-specific wording. Everything else gets a
 * generic form rather than a fabricated domain-specific rationale — inventing a
 * plausible-sounding reason for a predicate we have no theory about would be the
 * string-literal-as-measurement failure in a new costume.
 */
function explanationFor(type: RelationshipType, hasTimes: boolean): ContradictionExplanation {
  const timing = hasTimes
    ? "The two observations carry different collection times, so the underlying record may have changed between them."
    : "Collection times are unknown for at least one source, so a change over time cannot be ruled in or out.";

  if (type === "RESOLVES_TO" || type === "HOSTED_ON") {
    return {
      text: `DNS or hosting configuration may have changed between the two observations. ${timing}`,
      isHypothesis: true,
      basis: "Predicate is infrastructure-related, where records change frequently.",
    };
  }
  return {
    text: `The two sources report non-overlapping values for this property. ${timing}`,
    isHypothesis: true,
    basis: "Generic: no predicate-specific explanation is claimed.",
  };
}

/**
 * Finds pairs of collectors whose claims about the same (entity, predicate) are
 * entirely disjoint.
 *
 * Deterministic ordering: collectors are compared in sorted id order and each pair
 * is emitted once, so the same input always produces the same output in the same
 * sequence. A contradiction list that reshuffles between runs is one an analyst
 * cannot diff.
 */
export function detectContradictions(inputs: readonly ContradictionInput[]): Contradiction[] {
  const out: Contradiction[] = [];

  for (const [key, byCollector] of claimSets(inputs)) {
    if (byCollector.size < 2) continue;
    const entity = key.slice(0, key.indexOf(" "));
    const collectorIds = [...byCollector.keys()].sort();

    for (let i = 0; i < collectorIds.length; i++) {
      for (let j = i + 1; j < collectorIds.length; j++) {
        const a = byCollector.get(collectorIds[i]!)!;
        const b = byCollector.get(collectorIds[j]!)!;
        if (!disjoint(a.values, b.values)) continue;

        out.push({
          entity,
          relationshipType: a.type,
          claimA: {
            source: collectorIds[i]!,
            values: [...a.values].sort(),
            observedAt: a.observedAt,
          },
          claimB: {
            source: collectorIds[j]!,
            values: [...b.values].sort(),
            observedAt: b.observedAt,
          },
          possibleExplanation: explanationFor(a.type, a.observedAt !== null && b.observedAt !== null),
          status: "warrants-review",
        });
      }
    }
  }

  // Stable overall ordering, independent of Map iteration order.
  return out.sort(
    (x, y) =>
      x.entity.localeCompare(y.entity) ||
      x.relationshipType.localeCompare(y.relationshipType) ||
      x.claimA.source.localeCompare(y.claimA.source) ||
      x.claimB.source.localeCompare(y.claimB.source),
  );
}

/** One-line rendering for a report or list view. Keeps the hypothesis marker visible. */
export function describeContradiction(c: Contradiction): string {
  const a = `${c.claimA.source} reports ${c.claimA.values.join(", ")}`;
  const b = `${c.claimB.source} reports ${c.claimB.values.join(", ")}`;
  return `${c.entity} — ${c.relationshipType}: ${a}; ${b}. Possible explanation (hypothesis): ${c.possibleExplanation.text}`;
}

export interface ContradictionSummary {
  total: number;
  /** How many distinct entities are affected — a truer sense of scale than a raw pair count. */
  entitiesAffected: number;
  byRelationshipType: Record<string, number>;
  limitations: string[];
}

export function summariseContradictions(contradictions: readonly Contradiction[]): ContradictionSummary {
  const byRelationshipType: Record<string, number> = {};
  const entities = new Set<string>();
  for (const c of contradictions) {
    entities.add(c.entity);
    byRelationshipType[c.relationshipType] = (byRelationshipType[c.relationshipType] ?? 0) + 1;
  }
  return {
    total: contradictions.length,
    entitiesAffected: entities.size,
    byRelationshipType,
    limitations: CONTRADICTION_LIMITATIONS,
  };
}
