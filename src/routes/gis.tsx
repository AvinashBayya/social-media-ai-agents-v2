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
} from "lucide-react";
import { getActiveTarget, setActiveTarget } from "@/utils/active-target";
import { fetchGeoLayers } from "@/utils/geo-sources";
import {
  cellSizeForZoom,
  clusterByGrid,
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

const CARD = "bg-[#111827] border-[#263548]";

const layerColour = (id: GeoLayerId) => GEO_LAYERS.find((l) => l.id === id)?.colour ?? "#94A3B8";

/** Marker radius in pixels from a layer-relative magnitude. Constant when unmeasured. */
function radiusFor(record: GeoRecord, maxMagnitude: number): number {
  if (record.magnitude === null || maxMagnitude <= 0) return 5;
  return 4 + Math.sqrt(Math.max(0, record.magnitude) / maxMagnitude) * 12;
}

function GISPage() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const layerGroupRef = useRef<any>(null);
  const leafletRef = useRef<any>(null);

  const [target, setTarget] = useState(() => getActiveTarget());
  const [draft, setDraft] = useState(() => getActiveTarget());
  const [results, setResults] = useState<LayerResult[]>([]);
  const [imageRecords, setImageRecords] = useState<GeoRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState(2);
  const [selected, setSelected] = useState<GeoRecord | null>(null);

  const [enabled, setEnabled] = useState<Record<GeoLayerId, boolean>>({
    conflict: true,
    seismic: true,
    news: true,
    imagery: true,
    infrastructure: true,
  });
  const [timeWindow, setTimeWindow] = useState<[number, number] | null>(null);

  // ── Collect server-side layers ───────────────────────────────────────────
  useEffect(() => {
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
    ],
    [results, imageRecords],
  );

  const allRecords = useMemo(
    () => allResults.filter((r) => enabled[r.layer]).flatMap((r) => r.records),
    [allResults, enabled],
  );

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

  // ── Map ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (typeof window === "undefined" || !containerRef.current) return;
    let cancelled = false;

    if (!document.querySelector("link[data-leaflet]")) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
      link.setAttribute("data-leaflet", "true");
      document.head.appendChild(link);
    }

    import("leaflet").then((mod) => {
      if (cancelled || !containerRef.current || mapRef.current) return;
      const L: any = (mod as any).default ?? mod;
      leafletRef.current = L;

      const map = L.map(containerRef.current, { center: [20, 20], zoom: 2, worldCopyJump: true });
      L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap, &copy; CARTO",
      }).addTo(map);

      layerGroupRef.current = L.layerGroup().addTo(map);
      map.on("zoomend", () => setZoom(map.getZoom()));
      mapRef.current = map;
      setTimeout(() => map.invalidateSize(), 0);
    });

    return () => {
      cancelled = true;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []);

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
              `<div style="background:${colour};color:#0B1220;border-radius:999px;` +
              `width:26px;height:26px;display:grid;place-items:center;font:700 11px sans-serif;` +
              `border:2px solid #0B1220">${cluster.members.length}</div>`,
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
            `${r.source} · ${new Date(r.timestamp).toISOString().slice(0, 16).replace("T", " ")}<br/>` +
            `<em>${PRECISION_LABEL[r.precision]} — locates ${r.locates}</em>`,
        );
    }
  }, [visible, zoom]);

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
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[#64748B]" />
                  <Input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && search()}
                    placeholder="Subject for the news layer…"
                    className="h-8 border-[#263548] bg-[#0B1220] pl-8 text-[11px] text-white"
                  />
                </div>
                <Button size="sm" onClick={search} disabled={loading} className="h-8">
                  {loading ? <Loader2 className="size-3.5 animate-spin" /> : "Collect"}
                </Button>
                <span className="font-mono text-[10px] text-[#64748B]">
                  {visible.length} of {allRecords.length} plotted · zoom {zoom}
                </span>
              </div>

              {error && (
                <div className="mt-2 flex items-start gap-2 rounded border border-[#EF4444]/30 bg-[#EF4444]/5 p-2">
                  <AlertTriangle className="size-3.5 shrink-0 text-[#EF4444]" />
                  <span className="font-mono text-[10px] text-[#EF4444]">{error}</span>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className={CARD}>
            <CardContent className="p-0">
              <div ref={containerRef} className="h-[520px] w-full rounded-t-lg" />

              {/* ── Time slider ──────────────────────────────────────────── */}
              <div className="border-t border-[#263548] p-3">
                {extent && timeWindow ? (
                  <>
                    <div className="flex items-center justify-between font-mono text-[10px] text-[#94A3B8]">
                      <span>{fmtDay(timeWindow[0])}</span>
                      <span className="text-[#64748B]">
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
                    <p className="mt-1 font-mono text-[9px] text-[#64748B]">
                      Range is the true extent of the collected records ({fmtDay(extent.fromMs)} to{" "}
                      {fmtDay(extent.toMs)}), not a fixed window.
                    </p>
                  </>
                ) : (
                  <p className="font-mono text-[10px] text-[#64748B]">
                    No dated records to filter. The slider appears when the collection carries
                    usable timestamps.
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          {/* ── Selected record ────────────────────────────────────────── */}
          {selected && (
            <Card className="border-[#3B82F6]/40 bg-[#111827]">
              <CardContent className="p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <MapPin className="size-3.5" style={{ color: layerColour(selected.layer) }} />
                  <span className="text-xs font-bold uppercase text-white">
                    {GEO_LAYERS.find((l) => l.id === selected.layer)?.label}
                  </span>
                  <button
                    onClick={() => setSelected(null)}
                    className="ml-auto text-[10px] text-[#64748B] hover:text-white"
                  >
                    close
                  </button>
                </div>

                <p className="mt-1.5 text-sm leading-snug text-[#F3F4F6]">{selected.title}</p>

                <dl className="mt-2 space-y-1 border-t border-[#263548] pt-2 font-mono text-[10px]">
                  <div className="flex justify-between gap-2">
                    <dt className="text-[#64748B]">Coordinate</dt>
                    <dd className="text-white">
                      {selected.lat.toFixed(5)}, {selected.lon.toFixed(5)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-[#64748B]">Precision</dt>
                    <dd className="text-[#F59E0B]">{PRECISION_LABEL[selected.precision]}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="shrink-0 text-[#64748B]">Locates</dt>
                    <dd className="text-right text-white">{selected.locates}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-[#64748B]">Reported</dt>
                    <dd className="text-white">{selected.timestamp}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-[#64748B]">Magnitude</dt>
                    <dd className="text-white">{selected.magnitudeLabel}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-[#64748B]">Module 1 credibility</dt>
                    <dd className="text-white">
                      {selected.credibility === null
                        ? "not scored for this record type"
                        : `${(selected.credibility * 100).toFixed(0)}%`}
                    </dd>
                  </div>
                  {Object.entries(selected.detail)
                    .filter(([k]) => k !== "thumbnail")
                    .map(([k, v]) => (
                      <div key={k} className="flex justify-between gap-2">
                        <dt className="text-[#64748B]">{k}</dt>
                        <dd className="text-right text-white">{String(v)}</dd>
                      </div>
                    ))}
                </dl>

                {typeof selected.detail.thumbnail === "string" && (
                  <img
                    src={selected.detail.thumbnail}
                    alt={selected.title}
                    className="mt-2 max-h-40 rounded border border-[#263548] object-contain"
                  />
                )}

                {selected.url && (
                  <a
                    href={selected.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 inline-block font-mono text-[10px] text-[#3B82F6] hover:underline"
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
              <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase text-white">
                <LayersIcon className="size-3.5 text-[#3B82F6]" />
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
                      className="rounded border border-[#263548] bg-[#0B1220]/60 p-2"
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
                          className={`text-[11px] font-medium ${on ? "text-white" : "text-[#64748B]"}`}
                        >
                          {layer.label}
                        </span>
                        <span className="ml-auto shrink-0 font-mono text-[10px] text-[#94A3B8]">
                          {count}
                        </span>
                      </button>

                      {result?.error && (
                        <p className="mt-1 text-[9px] leading-relaxed text-[#F59E0B]">
                          {result.error}
                        </p>
                      )}
                      {!result?.error && (result?.unplaceable ?? 0) > 0 && (
                        <p className="mt-1 text-[9px] leading-relaxed text-[#F59E0B]">
                          {result!.unplaceable} collected record(s) carried no usable coordinate and
                          were excluded rather than approximated.
                        </p>
                      )}
                      <p className="mt-1 text-[9px] leading-relaxed text-[#64748B]">
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
              <h3 className="text-xs font-bold uppercase text-white">Collection integrity</h3>
              <p className="mt-2 text-[10px] leading-relaxed text-[#94A3B8]">{summary.note}</p>
              <div className="mt-2 flex flex-wrap gap-1">
                <Badge
                  variant="outline"
                  className="border-[#10B981]/40 bg-[#10B981]/10 text-[9px] font-normal text-[#10B981]"
                >
                  {summary.plotted} plotted
                </Badge>
                {summary.unplaceable > 0 && (
                  <Badge
                    variant="outline"
                    className="border-[#F59E0B]/40 bg-[#F59E0B]/10 text-[9px] font-normal text-[#F59E0B]"
                  >
                    {summary.unplaceable} excluded
                  </Badge>
                )}
              </div>
              <p className="mt-2 flex items-start gap-1.5 text-[9px] leading-relaxed text-[#64748B]">
                <Info className="mt-px size-3 shrink-0" />
                Exact fixes render as filled points sized by magnitude. Anything coarser renders as
                a dashed circle at its true uncertainty radius — a country-level record can never be
                read as a located event.
              </p>
            </CardContent>
          </Card>

          <Card className={CARD}>
            <CardContent className="p-4">
              <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase text-white">
                <Camera className="size-3.5 text-[#10B981]" />
                Imagery from Module 4
              </h3>
              <p className="mt-1.5 text-[10px] leading-relaxed text-[#94A3B8]">
                {imageRecords.length === 0
                  ? "No analysed image carried an EXIF GPS fix. Analyse a geotagged image on the Image Intelligence page and it appears here — the corpus lives in this browser and is never uploaded."
                  : `${imageRecords.length} analysed image(s) carried a GPS fix and are plotted.`}
              </p>
            </CardContent>
          </Card>

          <Card className={CARD}>
            <CardContent className="flex items-start gap-2 p-3">
              <Globe className="size-3.5 shrink-0 text-[#64748B]" />
              <p className="text-[9px] leading-relaxed text-[#94A3B8]">
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
