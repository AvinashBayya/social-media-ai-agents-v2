import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Badge } from "@/components/ui/badge";
import { Boxes, Network, GitMerge, ShieldQuestion } from "lucide-react";
import { getGraphForCase } from "@/utils/graph-store";
import {
  contributingSourcesOf,
  isResolvedEntity,
  resolutionSummary,
  resolvedCaseEntities,
  RESOLUTION_CAVEATS,
} from "@/utils/cases/case-entities";
import { CASE_RUNS_CHANGED_EVENT } from "@/utils/cases/case-runs";
import type { CollectorEntity } from "@/utils/collectors/result";
import type { Investigation } from "@/utils/investigations-store";

/**
 * Resolved entities for the selected case (2026-08-30, ported from the
 * teammate's fork).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * A VIEW, NOT A RESOLVER.
 *
 * The `CaseSummaryPanel` already shows the resolved entity COUNT; this makes that
 * set BROWSABLE. It computes nothing: it reads the case's own graph snapshot and
 * calls the existing `resolvedCaseEntities` accessor — the same one the summary
 * panel uses, which itself only wraps `osint/entity-resolution.ts`. There is no
 * second resolver here, no identity join, and no promotion of a candidate
 * account/identity into confirmed ownership. A CANDIDATE stays a candidate and
 * is labelled as one.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * PRESENT / ZERO / NOT_CASE_SCOPED IS LOAD-BEARING.
 *
 * `getGraphForCase` falls back to the UNSCOPED slot and STILL returns a snapshot
 * with a non-MATCH verdict. Reading entities off that would attribute another
 * case's graph to this one, so the list is gated on `verdict.result === "MATCH"`.
 * A case with no scoped graph renders NOT_CASE_SCOPED — never an empty list read
 * as "this case has no entities", which is a different and unmeasured fact.
 */

const DIM = "text-console-label";
/** A large run can hold hundreds of entities; render a capped, disclosed slice. */
const MAX_RENDERED = 60;

interface EntityView {
  entity: CollectorEntity;
  resolved: boolean;
  contributors: string[];
  /** Sherlock/handle candidates carry this — surfaced so nothing reads as confirmed ownership. */
  candidate: boolean;
  confidencePct: number | null;
}

type PanelState =
  | { kind: "PENDING" }
  | { kind: "NOT_CASE_SCOPED"; detail: string }
  | { kind: "PRESENT"; summary: string; total: number; entities: EntityView[] };

export function CaseEntitiesPanel({ investigation }: { investigation: Investigation }) {
  const [state, setState] = useState<PanelState>({ kind: "PENDING" });

  const refresh = useCallback(() => {
    const graph = getGraphForCase(investigation.id);
    // Scope gate — a non-MATCH verdict is not this case's graph.
    const ok = graph.verdict.result === "MATCH" && graph.snapshot;
    if (!ok) {
      setState({
        kind: "NOT_CASE_SCOPED",
        detail:
          graph.verdict.result === "MATCH"
            ? "This case has no graph snapshot yet. Run a collection or attach findings to build one."
            : graph.verdict.detail,
      });
      return;
    }

    const original = graph.snapshot!.entities.length;
    const resolved = resolvedCaseEntities({
      entities: graph.snapshot!.entities,
      relationships: graph.snapshot!.relationships,
    });

    const entities: EntityView[] = resolved.entities.map((e) => ({
      entity: e,
      resolved: isResolvedEntity(e),
      contributors: contributingSourcesOf(e),
      candidate: e.metadata?.status === "CANDIDATE",
      // Existing resolution confidence, unchanged. null stays "unscored", never 0.
      confidencePct: e.confidence.value === null ? null : Math.round(e.confidence.value * 100),
    }));

    setState({
      kind: "PRESENT",
      summary: resolutionSummary(resolved, original),
      total: resolved.entities.length,
      entities,
    });
  }, [investigation.id]);

  useEffect(() => {
    refresh();
    // Same refresh seam the sibling case panels use — a run from this page
    // dispatches it after writing the case's snapshots.
    window.addEventListener(CASE_RUNS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(CASE_RUNS_CHANGED_EVENT, refresh);
  }, [refresh]);

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-console-purple">
        <Boxes className="size-3" />
        Resolved entities — {investigation.id}
      </span>
      {/* Entity → graph, always carrying the case. Shown only when a MATCH
          graph exists, i.e. there is a graph representation to view. */}
      {state.kind === "PRESENT" && state.total > 0 && (
        <Link
          to="/graph"
          search={{ case: investigation.id }}
          data-testid="case-entities-graph-link"
          className="inline-flex items-center gap-1 rounded border border-console-purple/40 bg-console-purple/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-console-purple hover:bg-console-purple/20"
        >
          <Network className="size-2.5" /> View in Graph
        </Link>
      )}
    </div>
  );

  return (
    <div
      className="space-y-2 rounded border border-console-border bg-console-deep p-3 font-mono text-xs"
      data-testid="case-entities-panel"
    >
      {header}

      {state.kind === "PENDING" && (
        <p className={`text-[10px] ${DIM}`}>Reading this case's graph snapshot…</p>
      )}

      {state.kind === "NOT_CASE_SCOPED" && (
        <p data-testid="case-entities-notscoped" className={`text-[10px] leading-relaxed ${DIM}`}>
          Not case-scoped. {state.detail} Nothing is substituted from another case or the unscoped
          slot — an empty list here would be an unmeasured absence, not a finding that this case has
          no entities.
        </p>
      )}

      {state.kind === "PRESENT" && (
        <>
          <p className={`text-[9px] leading-relaxed ${DIM}`}>{state.summary}</p>

          {state.total === 0 ? (
            <p className={`text-[10px] leading-relaxed ${DIM}`}>
              This case's graph snapshot holds no entities. A measured zero over a real snapshot.
            </p>
          ) : (
            <div className="max-h-80 space-y-1 overflow-y-auto rounded border border-console-border">
              {state.entities.slice(0, MAX_RENDERED).map((v) => (
                <div
                  key={v.entity.id}
                  data-testid="case-entity-row"
                  className="space-y-0.5 border-b border-console-border/50 px-2 py-1.5 last:border-0"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge className="h-4 rounded-none border-console-blue/30 bg-console-blue/10 px-1 text-[8px] uppercase text-console-blue">
                      {v.entity.type}
                    </Badge>
                    {v.resolved && (
                      <Badge className="h-4 gap-0.5 rounded-none border-console-green/30 bg-console-green/10 px-1 text-[8px] uppercase text-console-green">
                        <GitMerge className="size-2.5" /> merged
                      </Badge>
                    )}
                    {/* A candidate is never rendered as confirmed ownership. */}
                    {v.candidate && (
                      <Badge className="h-4 gap-0.5 rounded-none border-console-amber/30 bg-console-amber/10 px-1 text-[8px] uppercase text-console-amber">
                        <ShieldQuestion className="size-2.5" /> candidate
                      </Badge>
                    )}
                    <span className="truncate text-[10px] text-console-text">
                      {v.entity.displayName || v.entity.value}
                    </span>
                    <span className={`ml-auto text-[9px] ${DIM}`}>
                      {/* Existing resolution confidence — null is "unscored", not 0. */}
                      {v.confidencePct === null ? "unscored" : `${v.confidencePct}%`}
                    </span>
                  </div>
                  <div className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[8px] ${DIM}`}>
                    <span>
                      {v.resolved ? "contributors:" : "source:"} {v.contributors.join(", ") || "—"}
                    </span>
                    {v.entity.confidence.reasons.length > 0 && (
                      <span className="text-console-muted">· {v.entity.confidence.reasons[0]}</span>
                    )}
                  </div>
                </div>
              ))}
              {state.total > MAX_RENDERED && (
                <p className={`px-2 py-1 text-[8px] ${DIM}`}>
                  Showing the first {MAX_RENDERED} of {state.total}. The full set is in the graph.
                </p>
              )}
            </div>
          )}

          <div className="space-y-0.5 border-t border-console-border/40 pt-1.5">
            {RESOLUTION_CAVEATS.map((c) => (
              <p key={c} className={`text-[8px] leading-relaxed ${DIM}`}>
                {c}
              </p>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
