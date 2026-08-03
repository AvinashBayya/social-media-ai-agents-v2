import { createFileRoute } from "@tanstack/react-router";
import { AppShell, PageHeader } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Search, ZoomIn, ZoomOut, Maximize2, Route as RouteIcon, Filter } from "lucide-react";

export const Route = createFileRoute("/graph")({
  head: () => ({ meta: [{ title: "Knowledge Graph — Sentinel AI" }] }),
  component: Page,
});

type Node = {
  id: string;
  label: string;
  type: "person" | "org" | "country" | "domain" | "phone" | "email" | "social";
  x: number;
  y: number;
  r: number;
};
const NODES: Node[] = [
  { id: "v17", label: "Vector-17", type: "person", x: 400, y: 260, r: 22 },
  { id: "ch", label: "channel_9821", type: "social", x: 260, y: 180, r: 16 },
  { id: "am", label: "Aster Motors", type: "org", x: 550, y: 200, r: 20 },
  { id: "sy", label: "Syria", type: "country", x: 340, y: 360, r: 18 },
  { id: "ru", label: "Russia", type: "country", x: 180, y: 340, r: 18 },
  { id: "dom", label: "aster-motors.com", type: "domain", x: 640, y: 300, r: 14 },
  { id: "ph", label: "+91 98••••4211", type: "phone", x: 500, y: 400, r: 12 },
  { id: "em", label: "vector17@proton.me", type: "email", x: 300, y: 440, r: 14 },
  { id: "hn", label: "@osint_watch", type: "social", x: 180, y: 230, r: 14 },
  { id: "ort", label: "M. Ortega", type: "person", x: 620, y: 420, r: 12 },
];
const EDGES: [string, string, string][] = [
  ["v17", "ch", "posts via"],
  ["v17", "em", "owns"],
  ["v17", "sy", "located"],
  ["ch", "ru", "hosted"],
  ["ch", "hn", "amplifies"],
  ["am", "dom", "operates"],
  ["am", "v17", "mentioned"],
  ["ph", "v17", "linked"],
  ["ort", "am", "employee"],
  ["hn", "v17", "reports on"],
];

const TYPE_STYLE: Record<Node["type"], { fill: string; ring: string }> = {
  person: { fill: "oklch(0.6 0.19 255)", ring: "oklch(0.6 0.19 255)" },
  org: { fill: "oklch(0.68 0.17 145)", ring: "oklch(0.68 0.17 145)" },
  country: { fill: "oklch(0.78 0.16 85)", ring: "oklch(0.78 0.16 85)" },
  domain: { fill: "oklch(0.7 0.16 210)", ring: "oklch(0.7 0.16 210)" },
  phone: { fill: "oklch(0.62 0.23 27)", ring: "oklch(0.62 0.23 27)" },
  email: { fill: "oklch(0.55 0.15 300)", ring: "oklch(0.55 0.15 300)" },
  social: { fill: "oklch(0.4 0.02 250)", ring: "oklch(0.4 0.02 250)" },
};

function Page() {
  const byId = Object.fromEntries(NODES.map((n) => [n.id, n]));
  return (
    <AppShell>
      <PageHeader
        title="Knowledge Graph"
        description="Explore relationships between people, organizations, places, and digital identifiers."
        actions={
          <>
            <Button variant="outline" size="sm" className="gap-1.5">
              <RouteIcon className="size-3.5" />
              Path finding
            </Button>
            <Button variant="outline" size="sm" className="gap-1.5">
              <Filter className="size-3.5" />
              Filter
            </Button>
            <Button size="sm" className="gap-1.5">
              <Maximize2 className="size-3.5" />
              Full screen
            </Button>
          </>
        }
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardContent className="p-0">
            <div className="flex items-center justify-between border-b px-4 py-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input className="h-8 w-64 pl-8 text-xs" placeholder="Find node…" />
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                {Object.entries(TYPE_STYLE).map(([t, s]) => (
                  <span key={t} className="flex items-center gap-1 text-muted-foreground">
                    <span className="size-2.5 rounded-full" style={{ background: s.fill }} />
                    {t}
                  </span>
                ))}
              </div>
              <div className="flex gap-1">
                <Button variant="ghost" size="icon" className="size-7">
                  <ZoomOut className="size-3.5" />
                </Button>
                <Button variant="ghost" size="icon" className="size-7">
                  <ZoomIn className="size-3.5" />
                </Button>
              </div>
            </div>
            <div
              className="relative h-[560px] w-full overflow-hidden rounded-b-lg"
              style={{
                background:
                  "radial-gradient(circle at 50% 45%, oklch(0.97 0.02 240), oklch(0.99 0.005 240))",
              }}
            >
              <svg viewBox="0 0 800 560" className="h-full w-full">
                <defs>
                  <pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse">
                    <path
                      d="M24 0H0V24"
                      fill="none"
                      stroke="oklch(0.94 0.01 245)"
                      strokeWidth="0.5"
                    />
                  </pattern>
                </defs>
                <rect width="800" height="560" fill="url(#grid)" />
                {EDGES.map(([a, b, rel], i) => {
                  const na = byId[a];
                  const nb = byId[b];
                  return (
                    <g key={i}>
                      <line
                        x1={na.x}
                        y1={na.y}
                        x2={nb.x}
                        y2={nb.y}
                        stroke="oklch(0.75 0.03 245)"
                        strokeWidth="1.5"
                      />
                      <text
                        x={(na.x + nb.x) / 2}
                        y={(na.y + nb.y) / 2 - 4}
                        textAnchor="middle"
                        fontSize="9"
                        fill="oklch(0.5 0.02 250)"
                      >
                        {rel}
                      </text>
                    </g>
                  );
                })}
                {NODES.map((n) => {
                  const s = TYPE_STYLE[n.type];
                  return (
                    <g key={n.id}>
                      <circle cx={n.x} cy={n.y} r={n.r + 6} fill={s.fill} opacity="0.15" />
                      <circle
                        cx={n.x}
                        cy={n.y}
                        r={n.r}
                        fill="white"
                        stroke={s.ring}
                        strokeWidth="2"
                      />
                      <text
                        x={n.x}
                        y={n.y + n.r + 12}
                        textAnchor="middle"
                        fontSize="10"
                        fontWeight="600"
                        fill="oklch(0.22 0.03 250)"
                      >
                        {n.label}
                      </text>
                    </g>
                  );
                })}
              </svg>
              <div className="absolute bottom-3 right-3 flex gap-1">
                <Button variant="outline" size="sm">
                  Expand
                </Button>
                <Button variant="outline" size="sm">
                  Collapse
                </Button>
                <Button variant="outline" size="sm">
                  Highlight path
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardContent className="p-4">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Selected node
              </div>
              <div className="mt-1 flex items-center gap-2">
                <span
                  className="size-3 rounded-full"
                  style={{ background: TYPE_STYLE.person.fill }}
                />
                <h3 className="text-lg font-semibold">Vector-17</h3>
              </div>
              <Badge variant="outline" className="mt-1">
                Person · Watchlist
              </Badge>
              <dl className="mt-3 space-y-1 text-xs">
                <Row k="Aliases" v="V17, vect_seventeen" />
                <Row k="Country" v="SY / RU" />
                <Row k="First seen" v="2024-04-11" />
                <Row k="Risk score" v="88 / 100" />
                <Row k="Connections" v="12" />
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <h3 className="text-sm font-semibold">Shortest path</h3>
              <p className="mt-1 text-xs text-muted-foreground">Vector-17 → Aster Motors</p>
              <ol className="mt-2 space-y-1 text-xs">
                <li>
                  1. Vector-17 <span className="text-muted-foreground">mentioned</span> Aster Motors
                </li>
                <li>
                  2. Vector-17 <span className="text-muted-foreground">posts via</span> channel_9821{" "}
                  <span className="text-muted-foreground">→</span> @osint_watch{" "}
                  <span className="text-muted-foreground">reports on</span> Aster Motors
                </li>
              </ol>
            </CardContent>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between border-b py-1 last:border-b-0">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="font-medium">{v}</dd>
    </div>
  );
}
