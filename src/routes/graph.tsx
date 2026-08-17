import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { AppShell, PageHeader } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Search, ZoomIn, ZoomOut, Loader2, AlertTriangle, Info, Network } from "lucide-react";
import { getActiveTarget } from "@/utils/active-target";
import { fetchNews } from "./news";
import { aiExtractEntities, type AnalysisEntity } from "@/utils/analysis-llm";
import { clusterStories, type Article } from "@/utils/analysis";
import { defaultFactors, scoreCorpus, type CredibilityScore } from "@/utils/credibility";
import {
  buildEntityGraph,
  layoutGraph,
  nodeRadius,
  shortestPath,
  COOCCURRENCE_CAVEAT,
  type EntityGraph,
  type GraphArticleInput,
  type PositionedNode,
} from "@/utils/graph-build";
import { PinButton } from "@/components/pin-button";
import type { EntityType } from "@/types/core";

/**
 * Knowledge Graph — Module 2.
 *
 * What this page used to be: ten nodes and ten edges written into the file, with
 * literal x/y coordinates. Vector-17, Aster Motors, channel_9821,
 * vector17@proton.me, "+91 98••••4211". No fetch, no server function, no
 * `useEffect` anywhere in the module. Beside it, a permanently-selected node card
 * asserting "Risk score 88 / 100" and "Connections 12" — a number that
 * contradicted the ten edges drawn next to it — and a hardcoded "Shortest path"
 * naming the same three fictional entities every time.
 *
 * It now runs the pipeline `/entities` already runs successfully: collect a live
 * corpus for the active target, extract entities per article with the configured
 * open-weight model, and build a co-occurrence graph from the result. Every node
 * and edge traces back to article ids the analyst can open.
 *
 * Extraction stays MANUAL. One model call per article on page load would empty a
 * free tier immediately — the same reason `/entities` makes it a per-article
 * button.
 */

export const Route = createFileRoute("/graph")({
  head: () => ({ meta: [{ title: "Knowledge Graph — Sentinel AI" }] }),
  component: Page,
});

/**
 * Colours for the canonical `core.ts` vocabulary.
 *
 * The old legend also listed `domain`, `phone`, `email` and `social`. No
 * extractor in this system produces those types, so a legend entry for them
 * advertised a capability that does not exist.
 */
const TYPE_STYLE: Record<EntityType, string> = {
  PERSON: "oklch(0.6 0.19 255)",
  ORG: "oklch(0.68 0.17 145)",
  LOCATION: "oklch(0.78 0.16 85)",
  EVENT: "oklch(0.62 0.23 27)",
  EQUIPMENT: "oklch(0.55 0.15 300)",
  OTHER: "oklch(0.5 0.02 250)",
};

const VIEW_W = 800;
const VIEW_H = 560;

function Page() {
  const [target, setTarget] = useState(() => getActiveTarget());
  const [searchVal, setSearchVal] = useState(() => getActiveTarget());

  const [corpus, setCorpus] = useState<Article[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [extracted, setExtracted] = useState<Record<string, AnalysisEntity[]>>({});
  const [extracting, setExtracting] = useState(false);
  const [extractProgress, setExtractProgress] = useState({ done: 0, total: 0 });
  const [extractError, setExtractError] = useState("");
  const [model, setModel] = useState("");

  const [query, setQuery] = useState("");
  const [zoom, setZoom] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pathFrom, setPathFrom] = useState<string | null>(null);

  useEffect(() => {
    const handler = (e: any) => {
      if (e.detail) {
        setTarget(e.detail);
        setSearchVal(e.detail);
      }
    };
    window.addEventListener("sentinel_target_changed", handler);
    return () => window.removeEventListener("sentinel_target_changed", handler);
  }, []);

  // Collect a live corpus for the target. Extraction never runs automatically.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError("");
      setExtracted({});
      setExtractError("");
      setSelectedId(null);
      setPathFrom(null);
      try {
        const res: any = await fetchNews({ data: { query: target } });
        if (cancelled) return;
        const mapped: Article[] = (res?.stories ?? [])
          .map((s: any, i: number) => ({
            id: String(s.id ?? s.primaryLink ?? s.url ?? i),
            title: s.primaryTitle || "",
            source: s.primarySource || "",
            url: s.primaryLink || s.url || "",
            pubDate: s.pubDate || "",
            body: s.body || "",
          }))
          .filter((a: Article) => a.title);
        setCorpus(mapped);
      } catch (err: any) {
        if (!cancelled) setLoadError(err?.message ?? String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target]);

  // Module 1 scores, so a node can report the best-scored article naming it.
  const scores = useMemo<Map<string, CredibilityScore>>(() => {
    if (corpus.length === 0) return new Map();
    const clusters = clusterStories(corpus);
    return new Map(
      scoreCorpus(corpus, defaultFactors(), { clusters }).map((s) => [s.article.id, s]),
    );
  }, [corpus]);

  const graph: EntityGraph = useMemo(() => {
    const articles: GraphArticleInput[] = corpus
      .filter((a) => extracted[a.id]?.length)
      .map((a) => ({
        id: a.id,
        source: a.source,
        url: a.url,
        credibility: scores.get(a.id)?.score ?? null,
        entities: extracted[a.id].map((e) => ({
          entity: e.entity,
          type: e.type,
          confidence: e.confidence,
        })),
      }));
    return buildEntityGraph(articles);
  }, [corpus, extracted, scores]);

  const positioned: PositionedNode[] = useMemo(
    () => layoutGraph(graph, { width: VIEW_W, height: VIEW_H }),
    [graph],
  );
  const byId = useMemo(() => new Map(positioned.map((n) => [n.id, n])), [positioned]);

  const matched = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return new Set(positioned.map((n) => n.id));
    return new Set(
      positioned
        .filter((n) => n.label.toLowerCase().includes(q) || n.type.toLowerCase().includes(q))
        .map((n) => n.id),
    );
  }, [query, positioned]);

  const selected = selectedId ? (byId.get(selectedId) ?? null) : null;

  /** Path between the pinned start node and the current selection. */
  const path = useMemo(() => {
    if (!pathFrom || !selectedId || pathFrom === selectedId) return null;
    return shortestPath(graph, pathFrom, selectedId);
  }, [graph, pathFrom, selectedId]);
  const pathEdges = useMemo(() => {
    if (!path) return new Set<string>();
    const s = new Set<string>();
    for (let i = 0; i < path.length - 1; i += 1) {
      const [a, b] = path[i] < path[i + 1] ? [path[i], path[i + 1]] : [path[i + 1], path[i]];
      s.add(`${a}|${b}`);
    }
    return s;
  }, [path]);

  const vb = useMemo(() => {
    const w = VIEW_W / zoom;
    const h = VIEW_H / zoom;
    return `${(VIEW_W - w) / 2} ${(VIEW_H - h) / 2} ${w} ${h}`;
  }, [zoom]);

  const runExtraction = async () => {
    const pending = corpus.filter((a) => !extracted[a.id]);
    if (pending.length === 0) return;
    setExtracting(true);
    setExtractError("");
    setExtractProgress({ done: 0, total: pending.length });
    for (let i = 0; i < pending.length; i += 1) {
      const article = pending[i];
      try {
        const res: any = await aiExtractEntities({ data: { article } });
        setExtracted((prev) => ({ ...prev, [article.id]: res.entities ?? [] }));
        setModel(res.model);
      } catch (err: any) {
        // Stop on the first failure and say how far it got. Continuing would
        // build a graph over a partial corpus without saying so.
        setExtractError(
          `${err?.message ?? String(err)} — stopped after ${i} of ${pending.length} article(s).`,
        );
        break;
      }
      setExtractProgress({ done: i + 1, total: pending.length });
    }
    setExtracting(false);
  };

  const analysed = Object.keys(extracted).length;

  return (
    <AppShell>
      <PageHeader
        title="Knowledge Graph"
        description="Entities co-mentioned across live open-source reporting on the active subject. Every node and edge is derived from collected articles."
      />

      <Card className="mb-4">
        <CardContent className="p-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchVal}
              onChange={(e) => setSearchVal(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && setTarget(searchVal.trim() || target)}
              placeholder="Subject to collect reporting on..."
              className="h-11 pl-9 pr-28 text-base"
            />
            <Button
              size="sm"
              onClick={() => setTarget(searchVal.trim() || target)}
              className="absolute right-1.5 top-1/2 -translate-y-1/2"
            >
              Collect
            </Button>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3 text-xs">
            <span className="text-muted-foreground">
              {loading
                ? "Collecting corpus…"
                : `${corpus.length} article(s) collected · ${analysed} analysed`}
            </span>
            <Button
              size="sm"
              variant="outline"
              className="ml-auto h-8 gap-1.5"
              disabled={extracting || loading || corpus.length === 0 || analysed === corpus.length}
              onClick={runExtraction}
            >
              {extracting ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Network className="size-3.5" />
              )}
              {extracting
                ? `Extracting ${extractProgress.done}/${extractProgress.total}…`
                : `Extract entities from ${corpus.length - analysed} article(s)`}
            </Button>
            {model && <span className="font-mono text-[10px] text-muted-foreground">{model}</span>}
          </div>

          <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
            <Info className="mt-px size-3 shrink-0" />
            Extraction is one model call per article and is never run automatically — on a free
            tier, extracting a whole corpus on page load would exhaust it. {COOCCURRENCE_CAVEAT}
          </p>
        </CardContent>
      </Card>

      {loadError && (
        <Card className="mb-4 border-destructive/40">
          <CardContent className="flex items-start gap-2 p-3">
            <AlertTriangle className="size-4 shrink-0 text-destructive" />
            <div className="font-mono text-[11px] text-destructive">
              <span className="font-bold">Collection failed.</span> No corpus was retrieved for
              this subject.
              <div className="pt-0.5 opacity-80">{loadError}</div>
            </div>
          </CardContent>
        </Card>
      )}

      {extractError && (
        <Card className="mb-4 border-destructive/40">
          <CardContent className="flex items-start gap-2 p-3">
            <AlertTriangle className="size-4 shrink-0 text-destructive" />
            <div className="font-mono text-[11px] text-destructive">
              <span className="font-bold">Extraction failed.</span> The graph below covers only
              the articles that completed.
              <div className="pt-0.5 opacity-80">{extractError}</div>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardContent className="p-0">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="h-8 w-56 pl-8 text-xs"
                  placeholder="Filter nodes by label or type..."
                />
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                {Object.entries(TYPE_STYLE).map(([t, fill]) => (
                  <span key={t} className="flex items-center gap-1 text-muted-foreground">
                    <span className="size-2.5 rounded-full" style={{ background: fill }} />
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
              {positioned.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center px-8 text-center">
                  <Network className="size-8 text-muted-foreground/40" />
                  <p className="mt-3 text-sm font-medium">No graph yet.</p>
                  <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
                    {corpus.length === 0
                      ? "No corpus collected for this subject. Search above to collect open-source reporting."
                      : "Nothing has been extracted yet. Run extraction to build the graph from the collected articles — this page holds no sample topology of its own."}
                  </p>
                </div>
              ) : (
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
                  <rect width={VIEW_W} height={VIEW_H} fill="url(#grid)" />

                  {graph.edges.map((e) => {
                    const na = byId.get(e.a);
                    const nb = byId.get(e.b);
                    if (!na || !nb) return null;
                    const onPath = pathEdges.has(`${e.a}|${e.b}`);
                    const dim = !matched.has(e.a) && !matched.has(e.b);
                    return (
                      <line
                        key={`${e.a}|${e.b}`}
                        x1={na.x}
                        y1={na.y}
                        x2={nb.x}
                        y2={nb.y}
                        stroke={onPath ? "oklch(0.62 0.23 27)" : "oklch(0.75 0.03 245)"}
                        strokeWidth={onPath ? 3 : Math.min(4, 1 + e.weight * 0.6)}
                        opacity={dim ? 0.12 : 0.85}
                      >
                        <title>{`${na.label} — ${nb.label}: named together in ${e.weight} article(s)`}</title>
                      </line>
                    );
                  })}

                  {positioned.map((n) => {
                    const hit = matched.has(n.id);
                    const r = nodeRadius(n);
                    const isSelected = n.id === selectedId;
                    const isStart = n.id === pathFrom;
                    return (
                      <g
                        key={n.id}
                        opacity={hit ? 1 : 0.18}
                        onClick={() => setSelectedId(n.id)}
                        style={{ cursor: "pointer" }}
                      >
                        <circle cx={n.x} cy={n.y} r={r + 6} fill={TYPE_STYLE[n.type]} opacity={0.15} />
                        <circle
                          cx={n.x}
                          cy={n.y}
                          r={r}
                          fill="white"
                          stroke={
                            isStart
                              ? "oklch(0.62 0.23 27)"
                              : isSelected
                                ? "oklch(0.3 0.02 250)"
                                : TYPE_STYLE[n.type]
                          }
                          strokeWidth={isSelected || isStart ? 4 : 2}
                        />
                        <text
                          x={n.x}
                          y={n.y + r + 12}
                          textAnchor="middle"
                          fontSize="10"
                          fontWeight="600"
                          fill="oklch(0.22 0.03 250)"
                        >
                          {n.label.length > 24 ? `${n.label.slice(0, 23)}…` : n.label}
                        </text>
                        <title>{`${n.label} · ${n.type} · degree ${n.degree} · ${n.articleIds.length} article(s)`}</title>
                      </g>
                    );
                  })}
                </svg>
              )}

              {positioned.length > 0 && (
                <div className="absolute bottom-3 right-3 flex items-center gap-2">
                  <span className="rounded border bg-background/80 px-2 py-1 font-mono text-[10px] text-muted-foreground">
                    {graph.nodes.length} nodes · {graph.edges.length} edges · zoom{" "}
                    {zoom.toFixed(1)}x
                  </span>
                  <Button variant="outline" size="sm" onClick={() => setZoom(1)}>
                    Reset view
                  </Button>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardContent className="p-4">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Selected node
              </div>
              {!selected ? (
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  Click a node. This panel previously showed a fixed entity with a
                  &ldquo;Risk score 88 / 100&rdquo; and &ldquo;Connections 12&rdquo; regardless of
                  what was on screen. Nothing in this system computes a risk score, so none is
                  shown.
                </p>
              ) : (
                <>
                  <div className="mt-1 flex items-center gap-2">
                    <span
                      className="size-3 rounded-full"
                      style={{ background: TYPE_STYLE[selected.type] }}
                    />
                    <h3 className="text-base font-semibold">{selected.label}</h3>
                  </div>
                  <Badge variant="outline" className="mt-1">
                    {selected.type}
                  </Badge>

                  <dl className="mt-3 space-y-1 text-xs">
                    <Row k="Connections" v={String(selected.degree)} />
                    <Row k="Articles naming it" v={String(selected.articleIds.length)} />
                    <Row k="Distinct publishers" v={String(selected.sources.length)} />
                    <Row
                      k="Best extractor confidence"
                      v={`${(selected.bestConfidence * 100).toFixed(0)}%`}
                    />
                    <Row
                      k="Best Module 1 credibility"
                      v={
                        selected.bestCredibility === null
                          ? "not scored"
                          : `${(selected.bestCredibility * 100).toFixed(0)}%`
                      }
                    />
                  </dl>

                  <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
                    Confidence and credibility are the highest observed, never a mean — averaging
                    two model-reported confidences produces a third number no model asserted.
                  </p>

                  <div className="mt-3 flex flex-wrap gap-1.5">
                    <Button
                      size="sm"
                      variant={pathFrom === selected.id ? "default" : "outline"}
                      className="h-7 text-[11px]"
                      onClick={() =>
                        setPathFrom((p) => (p === selected.id ? null : selected.id))
                      }
                    >
                      {pathFrom === selected.id ? "Path start set" : "Set as path start"}
                    </Button>
                    <PinButton
                      label="Pin"
                      payload={{
                        kind: "note",
                        title: `Entity: ${selected.label} (${selected.type})`,
                        source: `Module 2 knowledge graph · ${selected.sources.length} publisher(s)`,
                        publishedAt: "",
                        excerpt:
                          `${selected.label} (${selected.type}) was named in ` +
                          `${selected.articleIds.length} collected article(s) from ` +
                          `${selected.sources.length} distinct publisher(s), co-mentioned with ` +
                          `${selected.degree} other entity/entities. ${COOCCURRENCE_CAVEAT}`,
                        credibility: selected.bestCredibility,
                        credibilityRationale:
                          selected.bestCredibility === null
                            ? "No article naming this entity carried a Module 1 score."
                            : "Highest Module 1 score among the articles naming this entity.",
                      }}
                    />
                  </div>

                  <div className="mt-3 border-t pt-2">
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      Source articles
                    </div>
                    <ul className="mt-1 space-y-1">
                      {selected.articleIds.map((id) => {
                        const a = corpus.find((x) => x.id === id);
                        if (!a) return null;
                        return (
                          <li key={id} className="text-[11px] leading-snug">
                            <a
                              href={a.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-primary hover:underline"
                            >
                              {a.title.slice(0, 70)}
                              {a.title.length > 70 ? "…" : ""}
                            </a>
                            <span className="text-muted-foreground">
                              {" "}
                              — {a.source || "publisher not reported"}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="p-4">
              <h3 className="text-sm font-semibold">Shortest path</h3>
              {!pathFrom || !selectedId ? (
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Select a node, press &ldquo;Set as path start&rdquo;, then select a second node.
                  This card used to print a fixed two-hop route between the same fictional
                  entities on every load.
                </p>
              ) : pathFrom === selectedId ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Start and end are the same node.
                </p>
              ) : path === null ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  <strong>No path found in the collected graph.</strong> These two entities were
                  never named in the same article, and no chain of co-mentions connects them.
                  That is a finding about the corpus, not a failure.
                </p>
              ) : (
                <ol className="mt-2 space-y-1 text-xs">
                  {path.map((id, i) => (
                    <li key={id}>
                      {i + 1}. {byId.get(id)?.label ?? id}
                      {i < path.length - 1 && (
                        <span className="text-muted-foreground"> → co-mentioned with</span>
                      )}
                    </li>
                  ))}
                </ol>
              )}
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
