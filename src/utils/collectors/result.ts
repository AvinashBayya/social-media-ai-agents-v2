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
  collectedAt: Iso8601,
  rawValue: z.unknown(),
  normalizedValue: z.unknown(),
  confidence: ConfidenceScoreSchema.nullable(),
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
