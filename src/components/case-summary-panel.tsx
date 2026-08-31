import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Gauge,
  FileText,
  Boxes,
  Share2,
  Quote,
  GitCompare,
  Link2,
  Clock,
  Globe2,
  Network,
  Newspaper,
  Users,
} from "lucide-react";
import { getGraphForCase } from "@/utils/graph-store";
import { getTimelineForCase } from "@/utils/timeline-store";
import { resolvedCaseEntities } from "@/utils/cases/case-entities";
import { caseMediaClaims, MEDIAINT_NOT_CASE_SCOPED } from "@/utils/cases/case-claims";
import {
  buildCaseContradictions,
  summariseCaseContradictions,
} from "@/utils/cases/case-contradictions";
import {
  buildCrossIntelligence,
  summariseCrossIntelligence,
} from "@/utils/cases/cross-intelligence";
import { buildEvidenceTimeline } from "@/utils/osint/timeline";
import { assessCompleteness, completenessHeadline } from "@/utils/cases/case-report";
import {
  buildCaseIntelligenceBreakdown,
  type DisciplineKey,
  type DisciplineSection,
} from "@/utils/cases/case-intelligence-breakdown";
import {
  GEOINT_DISCIPLINE_ROW,
  geointEvidenceIn,
  geointHypothesisCount,
} from "@/utils/cases/case-geoint";
import { capabilityReport, type CapabilityReport } from "@/utils/collectors/capability-report";
import { planOsintInvestigation } from "@/utils/osint/jobs";
import { CASE_RUNS_CHANGED_EVENT, runsForCase } from "@/utils/cases/case-runs";
import type { OsintPlan } from "@/utils/osint/query-planner";
import type { Investigation } from "@/utils/investigations-store";

/**
 * Case Intelligence Summary — the hub's at-a-glance roll-up (2026-08-30,
 * ported from the teammate's fork).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT IT ADDS, AND WHAT IT DELIBERATELY DOES NOT.
 *
 * Eight numbers an analyst wants at a glance for the SELECTED case: Evidence,
 * Entities, Relationships, Claims, Contradictions, Correlations, Timeline events,
 * Collection completeness — plus a compact strip of the four disciplines.
 *
 * It computes NOTHING new. Every figure is read off the SAME pure builder the
 * dedicated panel below already renders in full — the discipline breakdown, the
 * MEDIAINT claims accessor, the contradiction engine, the correlation engine,
 * the evidence timeline, and the completeness assessor. This is a roll-up view
 * of derivations that already exist, not a second calculation.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE DATA SOURCE IS THE RUN SNAPSHOTS, NOT PINNED EVIDENCE.
 *
 * These eight come from the case's graph + timeline snapshots (getGraphForCase /
 * getTimelineForCase), NOT from pinned investigation evidence, a different
 * quantity. The metrics strip above the panel keeps reporting pinned evidence;
 * this reports what the case's runs collected.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * PRESENT / ZERO / NOT_CASE_SCOPED IS LOAD-BEARING.
 *
 * getGraphForCase / getTimelineForCase fall back to the UNSCOPED slot and STILL
 * return a snapshot with a non-MATCH verdict. Reading a count off that would
 * attribute another case's intelligence to this one. So every figure is gated on
 * `verdict.result === "MATCH"`, exactly as the sibling panels do, and a figure
 * with no scoped snapshot renders NOT_CASE_SCOPED — never a measured zero. A real
 * zero over a real snapshot (ZERO) and an unmeasured one (NOT_CASE_SCOPED) are
 * different facts and read differently.
 */

const DIM = "text-console-label";

/** One summary figure. A count, a status, an unmeasured absence, or still-loading. */
type Datum =
  | { kind: "COUNT"; value: number; note?: string }
  | { kind: "STATUS"; value: string; detail: string }
  | { kind: "NOT_CASE_SCOPED"; reason: string }
  | { kind: "PENDING" };

interface CaseSummary {
  anyScoped: boolean;
  evidence: Datum;
  entities: Datum;
  relationships: Datum;
  claims: Datum;
  contradictions: Datum;
  correlations: Datum;
  timelineEvents: Datum;
  completeness: Datum;
  disciplines: DisciplineSection[] | null;
}

const NOT_SCOPED_GENERIC =
  "This case has no collected run data of its own for this figure. Nothing is substituted from another case or the unscoped slot.";

const DISCIPLINE_ICON: Record<DisciplineKey, typeof Users> = {
  SOCMINT: Users,
  TECHINT: Network,
  GEOINT: Globe2,
  MEDIAINT: Newspaper,
};
const DISCIPLINE_TONE: Record<DisciplineKey, string> = {
  SOCMINT: "text-console-purple",
  TECHINT: "text-console-cyan",
  GEOINT: "text-console-green",
  MEDIAINT: "text-console-amber",
};

export function CaseSummaryPanel({ investigation }: { investigation: Investigation }) {
  const [rows, setRows] = useState<CapabilityReport["rows"] | null>(null);
  // undefined = still planning; null = plan could not be determined (honest);
  // OsintPlan = planned. Kept distinct so completeness shows PENDING vs a real
  // "coverage unknown" state rather than conflating them.
  const [plan, setPlan] = useState<OsintPlan | null | undefined>(undefined);
  const [summary, setSummary] = useState<CaseSummary | null>(null);

  // The capability matrix is static per build — fetched once, the same server
  // function /crawlers and the discipline/correlation panels already use. An
  // unreadable matrix maps nothing (correlations then cannot be asserted).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const report = (await capabilityReport()) as unknown as CapabilityReport;
        if (!cancelled) setRows(report.rows);
      } catch {
        if (!cancelled) setRows([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Planning is READ-ONLY (a deterministic registry read; it starts nothing),
  // the same call /reports and /agents make for completeness. A failure degrades
  // to null, which assessCompleteness reports as "coverage unknown" rather than
  // as full coverage.
  useEffect(() => {
    let cancelled = false;
    setPlan(undefined);
    if (!investigation.target) {
      setPlan(null);
      return;
    }
    (async () => {
      try {
        const p = (await planOsintInvestigation({
          data: { target: investigation.target },
        })) as OsintPlan;
        if (!cancelled) setPlan(p);
      } catch {
        if (!cancelled) setPlan(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [investigation.target]);

  const refresh = useCallback(() => {
    const id = investigation.id;
    const graph = getGraphForCase(id);
    const timeline = getTimelineForCase(id);
    // Scope gate. A non-MATCH verdict means the snapshot belongs to another
    // case (or is the unscoped slot); its counts are not this case's.
    const graphOk = graph.verdict.result === "MATCH" && graph.snapshot;
    const timelineOk = timeline.verdict.result === "MATCH" && timeline.snapshot;

    // Entities and relationships are resolved TOGETHER in one call (the resolver
    // rewrites ids and remaps edge endpoints); the on-screen panels show the
    // resolved counts, so the summary must too.
    const resolved = resolvedCaseEntities({
      entities: graphOk ? graph.snapshot!.entities : [],
      relationships: graphOk ? graph.snapshot!.relationships : [],
    });
    const evidence = timelineOk ? timeline.snapshot!.evidence : [];
    const now = new Date().toISOString();
    const anyScoped = Boolean(graphOk || timelineOk);

    const notScoped = (reason: string): Datum => ({ kind: "NOT_CASE_SCOPED", reason });

    // Shared provenance for the derivations that need it.
    const runId = (timelineOk ? timeline.snapshot!.runId : graph.snapshot?.runId) ?? null;
    const investigationId =
      (timelineOk ? timeline.snapshot!.investigationId : graph.snapshot?.investigationId) ?? "";
    const snapshotSavedAt =
      (timelineOk ? timeline.snapshot!.savedAt : graph.snapshot?.savedAt) ?? "";

    // Compute the two shared derivations ONCE and reuse them for both the
    // headline figures and the discipline strip — the claim accessor and the
    // contradiction engine are each invoked a single time per refresh.
    const claimSet = caseMediaClaims({ caseId: id, evidence, extractedAt: now });
    const contradictionReport = anyScoped
      ? buildCaseContradictions({
          caseId: id,
          runId,
          investigationId,
          snapshotSavedAt,
          evidence,
          relationships: resolved.relationships,
          extractedAt: now,
        })
      : null;

    // ── Evidence / Entities / Relationships (direct off the scoped snapshots) ──
    const evidenceDatum: Datum = timelineOk
      ? { kind: "COUNT", value: evidence.length }
      : notScoped(NOT_SCOPED_GENERIC);
    const entitiesDatum: Datum = graphOk
      ? { kind: "COUNT", value: resolved.entities.length }
      : notScoped(NOT_SCOPED_GENERIC);
    const relationshipsDatum: Datum = graphOk
      ? { kind: "COUNT", value: resolved.relationships.length }
      : notScoped(NOT_SCOPED_GENERIC);

    // ── Claims (MEDIAINT) — the ONE case-level accessor the MEDIAINT panel uses.
    //    Gated on the TIMELINE snapshot: a case with no timeline snapshot has read
    //    no articles, and "0" there is an unmeasured zero, not a measured one. ──
    const claimsDatum: Datum = timelineOk
      ? { kind: "COUNT", value: claimSet.claims.length }
      : notScoped(MEDIAINT_NOT_CASE_SCOPED);

    // ── Contradictions — the same derivation the contradictions panel renders ──
    const contradictionsDatum: Datum = contradictionReport
      ? { kind: "COUNT", value: summariseCaseContradictions(contradictionReport).total }
      : notScoped(NOT_SCOPED_GENERIC);

    // ── Correlations — the cross-intelligence engine; needs the capability matrix
    //    to map disciplines. Until the matrix loads it is genuinely unknown
    //    (PENDING), never a false zero.
    let correlationsDatum: Datum;
    if (!anyScoped) {
      correlationsDatum = notScoped(NOT_SCOPED_GENERIC);
    } else if (rows === null) {
      correlationsDatum = { kind: "PENDING" };
    } else {
      correlationsDatum = {
        kind: "COUNT",
        value: summariseCrossIntelligence(
          buildCrossIntelligence({
            caseId: id,
            entities: resolved.entities,
            relationships: resolved.relationships,
            evidence,
            capabilityRows: [...rows, GEOINT_DISCIPLINE_ROW],
          }),
        ).total,
      };
    }

    // ── Timeline events — the pure builder /timeline renders. One event per ──
    //    evidence record, so this equals Evidence; shown as its own figure
    //    because the hub lists it, with that note so it never reads as new data.
    const timelineDatum: Datum = timelineOk
      ? {
          kind: "COUNT",
          value: buildEvidenceTimeline(evidence).summary.total,
          note: "one event per collected record",
        }
      : notScoped(NOT_SCOPED_GENERIC);

    // ── Collection completeness — the assessor /reports uses. Needs the plan; ──
    //    PENDING until it resolves, then an honest status (a null plan reports
    //    "coverage unknown", never COMPLETE).
    let completenessDatum: Datum;
    if (!anyScoped) {
      completenessDatum = notScoped(NOT_SCOPED_GENERIC);
    } else if (plan === undefined) {
      completenessDatum = { kind: "PENDING" };
    } else {
      const run = runsForCase(id).find((r) => r.id === runId) ?? runsForCase(id)[0] ?? null;
      const completeness = assessCompleteness({
        plan,
        evidence,
        runStatus: run?.status ?? null,
        graphTruncation: graphOk ? graph.snapshot!.truncation : undefined,
        timelineTruncation: timelineOk ? timeline.snapshot!.truncation : undefined,
      });
      completenessDatum = {
        kind: "STATUS",
        value: completeness.status,
        detail: completenessHeadline(completeness),
      };
    }

    // ── Discipline strip — REUSE the breakdown builder, do not reclassify. ──
    //    The same inputs the full breakdown panel below assembles, fed the shared
    //    claim/contradiction derivations computed once above; only the
    //    presentation differs (a compact status strip vs the detailed panel).
    let disciplines: DisciplineSection[] | null = null;
    if (anyScoped && rows !== null && contradictionReport) {
      disciplines = buildCaseIntelligenceBreakdown({
        caseId: id,
        evidence,
        entities: resolved.entities,
        relationships: resolved.relationships,
        capabilityRows: [...rows, GEOINT_DISCIPLINE_ROW],
        mediaClaims: claimSet.claims.length,
        mediaConflicts: contradictionReport.media.length,
        mediaEvidenceScoped: Boolean(timelineOk),
        infrastructureContradictions: contradictionReport.infrastructure.length,
        geointCaseScoped: geointEvidenceIn(evidence).length > 0,
        geointHypotheses: geointHypothesisCount(evidence),
      }).sections;
    }

    setSummary({
      anyScoped,
      evidence: evidenceDatum,
      entities: entitiesDatum,
      relationships: relationshipsDatum,
      claims: claimsDatum,
      contradictions: contradictionsDatum,
      correlations: correlationsDatum,
      timelineEvents: timelineDatum,
      completeness: completenessDatum,
      disciplines,
    });
  }, [investigation.id, rows, plan]);

  useEffect(() => {
    refresh();
    // A run in another tab writes snapshots without firing this event, but a run
    // FROM this page does — the runs panel dispatches it. Same refresh seam the
    // sibling panels use.
    window.addEventListener(CASE_RUNS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(CASE_RUNS_CHANGED_EVENT, refresh);
  }, [refresh]);

  const header = (
    <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-console-cyan">
      <Gauge className="size-3" />
      Case intelligence summary — {investigation.id}
    </span>
  );

  if (!summary) {
    return (
      <div className="rounded border border-console-border bg-console-deep p-3 font-mono text-xs">
        {header}
        <p className={`mt-1.5 text-[10px] ${DIM}`}>Reading this case's collected snapshots…</p>
      </div>
    );
  }

  const cells: Array<{ label: string; icon: typeof FileText; datum: Datum; testid: string }> = [
    { label: "Evidence", icon: FileText, datum: summary.evidence, testid: "sum-evidence" },
    { label: "Entities", icon: Boxes, datum: summary.entities, testid: "sum-entities" },
    { label: "Relationships", icon: Share2, datum: summary.relationships, testid: "sum-relationships" },
    { label: "Claims", icon: Quote, datum: summary.claims, testid: "sum-claims" },
    { label: "Contradictions", icon: GitCompare, datum: summary.contradictions, testid: "sum-contradictions" },
    { label: "Correlations", icon: Link2, datum: summary.correlations, testid: "sum-correlations" },
    { label: "Timeline events", icon: Clock, datum: summary.timelineEvents, testid: "sum-timeline" },
    { label: "Completeness", icon: Gauge, datum: summary.completeness, testid: "sum-completeness" },
  ];

  return (
    <div
      className="space-y-3 rounded border border-console-border bg-console-deep p-3 font-mono text-xs"
      data-testid="case-summary-panel"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        {header}
        <span className={`text-[9px] ${DIM}`}>
          {summary.anyScoped
            ? "Counted from this case's own collected run — not from pinned evidence."
            : "No collected run is scoped to this case yet."}
        </span>
      </div>

      {/* The eight figures. NOT_CASE_SCOPED is a dash with a reason, never a 0. */}
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {cells.map((c) => (
          <SummaryCell key={c.label} label={c.label} icon={c.icon} datum={c.datum} testid={c.testid} />
        ))}
      </div>

      {/* The four disciplines, made obvious. REUSES the breakdown builder — the
          full detail is the discipline panel below. */}
      {summary.disciplines && (
        <div className="flex flex-wrap gap-1.5 border-t border-console-border/40 pt-2" data-testid="sum-disciplines">
          {summary.disciplines.map((s) => (
            <DisciplineChip key={s.discipline} section={s} />
          ))}
        </div>
      )}

      <p className={`text-[9px] leading-relaxed ${DIM}`}>
        A dash means not case-scoped — this case has no collected snapshot for that figure, which is
        a different fact from a measured zero. No score, index or percentage is derived here.
      </p>
    </div>
  );
}

function SummaryCell({
  label,
  icon: Icon,
  datum,
  testid,
}: {
  label: string;
  icon: typeof FileText;
  datum: Datum;
  testid: string;
}) {
  return (
    <div className="rounded border border-console-border bg-console-surface px-2 py-1.5" data-testid={testid}>
      <div className={`flex items-center gap-1 text-[9px] uppercase tracking-wider ${DIM}`}>
        <Icon className="size-2.5" />
        {label}
      </div>
      <div className="mt-0.5">
        {datum.kind === "COUNT" && (
          <span className="font-mono text-sm font-bold text-console-text" data-testid={`${testid}-value`}>
            {datum.value}
          </span>
        )}
        {datum.kind === "STATUS" && (
          <span
            className="font-mono text-[11px] font-bold uppercase text-console-text"
            title={datum.detail}
            data-testid={`${testid}-value`}
          >
            {datum.value}
          </span>
        )}
        {datum.kind === "PENDING" && <span className={`text-[11px] ${DIM}`}>…</span>}
        {datum.kind === "NOT_CASE_SCOPED" && (
          <span
            className="text-sm font-bold text-console-label/60"
            title={datum.reason}
            data-testid={`${testid}-notscoped`}
          >
            —
          </span>
        )}
      </div>
      {datum.kind === "COUNT" && datum.note && (
        <div className={`mt-0.5 text-[8px] leading-tight ${DIM}`}>{datum.note}</div>
      )}
      {datum.kind === "NOT_CASE_SCOPED" && (
        <div className="mt-0.5 text-[8px] uppercase tracking-wider text-console-label/60">not case-scoped</div>
      )}
    </div>
  );
}

function DisciplineChip({ section }: { section: DisciplineSection }) {
  const Icon = DISCIPLINE_ICON[section.discipline];
  const tone = DISCIPLINE_TONE[section.discipline];
  if (section.status === "PRESENT") {
    return (
      <Badge className={`h-5 gap-1 rounded border-console-border bg-console-surface px-1.5 text-[9px] ${tone}`}>
        <Icon className="size-2.5" />
        {section.discipline}
      </Badge>
    );
  }
  // ZERO and NOT_CASE_SCOPED are different facts and read differently — a
  // discipline evaluated with no records vs one whose output is not in this case.
  const muted = section.status === "NOT_CASE_SCOPED";
  return (
    <Badge
      className={`h-5 gap-1 rounded border-console-border bg-console-deep px-1.5 text-[9px] ${DIM}`}
      title={
        muted
          ? "The capability exists but its output is not part of this case. Different from zero."
          : "This case was evaluated for this discipline and holds no records."
      }
    >
      <Icon className="size-2.5 opacity-60" />
      {section.discipline}
      <span className="opacity-70">· {muted ? "not scoped" : "none"}</span>
    </Badge>
  );
}
