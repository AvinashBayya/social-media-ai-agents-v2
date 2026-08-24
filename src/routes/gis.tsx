import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { AppShell, PageHeader } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import {
  Globe,
  Loader2,
  AlertTriangle,
  Info,
  Search,
  Layers as LayersIcon,
  MapPin,
  Camera,
  Wheat,
  FileOutput,
} from "lucide-react";
import { getActiveTarget, setActiveTarget } from "@/utils/active-target";
import { fetchGeoLayers } from "@/utils/geo-sources";
import {
  fetchSupplyDemand,
  type GrainsProduct,
  type SupplyDemandDomain,
  type SupplyDemandParams,
} from "@/utils/supply-demand-sources";
import { llmReport } from "@/utils/llm";
import { MarkdownReport } from "@/components/markdown-report";
import { fetchNewsAggregation, type NewsAggregationResult } from "@/utils/news-aggregation";
import { mergeTimeline, timelineFromGdeltEvents, timelineFromNewsItems } from "@/utils/timeline";
import { Timeline } from "@/components/timeline";
import {
  cellSizeForZoom,
  clusterByGrid,
  describeTileRequest,
  filterByTime,
  fromExifImage,
  summarise,
  timeExtent,
  GEO_LAYERS,
  PRECISION_LABEL,
  PRECISION_RADIUS_M,
  type GeoLayerId,
  type GeoRecord,
  type LayerResult,
} from "@/utils/geo";
import { loadImageCorpus } from "@/utils/imaging-client";
import {
  MAP_BACKGROUND,
  OFFLINE_BASEMAP_URL,
  addConsentedTileLayer,
  addGraticule,
  addOfflineBasemap,
  addScaleBar,
  resolveTileProvider,
  loadLeaflet,
} from "@/utils/leaflet-client";

/**
 * GIS Command Map — Module 5 (PS-18 §6.5), deterministic half.
 *
 * This page used to GENERATE ITS COORDINATES. News was placed at a country
 * centroid plus up to ±2.25° of Math.random() jitter — about 250 km — cyber
 * threats at a hardcoded 45.0N/15.0E in central Europe, Telegram posts at
 * 48.0N/31.0E in Ukraine, and every marker carried a random hour that then
 * drove the time-of-day filter. On an intelligence map the pin IS the claim,
 * so all of that is gone.
 *
 * What replaces it: real coordinates only, each drawn at its true precision.
 * An exact fix is a filled point sized by magnitude; anything coarser is a
 * dashed circle at its genuine uncertainty radius, so a country-level record
 * can never be read as a located event. Records carrying no coordinate are
 * counted and reported as unplaceable rather than approximated onto the map.
 */

export const Route = createFileRoute("/gis")({
  head: () => ({ meta: [{ title: "GIS Command Map — Sentinel AI" }] }),
  component: GISPage,
});

const CARD = "bg-console-surface border-console-border";

const layerColour = (id: GeoLayerId) => GEO_LAYERS.find((l) => l.id === id)?.colour ?? "var(--console-muted)";

/** Marker radius in pixels from a layer-relative magnitude. Constant when unmeasured. */
function radiusFor(record: GeoRecord, maxMagnitude: number): number {
  if (record.magnitude === null || maxMagnitude <= 0) return 5;
  return 4 + Math.sqrt(Math.max(0, record.magnitude) / maxMagnitude) * 12;
}

function GISPage() {
  // Resolved once — the provider is env-config, not runtime state. See
  // resolveTileProvider's doc comment in leaflet-client.ts.
  const tileProvider = useMemo(() => resolveTileProvider(), []);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const layerGroupRef = useRef<any>(null);
  const leafletRef = useRef<any>(null);

  // Empty on both server and first client render — getActiveTarget() reads
  // localStorage, unavailable during SSR. A synchronous getActiveTarget()
  // call here made the server-rendered text differ from the client's first
  // paint (a React hydration mismatch); a mount effect now sets the real
  // value client-side, after hydration.
  const [target, setTarget] = useState("");
  const [draft, setDraft] = useState("");
  const [results, setResults] = useState<LayerResult[]>([]);
  const [imageRecords, setImageRecords] = useState<GeoRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState(2);
  const [selected, setSelected] = useState<GeoRecord | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [basemapError, setBasemapError] = useState("");
  const [center, setCenter] = useState<[number, number]>([20, 20]);

  /*
   * Third-party basemap tiles, OFF until an analyst turns them on.
   *
   * This page is NOT "public feed data only", which is the reason it does not
   * get a more relaxed default than /images: the Imagery layer below defaults
   * to enabled and is populated from loadImageCorpus() — EXIF GPS fixes from
   * images analysed in this browser. Zooming to one of those pins with raster
   * tiles on requests the tile containing that image's coordinate, which is
   * the same disclosure /images had. Not persisted, for the same reason.
   */
  const [tiles, setTiles] = useState(false);

  const [enabled, setEnabled] = useState<Record<GeoLayerId, boolean>>({
    conflict: true,
    seismic: true,
    news: true,
    imagery: true,
    infrastructure: true,
    // GPS jamming and radiation previously shared the "infrastructure" id, so
    // toggling that one checkbox silently controlled three unrelated sources
    // and only one of them could ever render.
    gpsjam: true,
    radiation: true,
    reliefweb: true,
    supplyDemand: true,
    gdeltEvents: true,
    assetTracks: true,
    mentions: true,
  });
  const [timeWindow, setTimeWindow] = useState<[number, number] | null>(null);

  // ── Supply & Demand (Kpler) — analyst-driven, not auto-collected ─────────
  // Unlike every other layer, this doesn't run from the free-text target
  // search: Kpler takes explicit product/zone parameters. See
  // supply-demand-sources.ts's file doc comment for why.
  const [sdResults, setSdResults] = useState<LayerResult[]>([]);
  const [sdDomain, setSdDomain] = useState<SupplyDemandDomain>("grains");
  const [sdProduct, setSdProduct] = useState<GrainsProduct>("Corn");
  const [sdZonesDraft, setSdZonesDraft] = useState("Argentina, Brazil, Ukraine");
  const [sdMinYear, setSdMinYear] = useState(2023);
  const [sdMaxYear, setSdMaxYear] = useState(2025);
  const [sdStartDate, setSdStartDate] = useState("2024-01-01");
  const [sdEndDate, setSdEndDate] = useState("2025-01-01");
  const [sdLoading, setSdLoading] = useState(false);
  const [sdError, setSdError] = useState("");
  const [sdReport, setSdReport] = useState<{
    text: string;
    model: string;
    provider: string;
  } | null>(null);
  const [sdReportError, setSdReportError] = useState("");
  const [sdReportLoading, setSdReportLoading] = useState(false);

  // ── Timeline (GIS v2) — RSS aggregation feeding the chronology alongside
  // the gdeltEvents map layer. Fetched once: the feed list is fixed
  // configuration, not query-driven like the map's collectors.
  const [newsAgg, setNewsAgg] = useState<NewsAggregationResult | null>(null);

  useEffect(() => {
    const initial = getActiveTarget();
    setTarget(initial);
    setDraft(initial);

    // Without this, changing the target via the top-nav search bar while
    // already on this page did nothing until navigating away and back.
    const handleTargetChange = (e: any) => {
      if (e.detail) {
        setTarget(e.detail);
        setDraft(e.detail);
      }
    };
    window.addEventListener("sentinel_target_changed", handleTargetChange);
    return () => window.removeEventListener("sentinel_target_changed", handleTargetChange);
  }, []);

  // ── Collect server-side layers ───────────────────────────────────────────
  useEffect(() => {
    // Skip the empty placeholder — the mount-sync effect above fills in the
    // real target a moment later, which re-triggers this effect via [target].
    if (!target) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError("");
      try {
        const res: any = await fetchGeoLayers({ data: { query: target } });
        if (!cancelled) setResults(res?.layers ?? []);
      } catch (err: any) {
        if (!cancelled) setError(err?.message ?? String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target]);

  // ── RSS aggregation for the Timeline — fixed feed list, fetched once ──────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res: NewsAggregationResult = await fetchNewsAggregation();
        if (!cancelled) setNewsAgg(res);
      } catch (err: any) {
        if (!cancelled) {
          setNewsAgg({
            feeds: [],
            items: [],
            collectedAt: new Date().toISOString(),
            error: err?.message ?? String(err),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Image GPS comes from the Module 4 corpus, which lives in this browser ──
  useEffect(() => {
    const records: GeoRecord[] = [];
    for (const img of loadImageCorpus()) {
      const r = fromExifImage({
        id: img.id,
        name: img.context || img.id,
        gps: img.gps ?? null,
        capturedAt: img.seenAt,
        camera: img.camera ?? null,
      });
      if (r) records.push(r);
    }
    setImageRecords(records);
  }, []);

  const allResults = useMemo<LayerResult[]>(
    () => [
      ...results,
      { layer: "imagery" as const, records: imageRecords, unplaceable: 0, error: null },
      ...sdResults,
    ],
    [results, imageRecords, sdResults],
  );

  const fetchSupplyDemandData = async () => {
    const zones = sdZonesDraft
      .split(",")
      .map((z) => z.trim())
      .filter(Boolean);
    if (zones.length === 0) return;
    setSdLoading(true);
    setSdError("");
    setSdReport(null);
    setSdReportError("");
    const params: SupplyDemandParams =
      sdDomain === "grains"
        ? { domain: "grains", product: sdProduct, zones, minYear: sdMinYear, maxYear: sdMaxYear }
        : { domain: sdDomain, zones, startDate: sdStartDate, endDate: sdEndDate };
    try {
      const result: LayerResult = await fetchSupplyDemand({ data: params });
      setSdResults([result]);
      if (result.error) setSdError(result.error);
    } catch (err: any) {
      const message = err?.message ?? String(err);
      setSdError(message);
      setSdResults([{ layer: "supplyDemand", records: [], unplaceable: 0, error: message }]);
    } finally {
      setSdLoading(false);
    }
  };

  /**
   * Synthesizes a report from whatever real balance data was just fetched —
   * every metric Kpler reported, not a curated subset. llmReport already
   * refuses to invent unsupported sections, so this never runs without at
   * least one real zone's balance sheet in hand.
   */
  const generateSupplyDemandReport = async () => {
    const records = sdResults.flatMap((r) => r.records);
    if (records.length === 0) return;
    setSdReportLoading(true);
    setSdReportError("");
    setSdReport(null);
    try {
      const lines = records.map((r) => {
        const metrics = Object.entries(r.detail)
          .filter(([k]) => !["zone", "product", "period"].includes(k))
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ");
        return `${r.detail.zone} — ${r.detail.product}, period ${r.detail.period}: ${metrics}`;
      });
      const zones = [...new Set(records.map((r) => String(r.detail.zone)))];
      const res = await llmReport({
        data: {
          type: "Supply & Demand Intelligence",
          target: zones.join(", "),
          data: lines.join("\n"),
        },
      });
      setSdReport({ text: res.text, model: res.model, provider: res.provider });
    } catch (err: any) {
      setSdReportError(err?.message ?? String(err));
    } finally {
      setSdReportLoading(false);
    }
  };

  const allRecords = useMemo(
    () => allResults.filter((r) => enabled[r.layer]).flatMap((r) => r.records),
    [allResults, enabled],
  );

  const gdeltEventsResult = useMemo(
    () => allResults.find((r) => r.layer === "gdeltEvents") ?? null,
    [allResults],
  );

  const timelineEntries = useMemo(
    () =>
      mergeTimeline(
        timelineFromGdeltEvents(gdeltEventsResult?.records ?? []),
        timelineFromNewsItems(newsAgg?.items ?? []),
      ),
    [gdeltEventsResult, newsAgg],
  );

  // Both sources report their own disabled/error state via the same field a
  // layer card already uses (LayerResult.error / NewsAggregationResult.error)
  // — reused here rather than inventing a second "is GIS v2 on" client check.
  const timelineDisabledReason =
    gdeltEventsResult?.error && newsAgg?.error
      ? `Both timeline sources are unavailable. GDELT Events: ${gdeltEventsResult.error} News aggregation: ${newsAgg.error}`
      : null;

  const extent = useMemo(() => timeExtent(allRecords), [allRecords]);

  // Reset the slider whenever the underlying extent changes.
  useEffect(() => {
    setTimeWindow(extent ? [extent.fromMs, extent.toMs] : null);
  }, [extent?.fromMs, extent?.toMs]);

  const visible = useMemo(() => {
    if (!timeWindow) return allRecords;
    return filterByTime(allRecords, timeWindow[0], timeWindow[1]);
  }, [allRecords, timeWindow]);

  const summary = useMemo(() => summarise(allResults), [allResults]);

  // What the consent control below would disclose for the view on screen.
  const viewDisclosure = useMemo(
    () => describeTileRequest(center[0], center[1], zoom, tileProvider.pathTemplate),
    [center, zoom, tileProvider],
  );

  // ── Map ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (typeof window === "undefined" || !containerRef.current) return;
    let cancelled = false;

    loadLeaflet().then((L) => {
      if (cancelled || !containerRef.current || mapRef.current) return;
      leafletRef.current = L;

      const map = L.map(containerRef.current, { center: [20, 20], zoom: 2, worldCopyJump: true });
      // The basemap itself is added by the effect below, which is keyed on the
      // consent state. Rebuilding the map on a toggle would recreate
      // layerGroupRef and silently drop every plotted record.
      addGraticule(L, map);
      addScaleBar(L, map);

      layerGroupRef.current = L.layerGroup().addTo(map);
      map.on("zoomend", () => setZoom(map.getZoom()));
      map.on("moveend", () => {
        const c = map.getCenter();
        setCenter([c.lat, c.lng]);
      });
      mapRef.current = map;
      setMapReady(true);
      setTimeout(() => map.invalidateSize(), 0);
    });

    return () => {
      cancelled = true;
      setMapReady(false);
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []);

  // ── Basemap: first-party vectors by default, third-party tiles on consent ─
  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!mapReady || !L || !map) return;
    let cancelled = false;
    let layer: any = null;

    setBasemapError("");
    if (tiles) {
      layer = addConsentedTileLayer(L, map, tileProvider);
    } else {
      addOfflineBasemap(L, map)
        .then((added: any) => {
          // Consent may have been granted while the outlines were in flight.
          if (cancelled) map.removeLayer(added);
          else layer = added;
        })
        .catch((err: any) => {
          // "The outline file did not load" and "there is no land here" are
          // opposite claims and must not render identically.
          if (!cancelled) setBasemapError(err?.message ?? String(err));
        });
    }

    return () => {
      cancelled = true;
      if (layer && map.hasLayer(layer)) map.removeLayer(layer);
    };
  }, [tiles, mapReady, tileProvider]);

  // ── Draw ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    const L = leafletRef.current;
    const group = layerGroupRef.current;
    if (!L || !group) return;
    group.clearLayers();

    const cell = cellSizeForZoom(zoom);
    const clusters = clusterByGrid(visible, cell);
    const maxMagnitude = Math.max(0, ...visible.map((r) => r.magnitude ?? 0));

    for (const cluster of clusters) {
      // A multi-record cell collapses to one badge so dense regions stay
      // readable. The badge inherits the COARSEST precision in the cell.
      if (cluster.members.length > 1) {
        const colour = layerColour(cluster.members[0].layer);
        L.marker([cluster.lat, cluster.lon], {
          icon: L.divIcon({
            className: "",
            html:
              `<div style="background:${colour};color:var(--console-accent-foreground);border-radius:999px;` +
              `width:26px;height:26px;display:grid;place-items:center;font:700 11px sans-serif;` +
              `border:2px solid var(--console-accent-foreground)">${cluster.members.length}</div>`,
            iconSize: [26, 26],
          }),
        })
          .addTo(group)
          .bindPopup(
            `<strong>${cluster.members.length} records</strong><br/>` +
              `Cluster precision: ${PRECISION_LABEL[cluster.precision]}<br/>` +
              `<em>Zoom in to separate.</em>`,
          );
        continue;
      }

      const r = cluster.members[0];
      const colour = layerColour(r.layer);

      // Imprecise records get a circle at their real uncertainty radius, never
      // a bare pin. Rendering a country-level record as a point would assert a
      // precision the data does not have.
      if (r.precision !== "exact") {
        L.circle([r.lat, r.lon], {
          radius: PRECISION_RADIUS_M[r.precision],
          color: colour,
          weight: 1,
          opacity: 0.55,
          fillColor: colour,
          fillOpacity: 0.1,
          dashArray: "4 4",
        })
          .addTo(group)
          .on("click", () => setSelected(r));
      }

      L.circleMarker([r.lat, r.lon], {
        radius: r.precision === "exact" ? radiusFor(r, maxMagnitude) : 4,
        color: colour,
        weight: r.precision === "exact" ? 2 : 1,
        fillColor: colour,
        fillOpacity: r.precision === "exact" ? 0.65 : 0.25,
      })
        .addTo(group)
        .on("click", () => setSelected(r))
        .bindPopup(
          `<strong>${r.title.slice(0, 120)}</strong><br/>` +
            `${r.source} · ${r.timestamp ? new Date(r.timestamp).toISOString().slice(0, 16).replace("T", " ") : "no date reported"}<br/>` +
            `<em>${PRECISION_LABEL[r.precision]} — locates ${r.locates}</em>`,
        );
    }
  }, [visible, zoom, mapReady]);

  const search = () => {
    const v = draft.trim();
    if (!v) return;
    setActiveTarget(v);
    setTarget(v);
  };

  const fmtDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  return (
    <AppShell>
      <PageHeader
        title="GIS Command Map"
        description="Spatial-temporal view over real coordinates only. Precision is drawn, not implied."
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          <Card className={CARD}>
            <CardContent className="p-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-[200px] flex-1">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-console-label" />
                  <Input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && search()}
                    placeholder="Subject for the news layer…"
                    className="h-8 border-console-border bg-console-deep pl-8 text-[11px] text-console-text"
                  />
                </div>
                <Button size="sm" onClick={search} disabled={loading} className="h-8">
                  {loading ? <Loader2 className="size-3.5 animate-spin" /> : "Collect"}
                </Button>
                <span className="font-mono text-[10px] text-console-label">
                  {visible.length} of {allRecords.length} plotted · zoom {zoom}
                </span>
              </div>

              {error && (
                <div className="mt-2 flex items-start gap-2 rounded border border-console-red/30 bg-console-red/5 p-2">
                  <AlertTriangle className="size-3.5 shrink-0 text-console-red" />
                  <span className="font-mono text-[10px] text-console-red">{error}</span>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className={CARD}>
            <CardContent className="p-0">
              <div
                ref={containerRef}
                className="h-[520px] w-full rounded-t-lg"
                style={{ background: MAP_BACKGROUND }}
              />

              {/* ── Time slider ──────────────────────────────────────────── */}
              <div className="border-t border-console-border p-3">
                {extent && timeWindow ? (
                  <>
                    <div className="flex items-center justify-between font-mono text-[10px] text-console-muted">
                      <span>{fmtDay(timeWindow[0])}</span>
                      <span className="text-console-label">
                        spatial-temporal filter · {visible.length} in window
                      </span>
                      <span>{fmtDay(timeWindow[1])}</span>
                    </div>
                    <Slider
                      className="mt-2"
                      min={extent.fromMs}
                      max={extent.toMs}
                      step={Math.max(1, Math.floor((extent.toMs - extent.fromMs) / 200))}
                      value={timeWindow}
                      onValueChange={(v) => setTimeWindow([v[0], v[1] ?? v[0]])}
                    />
                    <p className="mt-1 font-mono text-[9px] text-console-label">
                      Range is the true extent of the collected records ({fmtDay(extent.fromMs)} to{" "}
                      {fmtDay(extent.toMs)}), not a fixed window.
                    </p>
                  </>
                ) : (
                  <p className="font-mono text-[10px] text-console-label">
                    No dated records to filter. The slider appears when the collection carries
                    usable timestamps.
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          {/* ── Basemap disclosure ─────────────────────────────────────── */}
          <Card className={tiles ? "border-console-amber/40 bg-console-surface" : CARD}>
            <CardContent className="p-3">
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={tiles}
                  onChange={(e) => setTiles(e.target.checked)}
                  className="mt-0.5 size-3 shrink-0 accent-console-amber"
                />
                <span className="text-[10px] leading-relaxed text-console-muted">
                  <span className="font-semibold text-console-text">
                    Request raster basemap tiles from {tileProvider.host} —{" "}
                    {tiles ? "ON, tiles are being requested" : "off"}
                  </span>
                  <br />
                  <span className="text-console-label">Off:</span> every pixel on this map comes from
                  this origin — Leaflet&apos;s stylesheet and marker icons are bundled with the app
                  and the country outlines are{" "}
                  <span className="font-mono text-[#CBD5E1]">{OFFLINE_BASEMAP_URL}</span>. No map
                  provider is contacted, at any zoom. The trade-off is real: coastlines and a
                  graticule, no roads or buildings.
                  <br />
                  <span className="text-console-label">On:</span> the browser sends one request per
                  visible tile to{" "}
                  <span className="font-mono text-[#CBD5E1]">{tileProvider.host}</span> (
                  {tileProvider.operator}) on every pan and zoom, and the request path IS the view:
                  the current centre is{" "}
                  <span className="font-mono text-console-amber">{viewDisclosure.path}</span>, a{" "}
                  {viewDisclosure.footprint} square, recorded there with your IP address and the
                  time. This page is not only public feed data — the Imagery layer plots EXIF GPS
                  fixes from images analysed in this browser, so zooming to one of those pins
                  discloses that image&apos;s location to {tileProvider.operator} even though the
                  image file itself never leaves this machine. Not stored anywhere; it resets on
                  reload.
                </span>
              </label>
              {basemapError && (
                <p className="mt-2 font-mono text-[10px] leading-relaxed text-console-amber">
                  Offline basemap unavailable: {basemapError}. Markers are unaffected — only the
                  coastline backdrop is missing, and nothing was substituted for it.
                </p>
              )}
            </CardContent>
          </Card>

          {/* ── Supply & Demand (Kpler) ─────────────────────────────────── */}
          <Card className={CARD}>
            <CardContent className="p-4">
              <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase text-console-text">
                <Wheat className="size-3.5" style={{ color: layerColour("supplyDemand") }} />
                Supply & Demand (Kpler)
              </h3>
              <p className="mt-1.5 text-[10px] leading-relaxed text-console-label">
                Kpler is a commercial commodity-intelligence provider — grains and LNG/gas
                balance sheets require a paid KPLER_API_KEY, unlike every other layer on this
                page. Analyst-selected product and zones only; this does not run automatically
                from the search bar above.
              </p>

              <div className="mt-3 flex flex-wrap gap-1">
                {(["grains", "lng", "gas"] as SupplyDemandDomain[]).map((d) => (
                  <button
                    key={d}
                    onClick={() => setSdDomain(d)}
                    className={`rounded border px-2 py-1 text-[10px] uppercase ${
                      sdDomain === d
                        ? "border-[#84CC16]/50 bg-[#84CC16]/10 text-[#84CC16]"
                        : "border-console-border bg-console-deep text-console-label"
                    }`}
                  >
                    {d === "grains" ? "Grains" : d === "lng" ? "LNG" : "Natural gas"}
                  </button>
                ))}
              </div>

              {sdDomain === "grains" && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {(["Corn", "Soybean", "Wheat"] as GrainsProduct[]).map((p) => (
                    <button
                      key={p}
                      onClick={() => setSdProduct(p)}
                      className={`rounded border px-2 py-1 text-[10px] ${
                        sdProduct === p
                          ? "border-[#84CC16]/50 bg-[#84CC16]/10 text-[#84CC16]"
                          : "border-console-border bg-console-deep text-console-label"
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              )}

              <div className="mt-2">
                <label className="text-[10px] uppercase tracking-wider text-console-label">
                  Zones / countries (comma-separated)
                </label>
                <Input
                  value={sdZonesDraft}
                  onChange={(e) => setSdZonesDraft(e.target.value)}
                  placeholder="Argentina, Brazil, Ukraine"
                  className="mt-1 h-8 border-console-border bg-console-deep text-[11px] text-console-text"
                />
              </div>

              {sdDomain === "grains" ? (
                <div className="mt-2 flex gap-2">
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-console-label">
                      Min year
                    </label>
                    <Input
                      type="number"
                      min={2017}
                      value={sdMinYear}
                      onChange={(e) => setSdMinYear(Number(e.target.value) || 2017)}
                      className="mt-1 h-8 w-24 border-console-border bg-console-deep text-[11px] text-console-text"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-console-label">
                      Max year
                    </label>
                    <Input
                      type="number"
                      min={2017}
                      value={sdMaxYear}
                      onChange={(e) => setSdMaxYear(Number(e.target.value) || sdMinYear)}
                      className="mt-1 h-8 w-24 border-console-border bg-console-deep text-[11px] text-console-text"
                    />
                  </div>
                </div>
              ) : (
                <div className="mt-2 flex gap-2">
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-console-label">
                      Start date
                    </label>
                    <Input
                      type="date"
                      value={sdStartDate}
                      onChange={(e) => setSdStartDate(e.target.value)}
                      className="mt-1 h-8 border-console-border bg-console-deep text-[11px] text-console-text"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-console-label">
                      End date
                    </label>
                    <Input
                      type="date"
                      value={sdEndDate}
                      onChange={(e) => setSdEndDate(e.target.value)}
                      className="mt-1 h-8 border-console-border bg-console-deep text-[11px] text-console-text"
                    />
                  </div>
                </div>
              )}

              <Button
                size="sm"
                variant="outline"
                disabled={sdLoading || !sdZonesDraft.trim()}
                onClick={fetchSupplyDemandData}
                className="mt-3 h-8 gap-1.5"
              >
                {sdLoading ? <Loader2 className="size-3.5 animate-spin" /> : <Wheat className="size-3.5" />}
                Fetch Supply & Demand Data
              </Button>

              {sdError && (
                <div className="mt-2 flex items-start gap-2 rounded border border-console-red/30 bg-console-red/5 p-2">
                  <AlertTriangle className="size-3.5 shrink-0 text-console-red" />
                  <span className="text-[10px] leading-relaxed text-console-red">{sdError}</span>
                </div>
              )}

              {sdResults.flatMap((r) => r.records).length > 0 && (
                <div className="mt-3 space-y-1.5">
                  {sdResults
                    .flatMap((r) => r.records)
                    .map((r) => (
                      <div
                        key={r.id}
                        className="cursor-pointer rounded border border-console-border bg-console-deep/60 p-2"
                        onClick={() => setSelected(r)}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-medium text-console-text">{r.title}</span>
                          <span className="font-mono text-[10px] text-console-muted">
                            {r.magnitudeLabel}
                          </span>
                        </div>
                      </div>
                    ))}

                  <Button
                    size="sm"
                    variant="outline"
                    disabled={sdReportLoading}
                    onClick={generateSupplyDemandReport}
                    className="mt-1 h-7 gap-1 text-[10px]"
                  >
                    {sdReportLoading ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <FileOutput className="size-3" />
                    )}
                    Generate AI Analysis Report
                  </Button>

                  {sdReportError && (
                    <div className="flex items-start gap-2 rounded border border-console-red/30 bg-console-red/5 p-2">
                      <AlertTriangle className="size-3.5 shrink-0 text-console-red" />
                      <span className="text-[10px] leading-relaxed text-console-red">
                        <span className="font-bold">AI unavailable.</span> {sdReportError}
                      </span>
                    </div>
                  )}

                  {sdReport && (
                    <div>
                      <div className="max-h-96 overflow-auto rounded border border-console-border bg-console-deep p-2.5">
                        <MarkdownReport text={sdReport.text} />
                      </div>
                      <p className="mt-1.5 font-mono text-[9px] text-console-label">
                        {sdReport.model} via {sdReport.provider}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* ── Selected record ────────────────────────────────────────── */}
          {selected && (
            <Card className="border-console-blue/40 bg-console-surface">
              <CardContent className="p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <MapPin className="size-3.5" style={{ color: layerColour(selected.layer) }} />
                  <span className="text-xs font-bold uppercase text-console-text">
                    {GEO_LAYERS.find((l) => l.id === selected.layer)?.label}
                  </span>
                  <button
                    onClick={() => setSelected(null)}
                    className="ml-auto text-[10px] text-console-label hover:text-console-text"
                  >
                    close
                  </button>
                </div>

                <p className="mt-1.5 text-sm leading-snug text-console-text">{selected.title}</p>

                <dl className="mt-2 space-y-1 border-t border-console-border pt-2 font-mono text-[10px]">
                  <div className="flex justify-between gap-2">
                    <dt className="text-console-label">Coordinate</dt>
                    <dd className="text-console-text">
                      {selected.lat.toFixed(5)}, {selected.lon.toFixed(5)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-console-label">Precision</dt>
                    <dd className="text-console-amber">{PRECISION_LABEL[selected.precision]}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="shrink-0 text-console-label">Locates</dt>
                    <dd className="text-right text-console-text">{selected.locates}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-console-label">Reported</dt>
                    <dd className="text-console-text">{selected.timestamp}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-console-label">Magnitude</dt>
                    <dd className="text-console-text">{selected.magnitudeLabel}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-console-label">Module 1 credibility</dt>
                    <dd className="text-console-text">
                      {selected.credibility === null
                        ? "not scored for this record type"
                        : `${(selected.credibility * 100).toFixed(0)}%`}
                    </dd>
                  </div>
                  {Object.entries(selected.detail)
                    .filter(([k]) => k !== "thumbnail")
                    .map(([k, v]) => (
                      <div key={k} className="flex justify-between gap-2">
                        <dt className="text-console-label">{k}</dt>
                        <dd className="text-right text-console-text">{String(v)}</dd>
                      </div>
                    ))}
                </dl>

                {typeof selected.detail.thumbnail === "string" && (
                  <img
                    src={selected.detail.thumbnail}
                    alt={selected.title}
                    className="mt-2 max-h-40 rounded border border-console-border object-contain"
                  />
                )}

                {selected.url && (
                  <a
                    href={selected.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 inline-block font-mono text-[10px] text-console-blue hover:underline"
                  >
                    open source record
                  </a>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        {/* ── Layers ──────────────────────────────────────────────────────── */}
        <div className="space-y-4">
          <Card className={CARD}>
            <CardContent className="p-4">
              <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase text-console-text">
                <LayersIcon className="size-3.5 text-console-blue" />
                Layers
              </h3>

              <div className="mt-3 space-y-2">
                {GEO_LAYERS.map((layer) => {
                  const result = allResults.find((r) => r.layer === layer.id);
                  const count = result?.records.length ?? 0;
                  const on = enabled[layer.id];
                  return (
                    <div
                      key={layer.id}
                      className="rounded border border-console-border bg-console-deep/60 p-2"
                    >
                      <button
                        onClick={() => setEnabled((p) => ({ ...p, [layer.id]: !p[layer.id] }))}
                        className="flex w-full items-center gap-2 text-left"
                      >
                        <span
                          className="size-2.5 shrink-0 rounded-full"
                          style={{ background: on ? layer.colour : "#334155" }}
                        />
                        <span
                          className={`text-[11px] font-medium ${on ? "text-console-text" : "text-console-label"}`}
                        >
                          {layer.label}
                        </span>
                        <span className="ml-auto shrink-0 font-mono text-[10px] text-console-muted">
                          {count}
                        </span>
                      </button>

                      {result?.error && (
                        <p className="mt-1 text-[9px] leading-relaxed text-console-amber">
                          {result.error}
                        </p>
                      )}
                      {!result?.error && (result?.unplaceable ?? 0) > 0 && (
                        <p className="mt-1 text-[9px] leading-relaxed text-console-amber">
                          {result!.unplaceable} collected record(s) carried no usable coordinate and
                          were excluded rather than approximated.
                        </p>
                      )}
                      <p className="mt-1 text-[9px] leading-relaxed text-console-label">
                        {layer.provenance}
                      </p>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          <Card className={CARD}>
            <CardContent className="p-4">
              <h3 className="text-xs font-bold uppercase text-console-text">Collection integrity</h3>
              <p className="mt-2 text-[10px] leading-relaxed text-console-muted">{summary.note}</p>
              <div className="mt-2 flex flex-wrap gap-1">
                <Badge
                  variant="outline"
                  className="border-console-green/40 bg-console-green/10 text-[9px] font-normal text-console-green"
                >
                  {summary.plotted} plotted
                </Badge>
                {summary.unplaceable > 0 && (
                  <Badge
                    variant="outline"
                    className="border-console-amber/40 bg-console-amber/10 text-[9px] font-normal text-console-amber"
                  >
                    {summary.unplaceable} excluded
                  </Badge>
                )}
              </div>
              <p className="mt-2 flex items-start gap-1.5 text-[9px] leading-relaxed text-console-label">
                <Info className="mt-px size-3 shrink-0" />
                Exact fixes render as filled points sized by magnitude. Anything coarser renders as
                a dashed circle at its true uncertainty radius — a country-level record can never be
                read as a located event.
              </p>
            </CardContent>
          </Card>

          <Card className={CARD}>
            <CardContent className="p-4">
              <h3 className="text-xs font-bold uppercase text-console-text">Timeline</h3>
              <p className="mt-1.5 text-[10px] leading-relaxed text-console-muted">
                Chronology of real GDELT events and RSS news, newest first. Every entry links to
                its source.
              </p>
              <div className="mt-3 max-h-96 overflow-y-auto">
                <Timeline
                  entries={timelineEntries}
                  disabledReason={timelineDisabledReason}
                  error={
                    gdeltEventsResult?.error && !timelineDisabledReason
                      ? `GDELT Events: ${gdeltEventsResult.error}`
                      : newsAgg?.error && !timelineDisabledReason
                        ? `News aggregation: ${newsAgg.error}`
                        : null
                  }
                />
              </div>
            </CardContent>
          </Card>

          <Card className={CARD}>
            <CardContent className="p-4">
              <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase text-console-text">
                <Camera className="size-3.5 text-console-green" />
                Imagery from Module 4
              </h3>
              <p className="mt-1.5 text-[10px] leading-relaxed text-console-muted">
                {imageRecords.length === 0
                  ? "No analysed image carried an EXIF GPS fix. Analyse a geotagged image on the Image Intelligence page and it appears here — the corpus lives in this browser and is never uploaded."
                  : `${imageRecords.length} analysed image(s) carried a GPS fix and are plotted.`}
              </p>
            </CardContent>
          </Card>

          <Card className={CARD}>
            <CardContent className="flex items-start gap-2 p-3">
              <Globe className="size-3.5 shrink-0 text-console-label" />
              <p className="text-[9px] leading-relaxed text-console-muted">
                This map previously placed news at a country centroid plus up to ±2.25° of random
                jitter, cyber threats at a fixed point in central Europe and Telegram posts at a
                fixed point in Ukraine — roughly 250 km of fabricated displacement per pin, rendered
                as geolocation. All of it is removed.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}
