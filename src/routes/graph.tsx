import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { AppShell, PageHeader } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/workspace-ui";
import { Search, ZoomIn, ZoomOut, X, Trash2, Network, Waypoints } from "lucide-react";
import { clearGraphSnapshot, readGraphSnapshot, type GraphSnapshot } from "@/utils/graph-store";
import { layoutRadial, shortestPath } from "@/utils/graph-layout";
import type { EntityType } from "@/utils/collectors/result";

export const Route = createFileRoute("/graph")({
  head: () => ({ meta: [{ title: "Knowledge Graph — Sentinel AI" }] }),
  component: Page,
});

/**
 * `/graph` used to render a fixed 10-node fictional topology ("Vector-17",
 * "Aster Motors") with a `SampleDataBanner` disclosing it. It is now driven
 * entirely by the last investigation saved from `/recon`'s "View in Graph"
 * button (`graph-store.ts`) — there is no seed data left to disclose, so the
 * banner is gone along with the fixture it labelled.
 *
 * 13 evenly-spaced hues (360°/13 ≈ 27.7° apart) so every `EntityType` gets a
 * genuinely distinct color rather than a handful of real types sharing a
 * "misc" bucket.
 */
const TYPE_HUE: Record<EntityType, number> = {
  image: 0,
  phone: 27,
  article: 55,
  location: 83,
  video: 111,
  organization: 138,
  ip: 166,
  domain: 194,
  person: 221,
  url: 249,
  social_account: 277,
  email: 304,
  username: 332,
};

function colorFor(type: EntityType): string {
  return `oklch(0.62 0.17 ${TYPE_HUE[type]})`;
}

const WIDTH = 800;
const HEIGHT = 560;
/** Investigations can return thousands of entities (crt.sh alone can); rendering all of them as SVG nodes is a real DOM-size problem, not just a style one — same reasoning as `MAX_RENDERED_ITEMS` on `/recon`. */
const MAX_GRAPH_NODES = 150;

function Page() {
  const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
  const [ready, setReady] = useState(false);
  const [query, setQuery] = useState("");
  const [zoom, setZoom] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Client-only: the snapshot lives in localStorage, which does not exist during SSR.
  useEffect(() => {
    setSnapshot(readGraphSnapshot());
    setReady(true);
  }, []);

  const entities = useMemo(() => snapshot?.entities ?? [], [snapshot]);
  const relationships = useMemo(() => snapshot?.relationships ?? [], [snapshot]);

  const rootId = useMemo(() => {
    if (!snapshot) return null;
    const target = snapshot.target.trim().toLowerCase();
    return entities.find((e) => e.value.toLowerCase() === target)?.id ?? null;
  }, [snapshot, entities]);

  const layout = useMemo(
    () => layoutRadial(entities, relationships, rootId, { width: WIDTH, height: HEIGHT }),
    [entities, relationships, rootId],
  );

  // Closest-to-root first, so a capped render keeps the entities nearest the
  // investigated target rather than an arbitrary slice.
  const shownNodes = useMemo(
    () =>
      [...layout.nodes]
        .sort((a, b) => (a.ring ?? Infinity) - (b.ring ?? Infinity))
        .slice(0, MAX_GRAPH_NODES),
    [layout],
  );
  const shownIds = useMemo(() => new Set(shownNodes.map((n) => n.id)), [shownNodes]);
  const nodeById = useMemo(() => new Map(shownNodes.map((n) => [n.id, n])), [shownNodes]);
  const entityById = useMemo(() => new Map(entities.map((e) => [e.id, e])), [entities]);
  const shownEdges = useMemo(
    () => relationships.filter((r) => shownIds.has(r.sourceEntity) && shownIds.has(r.targetEntity)),
    [relationships, shownIds],
  );

  const matched = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return shownIds;
    return new Set(
      [...shownIds].filter((id) => {
        const e = entityById.get(id);
        if (!e) return false;
        return (
          e.displayName.toLowerCase().includes(q) ||
          e.value.toLowerCase().includes(q) ||
          e.type.includes(q)
        );
      }),
    );
  }, [shownIds, entityById, query]);

  const vb = useMemo(() => {
    const w = WIDTH / zoom;
    const h = HEIGHT / zoom;
    return `${(WIDTH - w) / 2} ${(HEIGHT - h) / 2} ${w} ${h}`;
  }, [zoom]);

  const selectedEntity = selectedId ? (entityById.get(selectedId) ?? null) : null;
  const selectedDegree = useMemo(() => {
    if (!selectedId) return 0;
    return relationships.filter(
      (r) => r.sourceEntity === selectedId || r.targetEntity === selectedId,
    ).length;
  }, [selectedId, relationships]);
  const rootEntity = rootId ? (entityById.get(rootId) ?? null) : null;

  const pathToRoot = useMemo(() => {
    if (!selectedId || !rootId || selectedId === rootId) return null;
    return shortestPath(entities, relationships, selectedId, rootId);
  }, [selectedId, rootId, entities, relationships]);

  const clear = () => {
    clearGraphSnapshot();
    setSnapshot(null);
    setSelectedId(null);
  };

  if (!ready) return null;

  if (!snapshot || entities.length === 0) {
    return (
      <AppShell>
        <PageHeader
          title="Knowledge Graph"
          description="Explore relationships between people, organizations, places, and digital identifiers."
        />
        <div className="px-6 pt-4">
          <EmptyState
            icon={<Network className="mx-auto mb-1.5 size-5 text-[#F59E0B]" />}
            title="No Investigation Loaded"
            message='Run an investigation on Recon and click "View in Graph" — this page renders only what that investigation actually returned, nothing seeded.'
          />
          <div className="mt-3 text-center">
            <Link
              to="/recon"
              className="font-mono text-[10px] font-bold uppercase tracking-wider text-[#3B82F6] hover:underline"
            >
              Go to Recon →
            </Link>
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <PageHeader
        title="Knowledge Graph"
        description="Explore relationships between people, organizations, places, and digital identifiers."
      />
      <div className="mx-6 mt-4 flex items-center justify-between gap-3 font-mono text-[10px] text-muted-foreground">
        <span>
          Investigation of <span className="font-bold text-foreground">{snapshot.target}</span> ·{" "}
          {entities.length} entities · {relationships.length} relationships
          {entities.length > MAX_GRAPH_NODES &&
            ` — showing the ${MAX_GRAPH_NODES} nearest ${rootEntity ? "to the target" : "loaded"}`}
          {" · saved "}
          {new Date(snapshot.savedAt).toLocaleString()}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={clear}
          className="h-6 gap-1 px-2 font-mono text-[9px] uppercase tracking-wider text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="size-3" />
          Clear
        </Button>
      </div>
      <div className="grid gap-4 px-0 lg:grid-cols-[1fr_320px]">
        <Card className="mx-6">
          <CardContent className="p-0">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="h-8 w-64 pl-8 text-xs"
                  placeholder="Filter nodes by name, value or type..."
                />
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[10px]">
                {(Object.keys(TYPE_HUE) as EntityType[]).map((t) => (
                  <span key={t} className="flex items-center gap-1 text-muted-foreground">
                    <span className="size-2.5 rounded-full" style={{ background: colorFor(t) }} />
                    {t}
                  </span>
                ))}
              </div>
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
                <rect width={WIDTH} height={HEIGHT} fill="url(#grid)" />
                {shownEdges.map((rel, i) => {
                  const a = nodeById.get(rel.sourceEntity);
                  const b = nodeById.get(rel.targetEntity);
                  if (!a || !b) return null;
                  return (
                    <g key={i}>
                      <line
                        x1={a.x}
                        y1={a.y}
                        x2={b.x}
                        y2={b.y}
                        stroke="oklch(0.75 0.03 245)"
                        strokeWidth="1.5"
                      />
                      <text
                        x={(a.x + b.x) / 2}
                        y={(a.y + b.y) / 2 - 4}
                        textAnchor="middle"
                        fontSize="8"
                        fill="oklch(0.5 0.02 250)"
                      >
                        {rel.relationshipType}
                      </text>
                    </g>
                  );
                })}
                {shownNodes.map((n) => {
                  const entity = entityById.get(n.id);
                  if (!entity) return null;
                  const color = colorFor(entity.type);
                  const hit = matched.has(n.id);
                  const isSelected = selectedId === n.id;
                  const isRoot = n.id === rootId;
                  return (
                    <g
                      key={n.id}
                      opacity={hit ? 1 : 0.18}
                      onClick={() => setSelectedId(n.id)}
                      className="cursor-pointer"
                    >
                      <circle cx={n.x} cy={n.y} r={n.r + 6} fill={color} opacity="0.15" />
                      <circle
                        cx={n.x}
                        cy={n.y}
                        r={n.r}
                        fill="white"
                        stroke={color}
                        strokeWidth={isSelected ? 3.5 : 2}
                        strokeDasharray={n.ring === null ? "3 2" : undefined}
                      />
                      {isRoot && (
                        <circle
                          cx={n.x}
                          cy={n.y}
                          r={n.r + 4}
                          fill="none"
                          stroke={color}
                          strokeWidth="1"
                          opacity="0.5"
                        />
                      )}
                      <text
                        x={n.x}
                        y={n.y + n.r + 12}
                        textAnchor="middle"
                        fontSize="10"
                        fontWeight="600"
                        fill="oklch(0.22 0.03 250)"
                      >
                        {entity.displayName.length > 24
                          ? `${entity.displayName.slice(0, 22)}…`
                          : entity.displayName}
                      </text>
                    </g>
                  );
                })}
              </svg>
              <div className="absolute bottom-3 right-3 flex items-center gap-2">
                <span className="rounded border bg-background/80 px-2 py-1 font-mono text-[10px] text-muted-foreground">
                  zoom {zoom.toFixed(1)}x
                </span>
                <Button variant="outline" size="sm" onClick={() => setZoom(1)}>
                  Reset view
                </Button>
              </div>
              {entities.length > MAX_GRAPH_NODES && (
                <div className="absolute left-3 top-3 rounded border bg-background/80 px-2 py-1 font-mono text-[9px] text-muted-foreground">
                  {shownNodes.length} of {entities.length} entities shown (nearest to target)
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <div className="mr-6 space-y-4">
          <Card>
            <CardContent className="p-4">
              {selectedEntity ? (
                <>
                  <div className="flex items-start justify-between">
                    <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                      Selected node
                    </div>
                    <button
                      onClick={() => setSelectedId(null)}
                      aria-label="Clear selection"
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <span
                      className="size-3 rounded-full"
                      style={{ background: colorFor(selectedEntity.type) }}
                    />
                    <h3 className="break-all text-base font-semibold">
                      {selectedEntity.displayName}
                    </h3>
                  </div>
                  <Badge variant="outline" className="mt-1">
                    {selectedEntity.type}
                    {selectedEntity.id === rootId ? " · Investigated target" : ""}
                  </Badge>
                  <dl className="mt-3 space-y-1 text-xs">
                    <Row k="Value" v={selectedEntity.value} />
                    <Row k="Source collector" v={selectedEntity.source} />
                    <Row
                      k="Confidence"
                      v={
                        selectedEntity.confidence.value !== null
                          ? `${Math.round(selectedEntity.confidence.value * 100)}%`
                          : "not scored"
                      }
                    />
                    <Row k="Connections" v={String(selectedDegree)} />
                    <Row
                      k="Distance from target"
                      v={
                        nodeById.get(selectedEntity.id)?.ring === null
                          ? "no path found"
                          : (nodeById.get(selectedEntity.id)?.ring?.toString() ?? "—")
                      }
                    />
                  </dl>
                </>
              ) : (
                <>
                  <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                    Selected node
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Click a node to see its collected details.
                  </p>
                </>
              )}
            </CardContent>
          </Card>
          {selectedEntity && rootEntity && selectedEntity.id !== rootId && (
            <Card>
              <CardContent className="p-4">
                <h3 className="flex items-center gap-1.5 text-sm font-semibold">
                  <Waypoints className="size-3.5" />
                  Path to target
                </h3>
                {pathToRoot ? (
                  <>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {selectedEntity.displayName} → {rootEntity.displayName}
                    </p>
                    <ol className="mt-2 space-y-1 text-xs">
                      {pathToRoot.map((step, i) => {
                        const e = entityById.get(step.entityId);
                        return (
                          <li key={step.entityId}>
                            {i === 0 ? "" : `${i}. `}
                            {step.viaRelationship && (
                              <span className="text-muted-foreground">
                                {step.viaRelationship.toLowerCase().replace(/_/g, " ")}{" "}
                              </span>
                            )}
                            {e?.displayName ?? step.entityId}
                          </li>
                        );
                      })}
                    </ol>
                  </>
                ) : (
                  <p className="mt-1 text-xs text-muted-foreground">
                    No connecting path found in the collected data.
                  </p>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </AppShell>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3 border-b py-1 last:border-b-0">
      <dt className="shrink-0 text-muted-foreground">{k}</dt>
      <dd className="truncate text-right font-medium" title={v}>
        {v}
      </dd>
    </div>
  );
}
