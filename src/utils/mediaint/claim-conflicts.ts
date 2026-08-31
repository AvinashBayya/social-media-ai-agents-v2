/**
 * MEDIAINT claim conflict detection (2026-08-30, ported from the teammate's
 * fork) — the comparison half of claim extraction.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DELIBERATELY A SEPARATE FILE FROM `claims.ts`.
 *
 * Extraction creates structured claims. Comparison relates them. Keeping them in
 * one module would let a future change make extraction depend on what other
 * articles said, which is exactly how a single-source claim quietly acquires the
 * confidence of a corroborated one.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * REUSES THE CONTRADICTION ENGINE RATHER THAN DUPLICATING IT.
 *
 * `osint/contradictions.ts` detects disagreement between *collectors* over
 * *relationships* — "dns says 1.1.1.1, shodan says 2.2.2.2" — using a
 * disjoint-sets rule. That rule is right for multi-valued infrastructure facts
 * and wrong for prose: two outlets are not in conflict merely because their
 * wording differs.
 *
 * So the detection differs, but the OUTPUT does not: this module emits that
 * module's own `Contradiction` shape, with its `isHypothesis`-tagged explanation
 * and its `status: "warrants-review"`. One vocabulary, one renderer, one
 * discipline — and the contradiction engine is imported, not copied. The import
 * direction is claims → contradictions, never the reverse, so the
 * infrastructure engine stays unaware media claims exist.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT NEVER ADJUDICATES.
 *
 * "Company X announced an acquisition" against "Company X denied acquisition
 * discussions" produces CONFLICTING_CLAIMS with both source records retained.
 * Which is true is not decidable from the reporting alone, and nothing here
 * pretends otherwise. An LLM may later summarise or explain the conflict; it must
 * not resolve it.
 */

import type { Contradiction, ContradictionExplanation } from "../osint/contradictions";
import { CONTRADICTION_LIMITATIONS } from "../osint/contradictions";
import type { MediaClaim } from "./claims";
import { claimKey, claimsMatch } from "./claims";

/** A conflict between two media claims, carrying both full records. */
export interface ClaimConflict {
  kind: "CONFLICTING_CLAIMS";
  /** The normalised assertion both claims are about. */
  subject: string;
  assertion: MediaClaim;
  denial: MediaClaim;
  /** Both source records, retained verbatim — the whole point. */
  claims: [MediaClaim, MediaClaim];
  possibleExplanation: ContradictionExplanation;
  status: "warrants-review";
}

export const CLAIM_CONFLICT_LIMITATIONS: string[] = [
  "Only assertion-versus-denial pairs on a matching subject are detected. Two sources disagreeing on a NUMBER (casualty figures, valuations) are not caught here.",
  "Matching is over stemmed headline tokens, so a conflict phrased in entirely different words will be missed.",
  "A denial that post-dates an assertion may be a correction rather than a contradiction — the timestamps are reported so an analyst can judge; the system does not.",
  "Absence of a detected conflict is not evidence that sources agree.",
  ...CONTRADICTION_LIMITATIONS.filter((l) => l.includes("not evidence")),
];

function explanationFor(a: MediaClaim, b: MediaClaim): ContradictionExplanation {
  const bothDated = a.publishedAt !== null && b.publishedAt !== null;
  const timing = bothDated
    ? "Both carry publication dates, so one may be a later correction, retraction or update of the other."
    : "At least one claim carries no publication date, so their order cannot be established.";
  return {
    text: `One source asserts this and another denies it. ${timing} Both records are retained; neither is treated as settled.`,
    isHypothesis: true,
    basis: "Assertion/denial polarity on a matching subject, from the claims' own verbs.",
  };
}

/**
 * Finds assertion/denial pairs over the same subject.
 *
 * Deterministic ordering throughout: claims are compared in `claimId` order and
 * each pair is emitted once, so the same corpus always produces the same list in
 * the same sequence.
 *
 * **Same-publisher pairs are skipped.** One outlet reporting both "X announced"
 * and "X denied" across a developing story is a chronology, not a contradiction
 * between sources — flagging it would bury the real cross-source conflicts.
 */
export function detectClaimConflicts(claims: readonly MediaClaim[]): ClaimConflict[] {
  const asserts = claims.filter((c) => c.polarity === "assert" && claimKey(c)).sort(byId);
  const denials = claims.filter((c) => c.polarity === "deny" && claimKey(c)).sort(byId);

  const out: ClaimConflict[] = [];
  for (const a of asserts) {
    for (const d of denials) {
      // Matched by similarity, using the same threshold corroboration uses, so
      // "announced acquisition" and "denied acquisition discussions" pair up
      // while two unrelated stories about one company do not.
      if (!claimsMatch(a, d)) continue;
      const aPub = a.publisher ?? a.source;
      const dPub = d.publisher ?? d.source;
      if (aPub === dPub) continue;
      out.push({
        kind: "CONFLICTING_CLAIMS",
        subject: claimKey(a).split("|").join(" "),
        assertion: a,
        denial: d,
        claims: [a, d],
        possibleExplanation: explanationFor(a, d),
        status: "warrants-review",
      });
    }
  }

  return out.sort(
    (x, y) =>
      x.subject.localeCompare(y.subject) ||
      x.assertion.claimId.localeCompare(y.assertion.claimId) ||
      x.denial.claimId.localeCompare(y.denial.claimId),
  );
}

function byId(a: MediaClaim, b: MediaClaim): number {
  return a.claimId.localeCompare(b.claimId);
}

/**
 * Projects a claim conflict into the contradiction engine's `Contradiction`
 * shape, so a single renderer and a single report section can carry both
 * infrastructure and media conflicts.
 *
 * The projection is lossy by design — `Contradiction` has no field for an
 * article's publisher or publication date — so it is offered ALONGSIDE
 * `ClaimConflict`, never as a replacement for it. Anything needing the full
 * source records reads the `ClaimConflict`.
 */
export function toContradiction(conflict: ClaimConflict): Contradiction {
  return {
    entity: conflict.subject,
    // The closest existing edge: both claims are statements reported in articles.
    relationshipType: "MENTIONED_IN",
    claimA: {
      source: conflict.assertion.publisher ?? conflict.assertion.source,
      values: [conflict.assertion.claimText],
      observedAt: conflict.assertion.publishedAt,
    },
    claimB: {
      source: conflict.denial.publisher ?? conflict.denial.source,
      values: [conflict.denial.claimText],
      observedAt: conflict.denial.publishedAt,
    },
    possibleExplanation: conflict.possibleExplanation,
    status: "warrants-review",
  };
}

export interface ClaimConflictSummary {
  total: number;
  subjectsAffected: number;
  limitations: string[];
}

export function summariseClaimConflicts(conflicts: readonly ClaimConflict[]): ClaimConflictSummary {
  return {
    total: conflicts.length,
    subjectsAffected: new Set(conflicts.map((c) => c.subject)).size,
    limitations: CLAIM_CONFLICT_LIMITATIONS,
  };
}
