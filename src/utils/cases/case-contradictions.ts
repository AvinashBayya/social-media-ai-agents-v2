import type { CollectorEvidence, CollectorRelationship } from "../collectors/result";
import type { Contradiction, ContradictionInput } from "../osint/contradictions";
import { CONTRADICTION_LIMITATIONS, detectContradictions, summariseContradictions } from "../osint/contradictions";
import type { ClaimConflict } from "../mediaint/claim-conflicts";
import { CLAIM_CONFLICT_LIMITATIONS, detectClaimConflicts } from "../mediaint/claim-conflicts";
import type { MediaClaim } from "../mediaint/claims";
import { caseMediaClaims } from "./case-claims";

/**
 * Case-scoped contradictions (2026-08-30, ported from the teammate's fork).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THIS IS A COMPOSITION LAYER. IT CONTAINS NO DETECTION LOGIC.
 *
 * Both engines are already built and tested; nothing here re-detects anything.
 * Every rule, threshold, explanation and limitation string comes from the
 * existing modules:
 *
 *   infrastructure  osint/contradictions.ts       disjoint claim sets
 *   media           mediaint/claim-conflicts.ts   assertion vs denial
 *   extraction      mediaint/claims.ts            deterministic, pure, clock-free
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * DERIVED, NOT PERSISTED — AND THAT IS THE POINT.
 *
 * Case scoping already stores both inputs per case:
 *
 *   sentinel_graph_snapshot__<caseId>     relationships → infrastructure conflicts
 *   sentinel_timeline_snapshot__<caseId>  evidence      → media claims → conflicts
 *
 * `extractClaims` is pure and `claimIdFor` is stable, so the same snapshot always
 * yields the same claims and the same conflicts. Persisting them would create a
 * second copy that goes stale against the snapshot **silently** — the exact
 * failure `CaseRun` already documents about not copying run results. It would
 * also mean changing the snapshot storage, which this module must not do.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ASSOCIATION IS BY REFERENCE AT EVERY HOP. NOTHING IS DUPLICATED.
 *
 *   case → run → investigation → claimId → evidenceRef → sourceUrl
 *
 * A `CaseContradiction` holds ids and points at the two claim records the
 * detector already produced. It does not copy evidence, and it does not
 * re-describe a claim in its own words.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * IT NEVER ADJUDICATES.
 *
 * The only status either engine emits is `"warrants-review"`, and both types
 * make that the sole permitted value. Nothing here widens it. There is no
 * TRUE/FALSE, no "resolved", no winner. Which claim is correct is not decidable
 * from the reporting alone, and the UI says so in those words.
 */

/** Where a contradiction sits in the case hierarchy. Ids only — see the header. */
export interface ContradictionProvenance {
  caseId: string;
  /** The `CaseRun` that produced the snapshot, when the snapshot recorded one. */
  runId: string | null;
  /** The OSINT job-system investigation id. */
  investigationId: string;
  /** The snapshot's own save time, so a stale derivation is visible. */
  snapshotSavedAt: string;
}

/**
 * A media conflict placed in a case.
 *
 * `conflict` is the detector's own `ClaimConflict`, untouched — which is what
 * carries both full `MediaClaim` records, and therefore `claimClass`,
 * `confidence`, `evidenceRef`, `sourceUrl`, `publisher` and `publishedAt`.
 *
 * This is a `ClaimConflict` and not `toContradiction()` because that
 * projection has no field for claim class, confidence or evidence ref, and the
 * UI is required to show all three. `claim-conflicts.ts` says the same about
 * its own projection — it is offered alongside, never as a replacement.
 */
export interface CaseClaimConflict {
  kind: "MEDIA";
  provenance: ContradictionProvenance;
  conflict: ClaimConflict;
  /** Both claim ids, for linking. Duplicated from the claims deliberately — an id is a reference, not a copy. */
  claimIds: [string, string];
  /** Both evidence refs, or null where a claim has none. Drives the evidence-navigation rule. */
  evidenceRefs: [string | null, string | null];
}

/** An infrastructure contradiction placed in a case. `contradiction` is the engine's own record, untouched. */
export interface CaseInfraContradiction {
  kind: "INFRASTRUCTURE";
  provenance: ContradictionProvenance;
  contradiction: Contradiction;
}

export type CaseContradiction = CaseClaimConflict | CaseInfraContradiction;

export interface CaseContradictionReport {
  media: CaseClaimConflict[];
  infrastructure: CaseInfraContradiction[];
  /** Claims extracted, for context — a zero-conflict result over zero claims means something different from over 200. */
  claimsExamined: number;
  articlesExamined: number;
  relationshipsExamined: number;
  collectorsCompared: number;
  /**
   * Conflicts withheld because a claim could not be traced back to evidence.
   *
   * Reported, never silently dropped: "we found nothing" and "we found something
   * we refuse to show you" are different statements. A contradiction whose
   * underlying evidence cannot be reached is not displayable, but that does not
   * permit hiding that one existed.
   */
  withheldUntraceable: number;
  limitations: string[];
}

/** Both engines' limitation lists, deduplicated. Neither is authored here. */
export const CASE_CONTRADICTION_LIMITATIONS: string[] = [
  ...new Set([...CLAIM_CONFLICT_LIMITATIONS, ...CONTRADICTION_LIMITATIONS]),
];

/**
 * The caveat that must appear wherever a contradiction is shown.
 *
 * Wording fixed here so two surfaces cannot drift into softer language. The
 * second sentence is the load-bearing one.
 */
export const NO_ADJUDICATION_CAVEAT =
  "Conflicting claims detected. This finding requires analyst review; the system has not established which claim is true.";

/**
 * Real per-collector observation times, taken from the evidence itself.
 *
 * **Not the snapshot's `savedAt`** — that is when the snapshot was written, not
 * when anything was observed, and stamping it here would be the
 * timestamp-invention failure this project greps for. A collector with no dated
 * evidence gets `null`, which `explanationFor` already handles by saying a change
 * over time cannot be ruled in or out.
 *
 * The EARLIEST record is used: it is the first moment this collector is known to
 * have observed anything in this run, which is the honest floor.
 */
export function observedAtByCollector(
  evidence: readonly CollectorEvidence[],
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const ev of evidence) {
    if (!ev.collector) continue;
    const at = typeof ev.collectedAt === "string" && ev.collectedAt ? ev.collectedAt : null;
    if (!(ev.collector in out)) {
      out[ev.collector] = at;
      continue;
    }
    const current = out[ev.collector];
    if (at && (current === null || at < current)) out[ev.collector] = at;
  }
  return out;
}

/**
 * Groups relationships by the collector that asserted them.
 *
 * `CollectorRelationship.source` already names it, so no new field and no new
 * store is needed — this makes derived-on-demand viable.
 */
export function toContradictionInputs(
  relationships: readonly CollectorRelationship[],
  observedAt: Record<string, string | null> = {},
): ContradictionInput[] {
  const byCollector = new Map<string, CollectorRelationship[]>();
  for (const rel of relationships) {
    if (!rel.source) continue;
    const list = byCollector.get(rel.source);
    if (list) list.push(rel);
    else byCollector.set(rel.source, [rel]);
  }
  // Sorted so the input order — and therefore the output order — is deterministic.
  return [...byCollector.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([collectorId, rels]) => ({
      collectorId,
      relationships: rels,
      observedAt: observedAt[collectorId] ?? null,
    }));
}

/**
 * True when both sides of a conflict can be traced back to an evidence record.
 *
 * A contradiction whose underlying evidence cannot be reached is not
 * displayable, because the analyst cannot check it. `articlesFromEvidence`
 * always populates `evidenceRefs`, so in practice this only excludes claims
 * built from articles that reached the extractor by another path.
 */
export function isTraceable(conflict: ClaimConflict): boolean {
  return !!conflict.assertion.evidenceRef && !!conflict.denial.evidenceRef;
}

export interface BuildOptions {
  caseId: string;
  runId: string | null;
  investigationId: string;
  snapshotSavedAt: string;
  evidence: readonly CollectorEvidence[];
  relationships: readonly CollectorRelationship[];
  /** Injected — nothing in the extraction path may read a clock. */
  extractedAt: string;
}

/**
 * Runs both existing engines over one case's already-case-scoped snapshots.
 *
 * Pure: no storage read, no network, no clock. The caller supplies the snapshot
 * contents and the timestamp, which is what makes the whole path testable and
 * what keeps this module out of the case-scope storage layer entirely.
 */
export function buildCaseContradictions(options: BuildOptions): CaseContradictionReport {
  const provenance: ContradictionProvenance = {
    caseId: options.caseId,
    runId: options.runId,
    investigationId: options.investigationId,
    snapshotSavedAt: options.snapshotSavedAt,
  };

  // ── Media: evidence → articles → claims → conflicts ──────────────────────
  //
  // Routed through `caseMediaClaims`, the ONE case-level accessor, rather than
  // a second hand-written copy of the same three-call sequence. The
  // contradiction engine's detection logic is untouched.
  const projected = caseMediaClaims({
    caseId: options.caseId,
    evidence: options.evidence,
    extractedAt: options.extractedAt,
  });
  const claims: MediaClaim[] = projected.claims;
  const allConflicts = projected.conflicts;
  const traceable = allConflicts.filter(isTraceable);

  const media: CaseClaimConflict[] = traceable.map((conflict) => ({
    kind: "MEDIA",
    provenance,
    conflict,
    claimIds: [conflict.assertion.claimId, conflict.denial.claimId],
    evidenceRefs: [conflict.assertion.evidenceRef, conflict.denial.evidenceRef],
  }));

  // ── Infrastructure: relationships → per-collector inputs → contradictions ─
  const inputs = toContradictionInputs(
    options.relationships,
    observedAtByCollector(options.evidence),
  );
  const infrastructure: CaseInfraContradiction[] = detectContradictions(inputs).map(
    (contradiction) => ({ kind: "INFRASTRUCTURE", provenance, contradiction }),
  );

  return {
    media,
    infrastructure,
    claimsExamined: claims.length,
    articlesExamined: projected.articlesExamined,
    relationshipsExamined: options.relationships.length,
    collectorsCompared: inputs.length,
    withheldUntraceable: allConflicts.length - traceable.length,
    limitations: CASE_CONTRADICTION_LIMITATIONS,
  };
}

export interface CaseContradictionSummary {
  total: number;
  media: number;
  infrastructure: number;
  /** Distinct entities/subjects involved — a truer sense of scale than a pair count. */
  subjectsAffected: number;
  byRelationshipType: Record<string, number>;
  /** Always the same single value. Present so a renderer reads it rather than assuming. */
  statuses: string[];
}

export function summariseCaseContradictions(
  report: CaseContradictionReport,
): CaseContradictionSummary {
  const infraSummary = summariseContradictions(report.infrastructure.map((i) => i.contradiction));
  const subjects = new Set<string>([
    ...report.media.map((m) => m.conflict.subject),
    ...report.infrastructure.map((i) => i.contradiction.entity),
  ]);
  return {
    total: report.media.length + report.infrastructure.length,
    media: report.media.length,
    infrastructure: report.infrastructure.length,
    subjectsAffected: subjects.size,
    byRelationshipType: infraSummary.byRelationshipType,
    // Read off the records rather than hardcoded, so widening either engine's
    // status vocabulary would show up here instead of being silently absorbed.
    statuses: [
      ...new Set([
        ...report.media.map((m) => m.conflict.status),
        ...report.infrastructure.map((i) => i.contradiction.status),
      ]),
    ],
  };
}
