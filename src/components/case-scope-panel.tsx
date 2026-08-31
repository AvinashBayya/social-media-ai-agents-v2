import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { ShieldAlert, ShieldCheck, HelpCircle, Database } from "lucide-react";
import { getGraphForCase, type ScopedGraphSnapshot } from "@/utils/graph-store";
import { getTimelineForCase, type ScopedTimelineSnapshot } from "@/utils/timeline-store";
import { getEvidenceForCase } from "@/utils/evidence-store";
import { CASE_RUNS_CHANGED_EVENT } from "@/utils/cases/case-runs";
import { SCOPE_CAVEATS, storageReport, type CaseScopeResult } from "@/utils/cases/case-scope";
import type { Investigation } from "@/utils/investigations-store";

/**
 * Case data scope (2026-08-30, ported from the teammate's fork), rendered.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THIS PANEL EXISTS TO MAKE A MISMATCH IMPOSSIBLE TO MISS.
 *
 * The bug it closes was silent: run case A, run case B, open case A, and `/graph`
 * showed B's entities with nothing on screen saying so. Nothing errored. The
 * wrong data simply rendered, which is indistinguishable from the right answer.
 *
 * So every snapshot this case might display is resolved through
 * `assertSnapshotBelongsToCase` and reported as one of three states, in words:
 *
 *   MATCH     — belongs to this case. Safe to open.
 *   MISMATCH  — belongs to a DIFFERENT case, named. Shown as a warning, never
 *               as this case's data.
 *   UNSCOPED  — LEGACY, or produced outside a case (e.g. from Recon). Not
 *               adopted by this case.
 *
 * A UNSCOPED snapshot is deliberately NOT treated as this case's, even when it
 * is the only one present and the analyst is plainly looking at this case. The
 * currently-viewed case is not provenance.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * COLLECTED vs CASE EVIDENCE.
 *
 * Two counts, two labels, never summed. Collected evidence is what the run
 * observed; case evidence is what an analyst deliberately promoted. Showing one
 * number would erase the distinction the whole model rests on.
 */

const TONE: Record<CaseScopeResult, { label: string; cls: string; Icon: typeof ShieldCheck }> = {
  MATCH: {
    label: "This case",
    cls: "border-console-green/30 bg-console-green/10 text-console-green",
    Icon: ShieldCheck,
  },
  MISMATCH: {
    label: "Different case",
    cls: "border-console-red/30 bg-console-red/10 text-console-red",
    Icon: ShieldAlert,
  },
  UNSCOPED: {
    label: "Legacy / unscoped",
    cls: "border-console-amber/30 bg-console-amber/10 text-console-amber",
    Icon: HelpCircle,
  },
};

function ScopeRow({
  title,
  verdict,
  detail,
  summary,
  truncated,
}: {
  title: string;
  verdict: CaseScopeResult;
  detail: string;
  summary: string;
  truncated: string | null;
}) {
  const tone = TONE[verdict];
  const Icon = tone.Icon;
  return (
    <div className="space-y-1 border-b border-console-border/50 px-2 py-2 last:border-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] font-bold text-console-text">{title}</span>
        <Badge className={`h-4 rounded-none border px-1 text-[8px] uppercase ${tone.cls}`}>
          <Icon className="mr-0.5 size-2.5" />
          {tone.label}
        </Badge>
        <span className="text-[9px] text-console-muted">{summary}</span>
      </div>
      {/* The reason is always printed. An unexplained rejection is not actionable. */}
      <p className="text-[9px] leading-relaxed text-console-label">{detail}</p>
      {truncated && (
        <p className="text-[9px] leading-relaxed text-console-amber">{truncated}</p>
      )}
    </div>
  );
}

export function CaseScopePanel({ investigation }: { investigation: Investigation }) {
  const [graph, setGraph] = useState<ScopedGraphSnapshot | null>(null);
  const [timeline, setTimeline] = useState<ScopedTimelineSnapshot | null>(null);
  const [caseEvidence, setCaseEvidence] = useState(0);
  const [storage, setStorage] = useState<ReturnType<typeof storageReport> | null>(null);

  const refresh = useCallback(() => {
    setGraph(getGraphForCase(investigation.id));
    setTimeline(getTimelineForCase(investigation.id));
    setCaseEvidence(getEvidenceForCase(investigation.id).length);
    setStorage(storageReport());
  }, [investigation.id]);

  useEffect(() => {
    refresh();
    window.addEventListener(CASE_RUNS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(CASE_RUNS_CHANGED_EVENT, refresh);
  }, [refresh]);

  if (!graph || !timeline || !storage) return null;

  const graphSummary = graph.snapshot
    ? `${graph.snapshot.entities.length} entities · ${graph.snapshot.target}`
    : "no snapshot stored";
  const timelineSummary = timeline.snapshot
    ? `${timeline.snapshot.evidence.length} collected records · ${timeline.snapshot.target}`
    : "no snapshot stored";

  const truncNote = (t: { truncated: boolean; totalRecords: number; storedRecords: number } | undefined) =>
    t?.truncated
      ? `Capped for storage: showing ${t.storedRecords} of ${t.totalRecords} records. The run found more than are stored here.`
      : null;

  return (
    <div className="space-y-3 rounded border border-console-border bg-console-deep p-3 font-mono text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-console-cyan">
          <Database className="size-3" />
          Data scope for {investigation.id}
        </span>
        <span className="text-[9px] text-console-label">
          {Math.round(storage.totalBytes / 1024)} KB stored · {storage.percentOfQuota}% of quota ·{" "}
          {storage.scopedCases} scoped case{storage.scopedCases === 1 ? "" : "s"}
        </span>
      </div>

      <div className="rounded border border-console-border">
        <ScopeRow
          title="Graph snapshot"
          verdict={graph.verdict.result}
          detail={graph.verdict.detail}
          summary={graphSummary}
          truncated={truncNote(graph.snapshot?.truncation)}
        />
        <ScopeRow
          title="Timeline snapshot"
          verdict={timeline.verdict.result}
          detail={timeline.verdict.detail}
          summary={timelineSummary}
          truncated={truncNote(timeline.snapshot?.truncation)}
        />
      </div>

      {/* Two counts, two labels, never summed. A non-MATCH verdict means this
          case has no collected snapshot of its own — that is a different fact
          from a measured zero, so it renders as a dash, not "0". */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded border border-console-border bg-console-surface px-2 py-1.5 text-[9px]">
        <span className="text-console-blue" title={timeline.verdict.result !== "MATCH" ? timeline.verdict.detail : undefined}>
          Collected evidence:{" "}
          {timeline.verdict.result === "MATCH" ? timeline.snapshot!.evidence.length : "— (not scoped)"}
        </span>
        <span className="text-console-purple">
          Case evidence: {investigation.evidence.length}
          {caseEvidence > 0 && ` (+${caseEvidence} vault-linked)`}
        </span>
        <span className="basis-full text-console-label">
          Collected evidence is what this case's runs observed. Case evidence is what an analyst
          promoted into the case. They are different things and are never added together.
        </span>
      </div>

      <div className="space-y-0.5 border-t border-console-border/40 pt-2">
        {SCOPE_CAVEATS.map((c) => (
          <p key={c} className="text-[9px] leading-relaxed text-console-label">
            {c}
          </p>
        ))}
      </div>
    </div>
  );
}
