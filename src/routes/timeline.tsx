import { createFileRoute, Link } from "@tanstack/react-router";
import { AppShell, PageHeader, Tone } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useState, useEffect } from "react";
import { INVESTIGATIONS_CHANGED_EVENT, getInvestigations } from "@/utils/investigations-store";
import { bandFor } from "@/utils/credibility";
import { Clock, Network, GitCompare } from "lucide-react";
import {
  getTimelineForCase,
  readTimelineSnapshot,
  timelineEvictedCases,
  timelineScopedCases,
  type ScopedTimelineSnapshot,
  type TimelineSnapshot,
} from "@/utils/timeline-store";
import { SnapshotProvenanceLine } from "@/components/snapshot-provenance";
import { CaseSnapshotSelector } from "@/components/case-snapshot-selector";
import {
  UNSCOPED_SELECTION,
  buildSnapshotOptions,
  resolveSnapshotSelection,
} from "@/utils/cases/case-snapshot-selection";
import { MAX_SCOPED_CASES } from "@/utils/cases/case-scope";
import { bucketByYear, buildEvidenceTimeline, entitySpans } from "@/utils/osint/timeline";

/** Render caps. The full set stays in the snapshot; only display is bounded. */
const MAX_EVENTS = 200;
const MAX_SPANS = 100;

export const Route = createFileRoute("/timeline")({
  /**
   * `?case=INV-1001` preselects a case's evidence timeline — so the Graph↔Timeline
   * cross-links and a case run's "View in Timeline" open on the case they were
   * launched with, not the unscoped/latest slot. Strict about SHAPE only: a case
   * with no snapshot shows its own empty state, never a substituted one.
   */
  validateSearch: (search: Record<string, unknown>): { case?: string } => {
    const raw = search.case;
    if (typeof raw !== "string") return {};
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > 64) return {};
    return { case: trimmed };
  },
  head: () => ({ meta: [{ title: "Timeline Explorer — Sentinel AI" }] }),
  component: TimelinePage,
});

/**
 * The seeded event list is gone. It carried five invented entries — "Image
 * posted to channel_9821 with EXIF placing it within restricted zone",
 * "Sentiment shift to negative in retail investor communities" — and two case
 * openings for the demonstration dossiers that no longer exist. The timeline now
 * shows only what actually happened in the analyst's own cases.
 */

function TimelinePage() {
  // A case handed in via `?case=` (Graph→Timeline cross-link, or a case run's
  // "View in Timeline"). Seeds the evidence-timeline panel's case selection.
  const { case: requestedCase } = Route.useSearch();
  const [timelineEvents, setTimelineEvents] = useState<any[]>([]);

  useEffect(() => {
    const cases = getInvestigations();
    const list: any[] = [];
    cases.forEach((c) => {
      // Add case opening event
      list.push({
        d: new Date(c.createdAt).toISOString().replace("T", " ").substring(0, 16),
        k: "Case",
        t: `Investigation ${c.id} initialized: ${c.title}`,
        // Tone was driven by an invented per-case risk score. A case opening
        // is a neutral fact about the workspace, not a threat level.
        tone: "neutral",
      });

      // Add pinned evidence events
      c.evidence?.forEach((ev) => {
        list.push({
          // Evidence now carries a real ISO pinnedAt. `ev.t` was "09:42" with
          // no date, so every item fell back to a "12:00" placeholder.
          d: new Date(ev.pinnedAt ?? c.createdAt).toISOString().replace("T", " ").substring(0, 16),
          k: ev.kind,
          t: `[${c.id}] ${ev.title} — ${ev.source}`,
          // Tone reflects the item's Module 1 credibility where it has one,
          // rather than a `tone` field the analyst never set.
          tone:
            ev.credibility === null
              ? "neutral"
              : bandFor(ev.credibility).tone === "high"
                ? "verified"
                : bandFor(ev.credibility).tone === "low"
                  ? "unverified"
                  : "medium",
        });
      });
    });

    // Merge and sort descending
    const merged = [...list].sort((a, b) => b.d.localeCompare(a.d));
    setTimelineEvents(merged);
  }, []);

  return (
    <AppShell>
      <PageHeader
        title="Timeline Explorer"
        description="Case openings and pinned evidence in time order, built from your own cases. No alerts appear here: nothing in this system alerts on a schedule."
      />

      <EvidenceTimelinePanel initialCase={requestedCase} />
      <Card className="bg-console-surface border-console-border rounded">
        <CardContent className="p-6 font-mono text-xs text-console-muted">
          {/* An explicit heading so the two timelines on this page are not
              confused. This is the CASE ACTIVITY LOG (workspace events), a
              different object from the Investigation evidence timeline above
              (collected evidence ordered by when it was observed). */}
          <div
            className="mb-4 flex flex-wrap items-center gap-2 border-b border-console-border/40 pb-2"
            data-testid="case-activity-log-header"
          >
            <span className="flex items-center gap-1.5 text-[11px] font-bold text-console-text">
              <Clock className="size-4 text-console-green" /> Case activity log
            </span>
            <span className="text-[9px] leading-relaxed text-console-label">
              Workspace activity — cases opened and evidence pinned, in time order. Distinct from the
              evidence timeline above, which orders collected evidence by when it was observed.
            </span>
          </div>
          {timelineEvents.length === 0 ? (
            <div className="py-10 text-center">
              <Clock className="mx-auto size-8 text-console-border" />
              <p className="mt-3 text-[11px] text-console-muted">No case activity yet.</p>
              <p className="mx-auto mt-1 max-w-md text-[10px] leading-relaxed text-console-label">
                This timeline is built from your own cases and the evidence pinned to them. It
                previously merged in five seeded events describing analysis that never ran. Create a
                case on{" "}
                <a href="/investigations" className="text-console-blue hover:underline">
                  Investigations
                </a>{" "}
                and pin something to it.
              </p>
            </div>
          ) : (
            <div className="relative pl-6">
              <span className="absolute left-2.5 top-2 bottom-2 w-px bg-[#22332B]" />
              {timelineEvents.map((e, i) => (
                <div key={i} className="relative pb-5 last:pb-0">
                  <span className="absolute -left-[18.5px] top-1 grid size-3 place-items-center rounded-full bg-[#0D0E12] border border-console-green ring-2 ring-console-green/20" />
                  <div className="flex flex-wrap items-center gap-2 text-[10px]">
                    <span className="font-mono text-console-text font-bold">{e.d}</span>
                    <Badge
                      variant="secondary"
                      className="h-4 px-1.5 text-[8px] border-[#22332B] bg-console-deep rounded-none uppercase"
                    >
                      {e.k}
                    </Badge>
                    <Tone tone={e.tone} />
                  </div>
                  <p className="mt-1 text-console-text text-[11px] leading-relaxed">"{e.t}"</p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </AppShell>
  );
}

/**
 * Investigation evidence timeline (2026-08-30, ported from the teammate's
 * fork).
 *
 * A SEPARATE SECTION from the case timeline above, deliberately. They are
 * different objects: the case timeline is the analyst's own workspace activity
 * (cases opened, evidence pinned), this is when an investigation's collected
 * evidence was actually *observed*. Merging them would produce one list mixing
 * "you pinned this at 14:02 today" with "the Internet Archive captured this page
 * in 2014", which is two different kinds of time in one column.
 *
 * The third timeline in this codebase — `analysis.ts`'s `buildTimeline()`, per
 * news-story cluster — is untouched and lives on the M2 pages. Three things
 * called "timeline" that mean different things stay apart.
 */
function EvidenceTimelinePanel({ initialCase }: { initialCase?: string }) {
  // The analyst picks the case; nothing is inferred. Default is the
  // unscoped/latest slot, which is what /recon's hand-off writes — unless a
  // `?case=` hand-off named a specific case, which seeds the selection.
  const [selection, setSelection] = useState<string>(initialCase ?? UNSCOPED_SELECTION);
  const [cases, setCases] = useState<Array<{ id: string; target: string }>>([]);
  const [scopedIds, setScopedIds] = useState<string[]>([]);
  const [evictedIds, setEvictedIds] = useState<string[]>([]);
  const [unscoped, setUnscoped] = useState<TimelineSnapshot | null>(null);
  const [scoped, setScoped] = useState<ScopedTimelineSnapshot | null>(null);

  // Client-only: every store here is localStorage, absent during SSR.
  useEffect(() => {
    const load = () => {
      setCases(getInvestigations().map((c) => ({ id: c.id, target: c.target })));
      setScopedIds(timelineScopedCases());
      setEvictedIds(timelineEvictedCases());
      setUnscoped(readTimelineSnapshot());
    };
    load();
    window.addEventListener(INVESTIGATIONS_CHANGED_EVENT, load);
    return () => window.removeEventListener(INVESTIGATIONS_CHANGED_EVENT, load);
  }, []);

  // Re-read on every selection change rather than caching per case: a run in
  // another tab can land between selections, and a stale cache would show the
  // analyst data that is no longer what the store holds.
  useEffect(() => {
    setScoped(selection === UNSCOPED_SELECTION ? null : getTimelineForCase(selection));
    // Changing case is the natural refresh point: a run in another tab writes
    // and evicts without firing an investigations event.
    setScopedIds(timelineScopedCases());
    setEvictedIds(timelineEvictedCases());
  }, [selection]);

  const options = buildSnapshotOptions(cases, scopedIds, !!unscoped, evictedIds);
  const display = resolveSnapshotSelection(selection, scoped, unscoped, "timeline", evictedIds);

  const selector = (
    <CaseSnapshotSelector options={options} value={selection} onChange={setSelection} label="Case" />
  );

  if (!display.show) {
    return (
      <Card className="mb-4 bg-console-surface border-console-border rounded">
        <CardContent className="p-6 font-mono text-xs">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] font-bold text-console-text">Investigation evidence timeline</p>
            {selector}
          </div>
          <div className="flex items-start gap-2">
            <Clock className="mt-0.5 size-4 shrink-0 text-console-cyan" />
            <div>
              {/*
                The reason is the selection's own, not a generic blank. A case
                with no snapshot must NOT fall through to whatever the latest
                run happened to be — that is the contamination case-scoping
                exists to prevent, and it would be invisible.
              */}
              <p className="text-[11px] font-bold text-console-amber">{display.reason}</p>
              {/* An evicted case is NOT an empty result. The timeline existed
                  and storage discarded it; nothing is being reconstructed.
                  That is a different fact from "never run". */}
              {display.state === "EVICTED" && (
                <p className="mt-1 max-w-2xl text-[10px] leading-relaxed text-console-amber">
                  This case produced a timeline and it was discarded to stay under the{" "}
                  {MAX_SCOPED_CASES}-case storage cap. Nothing has been reconstructed or
                  substituted. Re-running the case rebuilds it.
                </p>
              )}
              <p className="mt-1 max-w-2xl text-[10px] leading-relaxed text-console-label">
                Nothing is substituted for a missing snapshot. Run this case from{" "}
                <a href="/investigations" className="text-console-cyan hover:underline">
                  Investigations
                </a>
                , or run an ad-hoc investigation on{" "}
                <a href="/recon" className="text-console-cyan hover:underline">
                  Recon
                </a>{" "}
                and press <span className="text-console-muted">View in Timeline</span>. This section
                orders collected evidence by when it was <em>observed</em>, which is a different
                question from the case activity below.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const snapshot = display.snapshot;
  const timeline = buildEvidenceTimeline(snapshot.evidence);
  const spans = entitySpans(snapshot.evidence);
  const buckets = bucketByYear(timeline);
  const shown = timeline.events.slice(0, MAX_EVENTS);

  return (
    <Card className="mb-4 bg-console-surface border-console-border rounded">
      <CardContent className="space-y-3 p-6 font-mono text-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex flex-wrap items-center gap-2 text-[11px] font-bold text-console-text">
            <Clock className="size-4 text-console-cyan" />
            Investigation evidence timeline — {snapshot.target}
            {/* The snapshot's OWN metadata is authoritative, not the option
                the analyst picked. See snapshot-provenance.tsx. */}
            <SnapshotProvenanceLine caseId={snapshot.caseId} truncation={snapshot.truncation} />
          </span>
          <span className="flex flex-wrap items-center gap-3">
            {selector}
            {/* Cross-link to the same case's knowledge graph. Carries the case so
                /graph opens on this snapshot's case, not the latest run. */}
            <Link
              to="/graph"
              search={{ case: snapshot.caseId || undefined }}
              title="Open this case's knowledge graph"
              className="inline-flex items-center gap-1 text-[10px] text-console-purple hover:underline"
            >
              <Network className="size-3" />
              View in Graph
            </Link>
            <span className="text-[10px] text-console-label">
              {timeline.summary.total} events · {timeline.summary.collectors.length} collectors
              {snapshot.savedAt && ` · saved ${new Date(snapshot.savedAt).toLocaleString()}`}
            </span>
          </span>
        </div>

        {/* The latest-run slot is written by /recon AND by case runs, so it can
            hold a case's snapshot. Saying so beats letting the option label
            imply the data belongs to nobody. */}
        {display.note && <p className="text-[10px] leading-relaxed text-console-amber">{display.note}</p>}

        {/* The dated/undated split is the headline figure, not a footnote: a
            timeline that is mostly retrieval stamps is a different object from
            one that is mostly real dates. */}
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-[10px]">
          <span className="text-console-green">{timeline.summary.dated} with a real date</span>
          <span className="text-console-amber">
            {timeline.summary.undated} undated (positioned by retrieval time)
          </span>
          {timeline.summary.firstObserved && (
            <span className="text-console-muted">
              observed range {timeline.summary.firstObserved.slice(0, 10)} →{" "}
              {timeline.summary.lastObserved!.slice(0, 10)}
            </span>
          )}
          {timeline.summary.unscored > 0 && (
            <span className="text-console-label">{timeline.summary.unscored} unscored</span>
          )}
        </div>

        {buckets.length > 0 && (
          <div className="flex flex-wrap gap-1.5 border-t border-console-border/40 pt-2">
            {buckets.map((b) => (
              <Badge
                key={b.key}
                className="h-4 rounded-none border-console-cyan/30 bg-console-cyan/10 px-1.5 text-[9px] text-console-cyan"
              >
                {b.key} · {b.count}
              </Badge>
            ))}
          </div>
        )}

        <div className="max-h-96 overflow-y-auto rounded border border-console-border bg-console-deep">
          {shown.map((e) => (
            <div key={e.eventRef} className="space-y-1 border-b border-console-border/50 px-3 py-2 last:border-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-bold text-console-text text-[10px]">
                  {(e.observedAt ?? e.retrievedAt).slice(0, 19).replace("T", " ")}
                </span>
                {/* Timestamp type is never implied — an undated event says so. */}
                <Badge
                  className={`h-4 rounded-none px-1.5 text-[8px] uppercase ${
                    e.timestampType === "observed"
                      ? "border-console-green/30 bg-console-green/10 text-console-green"
                      : "border-console-amber/30 bg-console-amber/10 text-console-amber"
                  }`}
                >
                  {e.timestampType === "observed" ? "observed" : "retrieved only"}
                </Badge>
                <Badge className="h-4 rounded-none border-console-blue/30 bg-console-blue/10 px-1.5 text-[8px] text-console-blue">
                  {e.collector}
                </Badge>
                {e.claimClass && (
                  <Badge className="h-4 rounded-none border-console-purple/30 bg-console-purple/10 px-1.5 text-[8px] text-console-purple">
                    {e.claimClass}
                  </Badge>
                )}
                {/* Null band renders as nothing at all, never as a low score. */}
                {e.confidenceBand && (
                  <Badge className="h-4 rounded-none border-console-label/30 bg-console-label/10 px-1.5 text-[8px] text-console-muted">
                    {e.confidenceBand}
                  </Badge>
                )}
              </div>
              {e.entity && <div className="truncate text-[10px] text-console-muted">{e.entity}</div>}
              <div className="truncate text-[9px] text-console-label">{e.claim}</div>
              <div className="flex flex-wrap items-center gap-2 text-[9px] text-console-label">
                <span>{e.source}</span>
                <span className="text-[#3A4757]">·</span>
                <span>{e.evidenceId ?? e.eventRef}</span>
                {e.sourceUrl && (
                  <a
                    href={e.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-console-cyan hover:underline"
                  >
                    open
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>

        {timeline.events.length > MAX_EVENTS && (
          <p className="text-[10px] text-console-label">
            Showing the first {MAX_EVENTS} of {timeline.events.length} events.
          </p>
        )}

        {spans.length > 0 && (
          <div className="space-y-1.5 border-t border-console-border/40 pt-3">
            <p className="text-[10px] font-bold uppercase tracking-wider text-console-label">
              First / last seen per entity
            </p>
            <div className="max-h-56 overflow-y-auto rounded border border-console-border bg-console-deep">
              {spans.slice(0, MAX_SPANS).map((s) => (
                <div
                  key={s.entity}
                  className="flex flex-wrap items-center justify-between gap-2 border-b border-console-border/50 px-3 py-1.5 text-[9px] last:border-0"
                >
                  <span className="truncate text-console-muted">{s.entity}</span>
                  <span className="shrink-0 text-console-label">
                    {s.firstSeen ? (
                      <>
                        {s.firstSeen.slice(0, 10)} → {s.lastSeen!.slice(0, 10)}
                      </>
                    ) : (
                      /* Never blank, never a guessed date — states the absence. */
                      <span className="text-console-amber">no dated observation</span>
                    )}
                    {" · "}
                    {s.observations} obs
                    {s.multiSource && <span className="text-console-green"> · {s.collectors.length} sources</span>}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-1 border-t border-console-border/40 pt-2">
          {timeline.caveats.map((c) => (
            <p key={c} className="text-[9px] leading-relaxed text-console-label">
              {c}
            </p>
          ))}
          {/* The caveats mention "the contradiction engine" but ordering is not
              adjudication. This case's deterministic contradictions render on
              the case workspace; link there rather than duplicating the engine.
              Only shown when the snapshot carries a real case — an unscoped
              /recon run has no case contradiction view to point at. */}
          {snapshot.caseId && (
            <Link
              to="/investigations"
              search={{ case: snapshot.caseId }}
              className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-console-cyan hover:underline"
            >
              <GitCompare className="size-3" />
              Review this case's contradictions in Investigations
            </Link>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// No `export default TimelinePage` here. A route file that exports anything
// besides `Route` cannot be code-split — the router logs that warning on every
// page load. Nothing imported this: the route tree pulls in `Route` alone.
