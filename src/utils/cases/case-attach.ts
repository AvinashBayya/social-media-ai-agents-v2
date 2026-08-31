/**
 * Standalone finding → case attachment (2026-08-30, ported from the teammate's
 * fork).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NO SECOND CASE STORE, NO SECOND EVIDENCE MODEL.
 *
 * `/recon` already holds `CollectorEntity` / `CollectorRelationship` /
 * `CollectorEvidence` — the common contract every analytical surface reads. Until
 * now those records could only reach `/graph` and `/timeline` through the
 * UNSCOPED hand-off slot, which belongs to no case. This module is the missing
 * write path that puts them into a CASE's snapshots instead, and NOTHING else —
 * no collection, no re-derivation, no new store.
 *
 * It is a discipline-agnostic generalisation of the `attachGeointToCase`
 * precedent (`case-geoint.ts`), and it inherits that module's safety rules
 * verbatim because they are the rules that make an attach a scoped write rather
 * than a cross-scope leak:
 *
 *   1. The merge base is the case's OWN slot (`readGraphSnapshotForCase` /
 *      `readTimelineSnapshotForCase`), NEVER `getGraphForCase`. The latter falls
 *      back to the unscoped `/recon` slot when a case has no snapshot, and
 *      writing that merge back would stamp another target's records with this
 *      caseId — after which they read as verdict MATCH. `null` from the scoped
 *      reader is an EMPTY BASE, never a reason to refuse.
 *   2. The write is case-only (`saveGraphSnapshotForCase` /
 *      `saveTimelineSnapshotForCase`). The unscoped hand-off slot is never
 *      touched, so an attach cannot overwrite what `/recon` last handed to
 *      `/graph`.
 *   3. Existing records win on id collision, so an attach never overwrites the
 *      case's own collected evidence, and re-attaching is idempotent for records
 *      that carry a stable id.
 *   4. The stores cap SILENTLY inside a private `write()` and keep the FIRST n,
 *      so an over-cap merge would drop the case's own records off the end and
 *      tell nobody. This refuses with a stated reason instead.
 *   5. The case is passed in by the analyst. It is NEVER inferred from the target
 *      that was searched — the currently-searched target is not provenance.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT DOES NOT DO.
 *
 *   - It does not re-score or re-classify. Every record keeps its original
 *     source, sourceUrl, collector, collectedAt, confidence and claimClass.
 *   - It does not create a `CaseRun`. An attach came from no run, so `runId` is
 *     null — the honest value, never a permanently-QUEUED row asserting a
 *     collection that will not happen.
 *   - It never touches `Investigation.evidence[]` (the analyst-pinned curation
 *     model). That is a separate, existing mechanism reached by `PinButton`.
 */

import type {
  CollectorEntity,
  CollectorEvidence,
  CollectorRelationship,
} from "../collectors/result";
import {
  MAX_SNAPSHOT_ENTITIES,
  MAX_SNAPSHOT_EVIDENCE,
  MAX_SNAPSHOT_RELATIONSHIPS,
} from "./case-scope";
import type { GraphSnapshot } from "../graph-store";
import { readGraphSnapshotForCase, saveGraphSnapshotForCase } from "../graph-store";
import type { TimelineSnapshot } from "../timeline-store";
import { readTimelineSnapshotForCase, saveTimelineSnapshotForCase } from "../timeline-store";

/** The three things an attach can carry — exactly a collector's output shape. */
export interface AttachableResult {
  entities: CollectorEntity[];
  relationships: CollectorRelationship[];
  evidence: CollectorEvidence[];
}

/** Why an attach was refused. Never a silent no-op. */
export type CaseAttachRefusal =
  | "NO_CASE_SELECTED"
  | "NOTHING_TO_ATTACH"
  | "WOULD_EVICT_COLLECTED_RECORDS";

export interface CaseAttachOutcome {
  attached: boolean;
  refusal: CaseAttachRefusal | null;
  /** Always populated — a refusal the analyst cannot act on is not actionable. */
  detail: string;
  /** Evidence ids now attached, so the UI can link to a real reference. Only records that carry one appear. */
  evidenceIds: string[];
  counts: { evidence: number; entities: number; relationships: number };
}

export const NOT_CASE_SCOPED_ATTACH =
  "NOT ATTACHED — these findings are held in this browser only until you choose a case. They belong to no case, are not stored, and are lost when you leave this page. The case is never inferred from the target you searched.";

export const ATTACH_RESULT_CAVEATS: string[] = [
  "Attaching records findings a person judged relevant to a case. It is not a collection run, and the case's collection completeness does not change.",
  "Records are attached to ONE case, chosen explicitly. They are never visible from another case, and never reach the unscoped hand-off slot that /recon and /graph share.",
  "Every record keeps its original source, URL, collector, collection time, confidence and claim class. Nothing is re-scored or re-classified on the way in.",
  "Re-attaching is idempotent for records that carry a stable id. Records without one — most social and web evidence — may add duplicates if the underlying data changed between attaches.",
];

export interface MergeResultInput {
  caseId: string;
  /** The case's OWN graph snapshot, or null. Null is an empty base, never a refusal. */
  graph: GraphSnapshot | null;
  /** The case's OWN timeline snapshot, or null. Null is an empty base, never a refusal. */
  timeline: TimelineSnapshot | null;
  result: AttachableResult;
  /** Label used as the snapshot target only when there is no base (e.g. the recon target, a bluesky handle). */
  source: string;
  /** Injected — nothing here reads a clock. */
  now: string;
}

export interface MergeResultOutput {
  outcome: CaseAttachOutcome;
  /** Null when the merge was refused. */
  graph: GraphSnapshot | null;
  /** Null when the merge was refused. */
  timeline: TimelineSnapshot | null;
}

/**
 * Merges by id, keeping the EXISTING record on collision.
 *
 * Existing-wins because the case's own collected data is the thing an attach
 * must never overwrite.
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

/**
 * `evidenceId` when the collector supplied one; otherwise a positional key.
 *
 * The positional fallback is why re-attaching a set whose order or size changed
 * can duplicate — stated in `ATTACH_RESULT_CAVEATS`. It is NOT invented onto the
 * record: the contract keeps `evidenceId` absent when unknown, and this key is a
 * dedup handle, never written back as a claim about the record.
 */
function evKey(e: CollectorEvidence, i: number): string {
  return e.evidenceId ?? `${e.collector}#${e.source}#${i}`;
}

/**
 * Pure merge. No storage, no clock, no network — `now` and both bases are
 * supplied, so the whole decision is testable without a DOM.
 */
export function mergeResultIntoCase(input: MergeResultInput): MergeResultOutput {
  const refuse = (refusal: CaseAttachRefusal, detail: string): MergeResultOutput => ({
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
    return refuse("NO_CASE_SELECTED", NOT_CASE_SCOPED_ATTACH);
  }

  const { entities: newEntities, relationships: newRels, evidence: newEvidence } = input.result;
  if (newEvidence.length === 0 && newEntities.length === 0) {
    return refuse(
      "NOTHING_TO_ATTACH",
      "There is nothing to attach — this result produced no evidence or entities. An empty attachment would assert the case was examined and found clean, which is a different claim.",
    );
  }

  const baseEvidence: CollectorEvidence[] = input.timeline?.evidence ?? [];
  const baseEntities: CollectorEntity[] = input.graph?.entities ?? [];
  const baseRels: CollectorRelationship[] = input.graph?.relationships ?? [];

  const mergedEvidence = mergeById(baseEvidence, newEvidence, (e, i) => evKey(e, i));
  const mergedEntities = mergeById(baseEntities, newEntities, (e) => e.id);
  const mergedRels = mergeById(baseRels, newRels, relKey);

  // The store caps SILENTLY and keeps the FIRST n — so an over-cap merge would
  // drop the case's own collected records off the end and tell nobody. Refuse.
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
      `Attaching would push this case past the snapshot storage cap (${over.join(", ")}), and the store discards the overflow silently — the records dropped would be this case's own collected evidence. Nothing was written. Clear this case's snapshot or narrow the result first.`,
    );
  }

  const addedEvidence = mergedEvidence.length - baseEvidence.length;
  const addedEntities = mergedEntities.length - baseEntities.length;
  const addedRels = mergedRels.length - baseRels.length;

  const graph: GraphSnapshot = {
    // `""` is this codebase's established absence marker for this field — an
    // attach has no OSINT job. Carried forward from the base when one exists so
    // the case's original run provenance is preserved.
    investigationId: input.graph?.investigationId ?? "",
    target: input.graph?.target ?? input.source,
    savedAt: input.now,
    entities: mergedEntities,
    relationships: mergedRels,
    caseId: input.caseId,
    // Honest: this did not come from a run. Carried forward from the base run
    // when the case already has one.
    runId: input.graph?.runId ?? null,
    // Carried forward unchanged. Recomputing it from the merged list would report
    // "8 withheld" for a case whose run itself withheld 900.
    ...(input.graph?.truncation ? { truncation: input.graph.truncation } : {}),
  };

  const timeline: TimelineSnapshot = {
    investigationId: input.timeline?.investigationId ?? "",
    target: input.timeline?.target ?? input.source,
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
          ? "Already attached to this case. Nothing changed — every incoming record already had a matching id in the case's snapshot."
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
export function attachResultToCase(
  caseId: string,
  result: AttachableResult,
  source: string,
  now: string,
): CaseAttachOutcome {
  const merged = mergeResultIntoCase({
    caseId,
    source,
    now,
    result,
    // Scoped-only readers. NEVER `getGraphForCase` — see the header, rule 1.
    graph: caseId ? readGraphSnapshotForCase(caseId) : null,
    timeline: caseId ? readTimelineSnapshotForCase(caseId) : null,
  });

  if (!merged.outcome.attached) return merged.outcome;

  // Scoped-only writers. The unscoped slot is never touched.
  if (merged.graph) saveGraphSnapshotForCase(merged.graph);
  if (merged.timeline) saveTimelineSnapshotForCase(merged.timeline);

  return merged.outcome;
}
