import type { CollectorEvidence, CollectorRelationship, CollectorEntity } from "../collectors/result";
import type { OsintPlan } from "../osint/query-planner";
import type { RunStatus } from "./case-runs";
import type { SnapshotTruncation } from "./case-scope";
import type { GenerateInput, SourceRef } from "../reports";
import type { ReportMediaClaim } from "../reports";
import { renumber, sourcesFromCaseEvidence, sourcesFromOsintRelationships } from "../reports";
import type { CaseReportProvenance, CollectionCompleteness, ReportContradiction } from "./case-report";
import { assessCompleteness, toReportContradictions } from "./case-report";
import { buildCaseContradictions } from "./case-contradictions";
import { caseMediaClaims, isConflicted } from "./case-claims";
import { resolvedCaseEntities } from "./case-entities";
import {
  buildCrossIntelligence,
  type CollectorDisciplines,
  type CrossIntelligenceCorrelation,
} from "./cross-intelligence";

/**
 * Assembles a report's inputs from a case that has already been collected
 * (2026-08-30, ported from the teammate's fork).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * IT COLLECTS NOTHING. THAT IS THE ENTIRE POINT.
 *
 * An earlier audit found `/reports` calling `runOsintInvestigation()` — a
 * fresh, independent collection — to produce a report about a case that had
 * already been collected. The product then cited sources that were not in the
 * case at all.
 *
 * This function is pure over data the caller already read out of the stored
 * snapshots. No network, no clock, no job, no storage write. A test asserts it
 * contains no reference to `runOsintInvestigation`.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY IT LIVES HERE RATHER THAN IN `case-report.ts`.
 *
 * `case-report.ts` is pure over collector types and knows nothing about the
 * report module. Source numbering belongs to `reports.ts`. This file is the one
 * seam that imports both, so the dependency runs
 * `case-report-build → reports → case-report` and never loops.
 */

export interface CaseReportBuildInput {
  caseId: string;
  caseTitle: string;
  target: string;
  runId: string | null;
  investigationId: string;
  /** The snapshot's own save time. NOT when the report was generated. */
  collectedAt: string;
  runStatus: RunStatus | null;
  evidence: readonly CollectorEvidence[];
  relationships: readonly CollectorRelationship[];
  entities: readonly CollectorEntity[];
  /** Recomputed from the registry, which is a read-only operation, or null when unavailable. */
  plan: OsintPlan | null;
  graphTruncation?: SnapshotTruncation;
  timelineTruncation?: SnapshotTruncation;
  /** Injected — the claim extractor must never read a clock. */
  extractedAt: string;
  /**
   * From the EXISTING `capabilityReport()`. Optional and additive: without it no
   * cross-discipline correlation can be established, and none is emitted.
   */
  capabilityRows?: readonly CollectorDisciplines[];
}

export interface CaseReportBuild {
  sources: SourceRef[];
  completeness: CollectionCompleteness;
  contradictions: ReportContradiction[];
  correlations: CrossIntelligenceCorrelation[];
  /** MEDIAINT claims from the ONE case-level accessor. */
  mediaClaims: ReportMediaClaim[];
  provenance: CaseReportProvenance;
  /** Convenience: everything `generateProduct` needs except the product type. */
  toGenerateInput(type: GenerateInput["type"], subject?: string): GenerateInput;
}

export function buildCaseReport(input: CaseReportBuildInput): CaseReportBuild {
  // The ad-hoc /reports path already resolved entities (orchestrator.ts); the
  // case path did not, so one collection produced two different entity sets
  // depending on the route. Both now resolve.
  const resolved = resolvedCaseEntities({
    entities: input.entities,
    relationships: input.relationships,
  });

  // ── Sources — the case's OWN evidence, carrying evidenceId and claimClass. ──
  const evidenceSources = sourcesFromCaseEvidence(input.evidence, input.caseId);
  const relationshipSources = sourcesFromOsintRelationships(
    resolved.relationships,
    resolved.entities,
    evidenceSources.length + 1,
  ).map((s) => ({
    ...s,
    // Relationships have no evidence record of their own — they are asserted by
    // a collector. `evidenceId` stays ABSENT rather than borrowed from a nearby
    // record, which would be a citation pointing at the wrong thing.
    collector: s.outlet,
    caseId: input.caseId,
  }));
  const sources = renumber([...evidenceSources, ...relationshipSources]);

  const completeness = assessCompleteness({
    plan: input.plan,
    evidence: input.evidence,
    runStatus: input.runStatus,
    graphTruncation: input.graphTruncation,
    timelineTruncation: input.timelineTruncation,
  });

  // ── Contradictions — the EXISTING derivation, not a second engine. ──
  const contradictionReport = buildCaseContradictions({
    caseId: input.caseId,
    runId: input.runId,
    investigationId: input.investigationId,
    snapshotSavedAt: input.collectedAt,
    evidence: input.evidence,
    // Resolved, matching the entity set the sources were numbered from.
    relationships: resolved.relationships,
    extractedAt: input.extractedAt,
  });
  const contradictions = toReportContradictions(contradictionReport);

  // ── Correlations — deterministic; the model never authors them. Without a
  //    capability matrix no discipline can be established, so none is emitted
  //    rather than guessed. ──
  const correlationReport = buildCrossIntelligence({
    caseId: input.caseId,
    entities: resolved.entities,
    relationships: resolved.relationships,
    evidence: input.evidence,
    capabilityRows: input.capabilityRows ?? [],
  });

  // ── Media claims — the SAME accessor the case workspace and the grounded
  //    agent read, so a claim cannot appear on screen and be missing from the
  //    report of the same snapshot. Nothing is re-extracted. ──
  const claimSet = caseMediaClaims({
    caseId: input.caseId,
    evidence: input.evidence,
    extractedAt: input.extractedAt,
  });
  const mediaClaims: ReportMediaClaim[] = claimSet.claims.map((c) => ({
    claimId: c.claimId,
    claimText: c.claimText,
    // Carried VERBATIM. There is no branch here that could raise a class.
    claimClass: c.claimClass,
    polarity: c.polarity,
    attributedTo: c.attributedTo,
    source: c.source,
    sourceUrl: c.sourceUrl,
    publisher: c.publisher,
    publishedAt: c.publishedAt,
    // Null stays null — an unmeasured confidence is not a zero.
    confidence: c.confidence?.value ?? null,
    evidenceRef: c.evidenceRef,
    syndicated: c.syndicated,
    independentSources: c.independentSources,
    conflicted: isConflicted(claimSet, c.claimId),
  }));

  const provenance: CaseReportProvenance = {
    caseId: input.caseId,
    caseTitle: input.caseTitle,
    target: input.target,
    runId: input.runId,
    investigationId: input.investigationId,
    collectedAt: input.collectedAt,
    runStatus: input.runStatus,
  };

  return {
    sources,
    completeness,
    contradictions,
    correlations: correlationReport.correlations,
    mediaClaims,
    provenance,
    toGenerateInput(type, subject) {
      return {
        type,
        subject: subject ?? `${input.target} (case ${input.caseId})`,
        sources,
        caseProvenance: provenance,
        completeness,
        // Always supplied — an EMPTY ARRAY means "checked, none found", which is
        // a different statement from `undefined` ("not checked"). The report
        // renderer relies on that distinction.
        contradictions,
        mediaClaims,
        correlations: correlationReport.correlations,
      };
    },
  };
}

/**
 * Why a case cannot produce a report right now, or null when it can.
 *
 * Returned as a sentence rather than a boolean because "no report" needs a
 * reason on screen. A case with no stored run must show an honest unavailable
 * state, never a product assembled from whatever else was lying around.
 */
export function caseReportBlocker(input: {
  hasSnapshot: boolean;
  scopeVerdict: "MATCH" | "MISMATCH" | "UNSCOPED" | null;
  evidenceCount: number;
  runStatus: RunStatus | null;
}): string | null {
  if (!input.hasSnapshot) {
    return "No collected data is stored for this case. Run it from Investigations first — a report cannot be generated from a case that has not collected anything, and nothing will be substituted.";
  }
  if (input.scopeVerdict === "MISMATCH") {
    return "The stored snapshot belongs to a different case. It will not be used as a substitute for this case's own data.";
  }
  if (input.scopeVerdict === "UNSCOPED") {
    return "The stored snapshot records no case. It was produced outside a case (for example from Recon) and is not attributed to this one.";
  }
  if (input.evidenceCount === 0) {
    return "This case's run stored no evidence, so there is nothing to report on. This is a collection result, not a system error.";
  }
  if (input.runStatus === "QUEUED" || input.runStatus === "RUNNING") {
    return `This case's run is still ${input.runStatus.toLowerCase()}. Reporting on it now would describe an incomplete collection as if it were finished.`;
  }
  return null;
}
