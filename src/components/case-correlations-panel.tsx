import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Link2 } from "lucide-react";
import { getGraphForCase } from "@/utils/graph-store";
import { getTimelineForCase } from "@/utils/timeline-store";
import { CASE_RUNS_CHANGED_EVENT } from "@/utils/cases/case-runs";
import { GEOINT_DISCIPLINE_ROW } from "@/utils/cases/case-geoint";
import { capabilityReport, type CapabilityReport } from "@/utils/collectors/capability-report";
import { resolvedCaseEntities } from "@/utils/cases/case-entities";
import {
  CORRELATION_NOT_A_FINDING,
  NO_CORRELATIONS_MESSAGE,
  buildCrossIntelligence,
  summariseCrossIntelligence,
  type CrossIntelligenceCorrelation,
  type CrossIntelligenceReport,
} from "@/utils/cases/cross-intelligence";
import type { Investigation } from "@/utils/investigations-store";

/**
 * Cross-intelligence correlations for one case (2026-08-30, ported from the
 * teammate's fork), rendered.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE HEADLINE IS A DISCLAIMER, NOT A TITLE.
 *
 * A list of rows under a heading reads as findings. `CORRELATION_NOT_A_FINDING`
 * therefore prints ABOVE the first row, not as a footnote — because the one way
 * this feature could do harm is by an analyst reading "SOCMINT + TECHINT:
 * username ↔ domain" as "this person owns that domain".
 *
 * Every row carries its own limitations for the same reason, and a HYPOTHESIS
 * correlation is coloured and labelled apart from a CORRELATED one.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * MINIMUM SURFACE, DELIBERATELY.
 *
 * This panel mounts beside the existing case panels, reuses their prop/refresh
 * pattern exactly, and adds no new navigation, no filtering and no interaction
 * beyond the evidence links.
 */

const DIM = "text-console-label";

const TYPE_TONE: Record<string, string> = {
  ENTITY_CORRELATION: "border-console-cyan/30 bg-console-cyan/10 text-console-cyan",
  INFRASTRUCTURE_CORRELATION: "border-console-cyan/30 bg-console-cyan/10 text-console-cyan",
  MEDIA_ENTITY_CORRELATION: "border-console-amber/30 bg-console-amber/10 text-console-amber",
  GEO_CORRELATION: "border-console-green/30 bg-console-green/10 text-console-green",
  IDENTITY_CANDIDATE_CORRELATION: "border-console-purple/30 bg-console-purple/10 text-console-purple",
  SOURCE_CORRELATION: "border-console-label/30 bg-console-label/10 text-console-muted",
};

function CorrelationRow({ c }: { c: CrossIntelligenceCorrelation }) {
  const hypothesis = c.claimClass === "HYPOTHESIS";
  return (
    <div className="space-y-1 border-b border-console-border/50 px-2 py-2 last:border-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge className={`h-4 rounded-none border px-1 text-[8px] uppercase ${TYPE_TONE[c.type] ?? TYPE_TONE.SOURCE_CORRELATION}`}>
          {c.type.replace(/_CORRELATION$/, "").replace(/_/g, " ")}
        </Badge>
        <span className="font-mono text-[9px] font-bold text-console-text">
          {c.disciplines.join(" ↔ ")}
        </span>
        {/* A hypothesis is coloured and named apart. It must never sit in the
            same visual bucket as an observed relationship. */}
        <Badge
          className={`h-4 rounded-none border px-1 text-[8px] uppercase ${
            hypothesis
              ? "border-console-amber/30 bg-console-amber/10 text-console-amber"
              : "border-console-blue/30 bg-console-blue/10 text-console-blue"
          }`}
        >
          {c.claimClass}
        </Badge>
        <span className={`font-mono text-[9px] ${DIM}`}>
          {c.confidence.value === null
            ? "confidence not measured"
            : `confidence ${c.confidence.value}`}
        </span>
      </div>

      {c.relationship && (
        <p className={`font-mono text-[9px] ${DIM}`}>
          {c.relationship.from} — {c.relationship.type} → {c.relationship.to} · asserted by{" "}
          {c.relationship.assertedBy}
        </p>
      )}

      <p className="text-[10px] leading-relaxed text-console-muted">{c.explanation}</p>

      <div className="flex flex-wrap items-center gap-1.5 font-mono text-[9px]">
        <span className={DIM}>Evidence:</span>
        {c.evidenceRefs.length === 0 ? (
          <span className="text-console-amber">
            none — the asserting collector stored no identified records in this case
          </span>
        ) : (
          c.evidenceRefs.map((ref) => (
            <a
              key={ref}
              href={`/vault?q=${encodeURIComponent(ref)}`}
              className="text-console-cyan underline"
            >
              [{ref}]
            </a>
          ))
        )}
      </div>

      {c.sourceUrls.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 font-mono text-[9px]">
          <span className={DIM}>Sources:</span>
          {c.sourceUrls.slice(0, 4).map((u) => (
            <a
              key={u}
              href={u}
              target="_blank"
              rel="noopener noreferrer"
              className="text-console-blue underline"
            >
              {u}
            </a>
          ))}
        </div>
      )}

      {c.limitations.map((l) => (
        <p key={l} className={`text-[9px] leading-relaxed ${DIM}`}>
          {l}
        </p>
      ))}
    </div>
  );
}

export function CaseCorrelationsPanel({ investigation }: { investigation: Investigation }) {
  const [report, setReport] = useState<CrossIntelligenceReport | null>(null);
  const [rows, setRows] = useState<CapabilityReport["rows"] | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = (await capabilityReport()) as unknown as CapabilityReport;
        if (!cancelled) setRows(r.rows);
      } catch {
        // Without the matrix no discipline can be established, so NO correlation
        // is emitted. Reported below rather than guessed at.
        if (!cancelled) setRows([]);
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
    // Scope rules, unchanged. Correlating another case's snapshot would
    // attribute its relationships to this case, with citations that look valid.
    const graphOk = graph.verdict.result === "MATCH" && graph.snapshot;
    const timelineOk = timeline.verdict.result === "MATCH" && timeline.snapshot;

    if (!graphOk && !timelineOk) {
      setBlocked(
        "No collected data is stored for this case, so there is nothing to correlate. Nothing is substituted, and no other case's data is used.",
      );
      setReport(null);
      return;
    }
    setBlocked(null);

    // Resolved identities — entities and relationships together.
    const resolved = resolvedCaseEntities({
      entities: graphOk ? graph.snapshot!.entities : [],
      relationships: graphOk ? graph.snapshot!.relationships : [],
    });

    setReport(
      buildCrossIntelligence({
        caseId: investigation.id,
        entities: resolved.entities,
        relationships: resolved.relationships,
        evidence: timelineOk ? timeline.snapshot!.evidence : [],
        // See the note in case-intelligence-breakdown.tsx. Without this row a
        // GEOINT edge has only one known discipline and the correlation engine
        // correctly excludes it, so an attached image would produce no
        // GEO_CORRELATION at all.
        capabilityRows: [...rows, GEOINT_DISCIPLINE_ROW],
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
      <Link2 className="size-3" />
      Cross-intelligence — {investigation.id}
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

  if (!report) return null;
  const summary = summariseCrossIntelligence(report);

  return (
    <div className="space-y-3 rounded border border-console-border bg-console-deep p-3 font-mono text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {header}
        <span className={`text-[9px] ${DIM}`}>
          {summary.total} correlation{summary.total === 1 ? "" : "s"}
          {summary.pairs.length > 0 && ` · ${summary.pairs.join(", ")}`}
          {summary.hypotheses > 0 && ` · ${summary.hypotheses} hypothesis`}
        </span>
      </div>

      {/* The disclaimer sits ABOVE the rows. A list under a heading reads as
          findings, and that is the one way this could do harm. */}
      <p className="rounded border border-console-amber/30 bg-console-amber/5 px-2 py-1.5 text-[9px] leading-relaxed text-console-amber">
        {CORRELATION_NOT_A_FINDING}
      </p>

      {rows.length === 0 && (
        <p className="rounded border border-console-red/30 bg-console-red/5 px-2 py-1 text-[9px] leading-relaxed text-console-red">
          The collector capability matrix could not be read. Disciplines are declared by collectors,
          so without it no cross-discipline correlation can be established — none is shown rather
          than guessed.
        </p>
      )}

      {report.correlations.length === 0 ? (
        <p className={`text-[10px] leading-relaxed ${DIM}`}>{NO_CORRELATIONS_MESSAGE}</p>
      ) : (
        <div className="rounded border border-console-border">
          {report.correlations.map((c) => (
            <CorrelationRow key={c.id} c={c} />
          ))}
        </div>
      )}

      {/* "Examined and excluded" is as informative as what was found. */}
      <p className={`text-[9px] leading-relaxed ${DIM}`}>
        {report.singleDisciplineRelationships} relationship
        {report.singleDisciplineRelationships === 1 ? "" : "s"} involved only one discipline and are
        ordinary relationships, not cross-intelligence. {report.unclassifiedRelationships} had no
        correlation meaning in this vocabulary.
      </p>

      <div className="space-y-0.5 border-t border-console-border/40 pt-2">
        {report.caveats.map((c) => (
          <p key={c} className={`text-[9px] leading-relaxed ${DIM}`}>
            {c}
          </p>
        ))}
        {report.notImplemented.map((n) => (
          <p key={n} className={`text-[9px] leading-relaxed ${DIM}`}>
            Not derived — {n}
          </p>
        ))}
      </div>
    </div>
  );
}
