import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, ExternalLink, Newspaper } from "lucide-react";
import { getTimelineForCase } from "@/utils/timeline-store";
import { CASE_RUNS_CHANGED_EVENT } from "@/utils/cases/case-runs";
import {
  MEDIAINT_NOT_CASE_SCOPED,
  NO_CLAIMS_MESSAGE,
  caseMediaClaims,
  claimsHeadline,
  isConflicted,
  type CaseClaims,
} from "@/utils/cases/case-claims";
import { NO_ADJUDICATION_CAVEAT } from "@/utils/cases/case-contradictions";
import type { MediaClaim } from "@/utils/mediaint/claims";
import type { Investigation } from "@/utils/investigations-store";

/**
 * MEDIAINT claims in the case workspace (2026-08-30, ported from the
 * teammate's fork).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT WAS MISSING, AND WHY IT MATTERED.
 *
 * The claims themselves were never on screen anywhere in the case workspace —
 * only a COUNT in the discipline breakdown and, where two publishers
 * disagreed, a conflict block. So a case could hold forty attributed claims and
 * an analyst could read the whole workspace without seeing one of them, or the
 * class it carried.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * A CLAIM IS WHAT SOMEBODY SAID. THE PANEL NEVER LETS IT READ OTHERWISE.
 *
 *   - Every row carries its class badge — REPORTED or OFFICIAL_STATEMENT. Both
 *     are statements. **Neither is an observed fact**, and there is no code path
 *     here that produces `OBSERVED`: the class is read off the record.
 *   - A DENIAL is badged as one. Rendered without it, "X denied Y" reads as an
 *     assertion of Y.
 *   - Confidence renders as "not measured" when null, never as 0%.
 *   - Publication date renders as "date not reported" when absent, never as today.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * CONFLICTS ARE MARKED ON BOTH SIDES AND ADJUDICATED ON NEITHER.
 *
 * A conflicted claim shows the marker and `NO_ADJUDICATION_CAVEAT` verbatim.
 * Both sides of a disagreement carry the same marker — marking one would read as
 * that one being the disputed version. There is no winner, no ordering by
 * credibility and no strike-through. The full both-sides rendering lives in the
 * existing contradictions panel; this points at it rather than duplicating it.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ONE ACCESSOR, THE CASE'S OWN SNAPSHOT, NO FALLBACK.
 *
 * `caseMediaClaims` is the single case-level projection — the same one the
 * grounded agent context and the case report read, so a claim cannot appear here
 * and be missing from the report of the same snapshot. The timeline snapshot is
 * gated on a MATCH verdict first: a MISMATCH or UNSCOPED verdict means the data
 * belongs elsewhere, and it is refused rather than displayed. Nothing is stored.
 */

const DIM = "text-console-label";
const MAX_RENDERED = 30;

function ClaimRow({ claim, conflicted }: { claim: MediaClaim; conflicted: boolean }) {
  return (
    <div
      data-testid="mediaint-claim"
      className={`space-y-1 rounded border p-2 ${
        conflicted ? "border-console-amber/40 bg-console-amber/5" : "border-console-border bg-console-surface"
      }`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {/* The class badge is never optional — it is what stops a reported claim
            reading as a verified one. */}
        <Badge
          data-testid="mediaint-claim-class"
          className={`h-4 rounded-none px-1 text-[8px] uppercase ${
            claim.claimClass === "OFFICIAL_STATEMENT"
              ? "border-console-purple/30 bg-console-purple/10 text-console-purple"
              : "border-console-amber/30 bg-console-amber/10 text-console-amber"
          }`}
        >
          {claim.claimClass}
        </Badge>

        {/* Without this, "X denied Y" reads as an assertion of Y. */}
        {claim.polarity === "deny" && (
          <Badge className="h-4 rounded-none border-console-red/40 bg-console-red/10 px-1 text-[8px] uppercase text-console-red">
            denial
          </Badge>
        )}

        {conflicted && (
          <Badge
            data-testid="mediaint-conflict-marker"
            className="h-4 rounded-none border-console-amber/40 bg-console-amber/10 px-1 text-[8px] uppercase text-console-amber"
          >
            conflicting
          </Badge>
        )}

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
          {/* null is NOT MEASURED. Never rendered as 0%. */}
          {claim.confidence.value === null
            ? "confidence not measured"
            : `confidence ${Math.round(claim.confidence.value * 100)}%`}
        </span>
      </div>

      <p className="text-[10px] leading-relaxed text-console-text">
        {claim.attributedTo && <span className="text-console-purple">{claim.attributedTo}: </span>}
        “{claim.claimText}”
      </p>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[9px]">
        <span className={DIM}>
          {claim.source}
          {claim.publisher && claim.publisher !== claim.source && ` (${claim.publisher})`}
        </span>
        <span className={DIM}>
          {/* An absent date stays absent. Stamping "now" onto an undated record is
              the exact fabrication this project greps for. */}
          {claim.publishedAt ?? "date not reported"}
        </span>
        {claim.sourceUrl ? (
          <a
            href={claim.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="mediaint-source-link"
            className="flex items-center gap-0.5 text-console-blue hover:underline"
          >
            source <ExternalLink className="size-2.5" />
          </a>
        ) : (
          <span className={DIM}>no URL reported</span>
        )}
        {/* Evidence ids are never minted. A claim whose article carried none says
            so rather than pointing at something that does not exist. */}
        {claim.evidenceRef ? (
          <a
            href={`/vault?q=${encodeURIComponent(claim.evidenceRef)}`}
            data-testid="mediaint-evidence-ref"
            className="font-mono text-[8px] text-console-blue hover:underline"
          >
            {claim.evidenceRef}
          </a>
        ) : (
          <span className={`font-mono text-[8px] ${DIM}`}>no evidence reference recorded</span>
        )}
      </div>
    </div>
  );
}

export function CaseMediaIntPanel({ investigation }: { investigation: Investigation }) {
  const [result, setResult] = useState<CaseClaims | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);

  const refresh = useCallback(() => {
    const timeline = getTimelineForCase(investigation.id);
    // Scope rules, unchanged. `getTimelineForCase` falls back to the UNSCOPED
    // slot by design so legacy data stays visible with a verdict saying so —
    // which is why the verdict, not the snapshot, is what gates here.
    const ok = timeline.verdict.result === "MATCH" && timeline.snapshot;
    if (!ok) {
      setResult(null);
      setBlocked(MEDIAINT_NOT_CASE_SCOPED);
      return;
    }
    setBlocked(null);
    setResult(
      caseMediaClaims({
        caseId: investigation.id,
        evidence: timeline.snapshot!.evidence,
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

  const header = (
    <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-console-amber">
      <Newspaper className="size-3" />
      MEDIAINT claims — {investigation.id}
      {result && ` (${result.claims.length})`}
    </span>
  );

  if (blocked) {
    return (
      <div
        data-testid="mediaint-blocked"
        className="rounded border border-console-border bg-console-deep p-3 font-mono text-xs"
      >
        {header}
        <p className={`mt-1.5 text-[10px] leading-relaxed ${DIM}`}>{blocked}</p>
      </div>
    );
  }

  if (!result) return null;

  const shown = result.claims.slice(0, MAX_RENDERED);

  return (
    <div
      data-testid="mediaint-panel"
      className="space-y-2 rounded border border-console-border bg-console-deep p-3 font-mono text-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        {header}
        <span className={`text-[9px] ${DIM}`}>
          {result.articlesExamined} article{result.articlesExamined === 1 ? "" : "s"} examined
        </span>
      </div>

      <p className={`text-[9px] leading-relaxed ${DIM}`}>{claimsHeadline(result)}</p>

      {/* The caveat sits ABOVE the rows. A list under a heading reads as
          findings, and these are statements somebody made. */}
      <p
        data-testid="mediaint-claims-caveat"
        className="rounded border border-console-amber/30 bg-console-amber/5 px-2 py-1 text-[9px] leading-relaxed text-console-amber"
      >
        Every item below is a claim a publisher made. None is a finding of this system and none has
        been verified.
      </p>

      {result.conflicts.length > 0 && (
        <p
          data-testid="mediaint-no-adjudication"
          className="flex items-start gap-1.5 rounded border border-console-amber/30 bg-console-amber/5 px-2 py-1 text-[9px] leading-relaxed text-console-amber"
        >
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          <span>
            {NO_ADJUDICATION_CAVEAT} Both sides are marked below and shown in full in the
            Contradictions panel.
          </span>
        </p>
      )}

      {result.claims.length === 0 ? (
        <p className={`text-[10px] leading-relaxed ${DIM}`}>{NO_CLAIMS_MESSAGE}</p>
      ) : (
        <div className="space-y-1.5">
          {shown.map((c) => (
            <ClaimRow key={c.claimId} claim={c} conflicted={isConflicted(result, c.claimId)} />
          ))}
        </div>
      )}

      {result.claims.length > MAX_RENDERED && (
        <p className={`text-[9px] ${DIM}`}>
          Showing {MAX_RENDERED} of {result.claims.length}. The rest are held in the case, not
          discarded — this is a display cap.
        </p>
      )}

      <div className="space-y-0.5 border-t border-console-border/40 pt-1.5">
        {result.caveats.map((c) => (
          <p key={c} className={`text-[9px] leading-relaxed ${DIM}`}>
            {c}
          </p>
        ))}
      </div>
    </div>
  );
}
