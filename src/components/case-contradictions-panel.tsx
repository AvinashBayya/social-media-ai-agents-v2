import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, ExternalLink, GitCompareArrows, Network, Newspaper } from "lucide-react";
import { getGraphForCase } from "@/utils/graph-store";
import { getTimelineForCase } from "@/utils/timeline-store";
import { CASE_RUNS_CHANGED_EVENT } from "@/utils/cases/case-runs";
import { resolvedCaseEntities } from "@/utils/cases/case-entities";
import {
  NO_ADJUDICATION_CAVEAT,
  buildCaseContradictions,
  summariseCaseContradictions,
  type CaseClaimConflict,
  type CaseContradictionReport,
  type CaseInfraContradiction,
} from "@/utils/cases/case-contradictions";
import type { MediaClaim } from "@/utils/mediaint/claims";
import type { Investigation } from "@/utils/investigations-store";

/**
 * Contradictions in the case workflow (2026-08-30, ported from the teammate's
 * fork).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE ONE RULE THIS PANEL EXISTS TO ENFORCE.
 *
 * **The system has not decided which claim is true, and the page says so in
 * those words.** Every conflict block carries the caveat verbatim; there is no
 * "confirmed", no "resolved", no winner, no strike-through on the losing claim.
 * Both records are shown at equal weight, with their own publishers, dates,
 * claim classes and confidence, because that is the analyst's judgement to make.
 *
 * The engines cooperate: `warrants-review` is the ONLY status either type
 * permits. This panel reads it off the record rather than hardcoding it, so
 * widening that vocabulary upstream would surface here instead of being absorbed.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * IT RENDERS `ClaimConflict`, NOT `toContradiction()`.
 *
 * That projection has no field for claim class, confidence or evidence ref, and
 * all three are required on screen. `claim-conflicts.ts` says the same of its
 * own projection — offered alongside, never as a replacement.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * NOTHING WITHOUT TRACEABLE EVIDENCE IS DISPLAYED.
 *
 * `buildCaseContradictions` withholds any conflict whose claims cannot be traced
 * back to an evidence record, and *counts* what it withheld. This panel prints
 * that count: "we found nothing" and "we found something we will not show you"
 * are different statements, and collapsing them would be the quiet kind of lie.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * DERIVED FROM THE CASE'S OWN SNAPSHOTS — no new store.
 *
 * Both inputs are already case-scoped and validated. If the verdict is not
 * MATCH the panel says why rather than deriving contradictions from another
 * case's data, exactly as `/graph` and `/timeline` do.
 */

const DIM = "text-console-label";
const MAX_RENDERED = 25;

/** One claim, with every field the brief requires and a link back to its evidence. */
function ClaimCard({
  claim,
  role,
  evidenceRef,
}: {
  claim: MediaClaim;
  role: "ASSERTS" | "DENIES";
  evidenceRef: string | null;
}) {
  const asserts = role === "ASSERTS";
  return (
    <div
      className={`space-y-1 rounded border p-2 ${
        asserts ? "border-console-green/30 bg-console-green/5" : "border-console-red/30 bg-console-red/5"
      }`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge
          className={`h-4 rounded-none px-1 text-[8px] uppercase ${
            asserts
              ? "border-console-green/40 bg-console-green/10 text-console-green"
              : "border-console-red/40 bg-console-red/10 text-console-red"
          }`}
        >
          {role}
        </Badge>
        {/* The class badge is never optional — it is what stops a reported claim
            reading as a verified one. REPORTED and OFFICIAL_STATEMENT are both
            statements; neither is an observed fact. */}
        <Badge
          className={`h-4 rounded-none px-1 text-[8px] uppercase ${
            claim.claimClass === "OFFICIAL_STATEMENT"
              ? "border-console-purple/30 bg-console-purple/10 text-console-purple"
              : "border-console-amber/30 bg-console-amber/10 text-console-amber"
          }`}
        >
          {claim.claimClass}
        </Badge>
        {claim.syndicated && (
          <Badge className="h-4 rounded-none border-console-label/30 bg-console-label/10 px-1 text-[8px] text-console-muted">
            syndicated
          </Badge>
        )}
        {claim.independentSources > 1 && (
          <Badge className="h-4 rounded-none border-console-green/30 bg-console-green/10 px-1 text-[8px] text-console-green">
            {claim.independentSources} independent
          </Badge>
        )}
        <span className={`text-[9px] ${DIM}`}>
          {/* null is "not measured", never rendered as 0% — see the confidence rule. */}
          {claim.confidence.value === null
            ? "confidence not measured"
            : `confidence ${Math.round(claim.confidence.value * 100)}%`}
        </span>
      </div>

      <p className="text-[10px] leading-relaxed text-console-text">
        {claim.attributedTo && <span className="text-console-purple">{claim.attributedTo}: </span>}
        “{claim.claimText}”
      </p>

      <div className={`flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[9px] ${DIM}`}>
        <span>
          Source: <span className="text-console-muted">{claim.publisher ?? claim.source}</span>
        </span>
        <span>
          {/* An absent date stays absent. Never back-filled to now. */}
          {claim.publishedAt
            ? `Published ${claim.publishedAt.slice(0, 10)}`
            : "No publication date reported"}
        </span>
        {claim.sourceUrl && (
          <a
            href={claim.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 text-console-blue hover:underline"
          >
            Original source <ExternalLink className="size-2.5" />
          </a>
        )}
        {/* The navigation path ends at a real evidence id. */}
        <span>
          Evidence:{" "}
          <a
            href={`/vault?q=${encodeURIComponent(evidenceRef ?? "")}`}
            className="font-bold text-console-cyan hover:underline"
          >
            {evidenceRef}
          </a>
        </span>
        <span>Claim id: {claim.claimId}</span>
      </div>
    </div>
  );
}

function MediaConflictBlock({ item }: { item: CaseClaimConflict }) {
  const c = item.conflict;
  return (
    <div className="space-y-2 rounded border border-console-red/30 bg-console-deep p-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[10px] font-bold text-console-text">
          <Newspaper className="size-3 text-console-red" />
          {c.kind}
        </span>
        <span className={`text-[9px] ${DIM}`}>
          {/* Read off the record, not hardcoded. */}
          Status: <span className="uppercase text-console-amber">{c.status}</span>
        </span>
      </div>

      {/* The caveat is inside every block, not once at the top of the page. A
          reader who scrolls to one conflict must see it. */}
      <p className="rounded border border-console-amber/30 bg-console-amber/5 px-2 py-1 text-[9px] leading-relaxed text-console-amber">
        {NO_ADJUDICATION_CAVEAT}
      </p>

      <ClaimCard claim={c.assertion} role="ASSERTS" evidenceRef={item.evidenceRefs[0]} />
      <ClaimCard claim={c.denial} role="DENIES" evidenceRef={item.evidenceRefs[1]} />

      <div className="space-y-0.5 border-t border-console-border/40 pt-1.5">
        <p className={`text-[9px] leading-relaxed ${DIM}`}>
          <span className="font-bold text-console-muted">Possible explanation (hypothesis):</span>{" "}
          {c.possibleExplanation.text}
        </p>
        <p className={`text-[9px] leading-relaxed ${DIM}`}>Basis: {c.possibleExplanation.basis}</p>
        {(c.assertion.subject || c.denial.subject) && (
          <p className={`text-[9px] ${DIM}`}>
            Related entities:{" "}
            <span className="text-console-muted">
              {[...new Set([c.assertion.subject, c.assertion.object, c.denial.subject, c.denial.object].filter(Boolean))].join(" · ")}
            </span>
          </p>
        )}
        <p className={`text-[9px] ${DIM}`}>
          Case {item.provenance.caseId}
          {item.provenance.runId && ` · run ${item.provenance.runId}`} ·{" "}
          {item.provenance.investigationId}
        </p>
      </div>
    </div>
  );
}

function InfraContradictionBlock({ item }: { item: CaseInfraContradiction }) {
  const c = item.contradiction;
  return (
    <div className="space-y-1.5 rounded border border-console-amber/30 bg-console-deep p-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[10px] font-bold text-console-text">
          <Network className="size-3 text-console-amber" />
          {c.entity} — {c.relationshipType}
        </span>
        <span className={`text-[9px] ${DIM}`}>
          Status: <span className="uppercase text-console-amber">{c.status}</span>
        </span>
      </div>

      <p className="rounded border border-console-amber/30 bg-console-amber/5 px-2 py-1 text-[9px] leading-relaxed text-console-amber">
        {NO_ADJUDICATION_CAVEAT}
      </p>

      {[c.claimA, c.claimB].map((claim, i) => (
        <div
          key={`${claim.source}-${i}`}
          className="rounded border border-console-border bg-console-surface p-1.5 text-[9px]"
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge className="h-4 rounded-none border-console-blue/30 bg-console-blue/10 px-1 text-[8px] uppercase text-console-blue">
              {claim.source}
            </Badge>
            {/* Collector relationships are OBSERVED — read directly from the
                named source. That is a different claim class from a media
                claim, and the difference is shown rather than blurred. */}
            <Badge className="h-4 rounded-none border-console-green/30 bg-console-green/10 px-1 text-[8px] uppercase text-console-green">
              OBSERVED
            </Badge>
            <span className={DIM}>
              {claim.observedAt
                ? `observed ${claim.observedAt.slice(0, 10)}`
                : "collection time unknown"}
            </span>
          </div>
          <p className="mt-0.5 text-console-muted">{claim.values.join(", ")}</p>
        </div>
      ))}

      <div className="space-y-0.5 border-t border-console-border/40 pt-1.5">
        <p className={`text-[9px] leading-relaxed ${DIM}`}>
          <span className="font-bold text-console-muted">Possible explanation (hypothesis):</span>{" "}
          {c.possibleExplanation.text}
        </p>
        <p className={`text-[9px] leading-relaxed ${DIM}`}>Basis: {c.possibleExplanation.basis}</p>
        <p className={`text-[9px] ${DIM}`}>
          Case {item.provenance.caseId}
          {item.provenance.runId && ` · run ${item.provenance.runId}`} ·{" "}
          {item.provenance.investigationId}
        </p>
      </div>
    </div>
  );
}

export function CaseContradictionsPanel({ investigation }: { investigation: Investigation }) {
  const [report, setReport] = useState<CaseContradictionReport | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);

  const refresh = useCallback(() => {
    const graph = getGraphForCase(investigation.id);
    const timeline = getTimelineForCase(investigation.id);

    // Only this case's own snapshots. A MISMATCH or UNSCOPED verdict means the
    // data belongs elsewhere, and deriving contradictions from it would be
    // cross-case contamination — with the extra hazard that the output would
    // look like a finding about THIS case.
    const graphOk = graph.verdict.result === "MATCH" && graph.snapshot;
    const timelineOk = timeline.verdict.result === "MATCH" && timeline.snapshot;
    if (!graphOk && !timelineOk) {
      setReport(null);
      setBlocked(
        timeline.verdict.result === "MATCH" || graph.verdict.result === "MATCH"
          ? null
          : "No run data is stored for this case, so there is nothing to compare. Contradictions are derived from this case's own graph and timeline snapshots — never from another case's.",
      );
      return;
    }

    setBlocked(null);
    const snap = timelineOk ? timeline.snapshot! : null;
    // Resolve entities/relationships together (ids rewritten, edge endpoints
    // remapped) so infra-contradiction keying matches the summary, report and
    // agent-context surfaces. Passing the raw per-collector relationships keys
    // detection by unmerged ids and makes this panel under-detect versus those
    // siblings. `case-summary-panel.tsx` resolves identically before calling
    // buildCaseContradictions.
    const resolvedRelationships = graphOk
      ? resolvedCaseEntities({
          entities: graph.snapshot!.entities,
          relationships: graph.snapshot!.relationships,
        }).relationships
      : [];
    setReport(
      buildCaseContradictions({
        caseId: investigation.id,
        // The snapshot's own provenance is authoritative — not the selected case.
        runId: (timelineOk ? timeline.snapshot!.runId : graph.snapshot!.runId) ?? null,
        investigationId:
          (timelineOk ? timeline.snapshot!.investigationId : graph.snapshot!.investigationId) ?? "",
        snapshotSavedAt:
          (timelineOk ? timeline.snapshot!.savedAt : graph.snapshot!.savedAt) ?? "",
        evidence: snap?.evidence ?? [],
        relationships: resolvedRelationships,
        // Injected here because the extractor must never read a clock itself.
        extractedAt: new Date().toISOString(),
      }),
    );
  }, [investigation.id]);

  useEffect(() => {
    refresh();
    window.addEventListener(CASE_RUNS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(CASE_RUNS_CHANGED_EVENT, refresh);
  }, [refresh]);

  const summary = useMemo(() => (report ? summariseCaseContradictions(report) : null), [report]);

  if (blocked) {
    return (
      <div className="rounded border border-console-border bg-console-deep p-3 font-mono text-xs">
        <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-console-cyan">
          <GitCompareArrows className="size-3" />
          Contradictions — {investigation.id}
        </span>
        <p className={`mt-1.5 text-[10px] leading-relaxed ${DIM}`}>{blocked}</p>
      </div>
    );
  }

  if (!report || !summary) return null;

  const items = [...report.media, ...report.infrastructure];

  return (
    <div className="space-y-3 rounded border border-console-border bg-console-deep p-3 font-mono text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-console-cyan">
          <GitCompareArrows className="size-3" />
          Contradictions — {investigation.id} ({summary.total})
        </span>
        <span className={`text-[9px] ${DIM}`}>
          {summary.media} media · {summary.infrastructure} infrastructure ·{" "}
          {summary.subjectsAffected} subjects affected
        </span>
      </div>

      {/* A zero over zero claims means something different from a zero over 200. */}
      <p className={`text-[9px] leading-relaxed ${DIM}`}>
        Compared {report.claimsExamined} claims from {report.articlesExamined} articles and{" "}
        {report.relationshipsExamined} relationships across {report.collectorsCompared} collectors.
      </p>

      {report.withheldUntraceable > 0 && (
        // Withholding is stated. "Found nothing" and "found something we will not
        // show you" are different, and collapsing them would be a quiet lie.
        <p className="flex items-start gap-1.5 rounded border border-console-amber/30 bg-console-amber/5 px-2 py-1 text-[9px] leading-relaxed text-console-amber">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          {report.withheldUntraceable} conflict
          {report.withheldUntraceable === 1 ? " was" : "s were"} detected but not shown, because
          the underlying evidence could not be traced. A contradiction an analyst cannot verify is
          not displayed as a finding.
        </p>
      )}

      {items.length === 0 ? (
        <p className={`text-[10px] leading-relaxed ${DIM}`}>
          No contradictions detected in this case's collected data.{" "}
          <span className="text-console-amber">
            Absence of a flagged contradiction is not evidence that the sources agree
          </span>{" "}
          — see the limitations below.
        </p>
      ) : (
        <div className="max-h-[32rem] space-y-2 overflow-y-auto">
          {report.media.slice(0, MAX_RENDERED).map((m) => (
            <MediaConflictBlock key={`${m.claimIds[0]}-${m.claimIds[1]}`} item={m} />
          ))}
          {report.infrastructure.slice(0, MAX_RENDERED).map((i) => (
            <InfraContradictionBlock
              key={`${i.contradiction.entity}-${i.contradiction.relationshipType}-${i.contradiction.claimA.source}-${i.contradiction.claimB.source}`}
              item={i}
            />
          ))}
        </div>
      )}

      <div className="space-y-0.5 border-t border-console-border/40 pt-2">
        {/* Both engines' own limitation lists, verbatim. A detector whose blind
            spots are undocumented gets read as exhaustive. */}
        {report.limitations.map((l) => (
          <p key={l} className={`text-[9px] leading-relaxed ${DIM}`}>
            {l}
          </p>
        ))}
      </div>
    </div>
  );
}
