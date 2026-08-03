import { createFileRoute } from "@tanstack/react-router";
import { AppShell, PageHeader, Tone } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Bot, Users } from "lucide-react";

export const Route = createFileRoute("/network")({
  head: () => ({ meta: [{ title: "Network Analysis — Sentinel AI" }] }),
  component: Page,
});

const clusters = [
  {
    name: "CIB · #ElectionIntegrity",
    size: 42,
    bots: 76,
    tone: "critical" as const,
    community: "Political disinfo",
  },
  {
    name: "Fintech breach chatter",
    size: 128,
    bots: 22,
    tone: "high" as const,
    community: "InfoSec forums",
  },
  {
    name: "Aster Motors keynote",
    size: 3210,
    bots: 4,
    tone: "verified" as const,
    community: "Brand advocacy",
  },
  {
    name: "Border movement watchers",
    size: 88,
    bots: 44,
    tone: "high" as const,
    community: "OSINT",
  },
  {
    name: "Central bank commentary",
    size: 512,
    bots: 8,
    tone: "medium" as const,
    community: "Retail investors",
  },
];

const influencers = [
  { h: "@osint_watch", followers: "412K", reach: 94, tone: "verified" as const },
  { h: "@newsnowlive", followers: "1.2M", reach: 88, tone: "verified" as const },
  { h: "channel_9821", followers: "48K", reach: 62, tone: "unverified" as const },
  { h: "@brandops", followers: "312K", reach: 71, tone: "verified" as const },
  { h: "@vect17_ghost", followers: "12K", reach: 41, tone: "unverified" as const },
];

function Page() {
  return (
    <AppShell>
      <PageHeader
        title="Network Analysis"
        description="Clusters, influencers, bot detection, and community structure across social platforms."
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <Card>
          <CardContent className="p-0">
            <div
              className="relative h-[440px] overflow-hidden rounded-t-lg"
              style={{
                background:
                  "radial-gradient(circle at 30% 40%, oklch(0.94 0.05 255), oklch(0.99 0.005 240))",
              }}
            >
              <svg viewBox="0 0 600 440" className="h-full w-full">
                {Array.from({ length: 5 }).map((_, ci) => {
                  const cx = 120 + ci * 90 + (ci % 2) * 30;
                  const cy = 100 + (ci % 3) * 110;
                  const nodes = 8 + ci * 3;
                  return (
                    <g key={ci}>
                      {Array.from({ length: nodes }).map((_, i) => {
                        const angle = (i / nodes) * Math.PI * 2;
                        const r = 40 + (i % 3) * 8;
                        const x = cx + Math.cos(angle) * r;
                        const y = cy + Math.sin(angle) * r;
                        const col = [
                          "oklch(0.6 0.19 255)",
                          "oklch(0.62 0.23 27)",
                          "oklch(0.68 0.17 145)",
                          "oklch(0.78 0.16 85)",
                          "oklch(0.55 0.15 300)",
                        ][ci];
                        return (
                          <g key={i}>
                            <line
                              x1={cx}
                              y1={cy}
                              x2={x}
                              y2={y}
                              stroke={col}
                              strokeOpacity="0.25"
                              strokeWidth="1"
                            />
                            <circle cx={x} cy={y} r={2.5 + (i % 3)} fill={col} opacity="0.8" />
                          </g>
                        );
                      })}
                      <circle cx={cx} cy={cy} r={5} fill="oklch(0.22 0.03 250)" />
                    </g>
                  );
                })}
              </svg>
              <div className="absolute bottom-3 left-3 rounded-md border bg-background/95 px-3 py-2 text-xs">
                <div className="font-semibold">5 communities · 3,980 nodes</div>
                <div className="text-muted-foreground">Modularity 0.71 · avg. degree 6.2</div>
              </div>
            </div>
            <div className="divide-y">
              {clusters.map((c) => (
                <div key={c.name} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="grid size-8 place-items-center rounded-md bg-primary/10 text-primary">
                    <Users className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      {c.name}
                      <Tone tone={c.tone} />
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {c.community} · {c.size.toLocaleString()} accounts
                    </div>
                  </div>
                  <div className="w-40">
                    <div className="mb-0.5 flex justify-between text-[10px] text-muted-foreground">
                      <span>Bot likelihood</span>
                      <span>{c.bots}%</span>
                    </div>
                    <Progress value={c.bots} className="h-1" />
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <Bot className="size-4" />
              Top influencers
            </h3>
            <div className="mt-3 space-y-2">
              {influencers.map((i) => (
                <div key={i.h} className="rounded-md border bg-card p-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{i.h}</span>
                    <Tone tone={i.tone} />
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    {i.followers} followers
                  </div>
                  <div className="mt-1.5">
                    <div className="mb-0.5 flex justify-between text-[10px] text-muted-foreground">
                      <span>Reach</span>
                      <span>{i.reach}</span>
                    </div>
                    <Progress value={i.reach} className="h-1" />
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
