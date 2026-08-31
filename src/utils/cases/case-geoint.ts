/**
 * GEOINT → case association (2026-08-30, ported from the teammate's fork).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NO SECOND EVIDENCE MODEL, NO SECOND STORE.
 *
 * `geoint/evidence.ts` already projects image analysis into the EXISTING
 * `CollectorEvidence` / `CollectorEntity` / `CollectorRelationship` contract,
 * stamped `collector: "geoint"`. This module is the write path: it MERGES that
 * projection into the case's EXISTING graph and timeline snapshots.
 *
 * Everything downstream then works with no further wiring, because every
 * analytical surface already reads those two snapshots: the discipline
 * breakdown, cross-intelligence, contradictions, the grounded agent context and
 * the case report.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE MERGE IS NOT `saveGraphSnapshot`.
 *
 * Two traps:
 *
 *   1. `getGraphForCase` FALLS BACK to the unscoped slot when a case has no
 *      snapshot. Right for display — the verdict says plainly it is not this
 *      case's data — and catastrophic as a merge base: the first attach to a
 *      case would read `/recon`'s unrelated snapshot, and writing the merge back
 *      would stamp another target's records with this `caseId`, after which they
 *      read as verdict MATCH. So the base comes from `readGraphSnapshotForCase`,
 *      which reads ONLY the case's own slot and returns null — an EMPTY BASE,
 *      never a refusal — when there is none.
 *
 *   2. `saveGraphSnapshot` unconditionally writes the unscoped slot too, so an
 *      attach would silently replace whatever `/recon` last handed to `/graph`.
 *      So the write goes through `saveGraphSnapshotForCase`, which touches only
 *      the case key and refuses a falsy `caseId` outright.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CAP IS CHECKED HERE, NOT LEFT TO THE STORE.
 *
 * Both stores cap inside a private `write()` and return `void`, so a caller is
 * never told anything was cut. Appending GEOINT to a case already at
 * `MAX_SNAPSHOT_EVIDENCE` would therefore silently DELETE that many of the
 * case's own collected records from every analytical surface, with no eviction
 * ledger entry. Trading collected evidence for an image annotation is not a
 * trade this module may make silently, so it REFUSES with a stated reason
 * instead, and the analyst decides.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS MODULE DOES NOT DO.
 *
 *   - It does not re-derive anything. `geointGraph` is the single producer.
 *   - It does not create a `CaseRun`. `createCaseRun` hardcodes `status:
 *     "QUEUED"` and the only route off it needs a real `osintInvestigationId`,
 *     which an attach has not got. A permanently-QUEUED row would assert a
 *     pending collection that will never happen; `runId: null` is the honest
 *     value for an attach that came from no run.
 *   - It does not register `geoint` as a collector. The orchestrator can never
 *     invoke it — `detectTargetType` never returns `"image"` — so a registry
 *     entry would put a source the planner refuses to run into the passive
 *     policy gate, the `/crawlers` live probe and the `bun:sqlite` re-chunking
 *     blast radius, for nothing. The GEOINT layer declares its own discipline
 *     instead, exactly the way a collector does, and the case surfaces append
 *     that declaration. A producer declaration is not a name-match guess.
 *   - It never infers the case. The caller passes a `caseId` the analyst chose.
 */

import type {
  CollectorEntity,
  CollectorEvidence,
  CollectorRelationship,
} from "../collectors/result";
import type { GeoIntGraph } from "../geoint/evidence";
import type { CollectorDisciplines } from "./case-intelligence-breakdown";
import {
  MAX_SNAPSHOT_ENTITIES,
  MAX_SNAPSHOT_EVIDENCE,
  MAX_SNAPSHOT_RELATIONSHIPS,
} from "./case-scope";
import type { GraphSnapshot } from "../graph-store";
import { readGraphSnapshotForCase, saveGraphSnapshotForCase } from "../graph-store";
import type { TimelineSnapshot } from "../timeline-store";
import { readTimelineSnapshotForCase, saveTimelineSnapshotForCase } from "../timeline-store";

/** The `collector` value every `geointGraph` record carries. */
export const GEOINT_COLLECTOR_ID = "geoint";

/**
 * The GEOINT layer's own discipline declaration.
 *
 * Shaped as a `CollectorDisciplines` row so it can be appended to the rows
 * `capabilityReport()` returns, and consumed by the discipline breakdown and the
 * correlation engine with no change to either.
 *
 * This is a DECLARATION BY THE PRODUCER, which is the same basis every collector
 * uses. It is emphatically not the breakdown guessing a discipline from a
 * collector's name — the module refuses to do that, correctly, and this does not
 * weaken it.
 */
export const GEOINT_DISCIPLINE_ROW: CollectorDisciplines = {
  sourceId: GEOINT_COLLECTOR_ID,
  disciplines: ["GEOINT"],
};

export const NOT_CASE_SCOPED =
  "NOT CASE-SCOPED — this analysis is held in the browser only. It belongs to no case, is not stored, and is lost when this panel is closed. Select a case and attach it to keep it.";

export const ATTACH_CAVEATS: string[] = [
  "Attaching records an analysis a person judged relevant. It is not a collection run, and the case's collection completeness does not change.",
  "GEOINT records are attached to ONE case. They are never visible from another case, and they never reach the unscoped hand-off slot that /recon and /graph share.",
  "A location hypothesis stays a hypothesis after attachment. Nothing in the attach path can raise it, whatever confidence a provider reported.",
  "Local perceptual matching compares against images hashed in THIS BROWSER only. It is not a search of the open web, and an empty result is not evidence the image is unpublished.",
  "The image itself is never stored. Only the derived records are attached — no thumbnail, no data URI, no file bytes.",
];

/** Why an attach was refused. Never a silent no-op. */
export type AttachRefusal =
  | "NO_CASE_SELECTED"
  | "NOTHING_TO_ATTACH"
  | "WOULD_EVICT_COLLECTED_RECORDS";

export interface AttachOutcome {
  attached: boolean;
  refusal: AttachRefusal | null;
  /** Always populated — a refusal the analyst cannot act on is not actionable. */
  detail: string;
  /** Evidence ids now attached to the case, so the UI can show a real reference. */
  evidenceIds: string[];
  counts: { evidence: number; entities: number; relationships: number };
}

export interface MergeInput {
  caseId: string;
  /** The case's OWN graph snapshot, or null. Null is an empty base. */
  graph: GraphSnapshot | null;
  /** The case's OWN timeline snapshot, or null. Null is an empty base. */
  timeline: TimelineSnapshot | null;
  geoint: GeoIntGraph;
  /** The image identifier, used as the snapshot target when there is no base. */
  imageRef: string;
  /** Injected — nothing here reads a clock. */
  now: string;
}

export interface MergeResult {
  outcome: AttachOutcome;
  /** Null when the merge was refused. */
  graph: GraphSnapshot | null;
  /** Null when the merge was refused. */
  timeline: TimelineSnapshot | null;
}

/** True when this record came from the GEOINT layer. */
export function isGeointEvidence(e: CollectorEvidence): boolean {
  return e.collector === GEOINT_COLLECTOR_ID;
}

/**
 * The GEOINT records a case currently holds.
 *
 * Used to answer "is GEOINT scoped to this case?" from the case's OWN data,
 * which is the only honest basis. Deriving it from anything else would tell a
 * case with nothing attached that GEOINT is scoped to it.
 */
export function geointEvidenceIn(
  evidence: readonly CollectorEvidence[],
): CollectorEvidence[] {
  return evidence.filter(isGeointEvidence);
}

/** How many of a case's GEOINT records are location hypotheses. */
export function geointHypothesisCount(evidence: readonly CollectorEvidence[]): number {
  return geointEvidenceIn(evidence).filter((e) => e.claimClass === "HYPOTHESIS").length;
}

/**
 * Merges by id, keeping the EXISTING record on collision.
 *
 * Existing-wins because the case's own collected data is the thing an attach
 * must not overwrite. Re-attaching the same image is therefore idempotent: the
 * ids are content-derived, so nothing duplicates and nothing is replaced.
 */
function mergeById<T>(
  existing: readonly T[],
  incoming: readonly T[],
  key: (t: T, i: number) => string,
): T[] {
  const seen = new Set(existing.map((r, i) => key(r, i)));
  const added = incoming.filter((r, i) => !seen.has(key(r, existing.length + i)));
  return [...existing, ...added];
}

function relKey(r: CollectorRelationship): string {
  return `${r.sourceEntity}|${r.relationshipType}|${r.targetEntity}|${r.source}`;
}

function evKey(e: CollectorEvidence, i: number): string {
  return e.evidenceId ?? `${e.collector}#${e.source}#${i}`;
}

/**
 * Pure merge. No storage, no clock, no network — `now` and both bases are
 * supplied, so the whole decision is testable without a DOM.
 */
export function mergeGeointIntoCase(input: MergeInput): MergeResult {
  const refuse = (refusal: AttachRefusal, detail: string): MergeResult => ({
    outcome: {
      attached: false,
      refusal,
      detail,
      evidenceIds: [],
      counts: { evidence: 0, entities: 0, relationships: 0 },
    },
    graph: null,
    timeline: null,
  });

  if (!input.caseId) {
    return refuse(
      "NO_CASE_SELECTED",
      "No case is selected. GEOINT results are held in this browser only until a case is chosen — the case is never inferred from what happens to be on screen.",
    );
  }

  const { evidence: newEvidence, entities: newEntities, relationships: newRels } = input.geoint;
  if (newEvidence.length === 0 && newEntities.length === 0) {
    return refuse(
      "NOTHING_TO_ATTACH",
      "This image produced no GEOINT records. Nothing is attached — an empty attachment would assert that the image was examined and found clean, which is a different claim.",
    );
  }

  const baseEvidence: CollectorEvidence[] = input.timeline?.evidence ?? [];
  const baseEntities: CollectorEntity[] = input.graph?.entities ?? [];
  const baseRels: CollectorRelationship[] = input.graph?.relationships ?? [];

  const mergedEvidence = mergeById(baseEvidence, newEvidence, (e, i) => evKey(e, i));
  const mergedEntities = mergeById(baseEntities, newEntities, (e) => e.id);
  const mergedRels = mergeById(baseRels, newRels, relKey);

  // The store caps SILENTLY inside a private write(), and `capRecords` keeps the
  // FIRST n — so an over-cap merge would drop the case's own collected records
  // off the end and tell nobody. Refuse instead.
  const over: string[] = [];
  if (mergedEvidence.length > MAX_SNAPSHOT_EVIDENCE) {
    over.push(`evidence ${mergedEvidence.length}/${MAX_SNAPSHOT_EVIDENCE}`);
  }
  if (mergedEntities.length > MAX_SNAPSHOT_ENTITIES) {
    over.push(`entities ${mergedEntities.length}/${MAX_SNAPSHOT_ENTITIES}`);
  }
  if (mergedRels.length > MAX_SNAPSHOT_RELATIONSHIPS) {
    over.push(`relationships ${mergedRels.length}/${MAX_SNAPSHOT_RELATIONSHIPS}`);
  }
  if (over.length > 0) {
    return refuse(
      "WOULD_EVICT_COLLECTED_RECORDS",
      `Attaching would push this case past the snapshot storage cap (${over.join(", ")}), and the store discards the overflow silently — the records dropped would be this case's own collected evidence. Nothing was written. Clear this case's snapshot or narrow the collection first.`,
    );
  }

  const addedEvidence = mergedEvidence.length - baseEvidence.length;
  const addedEntities = mergedEntities.length - baseEntities.length;
  const addedRels = mergedRels.length - baseRels.length;

  const graph: GraphSnapshot = {
    // `""` is this codebase's established absence marker for this exact field —
    // an attach has no OSINT job, and no id is minted. Widening the type to
    // `string | null` would not be additive: existing readers render it bare.
    investigationId: input.graph?.investigationId ?? "",
    target: input.graph?.target ?? input.imageRef,
    savedAt: input.now,
    entities: mergedEntities,
    relationships: mergedRels,
    caseId: input.caseId,
    // Honest: this did not come from a run. Declared `string | null` already.
    runId: input.graph?.runId ?? null,
    // Carried forward unchanged. Recomputing it from the merged list would
    // report "8 withheld" for a case where the run itself had 900 withheld.
    ...(input.graph?.truncation ? { truncation: input.graph.truncation } : {}),
  };

  const timeline: TimelineSnapshot = {
    investigationId: input.timeline?.investigationId ?? "",
    target: input.timeline?.target ?? input.imageRef,
    savedAt: input.now,
    evidence: mergedEvidence,
    caseId: input.caseId,
    runId: input.timeline?.runId ?? null,
    ...(input.timeline?.truncation ? { truncation: input.timeline.truncation } : {}),
  };

  return {
    outcome: {
      attached: true,
      refusal: null,
      detail:
        addedEvidence === 0 && addedEntities === 0 && addedRels === 0
          ? "Already attached to this case. Nothing changed — GEOINT ids are derived from the image and its findings, so re-attaching the same analysis does not duplicate it."
          : `Attached ${addedEvidence} evidence record(s), ${addedEntities} entity/entities and ${addedRels} relationship(s) to this case.`,
      evidenceIds: newEvidence.map((e) => e.evidenceId).filter((id): id is string => !!id),
      counts: { evidence: addedEvidence, entities: addedEntities, relationships: addedRels },
    },
    graph,
    timeline,
  };
}

/**
 * Reads the case's own snapshots, merges, and writes them back.
 *
 * The only impure function here. `now` stays injected so a test can drive it
 * against a storage stub without a clock.
 */
export function attachGeointToCase(
  caseId: string,
  imageRef: string,
  geoint: GeoIntGraph,
  now: string,
): AttachOutcome {
  const result = mergeGeointIntoCase({
    caseId,
    imageRef,
    geoint,
    now,
    // Scoped-only readers. NEVER `getGraphForCase` — see the header.
    graph: caseId ? readGraphSnapshotForCase(caseId) : null,
    timeline: caseId ? readTimelineSnapshotForCase(caseId) : null,
  });

  if (!result.outcome.attached) return result.outcome;

  // Scoped-only writers. The unscoped slot is never touched.
  if (result.graph) saveGraphSnapshotForCase(result.graph);
  if (result.timeline) saveTimelineSnapshotForCase(result.timeline);

  return result.outcome;
}
