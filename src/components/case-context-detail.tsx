import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Badge } from "@/components/ui/badge";
import {
  Quote,
  GitCompare,
  Link2,
  Clock,
  FileText,
  FolderOpen,
  Network,
  AlertTriangle,
} from "lucide-react";
import type { CaseContext } from "@/utils/cases/case-context";

/**
 * Case context detail (2026-08-30, ported from the teammate's fork),
 * `/agents` CASE-mode exposure.
 *
 * The grounded capability already BUILDS a `CaseContext` (claims, contradictions,
 * correlations, timeline, evidence, limitations) and until now the page showed
 * only counts of it. This renders that same object as compact, collapsed detail
 * sections — nothing is recomputed, no second extractor or engine is created. It
 * receives the context the page already holds and reads fields off it.
 *
 * HONESTY: the context is the GROUNDED model's view, which `buildCaseContext`
 * caps for prompt size. `context.truncated` says how many records were dropped,
 * and that is surfaced — the detail is a capped subset, never presented as the
 * whole case. A section with 0 rows is a measured zero over a real snapshot
 * (the context only exists when the case's snapshot verdict was MATCH); a case
 * with no scoped snapshot never reaches this component — its caller shows the
 * NOT_CASE_SCOPED blocker instead.
 */

const DIM = "text-console-label";

function Section({
  icon: Icon,
  label,
  count,
  testid,
  children,
}: {
  icon: typeof Quote;
  label: string;
  count: number;
  testid: string;
  children: ReactNode;
}) {
  return (
    <details className="rounded border border-console-border bg-console-deep" data-testid={testid}>
      <summary className="flex cursor-pointer items-center gap-1.5 px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider text-console-muted">
        <Icon className="size-3 text-console-cyan" />
        {label}
        <span className="ml-1 font-mono text-console-text" data-testid={`${testid}-count`}>
          {count}
        </span>
      </summary>
      <div className="space-y-1.5 border-t border-console-border/50 p-2">
        {count === 0 ? (
          <p className={`text-[9px] leading-relaxed ${DIM}`}>
            None in this case's collected evidence. A measured zero over the stored snapshot — not
            unmeasured.
          </p>
        ) : (
          children
        )}
      </div>
    </details>
  );
}

function ClassBadge({ value }: { value: string | null }) {
  if (!value) return null;
  const tone =
    value === "OBSERVED"
      ? "border-console-green/40 bg-console-green/10 text-console-green"
      : value === "INFERRED" || value === "HYPOTHESIS"
        ? "border-console-amber/40 bg-console-amber/10 text-console-amber"
        : "border-console-purple/40 bg-console-purple/10 text-console-purple";
  return (
    <Badge variant="outline" className={`text-[8px] font-normal ${tone}`}>
      {value}
    </Badge>
  );
}

function Src({ url }: { url: string | null }) {
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="text-console-blue hover:underline"
    >
      source
    </a>
  );
}

export function CaseContextDetail({ context }: { context: CaseContext }) {
  const t = context.truncated;
  const anyTruncated =
    t.evidence + t.entities + t.relationships + t.claims + t.timeline > 0;

  return (
    <div
      className="space-y-2 rounded border border-console-border bg-console-deep/60 p-3 font-mono text-xs"
      data-testid="case-context-detail"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-console-cyan">
          <FileText className="size-3" />
          Collected evidence — case {context.caseId}
        </span>
        {/* Back to the case surfaces, always carrying the case. */}
        <span className="flex flex-wrap items-center gap-2 text-[9px]">
          <Link
            to="/investigations"
            search={{ case: context.caseId }}
            className="inline-flex items-center gap-1 text-console-muted hover:text-console-text"
          >
            <FolderOpen className="size-2.5" /> Case
          </Link>
          <Link
            to="/graph"
            search={{ case: context.caseId }}
            className="inline-flex items-center gap-1 text-console-purple hover:underline"
          >
            <Network className="size-2.5" /> Graph
          </Link>
          <Link
            to="/timeline"
            search={{ case: context.caseId }}
            className="inline-flex items-center gap-1 text-console-cyan hover:underline"
          >
            <Clock className="size-2.5" /> Timeline
          </Link>
        </span>
      </div>

      <p className={`text-[9px] leading-relaxed ${DIM}`}>
        This is the evidence the grounded capability reasons over for this case — the same
        deterministic derivations shown on the case workspace. Metadata-only capabilities do not use
        it.
      </p>

      {/* The context is capped for the model's prompt; say what was dropped so
          the detail never reads as the whole case. */}
      {anyTruncated && (
        <p className="flex items-start gap-1.5 rounded border border-console-amber/30 bg-console-amber/5 px-2 py-1 text-[9px] leading-relaxed text-console-amber">
          <AlertTriangle className="mt-px size-3 shrink-0" />
          Capped for the model's prompt: {t.evidence} evidence, {t.claims} claims, {t.timeline}{" "}
          timeline, {t.entities} entities, {t.relationships} relationships not shown. The full set is
          on the case workspace.
        </p>
      )}

      {/* ── Claims ── */}
      <Section icon={Quote} label="Claims" count={context.claims.length} testid="ccd-claims">
        {context.claims.map((c) => (
          <div key={c.claimId} className="space-y-0.5 border-b border-console-border/40 pb-1 last:border-0 last:pb-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <ClassBadge value={c.claimClass} />
              <span
                className={`text-[8px] uppercase ${c.polarity === "deny" ? "text-console-red" : "text-console-green"}`}
              >
                {c.polarity}
              </span>
              {c.evidenceRef && <span className={`text-[8px] ${DIM}`}>{c.evidenceRef}</span>}
            </div>
            <p className="text-[10px] leading-snug text-console-text">{c.claimText}</p>
            <div className={`flex flex-wrap items-center gap-2 text-[8px] ${DIM}`}>
              <span>{c.publisher ?? c.source}</span>
              {c.publishedAt && <span>{c.publishedAt.slice(0, 10)}</span>}
              {c.syndicated && <span className="text-console-amber">syndicated</span>}
              {c.independentSources > 1 && <span>{c.independentSources} independent</span>}
              <Src url={c.sourceUrl} />
            </div>
          </div>
        ))}
      </Section>

      {/* ── Contradictions ── */}
      <Section
        icon={GitCompare}
        label="Contradictions"
        count={context.contradictions.length}
        testid="ccd-contradictions"
      >
        {context.contradictions.map((c, i) => (
          <div key={`${c.kind}-${c.subject}-${i}`} className="space-y-0.5 border-b border-console-border/40 pb-1 last:border-0 last:pb-0">
            <p className="text-[9px] text-console-muted">
              {c.kind} · {c.subject} · {c.status}
            </p>
            <p className="text-[9px] text-console-green">
              A ({c.claimClassA ?? "class n/a"}): {c.claimA} — {c.sourceA} <Src url={c.sourceUrlA} />
            </p>
            <p className="text-[9px] text-console-red">
              B ({c.claimClassB ?? "class n/a"}): {c.claimB} — {c.sourceB} <Src url={c.sourceUrlB} />
            </p>
            <p className={`text-[8px] leading-relaxed ${DIM}`}>{c.explanation}</p>
          </div>
        ))}
      </Section>

      {/* ── Correlations ── */}
      <Section icon={Link2} label="Correlations" count={context.correlations.length} testid="ccd-correlations">
        {context.correlations.map((c) => (
          <div key={c.id} className="space-y-0.5 border-b border-console-border/40 pb-1 last:border-0 last:pb-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[9px] font-bold text-console-cyan">{c.type}</span>
              <ClassBadge value={c.claimClass} />
              <span className={`text-[8px] ${DIM}`}>{c.disciplines.join(" ↔ ")}</span>
            </div>
            <p className="text-[9px] leading-snug text-console-text">{c.explanation}</p>
            {c.sourceUrls.length > 0 && (
              <div className="flex flex-wrap gap-2 text-[8px]">
                {c.sourceUrls.slice(0, 4).map((u, j) => (
                  <Src key={j} url={u} />
                ))}
              </div>
            )}
          </div>
        ))}
      </Section>

      {/* ── Timeline observations ── */}
      <Section icon={Clock} label="Timeline observations" count={context.timeline.length} testid="ccd-timeline">
        {context.timeline.map((e, i) => (
          <div key={`${e.evidenceId ?? e.collector}-${i}`} className="flex flex-wrap items-center gap-2 border-b border-console-border/40 pb-1 text-[9px] last:border-0 last:pb-0">
            <span className="font-bold text-console-text">
              {e.observedAt ? e.observedAt.slice(0, 19).replace("T", " ") : "undated"}
            </span>
            {e.positionedByRetrieval && (
              <span className="text-[8px] text-console-amber">retrieved only</span>
            )}
            <span className="text-console-blue">{e.collector}</span>
            {e.entity && <span className="text-console-muted">{e.entity}</span>}
            <span className={`basis-full text-[8px] ${DIM}`}>{e.summary}</span>
          </div>
        ))}
      </Section>

      {/* ── Evidence / source references ── */}
      <Section icon={FileText} label="Evidence / sources" count={context.evidence.length} testid="ccd-evidence">
        {context.evidence.map((e, i) => (
          <div key={`${e.evidenceId ?? e.collector}-${i}`} className="space-y-0.5 border-b border-console-border/40 pb-1 last:border-0 last:pb-0">
            <div className="flex flex-wrap items-center gap-1.5 text-[8px]">
              <span className="font-mono text-console-blue">{e.evidenceId ?? "no id"}</span>
              <ClassBadge value={e.claimClass} />
              <span className={DIM}>{e.collector}</span>
              <span className={DIM}>{e.source}</span>
              {/* null confidence renders as "not measured", never as 0. */}
              <span className={DIM}>
                {e.confidence === null ? "conf n/m" : `conf ${(e.confidence * 100).toFixed(0)}%`}
              </span>
              <Src url={e.sourceUrl} />
            </div>
            <p className="text-[9px] leading-snug text-console-muted">{e.summary}</p>
          </div>
        ))}
      </Section>

      {/* ── Limitations (verbatim, the model is told these too) ── */}
      {context.limitations.length > 0 && (
        <div className="space-y-0.5 border-t border-console-border/40 pt-1.5">
          <p className={`text-[9px] font-bold uppercase tracking-wider ${DIM}`}>
            Limitations · {context.completeness.status} collection
          </p>
          {context.limitations.map((l) => (
            <p key={l} className={`text-[8px] leading-relaxed ${DIM}`}>
              {l}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
