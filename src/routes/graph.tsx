import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { AppShell, PageHeader } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Search, ZoomIn, ZoomOut } from "lucide-react";
import { SampleDataBanner } from "@/components/sample-data-banner";

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
  const [query, setQuery] = useState("");
  const [zoom, setZoom] = useState(1);

  /** Nodes matching the filter box. Empty query shows everything. */
  const matched = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return new Set(NODES.map((n) => n.id));
    return new Set(
      NODES.filter((n) => n.label.toLowerCase().includes(q) || n.type.includes(q)).map((n) => n.id),
    );
  }, [query]);

  // Zoom scales the viewBox about the centre, so the fixed layout stays put.
  const vb = useMemo(() => {
    const w = 800 / zoom;
    const h = 560 / zoom;
    return `${(800 - w) / 2} ${(560 - h) / 2} ${w} ${h}`;
  }, [zoom]);
  return (
    <AppShell>
      <PageHeader
        title="Knowledge Graph"
        description="Explore relationships between people, organizations, places, and digital identifiers."
      />

      {/*
        The SampleDataBanner used to be nested INSIDE the "Path finding" button.
        A measurement of the rendered page found the consequences: the button
        stretched to 1123px because it wrapped the whole 190-character warning,
        its accessible name became the entire disclaimer, the banner overflowed
        its 32px host, "Filter" and "Full screen" were pushed onto a second row,
        and the warning text itself became a click target that activated a
        button with no handler. It failed in the safe direction - the warning
        got bigger, not hidden - but it belongs at page level.

        The three header buttons are gone rather than left inert. "Path
        finding", "Filter" and "Full screen" had no onClick, and neither did
        Expand, Collapse, Highlight path or the two zoom controls. A control
        that cannot do anything is worse than an absent one: it invites the
        analyst to believe the capability exists.
      */}
      <SampleDataBanner detail="This graph is a fixed 10-node topology written into the page. It is NOT derived from collected entities, and no path finding, filtering or expansion is implemented." />
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardContent className="p-0">
            <div className="flex items-center justify-between border-b px-4 py-2">
              {/*
                This was an uncontrolled <Input> with no value and no onChange -
                typing into it did nothing at all. It now filters the fixed node
                set, which is a real (if small) capability over real page state.
              */}
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="h-8 w-64 pl-8 text-xs"
                  placeholder="Filter nodes by label or type..."
                />
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                {Object.entries(TYPE_STYLE).map(([t, s]) => (
                  <span key={t} className="flex items-center gap-1 text-muted-foreground">
                    <span className="size-2.5 rounded-full" style={{ background: s.fill }} />
                    {t}
                  </span>
                ))}
              </div>
              {/*
                Both zoom buttons had no onClick and no aria-label, so they were
                inert AND unreachable by name. They now scale the SVG viewBox,
                which is real behaviour over real state.
              */}
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label="Zoom out"
                  onClick={() => setZoom((z) => Math.max(0.5, Number((z - 0.2).toFixed(2))))}
                >
                  <ZoomOut className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label="Zoom in"
                  onClick={() => setZoom((z) => Math.min(2.5, Number((z + 0.2).toFixed(2))))}
                >
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
              <svg viewBox={vb} className="h-full w-full">
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
                  // Non-matching nodes dim rather than disappear, so the shape
                  // of the graph stays readable while the filter narrows it.
                  const hit = matched.has(n.id);
                  return (
                    <g key={n.id} opacity={hit ? 1 : 0.18}>
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
              {/*
                Expand / Collapse / Highlight path all had no onClick. Expanding
                a node means fetching its neighbours, and this graph has no data
                source to fetch from; highlighting a path means a traversal over
                a real edge set. Removed rather than left as decoration.
              */}
              <div className="absolute bottom-3 right-3 flex items-center gap-2">
                <span className="rounded border bg-background/80 px-2 py-1 font-mono text-[10px] text-muted-foreground">
                  zoom {zoom.toFixed(1)}x
                </span>
                <Button variant="outline" size="sm" onClick={() => setZoom(1)}>
                  Reset view
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
