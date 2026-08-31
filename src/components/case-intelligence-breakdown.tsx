import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Globe2, Layers, Network, Newspaper, Users } from "lucide-react";
import { getGraphForCase } from "@/utils/graph-store";
import { getTimelineForCase } from "@/utils/timeline-store";
import { CASE_RUNS_CHANGED_EVENT } from "@/utils/cases/case-runs";
import {
  GEOINT_DISCIPLINE_ROW,
  geointEvidenceIn,
  geointHypothesisCount,
} from "@/utils/cases/case-geoint";
import { capabilityReport, type CapabilityReport } from "@/utils/collectors/capability-report";
import { buildCaseContradictions } from "@/utils/cases/case-contradictions";
import {
  RESOLUTION_CAVEATS,
  resolutionSummary,
  resolvedCaseEntities,
} from "@/utils/cases/case-entities";
import { caseMediaClaims } from "@/utils/cases/case-claims";
import {
  buildCaseIntelligenceBreakdown,
  breakdownHeadline,
  type CaseIntelligenceBreakdown,
  type DisciplineKey,
  type DisciplineSection,
} from "@/utils/cases/case-intelligence-breakdown";
import type { Investigation } from "@/utils/investigations-store";

/**
 * Case intelligence breakdown (2026-08-30, ported from the teammate's fork).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT IT ADDS, AND WHAT IT DELIBERATELY DOES NOT.
 *
 * A case already held SOCMINT, TECHINT and MEDIAINT records; nothing on screen
 * said so. This panel tallies them by the collectors' OWN declared disciplines.
 *
 * It creates no second evidence model, no claim store and no discipline field.
 * The counting lives in a pure module; this file reads the case's stored
 * snapshots, fetches the EXISTING capability matrix, and renders the answer.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE CAPABILITY MATRIX IS FETCHED, NOT IMPORTED.
 *
 * `disciplines` lives on the `Collector` objects in the server-side registry, and
 * `capability-report.ts`'s own header explains why that registry must stay there:
 * importing it pulls `createServerFn` and server-only utilities into the browser
 * bundle, which is the failure this project has already shipped twice
 * (`bun:sqlite` in the client bundle, then in an SSR chunk).
 *
 * So this calls the existing `capabilityReport()` server function — the one
 * `/crawlers` already uses. No new endpoint, no new data, no bundling risk.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * AN UNAVAILABLE MATRIX IS REPORTED, NOT ASSUMED AWAY.
 *
 * If the matrix cannot be read, every collector becomes `unmapped` and the panel
 * says so. It does NOT fall back to guessing a discipline from a collector's
 * name — that would file real records under an invented heading, which is worse
 * than showing nothing.
 */

const DIM = "text-console-label";

const ICONS: Record<DisciplineKey, typeof Users> = {
  SOCMINT: Users,
  TECHINT: Network,
  GEOINT: Globe2,
  MEDIAINT: Newspaper,
};

const TONE: Record<DisciplineKey, string> = {
  SOCMINT: "text-console-purple",
  TECHINT: "text-console-cyan",
  GEOINT: "text-console-green",
  MEDIAINT: "text-console-amber",
};

function StatusBadge({ section }: { section: DisciplineSection }) {
  if (section.status === "NOT_CASE_SCOPED") {
    return (
      <Badge
        className="h-4 rounded-none border border-console-label/30 bg-console-label/10 px-1 text-[8px] uppercase text-console-muted"
        title="The capability exists but its output is not part of this case. Different from zero."
      >
        Not case-scoped
      </Badge>
    );
  }
  if (section.status === "ZERO") {
    return (
      <Badge
        className="h-4 rounded-none border border-console-amber/30 bg-console-amber/10 px-1 text-[8px] uppercase text-console-amber"
        title="This case was evaluated for this discipline and holds no records."
      >
        No records
      </Badge>
    );
  }
  return null;
}

function SectionRow({ section }: { section: DisciplineSection }) {
  const Icon = ICONS[section.discipline];
  return (
    <div className="space-y-1 border-b border-console-border/50 px-2 py-2 last:border-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <Icon className={`size-3 ${TONE[section.discipline]}`} />
        <span className={`text-[10px] font-bold uppercase tracking-wider ${TONE[section.discipline]}`}>
          {section.discipline}
        </span>
        <StatusBadge section={section} />
      </div>

      <div className="space-y-0.5 pl-4">
        {section.metrics.map((m) => (
          <div key={m.label}>
            <div className="flex items-baseline gap-2 font-mono text-[10px]">
              {/* The label is never optional — a bare number cannot say whether
                  it counts evidence, claims or articles. */}
              <span className={`w-24 shrink-0 ${DIM}`}>{m.label}</span>
              {m.value.kind === "COUNT" ? (
                <span className="font-bold text-console-text">{m.value.value}</span>
              ) : (
                <span
                  className="text-console-muted"
                  title={m.value.reason}
                >
                  Not case-scoped
                </span>
              )}
            </div>
            {m.value.kind === "NOT_CASE_SCOPED" && (
              <p className={`pl-26 text-[9px] leading-relaxed ${DIM}`}>{m.value.reason}</p>
            )}
            {m.note && (
              <p className={`text-[9px] leading-relaxed ${DIM}`} style={{ paddingLeft: "6.5rem" }}>
                {m.note}
              </p>
            )}
          </div>
        ))}
      </div>

      {/* Collector status — "declares it" and "produced it here" are different
          facts, and a discipline showing 0 needs the second one to be readable. */}
      <p className={`pl-4 text-[9px] leading-relaxed ${DIM}`}>
        Collectors declaring {section.discipline}: {section.declaredBy.length}
        {section.declaredBy.length > 0 && (
          <>
            {" "}
            ({section.declaredBy.join(", ")}) · produced here: {section.producedIn.length}
            {section.silent.length > 0 && (
              <> · silent here: {section.silent.join(", ")}</>
            )}
          </>
        )}
      </p>
    </div>
  );
}

export function CaseIntelligenceBreakdownPanel({
  investigation,
}: {
  investigation: Investigation;
}) {
  const [breakdown, setBreakdown] = useState<CaseIntelligenceBreakdown | null>(null);
  const [matrixError, setMatrixError] = useState<string | null>(null);
  const [rows, setRows] = useState<CapabilityReport["rows"] | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [resolution, setResolution] = useState<string | null>(null);

  // The capability matrix is static per build, so it is fetched once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const report = (await capabilityReport()) as unknown as CapabilityReport;
        if (!cancelled) {
          setRows(report.rows);
          setMatrixError(null);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setRows([]);
          setMatrixError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(() => {
    if (rows === null) return;

    const graph = getGraphForCase(investigation.id);
    const timeline = getTimelineForCase(investigation.id);

    // Scope rules, unchanged. A MISMATCH or UNSCOPED verdict means the data
    // belongs elsewhere, and counting it would attribute another case's
    // intelligence to this one — with the extra hazard that a tally looks
    // authoritative.
    const graphOk = graph.verdict.result === "MATCH" && graph.snapshot;
    const timelineOk = timeline.verdict.result === "MATCH" && timeline.snapshot;

    if (!graphOk && !timelineOk) {
      setBlocked(
        "No collected data is stored for this case, so there is nothing to break down. Counts are derived from this case's own snapshots — never from another case's, and never from the unscoped slot.",
      );
      setBreakdown(null);
      return;
    }
    setBlocked(null);

    const evidence = timelineOk ? timeline.snapshot!.evidence : [];
    // Count RESOLVED identities, so a case does not report two entities for one
    // IP simply because two collectors found it. Entities and relationships are
    // replaced together; `contributingSourcesOf` inside the pure counter
    // attributes a merged entity to every collector that contributed it, so no
    // discipline loses entities to the merge.
    const rawEntities = graphOk ? graph.snapshot!.entities : [];
    const rawRelationships = graphOk ? graph.snapshot!.relationships : [];
    const resolvedSet = resolvedCaseEntities({
      entities: rawEntities,
      relationships: rawRelationships,
    });
    const entities = resolvedSet.entities;
    const relationships = resolvedSet.relationships;
    setResolution(
      resolvedSet.mergedCount > 0
        ? resolutionSummary(resolvedSet, rawEntities.length)
        : null,
    );

    // MEDIAINT claims and both contradiction kinds come from the EXISTING
    // derivations over this same case-scoped evidence. Nothing is re-implemented
    // and nothing is stored.
    // The ONE case-level accessor, the same one the MEDIAINT panel, the
    // grounded context and the case report read.
    const claimSet = caseMediaClaims({
      caseId: investigation.id,
      evidence,
      extractedAt: new Date().toISOString(),
    });
    const contradictions = buildCaseContradictions({
      caseId: investigation.id,
      runId: (timelineOk ? timeline.snapshot!.runId : graph.snapshot?.runId) ?? null,
      investigationId:
        (timelineOk ? timeline.snapshot!.investigationId : graph.snapshot?.investigationId) ?? "",
      snapshotSavedAt: (timelineOk ? timeline.snapshot!.savedAt : graph.snapshot?.savedAt) ?? "",
      evidence,
      relationships,
      extractedAt: new Date().toISOString(),
    });

    setBreakdown(
      buildCaseIntelligenceBreakdown({
        caseId: investigation.id,
        evidence,
        entities,
        relationships,
        // The GEOINT layer's own discipline declaration, appended to the
        // matrix. `geoint` is not a registered collector (the orchestrator
        // can never invoke it), so the matrix cannot know it and every attached
        // record would otherwise report `unmapped`. This is a declaration BY THE
        // PRODUCER, the same basis every collector uses — not the breakdown
        // guessing a discipline from a name, which it still refuses to do.
        capabilityRows: [...rows, GEOINT_DISCIPLINE_ROW],
        mediaClaims: claimSet.claims.length,
        mediaConflicts: contradictions.media.length,
        // Claims come from evidence, which lives in the TIMELINE snapshot. A
        // case with a graph snapshot but no timeline snapshot has had nothing
        // read, and "Claims: 0" would be a measured zero standing in for an
        // unmeasured one.
        mediaEvidenceScoped: Boolean(timelineOk),
        infrastructureContradictions: contradictions.infrastructure.length,
        // Derived from THIS CASE's own records. Deriving it from anything else
        // would tell a case with nothing attached that GEOINT is scoped to it.
        geointCaseScoped: geointEvidenceIn(evidence).length > 0,
        geointHypotheses: geointHypothesisCount(evidence),
      }),
    );
  }, [investigation.id, rows]);

  useEffect(() => {
    refresh();
    window.addEventListener(CASE_RUNS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(CASE_RUNS_CHANGED_EVENT, refresh);
  }, [refresh]);

  const header = (
    <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-console-cyan">
      <Layers className="size-3" />
      Case intelligence — {investigation.id}
    </span>
  );

  if (rows === null) {
    return (
      <div className="rounded border border-console-border bg-console-deep p-3 font-mono text-xs">
        {header}
        <p className={`mt-1.5 text-[10px] ${DIM}`}>Reading the collector capability matrix…</p>
      </div>
    );
  }

  if (blocked) {
    return (
      <div className="rounded border border-console-border bg-console-deep p-3 font-mono text-xs">
        {header}
        <p className={`mt-1.5 text-[10px] leading-relaxed ${DIM}`}>{blocked}</p>
      </div>
    );
  }

  if (!breakdown) return null;

  return (
    <div className="space-y-3 rounded border border-console-border bg-console-deep p-3 font-mono text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {header}
        <span className={`text-[9px] ${DIM}`}>{breakdownHeadline(breakdown)}</span>
      </div>

      {/* A failed matrix read is stated, never papered over with guessed
          disciplines — see the header comment. */}
      {matrixError && (
        <p className="rounded border border-console-red/30 bg-console-red/5 px-2 py-1 text-[9px] leading-relaxed text-console-red">
          The collector capability matrix could not be read ({matrixError}). Disciplines are
          declared by collectors, so without it no record can be attributed to one. Every collector
          below is listed as unmapped rather than filed under a guess.
        </p>
      )}

      <div className="rounded border border-console-border">
        {breakdown.sections.map((s) => (
          <SectionRow key={s.discipline} section={s} />
        ))}
      </div>

      {(breakdown.untagged.collectors.length > 0 || breakdown.unmapped.collectors.length > 0) && (
        <div className="space-y-0.5 rounded border border-console-amber/30 bg-console-amber/5 px-2 py-1.5 text-[9px] leading-relaxed text-console-amber">
          {breakdown.untagged.collectors.length > 0 && (
            <p>
              {breakdown.untagged.evidence} record(s) from{" "}
              {breakdown.untagged.collectors.join(", ")} — these collectors declare no discipline,
              so their output is counted under none rather than filed under a guess.
            </p>
          )}
          {breakdown.unmapped.collectors.length > 0 && (
            <p>
              {breakdown.unmapped.evidence} record(s) from{" "}
              {breakdown.unmapped.collectors.join(", ")} — not present in the capability matrix, so
              their discipline is unknown.
            </p>
          )}
        </div>
      )}

      {/* Resolution changed the counts, so it is stated rather than leaving an
          analyst to wonder why the entity total moved. */}
      {resolution && (
        <p className="rounded border border-console-amber/30 bg-console-amber/5 px-2 py-1 text-[9px] leading-relaxed text-console-amber">
          {resolution}
        </p>
      )}

      <div className="space-y-0.5 border-t border-console-border/40 pt-2">
        {[...breakdown.caveats, ...RESOLUTION_CAVEATS].map((c) => (
          <p key={c} className={`text-[9px] leading-relaxed ${DIM}`}>
            {c}
          </p>
        ))}
      </div>
    </div>
  );
}
