/**
 * Common collector result model — OSINT-INTEGRATION-PLAN.md §8.
 *
 * Every collector, whether it wraps an existing Sentinel utility (`dorks.ts`,
 * `social.ts`, …) or a new external tool (theHarvester, SpiderFoot), must
 * normalize its output into this shape before it reaches the orchestrator
 * (§11, not yet built — P1). One shape means the orchestrator, entity
 * resolver, evidence store and graph never special-case a source.
 *
 * Validated with zod and parsed at the boundary, the same discipline
 * `src/types/core.ts` applies to the inter-developer contracts: a collector
 * that returns a malformed result throws `InvestigationResultValidationError`
 * naming the field that moved, rather than silently reaching the UI.
 *
 * Plan Rule 6 (never fabricate OSINT facts) is enforced structurally here,
 * not just by convention:
 *   - `Evidence` requires `source`, `collector` and `collectedAt` on every
 *     item — there is no way to add a fact without saying where it came from.
 *   - Confidence is `null` when not computed, never defaulted to 0 or 1 —
 *     the same "null means not measured" rule the rest of this project uses.
 *   - `ConfidenceScore.reasons` exists because plan §18 requires every score
 *     to be explainable ("Confidence: 82% — same public email, two
 *     independent sources…"), not just a bare number.
 */

import { z } from "zod";
import { COLLECTOR_ERROR_REASONS, type CollectorErrorInfo } from "./errors";

const Iso8601 = z.string().min(1);

// ─── Confidence ─────────────────────────────────────────────────────────────

/**
 * `value` is null until a collector or the entity resolver (§18) actually
 * computes a score — never a placeholder 0 or 1. `reasons` names the signals
 * that produced the score (§18: "same exact email", "two independent
 * sources", …) so a reader never has to trust a bare number.
 */
export const ConfidenceScoreSchema = z.object({
  value: z.number().min(0).max(1).nullable(),
  reasons: z.array(z.string()),
});
export type ConfidenceScore = z.infer<typeof ConfidenceScoreSchema>;

/** A score with no reasons yet — the default for a collector that does not itself compute confidence. */
export const UNSCORED: ConfidenceScore = { value: null, reasons: [] };

// ─── Claim classes (2026-08-30, ported from the teammate's fork) ────────────

/**
 * What KIND of statement a piece of evidence is. Orthogonal to how confident we
 * are in it — without it a DNS answer and a model's guess are the same kind of
 * object carrying different numbers, and a reader has no way to tell which is
 * which except by recognising the collector.
 *
 *   OBSERVED   — read directly from a source. A crt.sh record, an RDAP response.
 *   DERIVED    — computed from observations by deterministic code. A pHash, a
 *                normalised domain, an account-age figure from a createdAt.
 *   CORRELATED — produced by relating observations from ≥2 independent sources.
 *                Entity resolution's merges land here.
 *   INFERRED   — a model or a heuristic proposed it. Never a fact.
 *                `confidenceBandOf()` below enforces HYPOTHESIS regardless of score.
 */
export const CLAIM_CLASSES = [
  "OBSERVED",
  /**
   * REPORTED is the floor for anything extracted from an article. **Nothing from
   * a news story is OBSERVED in this system's sense**: we observed a publisher
   * asserting something, not the thing itself. Collapsing that distinction is
   * precisely how "According to X, Y happened" silently becomes "Y happened".
   */
  "REPORTED",
  /** A REPORTED claim whose attributed source is a government/military/official body. Still a statement, still not a verified fact. */
  "OFFICIAL_STATEMENT",
  "DERIVED",
  "CORRELATED",
  "INFERRED",
  /** An explicit hypothesis. Bands to HYPOTHESIS regardless of any score attached. */
  "HYPOTHESIS",
] as const;
export const ClaimClassSchema = z.enum(CLAIM_CLASSES);
export type ClaimClass = z.infer<typeof ClaimClassSchema>;

export const CLAIM_CLASS_DETAIL: Record<ClaimClass, string> = {
  OBSERVED: "Read directly from the named source.",
  REPORTED:
    "A publisher or named source asserted this. It records what was said, not that it is true.",
  OFFICIAL_STATEMENT:
    "Asserted by a government, military or official body. An authoritative statement of a position — still not independent verification of the underlying fact.",
  DERIVED: "Computed deterministically from observations.",
  CORRELATED: "Produced by relating observations from more than one independent source.",
  INFERRED: "Proposed by a model or heuristic. Treat as a hypothesis, never as a finding.",
  HYPOTHESIS: "An explicit hypothesis offered for analyst review. Never a finding.",
};

/**
 * Classes that record *what someone said* rather than *what is the case*.
 *
 * A UI must never render these as bare facts: the attribution is the finding.
 * Exported so every renderer asks one question instead of re-deriving the rule.
 */
export const ATTRIBUTED_CLAIM_CLASSES: ReadonlySet<ClaimClass> = new Set([
  "REPORTED",
  "OFFICIAL_STATEMENT",
]);

// ─── Confidence bands (2026-08-30, ported) ──────────────────────────────────

/**
 * Four bands, derived from the numeric score rather than replacing it.
 * `ConfidenceScore` stays the stored form; this is a presentation-layer mapping,
 * so nothing that already reads `.value` changes.
 */
export const CONFIDENCE_BANDS = ["HIGH", "MEDIUM", "LOW", "HYPOTHESIS"] as const;
export type ConfidenceBand = (typeof CONFIDENCE_BANDS)[number];

/**
 * Thresholds are a policy choice, not a measurement — exported so they are visible,
 * testable and tunable in one place rather than inlined at call sites.
 */
export const CONFIDENCE_BAND_THRESHOLDS = { high: 0.8, medium: 0.5 } as const;

/**
 * Maps a score to a band. **Returns `null` when the score is `null`.**
 *
 * That null is the whole reason this is a function and not a ternary at the call
 * site. `value: null` means NOT MEASURED, and the one thing this must never do is
 * flatten an unmeasured score into `LOW` — a reader treats LOW as a weak finding,
 * which is a different and much stronger claim than "we never scored this". It is
 * the same rule the collector layer already applies to unreported casualty counts
 * and unfetchable account ages.
 *
 * `INFERRED` overrides the numeric band entirely: model inference, visual-location
 * guesses and name-only correlation all belong under HYPOTHESIS, and a
 * confident-looking number attached to a guess is exactly the fabrication this
 * project forbids. A model that reports 0.95 still lands in HYPOTHESIS.
 */
export function confidenceBandOf(
  score: ConfidenceScore | null | undefined,
  claimClass?: ClaimClass | null,
): ConfidenceBand | null {
  // Both classes name something nobody measured: a model's proposal and an
  // explicit hypothesis. Either one outranks whatever number is attached.
  if (claimClass === "INFERRED" || claimClass === "HYPOTHESIS") return "HYPOTHESIS";
  if (!score || score.value === null) return null;
  if (score.value >= CONFIDENCE_BAND_THRESHOLDS.high) return "HIGH";
  if (score.value >= CONFIDENCE_BAND_THRESHOLDS.medium) return "MEDIUM";
  return "LOW";
}

/**
 * The band plus the reasons that produced it, for a UI that must show *why* a
 * confidence was assigned. Returns `reasons: []` rather than inventing a
 * justification when a collector supplied none.
 */
export function explainConfidence(
  score: ConfidenceScore | null | undefined,
  claimClass?: ClaimClass | null,
): { band: ConfidenceBand | null; reasons: string[]; unmeasured: boolean } {
  const band = confidenceBandOf(score, claimClass);
  const reasons = score ? [...score.reasons] : [];
  if (claimClass === "INFERRED") {
    reasons.push("Claim class INFERRED — reported as a hypothesis regardless of score.");
  }
  if (claimClass === "HYPOTHESIS") {
    reasons.push("Claim class HYPOTHESIS — offered for review, not as a finding.");
  }
  if (claimClass && ATTRIBUTED_CLAIM_CLASSES.has(claimClass)) {
    reasons.push(
      "Attributed claim — the confidence describes the reporting, not the truth of what was reported.",
    );
  }
  return { band, reasons, unmeasured: !score || score.value === null };
}

// ─── Entity ──────────────────────────────────────────────────────────────────

/**
 * Superset of plan §7's target types plus the graph-only kinds from §19
 * (`organization`, `social_account`) that a collector can discover but a
 * user would not directly search on.
 */
export const ENTITY_TYPES = [
  "person",
  "email",
  "phone",
  "username",
  "domain",
  "ip",
  "url",
  "location",
  "article",
  "image",
  "video",
  "organization",
  "social_account",
] as const;
export const EntityTypeSchema = z.enum(ENTITY_TYPES);
export type EntityType = z.infer<typeof EntityTypeSchema>;

export const CollectorEntitySchema = z.object({
  id: z.string().min(1),
  type: EntityTypeSchema,
  value: z.string().min(1),
  displayName: z.string().min(1),
  /** Which collector produced this entity, e.g. "dns", "theharvester". */
  source: z.string().min(1),
  confidence: ConfidenceScoreSchema,
  metadata: z.record(z.unknown()),
});
export type CollectorEntity = z.infer<typeof CollectorEntitySchema>;

// ─── Relationship ────────────────────────────────────────────────────────────

/** Exactly the edge vocabulary plan §19 names for the existing graph. Additive-only if a future collector needs one not listed here. */
export const RELATIONSHIP_TYPES = [
  "HAS_EMAIL",
  "USES_USERNAME",
  "WORKS_AT",
  "LOCATED_IN",
  "MENTIONED_IN",
  "OWNS_DOMAIN",
  "RESOLVES_TO",
  "HOSTED_ON",
  "HAS_PORT",
  "SUPPORTED_BY",
  /**
   * Added for the Wayback collector: a domain or URL and the archived snapshot of
   * it. Additive, per this enum's own note above — no existing edge meant "there
   * is a historical capture of this", and reusing `SUPPORTED_BY` for it would have
   * made the graph say something untrue.
   */
  "ARCHIVED_AS",
  /**
   * Added for GEOINT (2026-08-30, ported). Four edges, and the split between the
   * first two is the entire point of the module:
   *
   *   HAS_METADATA_LOCATION  — the file's own EXIF GPS block said so. OBSERVED.
   *   HAS_LOCATION_HYPOTHESIS — a provider or an analyst proposed it from what
   *                             the picture looks like. HYPOTHESIS, always.
   *
   * They must never be merged into one "image is at location" edge: one is a
   * recorded measurement (forgeable, but recorded), the other is a guess.
   */
  "HAS_METADATA_LOCATION",
  "HAS_LOCATION_HYPOTHESIS",
  /** An image was found published at a URL — a reverse-image match, not proof of origin. */
  "APPEARS_AT",
  /** Two images are perceptually matched. Never an assertion that they depict the same event. */
  "MATCHED_TO",
  /**
   * Added for Sherlock: a handle exists on a platform — nothing more. Deliberately
   * NOT `USES_USERNAME`, which reads as a person using a handle and would let a
   * username-existence check masquerade as an identity finding. Two different
   * people can hold the same handle on two platforms, and a handle matching a
   * person's name is not evidence they registered it. The edge is named for what
   * it is so no renderer can shorten it into ownership.
   */
  "CANDIDATE_ACCOUNT",
  /**
   * Added for email/phone intelligence (2026-08-30, ported). A person and an
   * identifier were seen together — **not** that the identifier is theirs.
   *
   * The case it exists for: a name beside an address, scraped from a page. That
   * establishes the pair was PUBLISHED somewhere. It does not establish
   * ownership: names on public pages go stale, and `info@`/`sales@` belong to
   * organisations, not people.
   *
   * Deliberately NOT `HAS_EMAIL` in the person→email direction, which reads as
   * ownership. `HAS_EMAIL` stays what theHarvester already uses it for —
   * domain→email, a deterministic fact about the address itself.
   */
  "CANDIDATE_IDENTITY",
] as const;
export const RelationshipTypeSchema = z.enum(RELATIONSHIP_TYPES);
export type RelationshipType = z.infer<typeof RelationshipTypeSchema>;

export const CollectorRelationshipSchema = z.object({
  /** Entity id, not a raw value — relationships link resolved entities. */
  sourceEntity: z.string().min(1),
  relationshipType: RelationshipTypeSchema,
  targetEntity: z.string().min(1),
  confidence: ConfidenceScoreSchema,
  source: z.string().min(1),
});
export type CollectorRelationship = z.infer<typeof CollectorRelationshipSchema>;

// ─── Evidence ────────────────────────────────────────────────────────────────

/**
 * Plan §6.1 / Rule 6 field list verbatim: source, source URL where
 * applicable, collector, collection time, raw/normalized value, confidence
 * where applicable. `sourceUrl` and `confidence` are nullable rather than
 * optional so a schema mismatch (a collector that forgets the field
 * entirely) still throws instead of silently validating.
 */
export const CollectorEvidenceSchema = z.object({
  source: z.string().min(1),
  sourceUrl: z.string().url().nullable(),
  collector: z.string().min(1),
  /**
   * A stable handle for this record, so a timeline event or a report citation
   * can point back at it (2026-08-30, ported).
   *
   * `.optional()` and additive, for the same reason `claimClass` is: every
   * collector that predates this field leaves it unset, and none is required to
   * set one at the boundary.
   *
   * **Absent means the collector did not supply an id — it is never derived into
   * the contract.** `osint/timeline.ts` mints a positional `eventRef` for
   * link-back instead, which is a reference key and not a claim about the record.
   */
  evidenceId: z.string().min(1).optional(),
  collectedAt: Iso8601,
  rawValue: z.unknown(),
  normalizedValue: z.unknown(),
  confidence: ConfidenceScoreSchema.nullable(),
  /**
   * (2026-08-30, ported). **`.optional()`, not `.nullable()`, and the distinction
   * is load-bearing here** — unlike `sourceUrl`/`confidence` above, which are
   * nullable so that a collector forgetting them still throws.
   *
   * This field is additive to a frozen-in-practice shape: every collector that
   * predates it leaves it unset. Making it required (or nullable-and-required)
   * would fail every one of them at the boundary — a breaking change to working
   * code, which the preservation protocol forbids.
   *
   * Absent therefore means **unclassified**, and readers must not default it to
   * OBSERVED. `confidenceBandOf()` takes the class as a separate argument
   * precisely so an absent class produces a band from the number alone rather
   * than an assumed provenance.
   */
  claimClass: ClaimClassSchema.optional(),
  metadata: z.record(z.unknown()),
});
export type CollectorEvidence = z.infer<typeof CollectorEvidenceSchema>;

// ─── Execution ───────────────────────────────────────────────────────────────

/**
 * Plan §12's job statuses, reused here as the per-run execution status so a
 * single collector run and the job that scheduled it speak the same
 * vocabulary. `partial` is distinct from `completed`: a collector that got
 * some results before hitting a recoverable error (e.g. one theHarvester
 * source failed but others returned) reports `partial`, not a clean success.
 */
export const EXECUTION_STATUSES = [
  "queued",
  "running",
  "completed",
  "partial",
  "failed",
  "cancelled",
] as const;
export const ExecutionStatusSchema = z.enum(EXECUTION_STATUSES);
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

const CollectorErrorInfoSchema = z.object({
  collector: z.string().min(1),
  reason: z.enum(COLLECTOR_ERROR_REASONS),
  message: z.string().min(1),
}) satisfies z.ZodType<CollectorErrorInfo>;

export const CollectorExecutionMetaSchema = z.object({
  status: ExecutionStatusSchema,
  startedAt: Iso8601,
  /** Null while `status` is `queued` or `running`. */
  completedAt: Iso8601.nullable(),
  /** Null until completion — deriving it from timestamps at read time would round-trip through the same two fields anyway. */
  durationMs: z.number().nonnegative().nullable(),
  resultCount: z.number().int().nonnegative(),
  /** Null unless `status` is `failed`, `partial` or `cancelled`. Rule 5: a failure is never represented by an empty `entities[]` alone. */
  error: CollectorErrorInfoSchema.nullable(),
});
export type CollectorExecutionMeta = z.infer<typeof CollectorExecutionMetaSchema>;

// ─── InvestigationResult ──────────────────────────────────────────────────────

export const InvestigationResultSchema = z.object({
  entities: z.array(CollectorEntitySchema),
  relationships: z.array(CollectorRelationshipSchema),
  evidence: z.array(CollectorEvidenceSchema),
  /** Non-fatal notices — e.g. "3 of 12 records skipped: missing required field". */
  warnings: z.array(z.string()),
  /** Fatal-to-this-collector notices that still allowed a partial result. */
  errors: z.array(z.string()),
  metadata: z.record(z.unknown()),
  execution: CollectorExecutionMetaSchema,
});
export type InvestigationResult = z.infer<typeof InvestigationResultSchema>;

/** An `InvestigationResult` with no findings and no execution info attached yet — a starting point for a collector's `normalize()`, not a valid standalone result (callers must still fill in `execution`). */
export function emptyInvestigationResult(execution: CollectorExecutionMeta): InvestigationResult {
  return {
    entities: [],
    relationships: [],
    evidence: [],
    warnings: [],
    errors: [],
    metadata: {},
    execution,
  };
}

// ─── Boundary parsing ──────────────────────────────────────────────────────

/**
 * Thrown when a collector's `normalize()` output does not match the common
 * result model. Mirrors `ContractViolationError` in `src/types/core.ts`:
 * names the collector and zod's own path detail, and never coerces.
 */
export class InvestigationResultValidationError extends Error {
  constructor(
    readonly collectorId: string,
    readonly issues: string[],
  ) {
    super(
      `InvestigationResult from collector "${collectorId}" does not match the common result model: ` +
        `${issues.join("; ")}.`,
    );
    this.name = "InvestigationResultValidationError";
  }
}

export function parseInvestigationResult(collectorId: string, value: unknown): InvestigationResult {
  const result = InvestigationResultSchema.safeParse(value);
  if (result.success) return result.data;
  const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  throw new InvestigationResultValidationError(collectorId, issues);
}
