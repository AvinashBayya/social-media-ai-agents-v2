import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppShell, PageHeader } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/workspace-ui";
import {
  Search,
  ZoomIn,
  ZoomOut,
  X,
  Trash2,
  Network,
  Waypoints,
  Download,
  Loader2,
  AlertTriangle,
  Info,
  Sparkles,
  Clock,
  FolderOpen,
} from "lucide-react";
import {
  clearGraphForCase,
  clearGraphSnapshot,
  getGraphForCase,
  graphEvictedCases,
  graphScopedCases,
  readGraphSnapshot,
  saveGraphSnapshot,
  type GraphSnapshot,
  type ScopedGraphSnapshot,
} from "@/utils/graph-store";
import { SnapshotProvenanceLine } from "@/components/snapshot-provenance";
import { CaseSnapshotSelector } from "@/components/case-snapshot-selector";
import {
  UNSCOPED_SELECTION,
  buildSnapshotOptions,
  resolveSnapshotSelection,
} from "@/utils/cases/case-snapshot-selection";
import { MAX_SCOPED_CASES } from "@/utils/cases/case-scope";
import { resolutionSummary, resolvedCaseEntities } from "@/utils/cases/case-entities";
import { INVESTIGATIONS_CHANGED_EVENT, getInvestigations } from "@/utils/investigations-store";
import { toMaltegoCsv } from "@/utils/maltego-export";
import { getActiveTarget } from "@/utils/active-target";
import {
  startOsintInvestigationJob,
  pollOsintInvestigationJob,
  type InvestigationPoll,
} from "@/utils/osint/jobs";
import { fetchNews } from "./news";
import { aiExtractEntities, type AnalysisEntity } from "@/utils/analysis-llm";
import { clusterStories, type Article } from "@/utils/analysis";
import { defaultFactors, scoreCorpus, type CredibilityScore } from "@/utils/credibility";
import { buildEntityGraph, type EntityGraph, type GraphArticleInput } from "@/utils/graph-build";
import {
  colourFor,
  emptyView,
  matchNodes,
  pathBetween,
  typeLegend,
  viewFromCorpus,
  viewFromInvestigation,
  type GraphSource,
  type GraphView,
} from "@/utils/graph-view";

const POLL_INTERVAL_MS = 1200;

export const Route = createFileRoute("/graph")({
  /**
   * `?case=INV-1001` preselects a case's snapshot — so "View in Graph" from a
   * case run, and Timeline↔Graph cross-links, keep the case they were opened
   * with instead of silently landing on the unscoped/latest slot. Validation is
   * strict about SHAPE, not existence: an id with no snapshot renders the
   * selection's own empty state (see the `!hasGraph` branch), never a fallback.
   */
  validateSearch: (search: Record<string, unknown>): { case?: string } => {
    const raw = search.case;
    if (typeof raw !== "string") return {};
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > 64) return {};
    return { case: trimmed };
  },
  head: () => ({ meta: [{ title: "Knowledge Graph — Sentinel AI" }] }),
  component: Page,
});

/**
 * Knowledge Graph — TWO SOURCES, ONE RENDERER.
 *
 * This route was the collision point of two features built in parallel, each
 * assuming it owned `/graph`:
 *
 *   INVESTIGATION  the OSINT collector framework's entity/relationship set,
 *                  handed over from `/recon`'s "View in Graph"
 *                  (`graph-store.ts` → `graph-layout.ts`). Exports to Maltego.
 *   CORPUS         Module 2's entity CO-OCCURRENCE across live reporting on
 *                  the active subject (`graph-build.ts`).
 *
 * They are not two versions of one page — they answer different questions from
 * different data, and deleting either lost a working capability. Both now live
 * here behind an explicit source switch, normalised through
 * `utils/graph-view.ts` so there is ONE layout contract, ONE cap policy, ONE
 * search and ONE SVG renderer rather than two of each.
 *
 * Neither engine was rewritten. `layoutRadial`, `shortestPath` (both of them),
 * `buildEntityGraph`, `layoutGraph` and `toMaltegoCsv` are untouched; the view
 * model adapts their output rather than replacing them.
 *
 * WHAT EACH SOURCE MAY CLAIM DIFFERS, and the UI must not blur it. The
 * investigation graph has a root (the investigated target) and rings measuring
 * distance from it; co-occurrence has neither, so those controls are absent
 * rather than shown empty. Maltego export is offered only for the
 * investigation, because the corpus vocabulary has no collector-side
 * equivalent for EVENT, EQUIPMENT or OTHER and exporting would mean assigning a
 * Maltego type nobody measured.
 */

const WIDTH = 800;
const HEIGHT = 560;

function Page() {
  // A case handed in via `?case=` (from a case run's "View in Graph", or the
  // Timeline↔Graph cross-link). Seeds the case selection and forces the
  // investigation source below.
  const { case: requestedCase } = Route.useSearch();

  const [source, setSource] = useState<GraphSource>("investigation");
  const [ready, setReady] = useState(false);

  // Shared view chrome.
  const [query, setQuery] = useState("");
  const [zoom, setZoom] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pathFrom, setPathFrom] = useState<string | null>(null);

  // ── Investigation source ────────────────────────────────────────────────
  //
  // The analyst picks which case's snapshot to view. Nothing is inferred: the
  // default is the unscoped/latest slot, which is exactly what /recon's "View
  // in Graph" hand-off writes, so that hand-off keeps working.
  const [selection, setSelection] = useState<string>(requestedCase ?? UNSCOPED_SELECTION);
  const [cases, setCases] = useState<Array<{ id: string; target: string }>>([]);
  const [scopedIds, setScopedIds] = useState<string[]>([]);
  const [evictedIds, setEvictedIds] = useState<string[]>([]);
  const [unscoped, setUnscoped] = useState<GraphSnapshot | null>(null);
  const [scoped, setScoped] = useState<ScopedGraphSnapshot | null>(null);

  // "Generate" — runs the SAME real OSINT investigation /recon's
  // "OSINT Investigation" panel does (startOsintInvestigationJob +
  // pollOsintInvestigationJob, the real collector job pipeline), just
  // triggered directly from /graph instead of requiring a trip to /recon
  // and a manual "View in Graph". Every entity/relationship this produces
  // is real collector output — nothing here invents graph content; an
  // earlier ask for an AI-generated graph was declined for exactly that
  // reason (see the chat writeup).
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState("");
  const [generatePoll, setGeneratePoll] = useState<InvestigationPoll | null>(null);
  const [generateTarget, setGenerateTarget] = useState("");
  const generateStoppedRef = useRef(false);

  // Client-only: every store here is localStorage, absent during SSR.
  useEffect(() => {
    const load = () => {
      setCases(getInvestigations().map((c) => ({ id: c.id, target: c.target })));
      setScopedIds(graphScopedCases());
      setEvictedIds(graphEvictedCases());
      setUnscoped(readGraphSnapshot());
    };
    load();
    window.addEventListener(INVESTIGATIONS_CHANGED_EVENT, load);
    return () => window.removeEventListener(INVESTIGATIONS_CHANGED_EVENT, load);
  }, []);

  // Re-read per selection rather than caching: a run in another tab can land
  // between selections, and a stale cache would show data the store no longer
  // holds.
  useEffect(() => {
    setScoped(selection === UNSCOPED_SELECTION ? null : getGraphForCase(selection));
    // Changing case is the natural refresh point for both lists: a run in
    // another tab writes snapshots and evicts without firing an investigations
    // event, so mount-time values can be stale by now.
    setScopedIds(graphScopedCases());
    setEvictedIds(graphEvictedCases());
  }, [selection]);

  const display = useMemo(
    () => resolveSnapshotSelection(selection, scoped, unscoped, "graph", evictedIds),
    [selection, scoped, unscoped, evictedIds],
  );
  /**
   * The snapshot actually rendered, or null.
   *
   * `display.show === false` collapses to null on purpose — a selected case
   * with no snapshot renders an empty state, never the latest run as a
   * stand-in. `getGraphForCase` does return the unscoped slot as a labelled
   * fallback, which is right for the case *panel* ("something is here and it
   * isn't yours") and wrong here: the analyst asked for case A, so anything
   * that is not case A's is not an answer.
   */
  const rawSnapshot = display.show ? display.snapshot : null;

  /**
   * The graph renders RESOLVED identities.
   *
   * The stored snapshot holds one entity per collector record, so `dns` and
   * `shodan` reporting the same IP drew two nodes for one address. Resolution
   * merges them and remaps every edge; entities and relationships are replaced
   * together, because `viewFromInvestigation` filters edges to known node ids
   * and a half-resolved snapshot would silently drop them.
   *
   * Storage is untouched — this is a view.
   */
  const resolvedEntities = useMemo(
    () =>
      rawSnapshot
        ? resolvedCaseEntities({
            entities: rawSnapshot.entities,
            relationships: rawSnapshot.relationships,
          })
        : null,
    [rawSnapshot],
  );

  const snapshot = useMemo(
    () =>
      rawSnapshot && resolvedEntities
        ? {
            ...rawSnapshot,
            entities: resolvedEntities.entities,
            relationships: resolvedEntities.relationships,
          }
        : null,
    [rawSnapshot, resolvedEntities],
  );
  const options = useMemo(
    () => buildSnapshotOptions(cases, scopedIds, !!unscoped, evictedIds),
    [cases, scopedIds, unscoped, evictedIds],
  );

  const runGenerate = async () => {
    const target = getActiveTarget().trim();
    if (!target) {
      setGenerateError("No active target set — set one from the search bar above first.");
      return;
    }
    setGenerating(true);
    setGenerateError("");
    setGeneratePoll(null);
    setGenerateTarget(target);
    generateStoppedRef.current = false;
    try {
      const started = await startOsintInvestigationJob({ data: { target } });
      const tick = async (): Promise<void> => {
        let data: InvestigationPoll;
        try {
          data = await pollOsintInvestigationJob({ data: { investigationId: started.investigationId } });
        } catch (err) {
          if (generateStoppedRef.current) return;
          setGenerateError(err instanceof Error ? err.message : String(err));
          setGenerating(false);
          return;
        }
        if (generateStoppedRef.current) return;
        setGeneratePoll(data);
        if (!data.done) {
          setTimeout(tick, POLL_INTERVAL_MS);
          return;
        }
        setGenerating(false);
        if (data.entities.length === 0) {
          setGenerateError(
            `Investigation for "${target}" completed but returned 0 entities` +
              (data.errors.length > 0 ? `: ${data.errors.join("; ")}` : " — nothing to graph."),
          );
          return;
        }
        // Written to whichever slot the analyst is currently viewing, mirroring
        // the case runs panel — a case selected here means the analyst wants
        // THIS case's snapshot updated, not the unscoped/latest one.
        const caseId = selection === UNSCOPED_SELECTION ? undefined : selection;
        saveGraphSnapshot({
          investigationId: started.investigationId,
          caseId,
          target,
          savedAt: new Date().toISOString(),
          entities: data.entities,
          relationships: data.relationships,
        });
        if (caseId) {
          setScoped(getGraphForCase(caseId));
          setScopedIds(graphScopedCases());
        } else {
          setUnscoped(readGraphSnapshot());
        }
        setSelectedId(null);
      };
      void tick();
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : String(err));
      setGenerating(false);
    }
  };

  useEffect(() => {
    return () => {
      generateStoppedRef.current = true;
    };
  }, []);

  // Default to whichever source actually has something. The snapshot is an
  // explicit hand-off an analyst just performed, so it wins when present;
  // otherwise land on the source that can still produce a graph rather than
  // on an empty state. Runs once — after that the analyst owns the choice.
  useEffect(() => {
    if (ready) return;
    // A `?case=` hand-off means the analyst asked for a SPECIFIC case's graph,
    // so stay on the investigation source even when the unscoped slot is empty —
    // the selection's own empty state is the honest answer, not the corpus.
    if (!requestedCase) {
      const snap = readGraphSnapshot();
      if (!snap || snap.entities.length === 0) setSource("corpus");
    }
    setReady(true);
  }, [ready]);

  // ── Corpus source ───────────────────────────────────────────────────────
  const [target, setTarget] = useState(() => getActiveTarget());
  const [corpus, setCorpus] = useState<Article[]>([]);
  const [corpusLoading, setCorpusLoading] = useState(false);
  const [corpusLoaded, setCorpusLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [extracted, setExtracted] = useState<Record<string, AnalysisEntity[]>>({});
  const [extracting, setExtracting] = useState(false);
  const [extractProgress, setExtractProgress] = useState({ done: 0, total: 0 });
  const [extractError, setExtractError] = useState("");
  const [model, setModel] = useState("");

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (detail) setTarget(detail);
    };
    window.addEventListener("sentinel_target_changed", handler);
    return () => window.removeEventListener("sentinel_target_changed", handler);
  }, []);

  /**
   * Collect the corpus LAZILY — only once the analyst selects this source.
   *
   * The previous single-source page fetched on mount. Now that the
   * investigation graph is the usual landing state, an unconditional fetch
   * would spend a Google News request on every visit to a page that is not
   * showing news. Extraction stays manual for the stronger version of the same
   * reason: one model call per article on load empties a free tier.
   */
  useEffect(() => {
    if (source !== "corpus") return;
    let cancelled = false;
    (async () => {
      setCorpusLoading(true);
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
        setCorpusLoaded(true);
      } catch (err: any) {
        if (!cancelled) setLoadError(err?.message ?? String(err));
      } finally {
        if (!cancelled) setCorpusLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, target]);

  const generateJobsSummary = useMemo(() => {
    const jobs = generatePoll?.jobs ?? [];
    if (jobs.length === 0) return null;
    const done = jobs.filter((j) => j.status !== "queued" && j.status !== "running").length;
    return { done, total: jobs.length };
  }, [generatePoll]);

  /** Module 1 scores, so a node can report the best-scored article naming it. */
  const scores = useMemo<Map<string, CredibilityScore>>(() => {
    if (corpus.length === 0) return new Map();
    const clusters = clusterStories(corpus);
    return new Map(
      scoreCorpus(corpus, defaultFactors(), { clusters }).map((s) => [s.article.id, s]),
    );
  }, [corpus]);

  const corpusGraph: EntityGraph = useMemo(() => {
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

  // ── The one view both sources render through ────────────────────────────
  const view: GraphView = useMemo(() => {
    if (source === "investigation") {
      if (!snapshot || snapshot.entities.length === 0) return emptyView("investigation");
      return viewFromInvestigation(snapshot, { width: WIDTH, height: HEIGHT });
    }
    if (corpusGraph.nodes.length === 0) return emptyView("corpus");
    return viewFromCorpus(corpusGraph, { width: WIDTH, height: HEIGHT });
  }, [source, snapshot, corpusGraph]);

  const nodeById = useMemo(() => new Map(view.nodes.map((n) => [n.id, n])), [view]);
  const matched = useMemo(() => matchNodes(view, query), [view, query]);
  const legend = useMemo(() => typeLegend(view), [view]);
  const selected = selectedId ? (nodeById.get(selectedId) ?? null) : null;
  const rootNode = view.rootId ? (nodeById.get(view.rootId) ?? null) : null;

  const vb = useMemo(() => {
    const w = WIDTH / zoom;
    const h = HEIGHT / zoom;
    return `${(WIDTH - w) / 2} ${(HEIGHT - h) / 2} ${w} ${h}`;
  }, [zoom]);

  /**
   * Path endpoints differ by source, and that is a real difference rather than
   * an inconsistency. The investigation graph has an investigated target, so
   * "path to target" is the question worth answering automatically.
   * Co-occurrence has no privileged node, so the analyst pins a start node
   * themselves.
   */
  const pathStart = source === "investigation" ? view.rootId : pathFrom;
  const path = useMemo(() => {
    if (!pathStart || !selectedId || pathStart === selectedId) return null;
    const raw =
      source === "investigation"
        ? { entities: snapshot?.entities ?? [], relationships: snapshot?.relationships ?? [] }
        : corpusGraph;
    // Investigation paths read selection → target; corpus paths read pinned
    // start → selection. Both end at the node the analyst is looking at.
    return source === "investigation"
      ? pathBetween(view, raw, selectedId, pathStart)
      : pathBetween(view, raw, pathStart, selectedId);
  }, [view, source, snapshot, corpusGraph, pathStart, selectedId]);

  const switchSource = useCallback((next: GraphSource) => {
    setSource(next);
    setSelectedId(null);
    setPathFrom(null);
    setQuery("");
  }, []);

  /**
   * Changing case must reset the view chrome, for the same reason changing
   * source does: node ids are per-snapshot, so a selection or path endpoint
   * carried across would either resolve to nothing or — worse — collide with a
   * different entity that happens to share an id.
   */
  const switchSelection = useCallback((next: string) => {
    setSelection(next);
    setSelectedId(null);
    setPathFrom(null);
    setQuery("");
  }, []);

  /**
   * Clears the slot the analyst is actually looking at.
   *
   * Before the selector existed there was only one slot, so `clearGraphSnapshot()`
   * was unambiguous. Now it is not: leaving it as-is would mean pressing Clear
   * while viewing case A wiped the *latest-run* slot and left A's graph on
   * screen — a control that appears to do nothing, which is the "control with no
   * handler" failure class this project already logged once.
   */
  const clear = () => {
    if (selection === UNSCOPED_SELECTION) {
      clearGraphSnapshot();
      setUnscoped(null);
    } else {
      clearGraphForCase(selection);
      setScoped(getGraphForCase(selection));
      setScopedIds(graphScopedCases());
      // A manual Clear is NOT an eviction — the analyst chose it, storage
      // pressure did not force it — so the ledger is deliberately not written.
      setEvictedIds(graphEvictedCases());
    }
    setSelectedId(null);
  };

  /**
   * Exports the FULL entity/relationship set, not the rendered subset — the
   * on-screen cap exists for DOM performance, not because the rest of the data
   * is less real. Handing off to Maltego is exactly the case where the analyst
   * wants everything, not just what fit on screen.
   */
  const exportMaltego = () => {
    if (!snapshot) return;
    const csv = toMaltegoCsv(snapshot.entities, snapshot.relationships);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sentinel-maltego_${snapshot.target.replace(/[^a-zA-Z0-9]/g, "_")}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const generateButton = (
    <Button
      variant="outline"
      size="sm"
      onClick={runGenerate}
      disabled={generating}
      className="h-7 gap-1.5 px-3 font-mono text-[10px] font-bold uppercase tracking-wider"
    >
      {generating ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
      {generating ? "Generating…" : "Generate"}
    </Button>
  );

  // Real progress from the real job poll — `generateJobsSummary` counts
  // actual terminal-status collector jobs, never a guessed fraction (see
  // `InvestigationJob.progress`'s own null-while-running rule in job-store.ts).
  const generateStatus = (generating || generateError) && (
    <div className="mt-2 font-mono text-[10px] text-muted-foreground">
      {generating && (
        <span>
          Running a real OSINT investigation for <span className="font-bold">{generateTarget}</span>
          {generateJobsSummary ? ` — ${generateJobsSummary.done}/${generateJobsSummary.total} collectors done` : "…"}
        </span>
      )}
      {generateError && <span className="text-destructive">{generateError}</span>}
    </div>
  );

  if (!ready) return null;

  const analysed = Object.keys(extracted).length;
  const hasGraph = view.nodes.length > 0;

  return (
    <AppShell>
      <PageHeader
        title="Knowledge Graph"
        description="Explore relationships between people, organizations, places, and digital identifiers."
      />

      <SourceSwitch
        source={source}
        onChange={switchSource}
        snapshotCount={snapshot?.entities.length ?? 0}
        corpusCount={corpusGraph.nodes.length}
      />

      {/* ── Source-specific status line and controls ── */}
      {source === "investigation" && snapshot && snapshot.entities.length > 0 && (
        <div className="mx-6 mt-3 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-3 font-mono text-[10px] text-muted-foreground">
            <span className="flex flex-wrap items-center gap-1.5">
              {/* Explicit selection, nothing inferred. */}
              <CaseSnapshotSelector
                options={options}
                value={selection}
                onChange={switchSelection}
                label="Case"
              />
              {/* The snapshot's OWN metadata is authoritative, not the option
                  the analyst picked. Without this, running case B then opening
                  this page from case A showed B's graph with nothing marking
                  it. See snapshot-provenance.tsx. */}
              <SnapshotProvenanceLine caseId={snapshot.caseId} truncation={snapshot.truncation} />
              <span>
                Investigation of <span className="font-bold text-foreground">{snapshot.target}</span> ·{" "}
                {snapshot.entities.length} entities · {snapshot.relationships.length} relationships
                {view.truncated &&
                  ` — showing the ${view.nodes.length} nearest ${rootNode ? "to the target" : "loaded"}`}
                {" · saved "}
                {new Date(snapshot.savedAt).toLocaleString()}
              </span>
              {/* Resolution is a view over the stored record, so it must be
                  visible. A count that silently shrank would be worse than the
                  duplicate nodes it replaced. */}
              {resolvedEntities && rawSnapshot && resolvedEntities.mergedCount > 0 && (
                <span className="basis-full text-console-amber">
                  {resolutionSummary(resolvedEntities, rawSnapshot.entities.length)}
                </span>
              )}
            </span>
            <div className="flex items-center gap-1">
              {generateButton}
              {/* Cross-link to the same case's workspace, where its
                  contradictions, correlations and provenance already render.
                  Carries the case so it opens scoped, not on the latest run.
                  Only points at a case when one is selected; the
                  unscoped/latest slot has no case workspace to open. */}
              {selection !== UNSCOPED_SELECTION && (
                <Link
                  to="/investigations"
                  search={{ case: selection }}
                  title="Open this case in Investigations (contradictions, correlations, provenance)"
                  className="inline-flex h-6 items-center gap-1 rounded px-2 font-mono text-[9px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
                >
                  <FolderOpen className="size-3" />
                  Open case
                </Link>
              )}
              {/* Cross-link to the same case's evidence timeline. Carries the
                  case so /timeline opens on this snapshot's case, not the
                  latest run; on the unscoped/latest slot it links there plainly. */}
              <Link
                to="/timeline"
                search={{ case: selection === UNSCOPED_SELECTION ? undefined : selection }}
                title="Open this case's evidence timeline"
                className="inline-flex h-6 items-center gap-1 rounded px-2 font-mono text-[9px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
              >
                <Clock className="size-3" />
                View in Timeline
              </Link>
              <Button
                variant="ghost"
                size="sm"
                onClick={exportMaltego}
                title="Export every entity and relationship as a CSV Maltego's Import Graph from Table can read"
                className="h-6 gap-1 px-2 font-mono text-[9px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
              >
                <Download className="size-3" />
                Export to Maltego
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={clear}
                className="h-6 gap-1 px-2 font-mono text-[9px] uppercase tracking-wider text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="size-3" />
                {/* Names the slot it will actually clear — see `clear()`. */}
                {selection === UNSCOPED_SELECTION ? "Clear" : `Clear ${selection}`}
              </Button>
            </div>
          </div>
          {generateStatus}
        </div>
      )}

      {/* The latest-run slot is written by /recon AND by case runs, so it can
          hold a case's snapshot. Saying so beats letting the option label
          imply the data belongs to nobody. */}
      {source === "investigation" && display.show && display.note && (
        <p className="mx-6 mt-2 font-mono text-[10px] leading-relaxed text-console-amber">
          {display.note}
        </p>
      )}

      {source === "corpus" && (
        <CorpusControls
          target={target}
          corpusCount={corpus.length}
          analysed={analysed}
          loading={corpusLoading}
          loaded={corpusLoaded}
          loadError={loadError}
          extracting={extracting}
          progress={extractProgress}
          extractError={extractError}
          model={model}
          onExtract={runExtraction}
          truncated={view.truncated}
          shown={view.nodes.length}
          total={view.totalNodes}
        />
      )}

      {/* ── Empty states ── */}
      {!hasGraph && source === "investigation" && (
        <div className="px-6 pt-4">
          {/* The selector stays visible in the empty state. Hiding it would
              strand an analyst who selected a case with no snapshot: no data
              AND no way to select a different case. */}
          <div className="mb-3 flex justify-center">
            <CaseSnapshotSelector
              options={options}
              value={selection}
              onChange={switchSelection}
              label="Case"
            />
          </div>
          <EmptyState
            icon={<Network className="mx-auto mb-1.5 size-5 text-console-amber" />}
            /* The selection's OWN reason, not a generic blank. A case with no
               snapshot must not fall through to the latest run — that is the
               contamination case-scoping exists to prevent, and it is
               otherwise invisible. */
            title={display.show ? "No Investigation Loaded" : display.reason}
            message={
              display.show || selection === UNSCOPED_SELECTION
                ? 'Run an investigation on Recon and click "View in Graph", or press Generate below to run one for the current target directly — this page renders only what a real investigation actually returned, nothing seeded.'
                : display.state === "EVICTED"
                  ? /* An evicted case is NOT an empty result. Saying so is the
                       whole point of the eviction ledger — the snapshot
                       existed, storage discarded it to stay under the cap, and
                       it is not being reconstructed from anything. Re-running
                       rebuilds it. */
                    `This case produced a graph and it was discarded to stay under the ${MAX_SCOPED_CASES}-case storage cap. Nothing has been reconstructed or substituted. Re-run the case from Investigations to rebuild it.`
                  : "This case has not produced a graph. Nothing is substituted for a missing snapshot — run it from Investigations, generate one below, or pick another case above."
            }
          />
          <div className="mt-3 flex flex-col items-center gap-2">
            {generateButton}
            {generateStatus}
            <Link
              to="/recon"
              className="font-mono text-[10px] font-bold uppercase tracking-wider text-console-blue hover:underline"
            >
              Go to Recon →
            </Link>
          </div>
        </div>
      )}

      {hasGraph && (
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
                {/* Legend is derived from what is on screen, not from the full
                    type enum — listing 13 types when 3 are present invites the
                    reader to look for entities that were never collected. */}
                <div className="flex flex-wrap items-center gap-2 text-[10px]">
                  {legend.map((t) => (
                    <span key={t.typeId} className="flex items-center gap-1 text-muted-foreground">
                      <span
                        className="size-2.5 rounded-full"
                        style={{ background: colourFor(view, t.typeId) }}
                      />
                      {t.label} ({t.count})
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

                  {view.edges.map((edge, i) => {
                    const a = nodeById.get(edge.a);
                    const b = nodeById.get(edge.b);
                    if (!a || !b) return null;
                    // The relationship-type label used to render at every edge's
                    // midpoint — with several edges converging on one root, their
                    // labels stacked on top of each other and the root's own
                    // label right in the center. Dropped from the canvas; the
                    // type is still real and still visible per-edge in the
                    // selected node's shortest-path detail below (step.via).
                    return (
                      <g key={`${edge.a}|${edge.b}|${i}`}>
                        <line
                          x1={a.x}
                          y1={a.y}
                          x2={b.x}
                          y2={b.y}
                          stroke="oklch(0.75 0.03 245)"
                          // Co-occurrence edges carry a weight, so thickness is
                          // a measurement. Investigation edges do not, so they
                          // stay uniform rather than implying a strength that
                          // was never computed.
                          strokeWidth={
                            edge.weight === null ? 1.5 : Math.min(1 + edge.weight * 0.6, 5)
                          }
                        />
                      </g>
                    );
                  })}

                  {view.nodes.map((n) => {
                    const color = colourFor(view, n.typeId);
                    const hit = matched.has(n.id);
                    const isSelected = selectedId === n.id;
                    const isRoot = n.id === view.rootId;
                    const isPathStart = n.id === pathFrom;
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
                          // Dashed = unreachable from the root. Only the
                          // investigation source has a root, so a corpus node
                          // (ring always null) must not be drawn as though it
                          // failed a reachability test nobody ran.
                          strokeDasharray={
                            view.source === "investigation" && n.ring === null ? "3 2" : undefined
                          }
                        />
                        {(isRoot || isPathStart) && (
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
                          {n.label.length > 24 ? `${n.label.slice(0, 22)}…` : n.label}
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

                {view.truncated && (
                  <div className="absolute left-3 top-3 rounded border bg-background/80 px-2 py-1 font-mono text-[9px] text-muted-foreground">
                    {view.nodes.length} of {view.totalNodes} entities shown
                    {view.source === "investigation" ? " (nearest to target)" : " (most connected)"}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* ── Detail panel ── */}
          <div className="mr-6 space-y-4">
            <Card>
              <CardContent className="p-4">
                {selected ? (
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
                        style={{ background: colourFor(view, selected.typeId) }}
                      />
                      <h3 className="break-all text-base font-semibold">{selected.label}</h3>
                    </div>
                    <Badge variant="outline" className="mt-1">
                      {selected.typeLabel}
                      {selected.id === view.rootId ? " · Investigated target" : ""}
                    </Badge>
                    <dl className="mt-3 space-y-1 text-xs">
                      {selected.facts.map((f) => (
                        <Row key={f.label} k={f.label} v={f.value} />
                      ))}
                      <Row k="Connections" v={String(selected.degree)} />
                      {/* Rings exist only where a root does. Rendering "—" for
                          a corpus node would imply a distance that was never
                          measurable. */}
                      {view.source === "investigation" && (
                        <Row
                          k="Distance from target"
                          v={selected.ring === null ? "no path found" : String(selected.ring)}
                        />
                      )}
                    </dl>

                    {view.source === "corpus" && (
                      <Button
                        variant={pathFrom === selected.id ? "secondary" : "outline"}
                        size="sm"
                        className="mt-3 h-7 w-full gap-1.5 text-[11px]"
                        onClick={() =>
                          setPathFrom((prev) => (prev === selected.id ? null : selected.id))
                        }
                      >
                        <Waypoints className="size-3" />
                        {pathFrom === selected.id ? "Unpin as path start" : "Pin as path start"}
                      </Button>
                    )}
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

            {selected && pathStart && selected.id !== pathStart && (
              <Card>
                <CardContent className="p-4">
                  <h3 className="flex items-center gap-1.5 text-sm font-semibold">
                    <Waypoints className="size-3.5" />
                    {view.source === "investigation" ? "Path to target" : "Path from pinned node"}
                  </h3>
                  {path ? (
                    <>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {view.source === "investigation"
                          ? `${selected.label} → ${rootNode?.label ?? "target"}`
                          : `${nodeById.get(pathStart)?.label ?? pathStart} → ${selected.label}`}
                      </p>
                      <ol className="mt-2 space-y-1 text-xs">
                        {path.map((step, i) => (
                          <li key={`${step.id}-${i}`}>
                            {i === 0 ? "" : `${i}. `}
                            {step.via && (
                              <span className="text-muted-foreground">
                                {step.via.toLowerCase().replace(/_/g, " ")}{" "}
                              </span>
                            )}
                            {nodeById.get(step.id)?.label ?? step.id}
                          </li>
                        ))}
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

            {view.caveat && (
              <Card>
                <CardContent className="flex gap-2 p-3">
                  <Info className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  <p className="text-[11px] leading-relaxed text-muted-foreground">{view.caveat}</p>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      )}
    </AppShell>
  );
}

// ─── Source switch ──────────────────────────────────────────────────────────

/**
 * Both counts are shown so the switch states what each source currently holds
 * rather than making the analyst click to find out — and so "0" is visible as a
 * fact about collection rather than discovered as an empty page.
 */
function SourceSwitch({
  source,
  onChange,
  snapshotCount,
  corpusCount,
}: {
  source: GraphSource;
  onChange: (s: GraphSource) => void;
  snapshotCount: number;
  corpusCount: number;
}) {
  const tab = (id: GraphSource, label: string, count: number, hint: string) => (
    <button
      key={id}
      onClick={() => onChange(id)}
      title={hint}
      className={`rounded-md px-3 py-1.5 text-left font-mono text-[10px] uppercase tracking-wider transition-colors ${
        source === id
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
    >
      {label}
      <span className="ml-1.5 opacity-70">({count})</span>
    </button>
  );

  return (
    <div className="mx-6 mt-4 flex flex-wrap items-center gap-1 rounded-lg border bg-muted/30 p-1">
      {tab(
        "investigation",
        "OSINT investigation",
        snapshotCount,
        "Entities and relationships from the last investigation handed over from /recon",
      )}
      {tab(
        "corpus",
        "Article co-occurrence",
        corpusCount,
        "Entities co-mentioned across live reporting on the active subject",
      )}
    </div>
  );
}

// ─── Corpus controls ────────────────────────────────────────────────────────

function CorpusControls(props: {
  target: string;
  corpusCount: number;
  analysed: number;
  loading: boolean;
  loaded: boolean;
  loadError: string;
  extracting: boolean;
  progress: { done: number; total: number };
  extractError: string;
  model: string;
  onExtract: () => void;
  truncated: boolean;
  shown: number;
  total: number;
}) {
  const {
    target,
    corpusCount,
    analysed,
    loading,
    loaded,
    loadError,
    extracting,
    progress,
    extractError,
    model,
    onExtract,
  } = props;

  return (
    <div className="mx-6 mt-3 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-3 font-mono text-[10px] text-muted-foreground">
        <span>
          Subject <span className="font-bold text-foreground">{target || "not set"}</span>
          {loading
            ? " · collecting reporting…"
            : ` · ${corpusCount} article(s) collected · ${analysed} analysed`}
          {model && ` · ${model}`}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="h-6 gap-1 px-2 font-mono text-[9px] uppercase tracking-wider"
          disabled={loading || extracting || corpusCount === 0 || analysed === corpusCount}
          onClick={onExtract}
        >
          {extracting ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
          {extracting
            ? `Extracting ${progress.done}/${progress.total}`
            : analysed === corpusCount && corpusCount > 0
              ? "All articles analysed"
              : "Extract entities"}
        </Button>
      </div>

      {loadError && (
        <Notice tone="error">
          Collection failed: {loadError} — no articles were retrieved, which is not the same as the
          subject having no coverage.
        </Notice>
      )}
      {extractError && <Notice tone="error">{extractError}</Notice>}

      {/* Extraction is manual and costs a model call per article; saying so is
          why the empty graph is empty. */}
      {!loading && !loadError && loaded && corpusCount > 0 && analysed === 0 && (
        <Notice tone="info">
          {corpusCount} article(s) collected. Entity extraction runs one open-weight model call per
          article and is not automatic — press Extract entities to build the graph.
        </Notice>
      )}
      {!loading && !loadError && loaded && corpusCount === 0 && (
        <Notice tone="info">
          No articles were returned for this subject, so there is nothing to build a graph from.
          Set a different subject from the search bar.
        </Notice>
      )}
    </div>
  );
}

function Notice({ tone, children }: { tone: "error" | "info"; children: React.ReactNode }) {
  const style =
    tone === "error"
      ? "border-red-500/30 bg-red-500/5 text-red-500"
      : "border-amber-500/30 bg-amber-500/5 text-amber-500";
  const Icon = tone === "error" ? AlertTriangle : Info;
  return (
    <div className={`flex items-start gap-2 rounded-md border p-2 text-[11px] ${style}`}>
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </div>
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
