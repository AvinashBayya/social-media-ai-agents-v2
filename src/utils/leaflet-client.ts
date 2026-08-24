/**
 * Leaflet, served entirely from this origin — Modules 4 and 5.
 *
 * Both maps in this app used to load `leaflet.css` from unpkg.com and their
 * basemap raster tiles from basemaps.cartocdn.com. The stylesheet is merely a
 * run-time supply-chain dependency. The tiles are worse than that, because a
 * raster tile request IS the coordinate: opening a geotagged photograph on
 * /images centred the map at zoom 15 on the image's own EXIF fix, so for
 * 28.613889, 77.208889 the browser fetched
 * `a.basemaps.cartocdn.com/dark_all/15/23411/13663.png` — a 1.07 km square,
 * logged by CARTO against the analyst's IP address and the time of analysis,
 * on a page whose own header reads "all in this browser; the file is never
 * uploaded".
 *
 * So:
 *   - Leaflet's stylesheet and its three marker PNGs are emitted as
 *     first-party assets through Vite's `?url` handling, exactly as
 *     `imaging-client.ts` does for the c2pa WASM and worker, and for the same
 *     reason: a defence tool should not be fetching pieces of itself from a
 *     CDN in the middle of an analysis.
 *   - The default basemap is VECTOR, not raster — country outlines from
 *     `/data/world.geo.json` on this origin, plus a graticule and a scale
 *     bar. It is coarse, and that is the honest trade-off: a global raster
 *     basemap is a dataset that cannot be bundled, so the choice is a coarse
 *     map that discloses nothing or a detailed map that discloses the
 *     coordinate. Neither page defaults to the second.
 *   - Third-party tiles remain reachable, but only behind an explicit control
 *     that is unchecked by default, names the host and its operator, and
 *     prints the exact path the coordinate in front of the analyst would
 *     produce (see `describeTileRequest` in geo.ts).
 *
 * Client-only: everything here touches DOM, `window` or `fetch`. The pure
 * arithmetic lives in `geo.ts` so it stays unit-testable.
 */

import { graticuleStepDegrees } from "@/utils/geo";

/**
 * Sea colour behind the vector basemap. Leaflet's own CSS paints #ddd.
 * Theme-reactive (a plain DOM `style={{ background }}`, not canvas) —
 * without this, the map would render a literal dark rectangle in light
 * mode while everything around it went light, an obvious visible "hole".
 */
export const MAP_BACKGROUND = "var(--console-deep)";

/**
 * LAND_FILL/COAST_STROKE/GRATICULE_STROKE paint via Leaflet's Canvas2D
 * renderer (`ctx.fillStyle`/`ctx.strokeStyle` in addOfflineBasemap/
 * addGraticule below) — Canvas2D does not resolve `var(...)`, unlike DOM/SVG
 * inline styles, so these stay literal hex and are deliberately excluded
 * from the light/dark migration (matching a chart palette or basemap tile
 * set, which conventionally doesn't invert with the app's own theme either).
 * Making these theme-reactive would need a `getComputedStyle` read at draw
 * time plus a redraw-on-theme-change listener, not a simple value swap.
 */
const LAND_FILL = "#16213A";
const COAST_STROKE = "#31435F";
const GRATICULE_STROKE = "#1C2A3E";

/** Country outlines, served by this app. Not a map service. */
export const OFFLINE_BASEMAP_URL = "/data/world.geo.json";

export interface TileProvider {
  id: string;
  /** Host the browser connects to. Named verbatim in the consent control. */
  host: string;
  /** Who operates that host, so consent is given to a party, not a hostname. */
  operator: string;
  urlTemplate: string;
  /**
   * Path portion with {z}/{x}/{y} placeholders, used to show the analyst the
   * exact request their coordinate produces. Kept in sync with urlTemplate by
   * hand — it is display text, not the fetch path.
   */
  pathTemplate: string;
  attribution: string;
  maxZoom: number;
}

export const CARTO_DARK: TileProvider = {
  id: "carto-dark",
  host: "basemaps.cartocdn.com",
  operator: "CARTO",
  urlTemplate: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
  pathTemplate: "/dark_all/{z}/{x}/{y}.png",
  attribution: "&copy; OpenStreetMap contributors, &copy; CARTO",
  maxZoom: 19,
};

/**
 * The networked tile provider is config-driven, not hardcoded to CARTO. No
 * provider is wired into this codebase beyond CARTO today — earlier planning
 * assumed Mappls had already been chosen and integrated; it has not (verified
 * live: zero references anywhere in src/ or .env.example). Rather than block
 * on obtaining a Mappls account/key, CARTO stays the tested, working default
 * and a self-hosted or alternative provider (Mappls included) can be dropped
 * in via env vars with no code change — the same "config, never code"
 * discipline llm.ts uses for its provider swap.
 *
 * VITE_ prefix: these are read in the browser (the tile request itself is a
 * client-side fetch, same as CARTO_DARK always was), so Vite must inline them
 * at build time.
 */
export function resolveTileProvider(): TileProvider {
  const env = (import.meta as any).env ?? {};
  const urlTemplate = env.VITE_GIS_TILE_URL_TEMPLATE;
  if (typeof urlTemplate !== "string" || !urlTemplate.trim()) return CARTO_DARK;

  return {
    id: env.VITE_GIS_TILE_ID || "custom",
    host: env.VITE_GIS_TILE_HOST || "unspecified host",
    operator: env.VITE_GIS_TILE_OPERATOR || "unspecified operator",
    urlTemplate,
    pathTemplate: env.VITE_GIS_TILE_PATH_TEMPLATE || CARTO_DARK.pathTemplate,
    attribution: env.VITE_GIS_TILE_ATTRIBUTION || "attribution not configured (VITE_GIS_TILE_ATTRIBUTION unset)",
    maxZoom: Number(env.VITE_GIS_TILE_MAX_ZOOM) || 19,
  };
}

// ─── Leaflet itself ────────────────────────────────────────────────────────

let leafletPromise: Promise<any> | null = null;

/**
 * Load Leaflet with its stylesheet and marker icons resolved to first-party
 * URLs. Memoised: the module is a singleton and the <link> must be injected
 * once.
 */
export function loadLeaflet(): Promise<any> {
  if (!leafletPromise) leafletPromise = initLeaflet();
  return leafletPromise;
}

async function initLeaflet(): Promise<any> {
  const [mod, css, icon, icon2x, shadow] = await Promise.all([
    import("leaflet"),
    import("leaflet/dist/leaflet.css?url"),
    import("leaflet/dist/images/marker-icon.png?url"),
    import("leaflet/dist/images/marker-icon-2x.png?url"),
    import("leaflet/dist/images/marker-shadow.png?url"),
  ]);
  const L: any = (mod as any).default ?? mod;

  if (typeof document !== "undefined" && !document.querySelector("link[data-leaflet]")) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = (css as any).default;
    link.setAttribute("data-leaflet", "true");
    document.head.appendChild(link);
  }

  /*
   * Leaflet 1.9.4 GUESSES where its marker PNGs live, and the guess is broken.
   * `Icon.Default._detectIconPath` first reads the background-image of a
   * `.leaflet-default-icon-path` probe element — which is empty when, as here,
   * the stylesheet was injected in the same tick and has not loaded yet — and
   * then falls back to
   *
   *     link.href.substring(0, link.href.length - 'leaflet.css'.length - 1)
   *
   * That `- 1` eats the separator as well as the filename, so a CDN href
   * produced `https://unpkg.com/leaflet@1.9.4/dist` and every marker requested
   * `https://unpkg.com/leaflet@1.9.4/distmarker-icon.png` — the missing slash,
   * and the reason no pin ever rendered. A hashed first-party href would not
   * even match the `link[href$="leaflet.css"]` selector, so detection cannot be
   * relied on either way.
   *
   * Assigning a string to `imagePath` short-circuits detection permanently
   * (`if (typeof IconDefault.imagePath !== 'string')`), and "" makes the
   * prefix empty so the merged absolute URLs are used verbatim. Sizes and
   * anchors are already correct in Leaflet's defaults and are left alone.
   */
  L.Icon.Default.imagePath = "";
  L.Icon.Default.mergeOptions({
    iconUrl: (icon as any).default,
    iconRetinaUrl: (icon2x as any).default,
    shadowUrl: (shadow as any).default,
  });

  return L;
}

// ─── Panes ─────────────────────────────────────────────────────────────────

const BASEMAP_PANE = "sentinel-basemap";
const GRATICULE_PANE = "sentinel-graticule";

/**
 * Explicit panes, because the offline basemap arrives after a fetch. Without
 * them the country outlines can be appended to the overlay pane AFTER the
 * markers and paint over the findings. Leaflet's own panes: tiles 200,
 * overlays 400, markers 600.
 */
function ensurePane(map: any, name: string, zIndex: number): string {
  if (!map.getPane(name)) {
    const pane = map.createPane(name);
    pane.style.zIndex = String(zIndex);
    pane.style.pointerEvents = "none";
  }
  return name;
}

// ─── Offline vector basemap ────────────────────────────────────────────────

let outlinesPromise: Promise<any> | null = null;

function loadWorldOutlines(): Promise<any> {
  if (!outlinesPromise) {
    outlinesPromise = fetch(OFFLINE_BASEMAP_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`${OFFLINE_BASEMAP_URL} returned HTTP ${res.status}`);
        return res.json();
      })
      .catch((err) => {
        // Do not cache the failure — a later map should be allowed to retry.
        outlinesPromise = null;
        throw err;
      });
  }
  return outlinesPromise;
}

/**
 * Country outlines from this origin. Rejects if the file cannot be read; the
 * caller must SAY SO rather than leaving an empty backdrop, which would read
 * as "no land here".
 */
export async function addOfflineBasemap(L: any, map: any): Promise<any> {
  const geojson = await loadWorldOutlines();
  const pane = ensurePane(map, BASEMAP_PANE, 250);
  return L.geoJSON(geojson, {
    pane,
    renderer: L.canvas({ pane, padding: 0.3 }),
    interactive: false,
    style: {
      color: COAST_STROKE,
      weight: 1,
      fillColor: LAND_FILL,
      fillOpacity: 1,
    },
    attribution: `Country outlines: ${OFFLINE_BASEMAP_URL} on this origin — no map service contacted`,
  }).addTo(map);
}

// ─── Graticule ─────────────────────────────────────────────────────────────

/** A wide viewport at a fine step would otherwise emit thousands of paths. */
const MAX_GRATICULE_LINES = 60;

/**
 * Lat/lon grid, redrawn on every view change. With raster tiles off this and
 * the scale control are the only scale references on the map, which is the
 * cost of not disclosing the coordinate. Returns a remover.
 */
export function addGraticule(L: any, map: any): () => void {
  const pane = ensurePane(map, GRATICULE_PANE, 260);
  const group = L.layerGroup([], { pane }).addTo(map);
  const renderer = L.canvas({ pane, padding: 0.3 });
  const style = {
    pane,
    renderer,
    color: GRATICULE_STROKE,
    weight: 1,
    opacity: 0.8,
    interactive: false,
  };

  const draw = () => {
    group.clearLayers();
    const step = graticuleStepDegrees(map.getZoom());
    const bounds = map.getBounds();
    const south = Math.max(-85, Math.ceil(bounds.getSouth() / step) * step);
    const north = Math.min(85, Math.floor(bounds.getNorth() / step) * step);
    const west = Math.ceil(bounds.getWest() / step) * step;
    const east = Math.floor(bounds.getEast() / step) * step;
    const rows = Math.min(MAX_GRATICULE_LINES, Math.floor((north - south) / step) + 1);
    const cols = Math.min(MAX_GRATICULE_LINES, Math.floor((east - west) / step) + 1);

    for (let i = 0; i < rows; i++) {
      const lat = south + i * step;
      L.polyline(
        [
          [lat, bounds.getWest()],
          [lat, bounds.getEast()],
        ],
        style,
      ).addTo(group);
    }
    for (let i = 0; i < cols; i++) {
      const lon = west + i * step;
      L.polyline(
        [
          [Math.max(-85, bounds.getSouth()), lon],
          [Math.min(85, bounds.getNorth()), lon],
        ],
        style,
      ).addTo(group);
    }
  };

  draw();
  map.on("moveend zoomend resize", draw);
  return () => {
    map.off("moveend zoomend resize", draw);
    group.remove();
  };
}

/** Metric scale bar. Free, offline, and the honest substitute for street detail. */
export function addScaleBar(L: any, map: any): any {
  return L.control.scale({ metric: true, imperial: false, maxWidth: 140 }).addTo(map);
}

// ─── Third-party tiles, only on consent ────────────────────────────────────

/**
 * Add a third-party raster basemap. The name is deliberate: there is no other
 * caller path, and every call site must be able to point at the control the
 * analyst ticked. Returns the layer so it can be removed on withdrawal.
 */
export function addConsentedTileLayer(L: any, map: any, provider: TileProvider): any {
  return L.tileLayer(provider.urlTemplate, {
    maxZoom: provider.maxZoom,
    attribution: provider.attribution,
  }).addTo(map);
}
