/**
 * Case deletion cascade (2026-08-30, ported from the teammate's fork).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DEFECT THIS CLOSES, reproduced live during the source fork's final audit.
 *
 * `deleteInvestigation` removes only the case record, and case ids are minted
 * as `max(existing) + 1` — so deleting the highest-numbered case makes the NEXT
 * created case reuse its id. The deleted case's graph/timeline snapshots survive
 * under `sentinel_graph_snapshot__INV-1001` (and the timeline twin), and the
 * recreated INV-1001 then reads them back with verdict **MATCH**. Every scope
 * gate in the codebase passes, because the gate is honest: the snapshot really
 * does carry that case id. The id is simply no longer the same case.
 *
 * Reproduced end-to-end against the real modules: case A (INV-1001) deleted,
 * case B created as INV-1001, and case A's entities returned for case B with
 * verdict MATCH. That is the exact cross-case failure class case scoping exists
 * to prevent, reachable through two ordinary UI actions.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT DELETION MUST THEREFORE TAKE WITH IT.
 *
 *   1. The case's scoped graph and timeline slots.
 *   2. The UNSCOPED mirrors — but ONLY when they carry this case's id. The
 *      unscoped slot is a shared scratch hand-off; if the deleted case produced
 *      the most recent run, the mirror carries its `caseId` and the fallback in
 *      `getGraphForCase` would resurrect it as MATCH for a reused id. A mirror
 *      carrying a DIFFERENT case's id (or none) is not ours to clear.
 *   3. The eviction-ledger rows for this case, in both stores. A recreated id
 *      must not be told its snapshot "was evicted" when nothing of its ever
 *      existed.
 *   4. The case's runs.
 *   5. Vault records are UNLINKED, not deleted. An analyst's pinned exhibit
 *      outlives the case it was filed under — destroying evidence on a case
 *      delete would be its own integrity failure — but it must not surface
 *      under a future case that merely reuses the number. `caseId: ""` puts it
 *      in the existing unlinked pool, where /vault already shows it honestly.
 *
 * This module composes EXISTING deleters only. It defines no storage of its
 * own and never touches another case's keys.
 */

import { deleteInvestigation } from "../investigations-store";
import {
  clearGraphForCase,
  clearGraphSnapshot,
  readGraphSnapshot,
} from "../graph-store";
import {
  clearTimelineForCase,
  clearTimelineSnapshot,
  readTimelineSnapshot,
} from "../timeline-store";
import { clearEviction } from "./case-scope";
import { deleteRunsForCase } from "./case-runs";
import { getEvidence, saveEvidence } from "../evidence-store";

/**
 * The two stores' public storage keys, as documented on
 * `EvictionRecord.baseKey`. The stores keep their own key constants private;
 * these literals are the stable, documented external names of the same keys and
 * a test asserts they still match what the stores actually write.
 */
export const GRAPH_BASE_KEY = "sentinel_graph_snapshot";
export const TIMELINE_BASE_KEY = "sentinel_timeline_snapshot";

export interface CaseDeletionReport {
  caseId: string;
  clearedScopedGraph: boolean;
  clearedScopedTimeline: boolean;
  /** True only when the unscoped mirror carried this case's id and was cleared. */
  clearedUnscopedGraph: boolean;
  clearedUnscopedTimeline: boolean;
  runsDeleted: boolean;
  /** Vault records moved to the unlinked pool — never deleted. */
  evidenceUnlinked: number;
}

/**
 * Deletes a case and everything that would otherwise be resurrected by a
 * reused id.
 *
 * Order matters only for honesty of the report: reads happen before deletes.
 */
export function deleteCaseCascade(caseId: string): CaseDeletionReport {
  const report: CaseDeletionReport = {
    caseId,
    clearedScopedGraph: false,
    clearedScopedTimeline: false,
    clearedUnscopedGraph: false,
    clearedUnscopedTimeline: false,
    runsDeleted: false,
    evidenceUnlinked: 0,
  };
  if (!caseId) return report;

  // 1. Scoped snapshot slots.
  clearGraphForCase(caseId);
  clearTimelineForCase(caseId);
  report.clearedScopedGraph = true;
  report.clearedScopedTimeline = true;

  // 2. Unscoped mirrors — only when they are THIS case's.
  if (readGraphSnapshot()?.caseId === caseId) {
    clearGraphSnapshot();
    report.clearedUnscopedGraph = true;
  }
  if (readTimelineSnapshot()?.caseId === caseId) {
    clearTimelineSnapshot();
    report.clearedUnscopedTimeline = true;
  }

  // 3. Eviction ledger rows, both stores.
  clearEviction(GRAPH_BASE_KEY, caseId);
  clearEviction(TIMELINE_BASE_KEY, caseId);

  // 4. Runs.
  deleteRunsForCase(caseId);
  report.runsDeleted = true;

  // 5. Vault records: unlink, never delete.
  const evidence = getEvidence();
  const linked = evidence.filter((e) => e.caseId === caseId);
  if (linked.length > 0) {
    saveEvidence(
      evidence.map((e) =>
        e.caseId === caseId ? { ...e, caseId: "", pinnedEvidenceId: null } : e,
      ),
    );
    report.evidenceUnlinked = linked.length;
  }

  // 6. The case record itself, last — a failure above leaves the case visible
  //    rather than leaving orphaned data behind an already-deleted case.
  deleteInvestigation(caseId);

  return report;
}
