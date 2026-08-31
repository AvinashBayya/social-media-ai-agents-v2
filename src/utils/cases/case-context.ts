import type { CollectorEntity, CollectorEvidence, CollectorRelationship, ClaimClass } from "../collectors/result";
import type { OsintPlan } from "../osint/query-planner";
import type { RunStatus } from "./case-runs";
import type { SnapshotTruncation } from "./case-scope";
import type { CollectionCompleteness, ReportContradiction } from "./case-report";
import { assessCompleteness, completenessHeadline, toReportContradictions } from "./case-report";
import { buildCaseContradictions } from "./case-contradictions";
import { caseMediaClaims } from "./case-claims";
import { buildEvidenceTimeline } from "../osint/timeline";
import {
  RESOLUTION_CAVEATS,
  resolutionSummary,
  resolvedCaseEntities,
} from "./case-entities";
import {
  CORRELATION_CAVEATS,
  buildCrossIntelligence,
  type CollectorDisciplines,
  type CrossIntelligenceCorrelation,
} from "./cross-intelligence";

/**
 * The typed context an analysis agent is allowed to see (2026-08-30, ported
 * from the teammate's fork).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT WAS WRONG.
 *
 * An earlier audit found `/agents` handing the model four strings — case title,
 * target, description, and a risk number nobody assigned — and nothing else. No
 * evidence, no evidence ids, no claims, no claim classes, no contradictions, no
 * collection limitations. The page had a working case selector, which made it
 * *look* grounded. It was not: the model was writing intelligence from a
 * headline.
 *
 * That is the most dangerous shape a defence tool can take, because the output
 * is fluent, plausible, and attributable to nothing.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * A PROJECTION, NOT A SECOND MODEL.
 *
 * Every field here is copied from a record that already exists in the case's
 * stored snapshots. Claims come from the one existing extractor, contradictions
 * from the one existing contradiction derivation, completeness from the one
 * existing assessor. Nothing is stored, nothing is re-detected, and the
 * authoritative record remains the `CollectorEvidence` in the snapshot — this
 * carries `evidenceId` so every statement can be walked back to it.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT IS DELIBERATELY EXCLUDED.
 *
 *   - `rawValue`. Provider payloads can be large and can contain material the
 *     analyst never asked to send to a model. `normalizedValue` is projected to
 *     a short summary instead.
 *   - Anything credential-shaped. A guard strips key/token/secret/password-like
 *     keys from every projected value, and a test asserts it.
 *   - Sample-derived entities. A case context contains case evidence only; see
 *     `SAMPLE_EXCLUDED_NOTE`.
 */

// ─── Projections ────────────────────────────────────────────────────────────

/** One evidence record, projected. Field-for-field a subset — nothing invented. */
export interface ContextEvidence {
  /** The citation handle. Null when the collector supplied none — never minted. */
  evidenceId: string | null;
  collector: string;
  source: string;
  sourceUrl: string | null;
  collectedAt: string;
  claimClass: ClaimClass | null;
  /** null means NOT MEASURED, never zero. */
  confidence: number | null;
  confidenceReasons: string[];
  /** Short human-readable projection of `normalizedValue`. Never the raw provider payload. */
  summary: string;
  /** Which case this belongs to, so a citation cannot be traced to the wrong run. */
  caseId: string;
}

export interface ContextClaim {
  claimId: string;
  claimText: string;
  claimClass: ClaimClass;
  /** "assert" or "deny" — the polarity the extractor measured. */
  polarity: string;
  evidenceRef: string | null;
  source: string;
  sourceUrl: string | null;
  publisher: string | null;
  publishedAt: string | null;
  confidence: number | null;
  syndicated: boolean;
  independentSources: number;
}

export interface ContextEntity {
  id: string;
  type: string;
  value: string;
  /** The collector that asserted it. */
  source: string;
  confidence: number | null;
}

export interface ContextRelationship {
  from: string;
  type: string;
  to: string;
  source: string;
  confidence: number | null;
}

export interface ContextTimelineEvent {
  evidenceId: string | null;
  entity: string | null;
  /** ISO, or null when nothing dated it. Never back-filled. */
  observedAt: string | null;
  /** True when the position comes from retrieval time rather than a real date. */
  positionedByRetrieval: boolean;
  collector: string;
  summary: string;
}

/**
 * Everything an agent may see about one case.
 *
 * `caseId` is on the object AND on every evidence row, so a cross-case leak
 * would have to defeat two checks rather than one.
 */
export interface CaseContext {
  caseId: string;
  caseTitle: string;
  target: string;
  description: string;
  runId: string | null;
  investigationId: string;
  runStatus: RunStatus | null;
  collectedAt: string;

  evidence: ContextEvidence[];
  entities: ContextEntity[];
  relationships: ContextRelationship[];
  claims: ContextClaim[];
  contradictions: ReportContradiction[];
  timeline: ContextTimelineEvent[];
  /**
   * Cross-intelligence correlations.
   *
   * Derived DETERMINISTICALLY before the model is called, from relationships
   * collectors already asserted. The model may explain these; it must not
   * invent new ones, and `buildGroundedPrompt` says so explicitly.
   */
  correlations: CrossIntelligenceCorrelation[];

  completeness: CollectionCompleteness;
  /** Rendered verbatim into the prompt. The model is told these, not left to infer them. */
  limitations: string[];

  /** Counts of what was capped for prompt size, so the model is not told it saw everything. */
  truncated: { evidence: number; entities: number; relationships: number; claims: number; timeline: number };
}

// ─── Caps ───────────────────────────────────────────────────────────────────
//
// A model context is finite. Capping is unavoidable; capping SILENTLY is not —
// `truncated` records what was withheld and the serializer prints it.

export const MAX_CONTEXT_EVIDENCE = 60;
export const MAX_CONTEXT_ENTITIES = 60;
export const MAX_CONTEXT_RELATIONSHIPS = 60;
export const MAX_CONTEXT_CLAIMS = 40;
export const MAX_CONTEXT_TIMELINE = 40;

export const SAMPLE_EXCLUDED_NOTE =
  "A case context is built only from that case's collected evidence. Sample and watchlist-derived entities are never included, and no sample record can reach a grounded answer.";

/**
 * Names that reach `/agents`' entity picker from the SEEDED sample watchlists.
 *
 * `watchlist-store.ts` ships two `[SAMPLE]`-prefixed watchlists whose
 * `filters.people` / `filters.organizations` ("Chen", "Ortega", "Vector-17",
 * "Aster Motors", …) are merged into that picker alongside real case targets,
 * with nothing distinguishing them.
 *
 * **A grounded case context is structurally immune**: it is built from case
 * evidence and never reads a watchlist, so no sample value can reach an answer.
 * This helper exists so the PICKER can label them, and so a test can prove the
 * separation rather than assert it.
 */
export const SAMPLE_WATCHLIST_PREFIX = "[SAMPLE]";

export function sampleDerivedEntities(
  watchlists: readonly { name: string; filters?: { people?: string[]; organizations?: string[] } }[],
): Set<string> {
  const out = new Set<string>();
  for (const w of watchlists) {
    if (!w.name?.startsWith(SAMPLE_WATCHLIST_PREFIX)) continue;
    w.filters?.people?.forEach((v) => out.add(v));
    w.filters?.organizations?.forEach((v) => out.add(v));
  }
  return out;
}

export const NO_CASE_SELECTED =
  "No case is selected. Analysis without a case is NOT grounded in collected evidence and must be labelled as such.";

// ─── Secret hygiene ─────────────────────────────────────────────────────────

/**
 * Keys whose values are never projected into a prompt.
 *
 * Collector `normalizedValue` is `z.unknown()` by contract, so nothing
 * structurally prevents a future collector from putting a token in it. This is a
 * belt-and-braces filter, not a claim that one is there today.
 */
const SECRET_KEY_PATTERN = /(^|_|\.)(api[_-]?key|apikey|token|secret|password|passwd|credential|authorization|auth|bearer|cookie|session|private[_-]?key)($|_|\.)/i;

/** True when a key looks credential-bearing. Exported so a test can enumerate it. */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

/**
 * Compact, human-readable projection of a collector's normalized value.
 *
 * Deliberately NOT `JSON.stringify(rawValue)`: raw provider payloads are large,
 * are not what the analyst asked to send anywhere, and are exactly where a
 * credential would hide if one ever appeared.
 */
export function summariseValue(value: unknown, maxLength = 220): string {
  if (value === null || value === undefined) return "(no value reported)";
  if (typeof value === "string") return value.slice(0, maxLength);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.slice(0, 6).map((v) => summariseValue(v, 60)).join(", ").slice(0, maxLength);
  }
  if (typeof value === "object") {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // A redacted key is REPORTED as redacted rather than dropped, so nobody
      // reads its absence as "the collector returned nothing here".
      if (isSecretKey(k)) {
        parts.push(`${k}=[redacted]`);
        continue;
      }
      if (v === null || v === undefined || v === "") continue;
      parts.push(`${k}=${summariseValue(v, 60)}`);
      if (parts.join(" · ").length > maxLength) break;
    }
    return parts.join(" · ").slice(0, maxLength) || "(no reportable fields)";
  }
  return String(value).slice(0, maxLength);
}

// ─── Build ──────────────────────────────────────────────────────────────────

export interface CaseContextInput {
  caseId: string;
  caseTitle: string;
  target: string;
  description: string;
  runId: string | null;
  investigationId: string;
  runStatus: RunStatus | null;
  collectedAt: string;
  evidence: readonly CollectorEvidence[];
  entities: readonly CollectorEntity[];
  relationships: readonly CollectorRelationship[];
  plan: OsintPlan | null;
  graphTruncation?: SnapshotTruncation;
  timelineTruncation?: SnapshotTruncation;
  /** Injected — nothing in the extraction path may read a clock. */
  extractedAt: string;
  /**
   * From the EXISTING `capabilityReport()`. Optional and additive: without it no
   * discipline can be established, so NO correlation is emitted — the honest
   * outcome, rather than guessing a discipline from a collector's name.
   */
  capabilityRows?: readonly CollectorDisciplines[];
}

function cap<T>(list: readonly T[], max: number): { kept: T[]; dropped: number } {
  return list.length <= max
    ? { kept: [...list], dropped: 0 }
    : { kept: list.slice(0, max), dropped: list.length - max };
}

/**
 * Builds the context.
 *
 * Pure and deterministic: no storage read, no network, no clock. The caller
 * supplies snapshot contents already validated against the case's scope verdict,
 * which is what keeps this out of the storage layer entirely.
 */
export function buildCaseContext(input: CaseContextInput): CaseContext {
  // Resolve to canonical identities BEFORE capping and projecting, so the model
  // sees one entity per real-world thing rather than one per collector. Entities
  // and relationships are resolved together and never separated: the resolver
  // rewrites ids and remaps every edge endpoint, so taking one without the
  // other would leave edges pointing at ids that no longer exist.
  const resolved = resolvedCaseEntities({
    entities: input.entities,
    relationships: input.relationships,
  });

  const evidenceCap = cap(input.evidence, MAX_CONTEXT_EVIDENCE);
  const entityCap = cap(resolved.entities, MAX_CONTEXT_ENTITIES);
  const relCap = cap(resolved.relationships, MAX_CONTEXT_RELATIONSHIPS);

  const evidence: ContextEvidence[] = evidenceCap.kept.map((e) => ({
    evidenceId: e.evidenceId ?? null,
    collector: e.collector,
    source: e.source,
    sourceUrl: e.sourceUrl ?? null,
    collectedAt: e.collectedAt,
    claimClass: e.claimClass ?? null,
    confidence: e.confidence?.value ?? null,
    confidenceReasons: e.confidence?.reasons ?? [],
    summary: summariseValue(e.normalizedValue),
    caseId: input.caseId,
  }));

  const entities: ContextEntity[] = entityCap.kept.map((e) => ({
    id: e.id,
    type: e.type,
    value: e.value,
    source: e.source,
    confidence: e.confidence?.value ?? null,
  }));

  // Resolved entities — the relationships were remapped onto their ids.
  const byId = new Map(resolved.entities.map((e) => [e.id, e.displayName || e.value]));
  const relationships: ContextRelationship[] = relCap.kept.map((r) => ({
    from: byId.get(r.sourceEntity) ?? r.sourceEntity,
    type: r.relationshipType,
    to: byId.get(r.targetEntity) ?? r.targetEntity,
    source: r.source,
    confidence: r.confidence?.value ?? null,
  }));

  // ── Claims — the ONE case-level accessor over this case's own evidence ──
  // This used to run `articlesFromEvidence`/`extractClaims` inline, one of
  // three hand-written copies of the same sequence.
  const projected = caseMediaClaims({
    caseId: input.caseId,
    evidence: input.evidence,
    extractedAt: input.extractedAt,
  });
  const allClaims = projected.claims;
  const claimCap = cap(allClaims, MAX_CONTEXT_CLAIMS);
  const claims: ContextClaim[] = claimCap.kept.map((c) => ({
    claimId: c.claimId,
    claimText: c.claimText,
    claimClass: c.claimClass,
    polarity: c.polarity,
    evidenceRef: c.evidenceRef,
    source: c.source,
    sourceUrl: c.sourceUrl,
    publisher: c.publisher,
    publishedAt: c.publishedAt,
    confidence: c.confidence?.value ?? null,
    syndicated: c.syndicated,
    independentSources: c.independentSources,
  }));

  // ── Contradictions — the EXISTING contradiction derivation, projected by the
  //    existing `toReportContradictions`. No second engine. ──
  const contradictions = toReportContradictions(
    buildCaseContradictions({
      caseId: input.caseId,
      runId: input.runId,
      investigationId: input.investigationId,
      snapshotSavedAt: input.collectedAt,
      evidence: input.evidence,
      // Resolved: the contradiction engine compares claim sets per (entity,
      // predicate), and pre-merge endpoints would split one entity's claims
      // across two ids.
      relationships: resolved.relationships,
      extractedAt: input.extractedAt,
    }),
  );

  // ── Timeline — the existing builder, projected compactly ──
  const built = buildEvidenceTimeline(input.evidence);
  const tlCap = cap(built.events, MAX_CONTEXT_TIMELINE);
  const timeline: ContextTimelineEvent[] = tlCap.kept.map((t) => ({
    evidenceId: t.evidenceId,
    entity: t.entity,
    // `observedAt` is null when nothing dated it; the flag says whether the
    // position came from retrieval time. Two different facts, kept apart.
    observedAt: t.observedAt ?? null,
    // `timestampType === "retrieved"` means the real date is unknown and the
    // position is a retrieval stamp standing in for it. A UI — and a model —
    // must be told, or "2026-08-26" reads as when the thing happened.
    positionedByRetrieval: t.timestampType === "retrieved",
    collector: t.collector,
    summary: summariseValue(t.claim, 120),
  }));

  // ── Correlations — deterministic, before any model call ──
  const correlationReport = buildCrossIntelligence({
    caseId: input.caseId,
    entities: resolved.entities,
    relationships: resolved.relationships,
    evidence: input.evidence,
    capabilityRows: input.capabilityRows ?? [],
  });

  const completeness = assessCompleteness({
    plan: input.plan,
    evidence: input.evidence,
    runStatus: input.runStatus,
    graphTruncation: input.graphTruncation,
    timelineTruncation: input.timelineTruncation,
  });

  const truncated = {
    evidence: evidenceCap.dropped,
    entities: entityCap.dropped,
    relationships: relCap.dropped,
    claims: claimCap.dropped,
    timeline: tlCap.dropped,
  };

  const limitations = [
    completenessHeadline(completeness),
    resolutionSummary(resolved, input.entities.length),
    ...RESOLUTION_CAVEATS,
    ...(correlationReport.correlations.length > 0 ? CORRELATION_CAVEATS : []),
    ...(input.capabilityRows === undefined || input.capabilityRows.length === 0
      ? [
          "The collector capability matrix was unavailable, so no cross-intelligence correlation could be established. Absence of correlations here is not evidence that none exist.",
        ]
      : []),
    ...completeness.reasons.map((r) => `${r.kind} · ${r.subject}: ${r.detail}`),
    ...built.caveats,
    SAMPLE_EXCLUDED_NOTE,
  ];
  for (const [what, n] of Object.entries(truncated)) {
    if (n > 0) {
      limitations.push(
        `${n} ${what} record(s) were withheld from this context to fit the model's input limit. They exist in the case; they are not in front of you.`,
      );
    }
  }

  return {
    caseId: input.caseId,
    caseTitle: input.caseTitle,
    target: input.target,
    description: input.description,
    runId: input.runId,
    investigationId: input.investigationId,
    runStatus: input.runStatus,
    collectedAt: input.collectedAt,
    evidence,
    entities,
    relationships,
    claims,
    contradictions,
    timeline,
    correlations: correlationReport.correlations,
    completeness,
    limitations,
    truncated,
  };
}

// ─── Citation surface ───────────────────────────────────────────────────────

/**
 * Every evidence id an answer is permitted to cite.
 *
 * The allow-list is built from the CONTEXT, not from the case — a record that
 * was capped out is not citable, because the model never saw it and could only
 * be guessing.
 */
export function citableEvidenceIds(context: CaseContext): Set<string> {
  const ids = new Set<string>();
  for (const e of context.evidence) if (e.evidenceId) ids.add(e.evidenceId);
  // Claims and contradictions reference evidence the context already carries,
  // but a claim's evidenceRef is added explicitly so a claim-only citation works.
  for (const c of context.claims) if (c.evidenceRef) ids.add(c.evidenceRef);
  for (const c of context.contradictions) {
    if (c.evidenceRefA) ids.add(c.evidenceRefA);
    if (c.evidenceRefB) ids.add(c.evidenceRefB);
  }
  return ids;
}

/** Resolve a citation back to the record it names. Null when it names nothing. */
export function resolveCitation(context: CaseContext, evidenceId: string): ContextEvidence | null {
  return context.evidence.find((e) => e.evidenceId === evidenceId) ?? null;
}
