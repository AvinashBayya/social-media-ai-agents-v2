import { createFileRoute } from "@tanstack/react-router";
import { AppShell, PageHeader, Tone } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/trends")({
  head: () => ({ meta: [{ title: "Trend Analytics — Sentinel AI" }] }),
  component: Page,
});

const topics = [
  { t: "#ElectionIntegrity", v: 412000, g: 184, tone: "negative" as const },
  { t: "#AIRegulation", v: 298000, g: 62, tone: "neutral" as const },
  { t: "Chandrayaan-4 launch", v: 241000, g: 31, tone: "positive" as const },
  { t: "#DataBreach", v: 188000, g: 112, tone: "negative" as const },
  { t: "Rate hike reaction", v: 152000, g: -8, tone: "negative" as const },
  { t: "OpenAI DevDay", v: 141000, g: 47, tone: "positive" as const },
  { t: "#BorderMovement", v: 98000, g: 210, tone: "negative" as const },
  { t: "Aster keynote", v: 88000, g: 74, tone: "positive" as const },
];

const cloud = [
  { w: "election", s: 44 },
  { w: "integrity", s: 40 },
  { w: "breach", s: 34 },
  { w: "keynote", s: 30 },
  { w: "border", s: 28 },
  { w: "surveillance", s: 26 },
  { w: "isro", s: 24 },
  { w: "chandrayaan", s: 22 },
  { w: "regulation", s: 22 },
  { w: "cluster", s: 20 },
  { w: "bank", s: 20 },
  { w: "sanctions", s: 18 },
  { w: "protest", s: 18 },
  { w: "phishing", s: 16 },
  { w: "leak", s: 16 },
  { w: "convoy", s: 14 },
  { w: "watchlist", s: 14 },
  { w: "sentiment", s: 12 },
  { w: "brand", s: 12 },
  { w: "market", s: 12 },
];

function Page() {
  return (
    <AppShell>
      <PageHeader
        title="Trend Analytics"
        description="Trending topics, hashtags, and emerging narratives with growth rate and topic clusters."
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <Card>
          <CardContent className="p-0">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <h3 className="text-sm font-semibold">Trending topics</h3>
              <div className="flex gap-1">
                {["Now", "24h", "7d", "30d"].map((t, i) => (
                  <Badge
                    key={t}
                    variant={i === 1 ? "default" : "outline"}
                    className="cursor-pointer font-normal"
                  >
                    {t}
                  </Badge>
                ))}
              </div>
            </div>
            <div className="divide-y">
              {topics.map((t, i) => (
                <div key={t.t} className="flex items-center gap-3 px-4 py-3">
                  <span className="w-6 text-right text-lg font-semibold tabular-nums text-muted-foreground">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      {t.t}
                      <Tone tone={t.tone} />
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {t.v.toLocaleString()} mentions
                    </div>
                  </div>
                  <div className="w-40">
                    <svg viewBox="0 0 100 30" className="h-8 w-full">
                      <path
                        d={`M0 ${15 - t.g / 20} ${Array.from({ length: 10 })
                          .map((_, k) => `L ${k * 11} ${15 + Math.sin((i + k) / 2) * (t.g / 15)}`)
                          .join(" ")}`}
                        fill="none"
                        stroke={t.g > 0 ? "oklch(0.68 0.17 145)" : "oklch(0.62 0.23 27)"}
                        strokeWidth="1.5"
                      />
                    </svg>
                  </div>
                  <span
                    className={`w-16 text-right text-sm font-semibold tabular-nums ${t.g > 0 ? "text-[oklch(0.4_0.17_145)]" : "text-destructive"}`}
                  >
                    {t.g > 0 ? "+" : ""}
                    {t.g}%
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <h3 className="text-sm font-semibold">Word cloud</h3>
            <div className="mt-3 flex flex-wrap gap-2 leading-tight">
              {cloud.map((c, i) => (
                <span
                  key={c.w}
                  className="font-semibold"
                  style={{
                    fontSize: `${c.s * 0.9}px`,
                    color: `oklch(${0.35 + (i % 5) * 0.06} 0.14 ${(i * 30) % 360})`,
                  }}
                >
                  {c.w}
                </span>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
