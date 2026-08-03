import { createFileRoute } from "@tanstack/react-router";
import { AppShell, PageHeader, Tone } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useState, useEffect } from "react";
import { getInvestigations } from "@/utils/investigations-store";
import { Clock } from "lucide-react";

export const Route = createFileRoute("/timeline")({
  head: () => ({ meta: [{ title: "Timeline Explorer — Sentinel AI" }] }),
  component: TimelinePage,
});

const DEFAULT_EVENTS = [
  {
    d: "2026-07-24 09:42",
    k: "Alert",
    t: "Face-match hit · Vector-17 in Damascus feed",
    tone: "critical" as const,
  },
  {
    d: "2026-07-24 08:14",
    k: "Note",
    t: "M. Ortega: EXIF metadata authentic. Requesting chain-of-custody review.",
    tone: "medium" as const,
  },
  {
    d: "2026-07-24 07:04",
    k: "Corroboration",
    t: "Analyst commentary on r/netsec corroborates fintech IOC.",
    tone: "medium" as const,
  },
  {
    d: "2026-07-23 22:11",
    k: "Publication",
    t: "BBC covers coordinated behavior around #ElectionIntegrity.",
    tone: "verified" as const,
  },
  {
    d: "2026-07-23 17:42",
    k: "Capture",
    t: "Image posted to channel_9821 with EXIF placing it within restricted zone.",
    tone: "high" as const,
  },
  {
    d: "2026-07-22 12:00",
    k: "Signal",
    t: "Sentiment shift to negative in retail investor communities post rate hike.",
    tone: "negative" as const,
  },
  {
    d: "2026-07-20 09:00",
    k: "Case",
    t: "Investigation INV-2038 opened: #ElectionIntegrity CIB cluster.",
    tone: "high" as const,
  },
  {
    d: "2026-07-20 15:20",
    k: "Case",
    t: "Investigation INV-2041 opened: Vector-17 · surveillance leak.",
    tone: "critical" as const,
  },
];

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
        tone: c.risk > 70 ? "critical" : "high"
      });

      // Add pinned evidence events
      c.evidence?.forEach((ev: any) => {
        list.push({
          d: `${new Date(c.createdAt).toISOString().substring(0, 10)} ${ev.t || "12:00"}`,
          k: ev.type,
          t: `[${c.id}] Pinned evidence: ${ev.note} (Source: ${ev.src})`,
          tone: ev.tone || "medium"
        });
      });
    });

    // Merge and sort descending
    const merged = [...list, ...DEFAULT_EVENTS].sort((a, b) => b.d.localeCompare(a.d));
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
          <div className="relative pl-6">
            <span className="absolute left-2.5 top-2 bottom-2 w-px bg-[#22332B]" />
            {timelineEvents.map((e, i) => (
              <div key={i} className="relative pb-5 last:pb-0">
                <span className="absolute -left-[18.5px] top-1 grid size-3 place-items-center rounded-full bg-[#0D0E12] border border-[#10B981] ring-2 ring-[#10B981]/20" />
                <div className="flex flex-wrap items-center gap-2 text-[10px]">
                  <span className="font-mono text-white font-bold">{e.d}</span>
                  <Badge variant="secondary" className="h-4 px-1.5 text-[8px] border-[#22332B] bg-[#0B1220] rounded-none uppercase">
                    {e.k}
                  </Badge>
                  <Tone tone={e.tone} />
                </div>
                <p className="mt-1 text-white text-[11px] leading-relaxed">"{e.t}"</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </AppShell>
  );
}
export default TimelinePage;
