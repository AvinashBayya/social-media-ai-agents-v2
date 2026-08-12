import { createFileRoute } from "@tanstack/react-router";
import { AppShell, PageHeader, Tone } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useState, useEffect } from "react";
import { getInvestigations } from "@/utils/investigations-store";
import { bandFor } from "@/utils/credibility";
import { Clock } from "lucide-react";

export const Route = createFileRoute("/timeline")({
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
        description="A chronological view of alerts, dynamic evidence compilation, and case history logs."
      />
      <Card className="bg-[#111827] border-[#263548] rounded">
        <CardContent className="p-6 font-mono text-xs text-[#94A3B8]">
          {timelineEvents.length === 0 ? (
            <div className="py-10 text-center">
              <Clock className="mx-auto size-8 text-[#263548]" />
              <p className="mt-3 text-[11px] text-[#94A3B8]">No case activity yet.</p>
              <p className="mx-auto mt-1 max-w-md text-[10px] leading-relaxed text-[#64748B]">
                This timeline is built from your own cases and the evidence pinned to them. It
                previously merged in five seeded events describing analysis that never ran. Create a
                case on{" "}
                <a href="/investigations" className="text-[#3B82F6] hover:underline">
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
                  <span className="absolute -left-[18.5px] top-1 grid size-3 place-items-center rounded-full bg-[#0D0E12] border border-[#10B981] ring-2 ring-[#10B981]/20" />
                  <div className="flex flex-wrap items-center gap-2 text-[10px]">
                    <span className="font-mono text-white font-bold">{e.d}</span>
                    <Badge
                      variant="secondary"
                      className="h-4 px-1.5 text-[8px] border-[#22332B] bg-[#0B1220] rounded-none uppercase"
                    >
                      {e.k}
                    </Badge>
                    <Tone tone={e.tone} />
                  </div>
                  <p className="mt-1 text-white text-[11px] leading-relaxed">"{e.t}"</p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </AppShell>
  );
}

// No `export default TimelinePage` here. A route file that exports anything
// besides `Route` cannot be code-split — the router logs that warning on every
// page load. Nothing imported this: the route tree pulls in `Route` alone.
