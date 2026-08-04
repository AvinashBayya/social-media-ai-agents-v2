/**
 * Module 5 — GIS layer (PS-18 §6.5), deterministic half.
 *
 * COORDINATE HONESTY is the entire point of this file. On an intelligence map
 * the pin IS the claim: an analyst reading a marker over a specific town will
 * act as though something happened in that town. The previous implementation
 * placed every stream with invented coordinates — news at a country centroid
 * plus up to +/-2.25 degrees of Math.random() jitter, cyber threats at a
 * hardcoded 45.0N/15.0E in central Europe, Telegram posts at 48.0N/31.0E in
 * Ukraine, and a random hour on each marker that then drove the time filter.
 * Roughly 250 km of fabricated displacement per pin, presented as geolocation.
 *
 * Rules here:
 *   1. A record with no real coordinate produces NO marker. It is counted and
 *      reported as unplaceable, never approximated onto the map.
 *   2. Every coordinate carries its PRECISION and a statement of what it
 *      actually locates. Country-precision data renders as an uncertainty
 *      circle, never as a pin.
 *   3. `locates` is separate from `title` on purpose: GDELT gives the
 *      publishing outlet's country, which is NOT where the event happened. A
 *      Sputnik article about India carries sourcecountry "China" — verified
 *      against the live API. Plotting that as an event location would be
 *      actively misleading, so it is labelled as the outlet's country and
 *      drawn at country precision.
 *
 * Pure: no DOM, no network. Collectors that fetch live upstreams live in
 * geo-sources.ts. No Math.random() anywhere.
 */

// ─── Precision ─────────────────────────────────────────────────────────────

export type GeoPrecision = "exact" | "city" | "country";

/**
 * Radius, in metres, of the uncertainty circle drawn for each precision class.
 *
 * "exact" is zero because it renders as a pin — a device GPS fix or a geocoded
 * event coordinate is a point. The others are drawn as circles sized to the
 * genuine ambiguity: roughly a metropolitan area, and roughly the radius of a
 * mid-sized country from its centroid.
 */
export const PRECISION_RADIUS_M: Record<GeoPrecision, number> = {
  exact: 0,
  city: 15_000,
  country: 400_000,
};

export const PRECISION_LABEL: Record<GeoPrecision, string> = {
  exact: "point coordinate",
  city: "city-level (±15 km)",
  country: "country-level (±400 km)",
};

export type GeoLayerId = "conflict" | "seismic" | "news" | "imagery" | "infrastructure";

export interface GeoLayer {
  id: GeoLayerId;
  label: string;
  /** Where the coordinates come from, stated in the UI. */
  provenance: string;
  colour: string;
}

export const GEO_LAYERS: GeoLayer[] = [
  {
    id: "conflict",
    label: "Conflict events (UCDP GED)",
    provenance:
      "Uppsala Conflict Data Program, Georeferenced Event Dataset. Event-level coordinates " +
      "geocoded by UCDP with their own precision field. Requires UCDP_API_TOKEN — the API " +
      "began returning 401 without one (verified 2026-08-04).",
    colour: "#EF4444",
  },
  {
    id: "seismic",
    label: "Seismic events (USGS)",
    provenance:
      "USGS earthquake feed. Instrument-derived epicentres — the most precisely located " +
      "open dataset available without a key.",
    colour: "#F59E0B",
  },
  {
    id: "news",
    label: "News outlets (GDELT)",
    provenance:
      "GDELT DOC API. Carries only the PUBLISHING OUTLET's country, not the event location. " +
      "Drawn at country precision and labelled as the outlet, because a Chinese outlet " +
      "reporting on India is not an event in China.",
    colour: "#3B82F6",
  },
  {
    id: "imagery",
    label: "Image GPS (Module 4)",
    provenance:
      "EXIF GPS from images analysed on the Image Intelligence page. Written by the capturing " +
      "device — precise, and forgeable, so treat as a strong lead rather than a fact.",
    colour: "#10B981",
  },
  {
    id: "infrastructure",
    label: "Infrastructure (Shodan)",
    provenance:
      "Not wired. Shodan InternetDB is the keyless endpoint we use and it returns no " +
      "geolocation; host geo needs the paid Shodan API. No coordinates are invented to fill it.",
    colour: "#8B5CF6",
  },
];

// ─── Record shape ──────────────────────────────────────────────────────────

export interface GeoRecord {
  id: string;
  layer: GeoLayerId;
  lat: number;
  lon: number;
  precision: GeoPrecision;
  /**
   * What the coordinate locates, in words. Rendered on the marker popup so the
   * analyst never has to infer it — "the reported event" and "the publishing
   * outlet's registered country" are very different claims.
   */
  locates: string;
  title: string;
  source: string;
  url: string;
  /** ISO 8601. Drives the time slider. */
  timestamp: string;
  /** Magnitude for marker sizing, or null when nothing measures one. */
  magnitude: number | null;
  magnitudeLabel: string;
  detail: Record<string, string | number>;
  /** Module 1 credibility 0-1, when the record came from a scored corpus. */
  credibility: number | null;
}

export interface LayerResult {
  layer: GeoLayerId;
  records: GeoRecord[];
  /** Records received that carried no usable coordinate, so were NOT plotted. */
  unplaceable: number;
  /** Non-null when the layer could not be collected at all. */
  error: string | null;
}

/** True only for a finite coordinate inside valid bounds and not the null island. */
export function isRealCoordinate(lat: unknown, lon: unknown): boolean {
  if (typeof lat !== "number" || typeof lon !== "number") return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return false;
  // 0,0 is in the Gulf of Guinea and is overwhelmingly a missing-value sentinel
  // rather than a real fix. Treating it as real puts a pin in the ocean for
  // every record whose coordinate failed to parse.
  if (lat === 0 && lon === 0) return false;
  return true;
}

const iso = (v: unknown): string | null => {
  if (v === null || v === undefined || v === "") return null;
  const d = v instanceof Date ? v : new Date(typeof v === "number" ? v : String(v));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
};

// ─── Country centroids ─────────────────────────────────────────────────────
// Used ONLY for country-precision layers, and always with an uncertainty circle.

export const COUNTRY_CENTROIDS: Record<string, [number, number]> = {
  "United States": [39.83, -98.58], "Russia": [61.52, 105.32], "China": [35.86, 104.2],
  "India": [22.35, 78.67], "Pakistan": [30.38, 69.35], "Iran": [32.43, 53.69],
  "Ukraine": [48.38, 31.17], "Germany": [51.17, 10.45], "United Kingdom": [55.38, -3.44],
  "France": [46.23, 2.21], "Israel": [31.05, 34.85], "Syria": [34.8, 38.997],
  "North Korea": [40.34, 127.51], "South Korea": [35.91, 127.77], "Japan": [36.2, 138.25],
  "Taiwan": [23.7, 120.96], "Turkey": [38.96, 35.24], "Saudi Arabia": [23.89, 45.08],
  "Bangladesh": [23.68, 90.36], "Sri Lanka": [7.87, 80.77], "Nepal": [28.39, 84.12],
  "Myanmar": [21.91, 95.96], "Afghanistan": [33.94, 67.71], "Iraq": [33.22, 43.68],
  "Yemen": [15.55, 48.52], "Egypt": [26.82, 30.8], "Nigeria": [9.08, 8.68],
  "Ethiopia": [9.15, 40.49], "Sudan": [12.86, 30.22], "Somalia": [5.15, 46.2],
  "Brazil": [-14.24, -51.93], "Canada": [56.13, -106.35], "Australia": [-25.27, 133.78],
  "Indonesia": [-0.79, 113.92], "Philippines": [12.88, 121.77], "Vietnam": [14.06, 108.28],
  "Thailand": [15.87, 100.99], "Malaysia": [4.21, 101.98], "Singapore": [1.35, 103.82],
  "Italy": [41.87, 12.57], "Spain": [40.46, -3.75], "Poland": [51.92, 19.15],
  "Netherlands": [52.13, 5.29], "Sweden": [60.13, 18.64], "Norway": [60.47, 8.47],
  "Switzerland": [46.82, 8.23], "Belgium": [50.5, 4.47], "Austria": [47.52, 14.55],
  "Mexico": [23.63, -102.55], "Argentina": [-38.42, -63.62], "South Africa": [-30.56, 22.94],
  "Kenya": [-0.02, 37.91], "Qatar": [25.35, 51.18], "United Arab Emirates": [23.42, 53.85],
};

// ─── Adapters: upstream record -> GeoRecord | null ─────────────────────────
// Each returns null when the source carries no real coordinate. That null is
// the mechanism preventing fabricated placement; every adapter is tested for it.

/** USGS earthquake GeoJSON feature. Coordinates are [lon, lat, depth]. */
export function fromUsgsFeature(feature: any): GeoRecord | null {
  const coords = feature?.geometry?.coordinates;
  if (!Array.isArray(coords)) return null;
  const [lon, lat, depth] = coords;
  if (!isRealCoordinate(lat, lon)) return null;

  const p = feature.properties ?? {};
  const time = iso(p.time);
  if (!time) return null;

  const mag = typeof p.mag === "number" ? p.mag : null;
  return {
    id: `usgs-${feature.id ?? `${lat},${lon},${p.time}`}`,
    layer: "seismic",
    lat, lon,
    precision: "exact",
    locates: "the instrument-derived epicentre",
    title: String(p.title ?? p.place ?? "Seismic event"),
    source: "USGS",
    url: String(p.url ?? ""),
    timestamp: time,
    magnitude: mag,
    magnitudeLabel: mag === null ? "magnitude not reported" : `M${mag.toFixed(1)}`,
    detail: {
      place: String(p.place ?? "unknown"),
      depthKm: typeof depth === "number" ? Number(depth.toFixed(1)) : "unknown",
      ...(typeof p.felt === "number" ? { feltReports: p.felt } : {}),
    },
    credibility: null,
  };
}

/**
 * UCDP GED event. `where_prec` is UCDP's own precision code:
 * 1 = exact site, 2 = near a site, 3 = area/second-order admin, 4+ = coarser.
 * That field is carried through rather than assumed — UCDP already did this
 * work and discarding it would throw away the honest answer.
 */
export function fromUcdpEvent(event: any): GeoRecord | null {
  const lat = typeof event?.latitude === "number" ? event.latitude : Number(event?.latitude);
  const lon = typeof event?.longitude === "number" ? event.longitude : Number(event?.longitude);
  if (!isRealCoordinate(lat, lon)) return null;

  const time = iso(event?.date_start ?? event?.date_end);
  if (!time) return null;

  const wherePrec = Number(event?.where_prec);
  const precision: GeoPrecision =
    wherePrec <= 2 ? "exact" : wherePrec === 3 ? "city" : "country";

  const deaths =
    (Number(event?.deaths_a) || 0) +
    (Number(event?.deaths_b) || 0) +
    (Number(event?.deaths_civilians) || 0) +
    (Number(event?.deaths_unknown) || 0);

  const sides = [event?.side_a, event?.side_b].filter(Boolean).join(" vs ");
  return {
    id: `ucdp-${event.id}`,
    layer: "conflict",
    lat, lon,
    precision,
    locates:
      precision === "exact"
        ? "the reported event site (UCDP precision 1-2)"
        : precision === "city"
          ? "the administrative area containing the event (UCDP precision 3)"
          : "a coarse area only (UCDP precision 4+)",
    title: sides || String(event?.conflict_name ?? "Conflict event"),
    source: "UCDP GED",
    url: "https://ucdp.uu.se/",
    timestamp: time,
    magnitude: deaths,
    magnitudeLabel: `${deaths} recorded fatality/ies`,
    detail: {
      country: String(event?.country ?? "unknown"),
      region: String(event?.region ?? "unknown"),
      typeOfViolence: String(event?.type_of_violence ?? "unknown"),
      ucdpPrecision: Number.isFinite(wherePrec) ? wherePrec : "unstated",
    },
    credibility: null,
  };
}

/**
 * GDELT DOC API article.
 *
 * GDELT gives `sourcecountry` — where the OUTLET is registered — and nothing
 * about where the story happened. Verified live: a Sputnik article about India
 * carries sourcecountry "China". This is therefore plotted at COUNTRY precision
 * and explicitly labelled as the outlet's country, never as an event location.
 */
export function fromGdeltArticle(article: any, credibility: number | null = null): GeoRecord | null {
  const country = String(article?.sourcecountry ?? "").trim();
  const centroid = COUNTRY_CENTROIDS[country];
  if (!centroid) return null;

  // GDELT's seendate is compact ISO: 20260727T144500Z.
  const raw = String(article?.seendate ?? "");
  const normalised = /^\d{8}T\d{6}Z$/.test(raw)
    ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(9, 11)}:${raw.slice(11, 13)}:${raw.slice(13, 15)}Z`
    : raw;
  const time = iso(normalised);
  if (!time) return null;

  return {
    id: `gdelt-${article.url ?? `${country}-${raw}`}`,
    layer: "news",
    lat: centroid[0],
    lon: centroid[1],
    precision: "country",
    locates: `the PUBLISHING OUTLET's country (${country}) — NOT the location of the event reported`,
    title: String(article?.title ?? "Untitled report"),
    source: String(article?.domain ?? "GDELT"),
    url: String(article?.url ?? ""),
    timestamp: time,
    magnitude: null,
    magnitudeLabel: "no magnitude measured for news records",
    detail: {
      outletCountry: country,
      language: String(article?.language ?? "unknown"),
      domain: String(article?.domain ?? "unknown"),
    },
    credibility,
  };
}

/** An image analysed in Module 4 that carried an EXIF GPS fix. */
export function fromExifImage(image: {
  id: string;
  gps: { latitude: number; longitude: number; altitude: number | null } | null;
  name: string;
  capturedAt: string | null;
  camera?: string | null;
  thumbnail?: string;
}): GeoRecord | null {
  if (!image.gps || !isRealCoordinate(image.gps.latitude, image.gps.longitude)) return null;
  const time = iso(image.capturedAt);
  if (!time) return null;

  return {
    id: `exif-${image.id}`,
    layer: "imagery",
    lat: image.gps.latitude,
    lon: image.gps.longitude,
    precision: "exact",
    locates: "the position the capturing device recorded",
    title: image.name,
    source: image.camera || "EXIF GPS",
    url: "",
    timestamp: time,
    magnitude: null,
    magnitudeLabel: "no magnitude applies to an image fix",
    detail: {
      ...(image.gps.altitude !== null ? { altitudeM: Math.round(image.gps.altitude) } : {}),
      ...(image.camera ? { camera: image.camera } : {}),
      ...(image.thumbnail ? { thumbnail: image.thumbnail } : {}),
    },
    credibility: null,
  };
}

// ─── Clustering ────────────────────────────────────────────────────────────

export interface GeoCluster {
  /** Mean position of the members. Presentation only — never persisted. */
  lat: number;
  lon: number;
  members: GeoRecord[];
  /** Coarsest precision among members: a cluster is only as precise as its worst. */
  precision: GeoPrecision;
}

const PRECISION_ORDER: GeoPrecision[] = ["exact", "city", "country"];

/**
 * Grid clustering so dense regions stay readable at low zoom.
 *
 * The cluster's precision is the COARSEST of its members. Averaging an exact
 * fix with a country centroid and presenting the result as exact would
 * manufacture precision out of aggregation, which is the same error as
 * inventing a coordinate.
 */
export function clusterByGrid(records: GeoRecord[], cellDegrees: number): GeoCluster[] {
  if (cellDegrees <= 0) throw new Error("Cluster cell size must be positive.");
  const cells = new Map<string, GeoRecord[]>();

  for (const r of records) {
    const key = `${Math.floor(r.lat / cellDegrees)}:${Math.floor(r.lon / cellDegrees)}`;
    const list = cells.get(key);
    if (list) list.push(r); else cells.set(key, [r]);
  }

  return Array.from(cells.values()).map((members) => {
    const worst = members.reduce<GeoPrecision>(
      (acc, m) =>
        PRECISION_ORDER.indexOf(m.precision) > PRECISION_ORDER.indexOf(acc) ? m.precision : acc,
      "exact",
    );
    return {
      lat: members.reduce((s, m) => s + m.lat, 0) / members.length,
      lon: members.reduce((s, m) => s + m.lon, 0) / members.length,
      members,
      precision: worst,
    };
  });
}

/** Cell size for a Leaflet zoom level. Coarser when zoomed out. */
export function cellSizeForZoom(zoom: number): number {
  if (zoom >= 10) return 0.05;
  if (zoom >= 7) return 0.25;
  if (zoom >= 5) return 1;
  if (zoom >= 3) return 4;
  return 10;
}

// ─── Time filtering ────────────────────────────────────────────────────────

export interface TimeExtent {
  fromMs: number;
  toMs: number;
}

/** Earliest and latest timestamps present, or null when nothing is dated. */
export function timeExtent(records: GeoRecord[]): TimeExtent | null {
  const times = records
    .map((r) => new Date(r.timestamp).getTime())
    .filter((t) => Number.isFinite(t));
  if (times.length === 0) return null;
  return { fromMs: Math.min(...times), toMs: Math.max(...times) };
}

export function filterByTime(records: GeoRecord[], fromMs: number, toMs: number): GeoRecord[] {
  return records.filter((r) => {
    const t = new Date(r.timestamp).getTime();
    return Number.isFinite(t) && t >= fromMs && t <= toMs;
  });
}

// ─── Summary ───────────────────────────────────────────────────────────────

export interface GeoSummary {
  plotted: number;
  unplaceable: number;
  byLayer: { layer: GeoLayerId; plotted: number; unplaceable: number; error: string | null }[];
  /** Analyst-facing sentence, stating what was excluded and why. */
  note: string;
}

export function summarise(results: LayerResult[]): GeoSummary {
  const plotted = results.reduce((s, r) => s + r.records.length, 0);
  const unplaceable = results.reduce((s, r) => s + r.unplaceable, 0);
  const failed = results.filter((r) => r.error);

  const parts = [`${plotted} record(s) plotted from real coordinates.`];
  if (unplaceable > 0) {
    parts.push(
      `${unplaceable} collected record(s) carried no usable coordinate and were EXCLUDED ` +
        `rather than approximated — an invented pin is worse than no pin.`,
    );
  }
  if (failed.length > 0) {
    parts.push(`${failed.length} layer(s) could not be collected: ${failed.map((f) => f.layer).join(", ")}.`);
  }

  return {
    plotted,
    unplaceable,
    byLayer: results.map((r) => ({
      layer: r.layer,
      plotted: r.records.length,
      unplaceable: r.unplaceable,
      error: r.error,
    })),
    note: parts.join(" "),
  };
}
