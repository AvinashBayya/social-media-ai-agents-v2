import type { CollectorEvidence, CollectorRelationship, CollectorEntity } from "../collectors/result";
import type { SnapshotTruncation } from "./case-scope";
import type { OsintPlan } from "../osint/query-planner";
import type { RunStatus } from "./case-runs";
import type { CaseContradictionReport } from "./case-contradictions";
import { NO_ADJUDICATION_CAVEAT } from "./case-contradictions";

/**
 * A report's view of a case (2026-08-30, ported from the teammate's fork).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT WAS WRONG.
 *
 * An earlier audit found `/reports` calling `runOsintInvestigation()` to start
 * a **fresh, independent collection** and building the product from that. A
 * report about `INV-1001` therefore cited sources that were not in `INV-1001`.
 * Two different pictures of one subject, with nothing on either saying so.
 *
 * Worse, the product declared nothing about coverage. A report generated with
 * Sherlock, SpiderFoot and theHarvester all unconfigured looked identical to one
 * generated with all three running. For a defence product that is the highest-
 * consequence failure available: implied exhaustiveness it never had.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THIS MODULE IS A PROJECTION, NOT A COLLECTOR.
 *
 * It starts nothing, fetches nothing and stores nothing. It reads what a case
 * already holds — the stored snapshots, the `CaseRun` status, the deterministic
 * plan for that target — and states what is there and what is missing.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * COMPLETENESS IS REPORTED, NEVER SCORED.
 *
 * There is no percentage here, because there is no honest denominator: "how many
 * sources exist for this target" is not knowable. What IS knowable is named
 * instead — which collectors the planner selected, which of those actually
 * produced evidence, which were refused by the passive-only policy and why, which
 * need credentials nobody supplied, and whether a snapshot was capped. Each is a
 * fact with a reason attached.
 */

/**
 * The four states this module reports.
 *
 * Deliberately NOT a spectrum. `COMPLETE` is the narrow case where every planned
 * collector produced something and nothing was capped; anything less is
 * `PARTIAL`, which is the honest default rather than the exception.
 */
export type CollectionStatus = "COMPLETE" | "PARTIAL" | "FAILED" | "UNAVAILABLE";

/** One named reason the collection was not complete. Never a bare flag. */
export interface CompletenessReason {
  kind:
    | "EXCLUDED_BY_POLICY"
    | "CREDENTIALS_REQUIRED"
    | "NO_EVIDENCE_PRODUCED"
    | "SNAPSHOT_TRUNCATED"
    | "RUN_STATUS";
  /** The collector, or the snapshot, this concerns. */
  subject: string;
  /** Rendered verbatim. A reason nobody can read is not a reason. */
  detail: string;
}

export interface CollectionCompleteness {
  status: CollectionStatus;
  /** Empty ONLY when status is COMPLETE. */
  reasons: CompletenessReason[];
  /** Collector ids the planner selected for this target. */
  planned: string[];
  /** Collector ids that actually appear in the stored evidence — INCLUDING any the plan did not name. */
  produced: string[];
  /**
   * Of `planned`, the ones that produced. This is the numerator for coverage.
   *
   * `produced` alone is NOT, because a run's evidence can contain collectors the
   * recomputed plan does not name — which produces the nonsensical headline
   * "8 of 3 planned collectors produced evidence" if used directly.
   */
  producedPlanned: string[];
  /**
   * Produced evidence but were NOT in the plan.
   *
   * Not a coverage gain: it means the plan recomputed now does not describe the
   * run that actually happened (a different target-type detection, or a registry
   * change since). Coverage cannot be characterised confidently against a plan
   * that does not match, so this is reported as a limitation.
   */
  unplannedProducers: string[];
  /** Planned but produced nothing. Not the same as "found nothing" — see the caveats. */
  silent: string[];
  /** Refused by the passive-only policy, with the policy's own reason text. */
  excluded: { collectorId: string; reason: string }[];
  /** Planned but flagged `requiresCredentials` — unavailable unless configured. */
  credentialGated: string[];
  /** The run's own status, carried verbatim. */
  runStatus: RunStatus | null;
  truncation: { snapshot: string; truncation: SnapshotTruncation }[];
}

/** Where a report's material came from. Ids only — the case stores the data. */
export interface CaseReportProvenance {
  caseId: string;
  caseTitle: string;
  target: string;
  runId: string | null;
  investigationId: string;
  /** When the snapshot this report reads was written. NOT when the report was generated. */
  collectedAt: string;
  runStatus: RunStatus | null;
}

/**
 * Caveats that must be rendered wherever a case-sourced product is shown.
 *
 * The third is the one that matters most: a collector producing no evidence and a
 * collector never running are different facts, and only the first is visible here.
 */
export const COMPLETENESS_CAVEATS: string[] = [
  "This product was built from a stored case run. It reports only what that run collected — no new collection was performed to generate it.",
  "Collection completeness is reported as named facts, never as a percentage. There is no honest denominator for 'how many sources exist'.",
  "A collector listed as producing no evidence may have run and found nothing, or may have failed. The stored snapshot does not distinguish these, so neither does this report.",
  "Collectors refused by the passive-only policy are named with the policy's reason. They were never attempted.",
  "A capped snapshot means the run produced more records than were stored. The report covers the stored subset only.",
];

/** Never say a run established coverage it did not. */
export const NO_EXHAUSTIVE_CLAIM =
  "This is not an exhaustive survey of available sources. It covers only the collectors named below that produced evidence in this run.";

export interface CompletenessInput {
  /** The deterministic plan for this target. Planning starts nothing — it is a pure registry read. */
  plan: OsintPlan | null;
  evidence: readonly CollectorEvidence[];
  runStatus: RunStatus | null;
  graphTruncation?: SnapshotTruncation;
  timelineTruncation?: SnapshotTruncation;
}

/**
 * Derives what the run did and did not cover.
 *
 * Every input already exists. Nothing here is computed from a clock, a guess or
 * a heuristic — `planned` comes from the planner, `produced` from the evidence's
 * own `collector` field, `excluded` from the passive-policy's own reason strings.
 */
export function assessCompleteness(input: CompletenessInput): CollectionCompleteness {
  const planned = input.plan ? input.plan.collectors.map((c) => c.collectorId).sort() : [];
  const produced = [...new Set(input.evidence.map((e) => e.collector).filter(Boolean))].sort();
  const silent = planned.filter((id) => !produced.includes(id));
  const producedPlanned = planned.filter((id) => produced.includes(id));
  const unplannedProducers = produced.filter((id) => !planned.includes(id));
  const excluded = input.plan ? [...input.plan.excluded] : [];
  const credentialGated = input.plan
    ? input.plan.collectors.filter((c) => c.requiresCredentials).map((c) => c.collectorId).sort()
    : [];

  const truncation: CollectionCompleteness["truncation"] = [];
  if (input.graphTruncation?.truncated) {
    truncation.push({ snapshot: "graph", truncation: input.graphTruncation });
  }
  if (input.timelineTruncation?.truncated) {
    truncation.push({ snapshot: "timeline", truncation: input.timelineTruncation });
  }

  const reasons: CompletenessReason[] = [
    ...excluded.map((e) => ({
      kind: "EXCLUDED_BY_POLICY" as const,
      subject: e.collectorId,
      detail: e.reason,
    })),
    ...credentialGated.map((id) => ({
      kind: "CREDENTIALS_REQUIRED" as const,
      subject: id,
      detail: `${id} requires credentials. If none are configured it contributed nothing to this run.`,
    })),
    ...silent.map((id) => ({
      kind: "NO_EVIDENCE_PRODUCED" as const,
      subject: id,
      detail: `${id} was planned but no evidence from it is stored in this run. It may have found nothing, or it may have failed — the snapshot does not distinguish these.`,
    })),
    ...(planned.length > 0
      ? unplannedProducers.map((id) => ({
          kind: "RUN_STATUS" as const,
          subject: id,
          detail: `${id} produced evidence in this run but is not in the collection plan recomputed for this target. The plan does not describe this run exactly, so coverage against it is approximate.`,
        }))
      : []),
    ...truncation.map((t) => ({
      kind: "SNAPSHOT_TRUNCATED" as const,
      subject: `${t.snapshot} snapshot`,
      detail: `Capped for storage: ${t.truncation.storedRecords} of ${t.truncation.totalRecords} records stored. This report covers the stored subset only.`,
    })),
  ];

  // An UNKNOWN plan must never read as full coverage. With no plan there is
  // nothing to compare `produced` against, so "every planned collector produced
  // something" is vacuously true — and would render as COMPLETE COLLECTION on a
  // run whose coverage nobody established. That is precisely the false
  // exhaustiveness this module exists to remove.
  if (!input.plan) {
    reasons.push({
      kind: "RUN_STATUS",
      subject: "collection plan",
      detail:
        "The collection plan for this target could not be determined, so which collectors were expected to run is unknown. Coverage cannot be established and is not claimed.",
    });
  }

  // Status. Read off the run first — a failed run is failed regardless of what
  // partial evidence happens to sit in the snapshot.
  let status: CollectionStatus;
  if (input.runStatus === "FAILED" || input.runStatus === "CANCELLED") {
    status = "FAILED";
    reasons.unshift({
      kind: "RUN_STATUS",
      subject: "run",
      detail: `The run's recorded status is ${input.runStatus}. Any evidence below is what survived, not a completed collection.`,
    });
  } else if (input.evidence.length === 0) {
    status = "UNAVAILABLE";
  } else if (input.runStatus === "PARTIAL") {
    status = "PARTIAL";
    reasons.unshift({
      kind: "RUN_STATUS",
      subject: "run",
      detail: "The run's recorded status is partial: at least one collector did not complete.",
    });
  } else if (reasons.length > 0 || input.runStatus !== "COMPLETED") {
    // Anything unresolved makes it PARTIAL. COMPLETE is the narrow case.
    status = "PARTIAL";
  } else {
    status = "COMPLETE";
  }

  return {
    status,
    reasons,
    planned,
    produced,
    producedPlanned,
    unplannedProducers,
    silent,
    excluded,
    credentialGated,
    runStatus: input.runStatus,
    truncation,
  };
}

/**
 * One line stating coverage, for a report header.
 *
 * `COMPLETE` still refuses the word "exhaustive" — every planned collector
 * producing something says nothing about sources the planner never considered.
 */
export function completenessHeadline(c: CollectionCompleteness): string {
  switch (c.status) {
    case "COMPLETE":
      return `COMPLETE COLLECTION — all ${c.planned.length} planned collectors produced evidence and no snapshot was capped. ${NO_EXHAUSTIVE_CLAIM}`;
    case "PARTIAL":
      // `producedPlanned`, not `produced`: the run's evidence can contain
      // collectors the recomputed plan does not name, and using the raw count
      // produced ratios like "8 of 3".
      return `PARTIAL COLLECTION — ${c.producedPlanned.length} of ${c.planned.length} planned collectors produced evidence${c.unplannedProducers.length > 0 ? `, plus ${c.unplannedProducers.length} not in the plan` : ""}. ${c.reasons.length} limitation${c.reasons.length === 1 ? "" : "s"} recorded below. ${NO_EXHAUSTIVE_CLAIM}`;
    case "FAILED":
      return `FAILED COLLECTION — the run did not complete. This product reports only what survived. ${NO_EXHAUSTIVE_CLAIM}`;
    case "UNAVAILABLE":
      return "COLLECTION UNAVAILABLE — no evidence is stored for this run, so no product can be built from it.";
  }
}

// ─── Contradictions, projected for a report ─────────────────────────────────

/**
 * A contradiction in report form. Every field is copied from the existing
 * contradiction records — no re-detection, no second engine, no adjudication.
 */
export interface ReportContradiction {
  kind: "MEDIA" | "INFRASTRUCTURE";
  subject: string;
  claimA: string;
  claimB: string;
  sourceA: string;
  sourceB: string;
  sourceUrlA: string | null;
  sourceUrlB: string | null;
  evidenceRefA: string | null;
  evidenceRefB: string | null;
  claimClassA: string | null;
  claimClassB: string | null;
  confidenceA: number | null;
  confidenceB: number | null;
  publishedAtA: string | null;
  publishedAtB: string | null;
  /** Always `warrants-review` — read off the record, never assumed. */
  status: string;
  explanation: string;
  explanationBasis: string;
  isHypothesis: true;
}

/** The wording a report uses when it found none. Never "no contradictions exist". */
export const NO_CONTRADICTIONS_MESSAGE =
  "No contradictions detected in the available case data.";

/**
 * Projects the existing contradiction report into report rows.
 *
 * Reuses `buildCaseContradictions`'s output verbatim — this function only
 * flattens it for rendering. Infrastructure contradictions genuinely have no
 * evidence id (the contradiction engine's own `Contradiction` carries a
 * collector name), so those fields are `null` rather than filled with something
 * that looks like a reference.
 */
export function toReportContradictions(
  report: CaseContradictionReport,
): ReportContradiction[] {
  const media: ReportContradiction[] = report.media.map((m) => {
    const a = m.conflict.assertion;
    const b = m.conflict.denial;
    return {
      kind: "MEDIA",
      subject: m.conflict.subject,
      claimA: a.claimText,
      claimB: b.claimText,
      sourceA: a.publisher ?? a.source,
      sourceB: b.publisher ?? b.source,
      sourceUrlA: a.sourceUrl,
      sourceUrlB: b.sourceUrl,
      evidenceRefA: a.evidenceRef,
      evidenceRefB: b.evidenceRef,
      claimClassA: a.claimClass,
      claimClassB: b.claimClass,
      confidenceA: a.confidence.value,
      confidenceB: b.confidence.value,
      publishedAtA: a.publishedAt,
      publishedAtB: b.publishedAt,
      status: m.conflict.status,
      explanation: m.conflict.possibleExplanation.text,
      explanationBasis: m.conflict.possibleExplanation.basis,
      isHypothesis: true,
    };
  });

  const infra: ReportContradiction[] = report.infrastructure.map((i) => {
    const c = i.contradiction;
    return {
      kind: "INFRASTRUCTURE",
      subject: `${c.entity} — ${c.relationshipType}`,
      claimA: c.claimA.values.join(", "),
      claimB: c.claimB.values.join(", "),
      sourceA: c.claimA.source,
      sourceB: c.claimB.source,
      sourceUrlA: null,
      sourceUrlB: null,
      // The contradiction engine's Contradiction carries a collector NAME, not an
      // evidence id. Null is the honest value; inventing one would be a
      // reference to nothing.
      evidenceRefA: null,
      evidenceRefB: null,
      // Collector relationships are read directly from the named source.
      claimClassA: "OBSERVED",
      claimClassB: "OBSERVED",
      confidenceA: null,
      confidenceB: null,
      publishedAtA: c.claimA.observedAt,
      publishedAtB: c.claimB.observedAt,
      status: c.status,
      explanation: c.possibleExplanation.text,
      explanationBasis: c.possibleExplanation.basis,
      isHypothesis: true,
    };
  });

  return [...media, ...infra];
}

/** Carried into the product so a renderer cannot omit it. */
export const CONTRADICTION_CAVEAT = NO_ADJUDICATION_CAVEAT;

// ─── Entity/relationship helpers, for provenance display ───────────────────

/** Collectors that actually contributed, with how many records each produced. */
export function contributionByCollector(
  evidence: readonly CollectorEvidence[],
): { collector: string; records: number }[] {
  const counts = new Map<string, number>();
  for (const e of evidence) {
    if (!e.collector) continue;
    counts.set(e.collector, (counts.get(e.collector) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([collector, records]) => ({ collector, records }))
    .sort((a, b) => b.records - a.records || a.collector.localeCompare(b.collector));
}

/** Relationship count by asserting collector — the graph half of the same question. */
export function relationshipsByCollector(
  relationships: readonly CollectorRelationship[],
): { collector: string; relationships: number }[] {
  const counts = new Map<string, number>();
  for (const r of relationships) {
    if (!r.source) continue;
    counts.set(r.source, (counts.get(r.source) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([collector, relationships]) => ({ collector, relationships }))
    .sort((a, b) => b.relationships - a.relationships || a.collector.localeCompare(b.collector));
}

/** Entity count by source collector, for the provenance block. */
export function entitiesByCollector(
  entities: readonly CollectorEntity[],
): { collector: string; entities: number }[] {
  const counts = new Map<string, number>();
  for (const e of entities) {
    if (!e.source) continue;
    counts.set(e.source, (counts.get(e.source) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([collector, entities]) => ({ collector, entities }))
    .sort((a, b) => b.entities - a.entities || a.collector.localeCompare(b.collector));
}
