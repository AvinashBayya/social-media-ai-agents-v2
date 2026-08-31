/**
 * MEDIAINT claims, projected onto a case (2026-08-30, ported from the
 * teammate's fork).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE EXTRACTOR, ONE ACCESSOR. NOTHING IS STORED.
 *
 * `mediaint/claims.ts` is and remains the only claim extractor in this codebase,
 * and `mediaint/claim-conflicts.ts` the only conflict detector. This module adds
 * neither. It is the single place that runs them **over a case's own evidence**,
 * so the three-call sequence (`articlesFromEvidence` → `extractClaims` →
 * `detectClaimConflicts`) is written once rather than independently by the
 * discipline breakdown, the grounded context and the case contradictions
 * builder — three copies of a derivation drift; this is one.
 *
 * **Claims are DERIVED ON READ, never persisted.** They are a projection of
 * `CollectorEvidence` records that already live in the case's timeline snapshot.
 * Writing them anywhere would create a second copy that goes stale silently — the
 * same reason `CaseRun` deliberately does not copy its results out of the job
 * store. Every field a UI or a report needs is carried through from the evidence:
 * `evidenceRef`, `source`, `sourceUrl`, `publisher`, `publishedAt`, `claimClass`,
 * `confidence` and the publisher's own `claimText`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE FLOOR IS REPORTED, AND IT HAS NO CEILING ABOVE IT HERE.
 *
 * `extractClaims` assigns `OFFICIAL_STATEMENT` when its own closed
 * `OFFICIAL_SOURCE_MARKERS` list matches the attributed source, and `REPORTED`
 * otherwise. **Nothing in this module inspects or changes a claim class.** An
 * article claim can therefore never become `OBSERVED`: we observed a publisher
 * asserting something, not the thing itself, and collapsing that distinction is
 * exactly how "According to X, Y happened" silently becomes "Y happened".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONFLICTS ARE SHOWN, NEVER ADJUDICATED.
 *
 * `conflictsByClaimId` exists so a UI can mark a claim as *participating in* a
 * disagreement. It marks BOTH sides equally. There is no winner field, no
 * ordering by credibility, and no code path that could produce one.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure: no storage, no network, no clock. `extractedAt` is injected, which is
 * what makes the output byte-identical for a given snapshot.
 */

import type { CollectorEvidence } from "../collectors/result";
import type { MediaClaim } from "../mediaint/claims";
import {
  CLAIM_CAVEATS,
  articlesFromEvidence,
  extractClaims,
  summariseClaims,
  type ClaimSetSummary,
} from "../mediaint/claims";
import type { ClaimConflict } from "../mediaint/claim-conflicts";
import {
  CLAIM_CONFLICT_LIMITATIONS,
  detectClaimConflicts,
} from "../mediaint/claim-conflicts";

/**
 * Why a case shows no MEDIAINT figures at all.
 *
 * Distinct from a genuine zero. A case whose timeline snapshot is missing,
 * evicted or belongs to another case has not been *measured*, and rendering
 * "Claims: 0" for it would be a fabricated measurement — the `?? 0` failure this
 * project greps for, wearing a different hat.
 */
export const MEDIAINT_NOT_CASE_SCOPED =
  "No evidence snapshot is stored for this case, so no article has been read and no claim has been extracted. This is a collection state, not a finding that the coverage contains no claims.";

/** The wording used when a case genuinely has article evidence but no claim matched. */
export const NO_CLAIMS_MESSAGE =
  "No claim was extracted from this case's article evidence. The extractor only records sentences matching its closed attribution vocabulary, so this means nothing matched — never that the coverage makes no assertions.";

export const CASE_CLAIM_CAVEATS: string[] = [
  ...new Set([
    ...CLAIM_CAVEATS,
    "Claims are derived from this case's own evidence each time they are read. They are never stored, so they cannot go stale against the evidence they came from.",
    "A claim marked as conflicting is one side of a disagreement between publishers. Both sides are shown and neither is marked correct.",
    ...CLAIM_CONFLICT_LIMITATIONS,
  ]),
];

export interface CaseClaimsInput {
  caseId: string;
  /** The case's OWN evidence, already gated on a MATCH scope verdict by the caller. */
  evidence: readonly CollectorEvidence[];
  /** Injected — the extractor must never read a clock. */
  extractedAt: string;
}

export interface CaseClaims {
  caseId: string;
  claims: MediaClaim[];
  conflicts: ClaimConflict[];
  /**
   * Claim id → the conflicts it participates in. BOTH sides of every conflict
   * appear, so a UI cannot mark one and not the other.
   */
  conflictsByClaimId: Map<string, ClaimConflict[]>;
  summary: ClaimSetSummary;
  /** How many article-shaped records the evidence yielded. Zero articles and zero claims are different states. */
  articlesExamined: number;
  /** Evidence records that were not article-shaped and were skipped rather than coerced. */
  nonArticleEvidence: number;
  caveats: string[];
}

/**
 * Derives this case's media claims and their conflicts.
 *
 * The caller supplies evidence it has ALREADY gated on the case-scope
 * verdict. This function has no access to storage and therefore cannot fall back
 * to the unscoped slot — the isolation property is structural rather than a rule
 * that has to be remembered here.
 */
export function caseMediaClaims(input: CaseClaimsInput): CaseClaims {
  const { articles, evidenceRefs } = articlesFromEvidence(input.evidence);
  const claims = extractClaims(articles, {
    extractedAt: input.extractedAt,
    evidenceRefs,
  });
  const conflicts = detectClaimConflicts(claims);

  const conflictsByClaimId = new Map<string, ClaimConflict[]>();
  for (const c of conflicts) {
    // Both sides, always. A conflict marked on one claim only would read as one
    // side being the disputed one.
    for (const id of c.claims.map((m) => m.claimId)) {
      const list = conflictsByClaimId.get(id);
      if (list) list.push(c);
      else conflictsByClaimId.set(id, [c]);
    }
  }

  return {
    caseId: input.caseId,
    claims,
    conflicts,
    conflictsByClaimId,
    summary: summariseClaims(claims),
    articlesExamined: articles.length,
    nonArticleEvidence: input.evidence.length - articles.length,
    caveats: CASE_CLAIM_CAVEATS,
  };
}

/** True when this claim is one side of a detected disagreement. */
export function isConflicted(result: CaseClaims, claimId: string): boolean {
  return (result.conflictsByClaimId.get(claimId)?.length ?? 0) > 0;
}

/**
 * The evidence ids this case's claims cite.
 *
 * Never minted. A claim whose article carried no `evidenceId` contributes
 * nothing here, and the UI shows it as having no reference rather than inventing
 * one — a citation pointing at an id that does not exist is worse than one that
 * admits it has none.
 */
export function citedEvidenceRefs(result: CaseClaims): Set<string> {
  const out = new Set<string>();
  for (const c of result.claims) if (c.evidenceRef) out.add(c.evidenceRef);
  return out;
}

/** A one-line header figure. Reports counts only — never a judgement about the coverage. */
export function claimsHeadline(result: CaseClaims): string {
  if (result.claims.length === 0) return NO_CLAIMS_MESSAGE;
  const parts = [
    `${result.claims.length} claim${result.claims.length === 1 ? "" : "s"}`,
    `${result.summary.publishers} publisher${result.summary.publishers === 1 ? "" : "s"}`,
  ];
  if (result.summary.officialStatements > 0) {
    parts.push(`${result.summary.officialStatements} official statement${result.summary.officialStatements === 1 ? "" : "s"}`);
  }
  if (result.conflicts.length > 0) {
    parts.push(`${result.conflicts.length} conflicting pair${result.conflicts.length === 1 ? "" : "s"}`);
  }
  return parts.join(" · ");
}

// `NO_ADJUDICATION_CAVEAT` is deliberately NOT re-exported here. It lives in
// `case-contradictions.ts`, which now imports THIS module — re-exporting it back
// would close an import cycle between the two, and this project has a recorded
// re-chunking landmine that makes cycles expensive to debug. A surface showing
// both claims and conflicts imports the caveat from its own home.
