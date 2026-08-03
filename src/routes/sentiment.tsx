import { createFileRoute } from "@tanstack/react-router";
import { AppShell, PageHeader } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  AreaChart,
  Area,
  ResponsiveContainer,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  BarChart,
  Bar,
  Legend,
} from "recharts";

export const Route = createFileRoute("/sentiment")({
  head: () => ({ meta: [{ title: "Sentiment Analytics — Sentinel AI" }] }),
  component: Page,
});

const days = Array.from({ length: 30 }).map((_, i) => ({
  d: `D${i + 1}`,
  pos: 30 + Math.round(Math.sin(i / 4) * 12 + Math.random() * 6),
  neu: 40 + Math.round(Math.cos(i / 5) * 8 + Math.random() * 4),
  neg: 30 + Math.round(Math.sin(i / 3 + 1) * 10 + Math.random() * 6),
}));

const emotions = [
  { e: "Trust", v: 62 },
  { e: "Joy", v: 41 },
  { e: "Anticipation", v: 38 },
  { e: "Sadness", v: 24 },
  { e: "Anger", v: 48 },
  { e: "Fear", v: 34 },
  { e: "Disgust", v: 18 },
  { e: "Surprise", v: 27 },
];

const compare = [
  { name: "India", pos: 44, neu: 38, neg: 18 },
  { name: "US", pos: 32, neu: 38, neg: 30 },
  { name: "UK", pos: 28, neu: 42, neg: 30 },
  { name: "DE", pos: 40, neu: 44, neg: 16 },
  { name: "BR", pos: 48, neu: 32, neg: 20 },
  { name: "UA", pos: 14, neu: 32, neg: 54 },
];

function Page() {
  return (
    <AppShell>
      <PageHeader
        title="Sentiment Analytics"
        description="Overall score, positive/negative/neutral splits, emotion analysis, and per-country/platform comparisons."
      />
      <div className="grid gap-4 lg:grid-cols-4">
        {[
          { l: "Overall score", v: "-12", sub: "Slightly negative", val: 44 },
          {
            l: "Positive",
            v: "34%",
            sub: "vs 40% last week",
            val: 34,
            color: "oklch(0.68 0.17 145)",
          },
          { l: "Neutral", v: "38%", sub: "stable", val: 38, color: "oklch(0.6 0.19 255)" },
          {
            l: "Negative",
            v: "28%",
            sub: "vs 22% last week",
            val: 28,
            color: "oklch(0.62 0.23 27)",
          },
        ].map((k) => (
          <Card key={k.l}>
            <CardContent className="p-4">
              <div className="text-xs text-muted-foreground">{k.l}</div>
              <div className="mt-1 text-2xl font-semibold">{k.v}</div>
              <div className="text-[11px] text-muted-foreground">{k.sub}</div>
              <Progress value={k.val} className="mt-2 h-1.5" />
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardContent className="p-4">
            <h3 className="text-sm font-semibold">30-day sentiment timeline</h3>
            <div className="mt-3 h-64">
              <ResponsiveContainer>
                <AreaChart data={days} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="oklch(0.92 0.01 245)"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="d"
                    tick={{ fontSize: 10, fill: "oklch(0.5 0.02 250)" }}
                    interval={4}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: "oklch(0.5 0.02 250)" }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "white",
                      border: "1px solid oklch(0.92 0.01 245)",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="pos"
                    stackId="1"
                    stroke="oklch(0.68 0.17 145)"
                    fill="oklch(0.68 0.17 145)"
                    fillOpacity={0.6}
                  />
                  <Area
                    type="monotone"
                    dataKey="neu"
                    stackId="1"
                    stroke="oklch(0.6 0.19 255)"
                    fill="oklch(0.6 0.19 255)"
                    fillOpacity={0.5}
                  />
                  <Area
                    type="monotone"
                    dataKey="neg"
                    stackId="1"
                    stroke="oklch(0.62 0.23 27)"
                    fill="oklch(0.62 0.23 27)"
                    fillOpacity={0.6}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <h3 className="text-sm font-semibold">Emotion distribution</h3>
            <div className="mt-3 space-y-2">
              {emotions.map((e) => (
                <div key={e.e}>
                  <div className="mb-0.5 flex justify-between text-xs">
                    <span>{e.e}</span>
                    <span className="tabular-nums text-muted-foreground">{e.v}%</span>
                  </div>
                  <Progress value={e.v} className="h-1.5" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardContent className="p-4">
          <h3 className="text-sm font-semibold">Sentiment by country</h3>
          <div className="mt-3 h-64">
            <ResponsiveContainer>
              <BarChart data={compare}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="oklch(0.92 0.01 245)"
                  vertical={false}
                />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
                <Tooltip
                  contentStyle={{
                    background: "white",
                    border: "1px solid oklch(0.92 0.01 245)",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="pos" stackId="a" fill="oklch(0.68 0.17 145)" name="Positive" />
                <Bar dataKey="neu" stackId="a" fill="oklch(0.6 0.19 255)" name="Neutral" />
                <Bar
                  dataKey="neg"
                  stackId="a"
                  fill="oklch(0.62 0.23 27)"
                  name="Negative"
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>
    </AppShell>
  );
}
