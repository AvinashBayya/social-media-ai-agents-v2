import { useEffect, useMemo, useRef, useState } from "react";
import type { GpsFix } from "@/utils/imaging";
import { describeTileRequest } from "@/utils/geo";
import {
  CARTO_DARK,
  MAP_BACKGROUND,
  addConsentedTileLayer,
  addGraticule,
  addOfflineBasemap,
  addScaleBar,
  loadLeaflet,
} from "@/utils/leaflet-client";

/**
 * Leaflet map for an EXIF GPS fix.
 *
 * Renders only when a coordinate actually exists — there is no default view and
 * no placeholder marker. A map centred on 0,0 with a pin on it would read as a
 * location finding, and 0,0 is a real place in the Gulf of Guinea.
 *
 * NOTHING ON THIS MAP IS FETCHED FROM A THIRD PARTY BY DEFAULT. It used to
 * pull leaflet.css from unpkg.com and dark_all tiles from
 * basemaps.cartocdn.com, and the tiles were the leak: at zoom 15 an EXIF fix
 * of 28.613889, 77.208889 caused /dark_all/15/23411/13663.png to be requested,
 * which places the camera inside a 1.07 km square in CARTO's access log,
 * alongside the analyst's IP address — while the page header promises "all in
 * this browser; the file is never uploaded". The file was indeed never
 * uploaded. Its location was.
 *
 * The stylesheet, the marker icons and the coastlines are now served from this
 * origin (see leaflet-client.ts). Tiles are opt-in per image, never persisted,
 * and the control states the exact request the coordinate would produce.
 *
 * Leaflet is imported dynamically because it touches `window` at module scope
 * and would break SSR.
 */
export function ExifMap({ gps, label }: { gps: GpsFix; label: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);

  /*
   * Third-party tiles are off until an analyst ticks the box, and the tick is
   * ordinary component state ON PURPOSE. It is not written to localStorage and
   * not shared with /gis: consent given about one photograph is not consent
   * about the next one, and a remembered tick would silently disclose the
   * location of every geotagged image opened afterwards.
   */
  const [tiles, setTiles] = useState(false);
  const [zoom, setZoom] = useState(15);
  const [basemapError, setBasemapError] = useState("");

  // Recomputed as the analyst zooms, so the disclosure describes the request
  // that would actually be made, not a worked example from the docs.
  const disclosure = useMemo(
    () => describeTileRequest(gps.latitude, gps.longitude, zoom, CARTO_DARK.pathTemplate),
    [gps.latitude, gps.longitude, zoom],
  );

  useEffect(() => {
    if (typeof window === "undefined" || !containerRef.current) return;
    let cancelled = false;

    loadLeaflet().then((L) => {
      if (cancelled || !containerRef.current) return;

      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }

      const map = L.map(containerRef.current, {
        center: [gps.latitude, gps.longitude],
        zoom: 15,
        attributionControl: true,
      });
      mapRef.current = map;
      setZoom(map.getZoom());
      map.on("zoomend", () => setZoom(map.getZoom()));

      if (tiles) {
        addConsentedTileLayer(L, map, CARTO_DARK);
      } else {
        // Coastlines from this origin. If the file cannot be read we say so —
        // an empty backdrop must never be mistaken for "no land here".
        addOfflineBasemap(L, map).catch((err: any) => {
          if (!cancelled) setBasemapError(err?.message ?? String(err));
        });
      }
      addGraticule(L, map);
      addScaleBar(L, map);

      L.marker([gps.latitude, gps.longitude])
        .addTo(map)
        .bindPopup(
          `<strong>${label}</strong><br/>${gps.latitude.toFixed(6)}, ${gps.longitude.toFixed(6)}` +
            (gps.altitude !== null ? `<br/>${gps.altitude.toFixed(0)} m` : ""),
        );

      // Leaflet mis-measures its container when created inside a panel that is
      // still laying out.
      setTimeout(() => map.invalidateSize(), 0);
    });

    return () => {
      cancelled = true;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, [gps.latitude, gps.longitude, gps.altitude, label, tiles]);

  return (
    <div className="space-y-1.5">
      <div
        ref={containerRef}
        className="h-56 w-full rounded border border-[#263548]"
        style={{ background: MAP_BACKGROUND }}
      />
      {basemapError && (
        <p className="font-mono text-[10px] leading-relaxed text-[#F59E0B]">
          Offline basemap unavailable: {basemapError}. The marker is unaffected — only the coastline
          backdrop is missing, and nothing was substituted for it.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] text-[#94A3B8]">
        <span>
          {gps.latitude.toFixed(6)}, {gps.longitude.toFixed(6)}
          {gps.altitude !== null ? ` · ${gps.altitude.toFixed(0)} m` : ""}
        </span>
        <a
          href={`https://www.openstreetmap.org/?mlat=${gps.latitude}&mlon=${gps.longitude}#map=16/${gps.latitude}/${gps.longitude}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[#3B82F6] hover:underline"
        >
          OpenStreetMap
        </a>
        <a
          href={`https://www.google.com/maps/search/?api=1&query=${gps.latitude},${gps.longitude}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[#3B82F6] hover:underline"
        >
          Google Maps
        </a>
      </div>

      <p className="text-[10px] leading-relaxed text-[#64748B]">
        Both links carry this coordinate in the URL, so opening one discloses it to that provider.
        Nothing is sent until you click.
      </p>

      {tiles ? (
        <div className="rounded border border-[#F59E0B]/40 bg-[#F59E0B]/5 p-2">
          <p className="text-[10px] leading-relaxed text-[#F59E0B]">
            <span className="font-semibold">
              Requesting basemap tiles from {CARTO_DARK.host} — this image&apos;s location is being
              disclosed.
            </span>{" "}
            At the current zoom the fix sits in <span className="font-mono">{disclosure.path}</span>
            , a {disclosure.footprint} square. Every pan and zoom sends more paths. The image file
            itself still never leaves this browser.{" "}
            <button onClick={() => setTiles(false)} className="underline hover:text-white">
              Turn tiles off
            </button>
          </p>
        </div>
      ) : (
        <label className="flex items-start gap-2 rounded border border-[#263548] bg-[#0B1220] p-2">
          <input
            type="checkbox"
            checked={false}
            onChange={() => setTiles(true)}
            className="mt-0.5 size-3 shrink-0 accent-[#F59E0B]"
          />
          <span className="text-[10px] leading-relaxed text-[#94A3B8]">
            <span className="font-semibold text-white">
              Load street-level basemap tiles from {CARTO_DARK.host} — off
            </span>
            <br />
            Right now this map contacts no one: Leaflet&apos;s stylesheet and marker icons ship
            inside this app and the coastlines come from{" "}
            <span className="font-mono text-[#CBD5E1]">/data/world.geo.json</span> on this origin.
            Ticking this box makes the browser request raster tiles from{" "}
            <span className="font-mono text-[#CBD5E1]">{CARTO_DARK.host}</span> (
            {CARTO_DARK.operator}
            ). A tile path is the coordinate: this image&apos;s fix would be requested as{" "}
            <span className="font-mono text-[#F59E0B]">{disclosure.path}</span>, which pins the
            camera to a {disclosure.footprint} square in {CARTO_DARK.operator}&apos;s access log,
            together with your IP address, the time and your browser User-Agent. The image file is
            still never uploaded — only its location is disclosed. This box is not remembered; it is
            clear again for the next image.
          </span>
        </label>
      )}
    </div>
  );
}
