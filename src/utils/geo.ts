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

export type GeoLayerId =
  | "conflict"
  | "seismic"
  | "news"
  | "imagery"
  | "infrastructure"
  | "gpsjam"
  | "radiation"
  | "reliefweb"
  | "supplyDemand"
  | "gdeltEvents"
  | "assetTracks"
  | "mentions";

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
  /*
   * GPS jamming and radiation used to be returned under `layer: "infrastructure"`
   * — the SAME id as Shodan and as each other. The map resolves a record's layer
   * with `.find()`, so only the first match won: radiation records were drawn in
   * Shodan's colour, carrying Shodan's "not wired" provenance, and their count
   * and error state were unreachable. Observed as 479 markers plotted against
   * 454 accounted for in the layer cards.
   */
  {
    id: "gpsjam",
    label: "GPS interference (GPSJam)",
    provenance:
      "GPSJam aggregates ADS-B position-quality reports into H3 hexes, so a marker locates " +
      "an AREA where aircraft reported degraded navigation — not a jammer. Hex centroid, " +
      "drawn at city precision.",
    colour: "#F97316",
  },
  {
    id: "radiation",
    label: "Environmental radiation (Safecast)",
    provenance:
      "Safecast is a volunteer sensor network. Device siting and calibration vary between " +
      "contributors, so readings are comparable over time at one station but not strictly " +
      "between stations.",
    colour: "#22D3EE",
  },
  {
    id: "reliefweb",
    label: "Humanitarian events (ReliefWeb)",
    provenance:
      "ReliefWeb API (UN OCHA). Reports of humanitarian crises, disasters and conflict events " +
      "sourced from partner agencies. Coordinates are country-level centroids from the API's " +
      "country field — requires RELIEFWEB_APP_NAME (free registration at reliefweb.int/developers).",
    colour: "#EC4899",
  },
  {
    id: "supplyDemand",
    label: "Supply & Demand (Kpler)",
    provenance:
      "Kpler Supply & Demand API — grains (Corn/Soybean/Wheat) balance sheets and LNG/gas " +
      "supply-demand-storage balances, by country. Kpler is a COMMERCIAL data provider with " +
      "no free tier; requires a paid KPLER_API_KEY. Analyst-selected product and zones only — " +
      "unlike every other layer here, it does not auto-collect from the global search bar, " +
      "because Kpler's API takes explicit zone names, not a free-text query. Coordinates are " +
      "country centroids (the country's balance sheet, not a specific port, field or facility).",
    colour: "#84CC16",
  },
  {
    id: "gdeltEvents",
    label: "Geocoded events (GDELT 2.0)",
    provenance:
      "GDELT 2.0 Events export (data.gdeltproject.org/gdeltv2/*.export.CSV.zip, refreshed " +
      "every 15 minutes). GDELT's own geocoder places each event; ActionGeo_Type 1 (COUNTRY) " +
      "renders at country precision, every other type at city precision — GDELT gives no " +
      "device-level fix, so this layer never renders a point as exact. No natural-language " +
      "headline is supplied, so the title is built from GDELT's own CAMEO EventRootCode.",
    colour: "#A855F7",
  },
  {
    id: "assetTracks",
    label: "Asset tracks (OpenSky)",
    provenance:
      "OpenSky Network public ADS-B feed — transponder-derived aircraft positions, the most " +
      "precisely located data this page plots. Networked-only, off by default and disabled " +
      "in air-gapped deployments; requires OPENSKY_TRACKS_ENABLED=true. Bounded to a " +
      "configurable region (defaults to South Asia) rather than the whole globe's traffic.",
    colour: "#FACC15",
  },
  {
    id: "mentions",
    label: "Target mentions (geocoded)",
    provenance:
      "Real news articles collected for the current search (Google News RSS, the same feed " +
      "/news uses), run through the same LLM entity extraction /entities already uses (an " +
      "open-weight model via Sarvam) to find place NAMES actually written in that real text, " +
      "then geocoded through OpenStreetMap Nominatim (free, keyless, rate-limited to 1 " +
      "lookup/second by its usage policy — the top 6 most-mentioned real places per search " +
      "are geocoded, not every mention). Social media is deliberately excluded from this " +
      "layer's sources — see geo-sources.ts's collectTargetMentions for why. A pin marks " +
      "where the mentioned place name resolves to — a city or region's representative point, " +
      "not the specific event or person — so this always renders at city precision, never as " +
      "an exact fix.",
    colour: "#14B8A6",
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
  /**
   * ISO 8601, as the upstream reported it. Drives the time slider.
   *
   * Null when the source carried no time. Safecast readings and some feed items
   * genuinely arrive undated, and the collectors were stamping those with the
   * moment of collection — which then rendered as "Reported:" and set the
   * slider's extent from a measurement that never happened.
   */
  timestamp: string | null;
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
  "United States": [39.83, -98.58],
  Russia: [61.52, 105.32],
  China: [35.86, 104.2],
  India: [22.35, 78.67],
  Pakistan: [30.38, 69.35],
  Iran: [32.43, 53.69],
  Ukraine: [48.38, 31.17],
  Germany: [51.17, 10.45],
  "United Kingdom": [55.38, -3.44],
  France: [46.23, 2.21],
  Israel: [31.05, 34.85],
  Syria: [34.8, 38.997],
  "North Korea": [40.34, 127.51],
  "South Korea": [35.91, 127.77],
  Japan: [36.2, 138.25],
  Taiwan: [23.7, 120.96],
  Turkey: [38.96, 35.24],
  "Saudi Arabia": [23.89, 45.08],
  Bangladesh: [23.68, 90.36],
  "Sri Lanka": [7.87, 80.77],
  Nepal: [28.39, 84.12],
  Myanmar: [21.91, 95.96],
  Afghanistan: [33.94, 67.71],
  Iraq: [33.22, 43.68],
  Yemen: [15.55, 48.52],
  Egypt: [26.82, 30.8],
  Nigeria: [9.08, 8.68],
  Ethiopia: [9.15, 40.49],
  Sudan: [12.86, 30.22],
  Somalia: [5.15, 46.2],
  Brazil: [-14.24, -51.93],
  Canada: [56.13, -106.35],
  Australia: [-25.27, 133.78],
  Indonesia: [-0.79, 113.92],
  Philippines: [12.88, 121.77],
  Vietnam: [14.06, 108.28],
  Thailand: [15.87, 100.99],
  Malaysia: [4.21, 101.98],
  Singapore: [1.35, 103.82],
  Italy: [41.87, 12.57],
  Spain: [40.46, -3.75],
  Poland: [51.92, 19.15],
  Netherlands: [52.13, 5.29],
  Sweden: [60.13, 18.64],
  Norway: [60.47, 8.47],
  Switzerland: [46.82, 8.23],
  Belgium: [50.5, 4.47],
  Austria: [47.52, 14.55],
  Mexico: [23.63, -102.55],
  Argentina: [-38.42, -63.62],
  "South Africa": [-30.56, 22.94],
  Kenya: [-0.02, 37.91],
  Qatar: [25.35, 51.18],
  "United Arab Emirates": [23.42, 53.85],
  // Added for the Kpler Supply & Demand layer — major grain and LNG/gas
  // exporters the existing ~52-country list didn't yet cover.
  Kazakhstan: [48.02, 66.92],
  Romania: [45.94, 24.97],
  Algeria: [28.03, 1.66],
  "Trinidad and Tobago": [10.69, -61.22],
  Azerbaijan: [40.14, 47.58],
  Turkmenistan: [38.97, 59.56],
  Peru: [-9.19, -75.02],
  Oman: [21.47, 55.98],
  Paraguay: [-23.44, -58.44],
  Uruguay: [-32.52, -55.77],
  Mozambique: [-18.67, 35.53],
};

// ─── Adapters: upstream record -> GeoRecord | null ─────────────────────────
// Each returns null when the source carries no real coordinate. That null is
// the mechanism preventing fabricated placement; every adapter is tested for it.

/**
 * A real place name extracted from real collected text (news/social) about
 * the current target, already geocoded to a real coordinate by
 * geo-sources.ts's Nominatim lookup. Kept as a separate, testable, pure step
 * from that lookup — same pure/impure split every other adapter here follows
 * — so this only shapes the record; it never decides whether a coordinate is
 * real (isRealCoordinate does that, defensively, in case the caller ever
 * passes through a bad value).
 */
export function fromLocationMention(input: {
  placeName: string;
  lat: number;
  lon: number;
  mentionCount: number;
  sampleTitle: string;
  sampleSource: string;
  sampleUrl: string;
  sampleTimestamp: string | null;
}): GeoRecord | null {
  if (!isRealCoordinate(input.lat, input.lon)) return null;
  const slug = input.placeName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return {
    id: `mention-${slug || "place"}`,
    layer: "mentions",
    lat: input.lat,
    lon: input.lon,
    precision: "city",
    locates: `where "${input.placeName}" resolves to — a mentioned place, not the event or person itself`,
    title: `"${input.placeName}" — ${input.mentionCount} real mention${input.mentionCount === 1 ? "" : "s"}`,
    source: input.sampleSource,
    url: input.sampleUrl,
    timestamp: input.sampleTimestamp,
    magnitude: input.mentionCount,
    magnitudeLabel: `${input.mentionCount} mention${input.mentionCount === 1 ? "" : "s"}`,
    detail: { place: input.placeName, sampleHeadline: input.sampleTitle },
    credibility: null,
  };
}

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
    lat,
    lon,
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
  const precision: GeoPrecision = wherePrec <= 2 ? "exact" : wherePrec === 3 ? "city" : "country";

  /**
   * Casualties, or null when UCDP reported none of the four fields.
   *
   * This summed `Number(x) || 0` across all four, so an event with NO casualty
   * figures at all produced 0 — and the map then rendered "0 casualties",
   * which reads as "we know this event killed nobody" rather than "UCDP did not
   * report this". They are opposite findings, and the same pattern was fixed in
   * osint.tsx's UCDP handler while this copy was missed.
   *
   * A field that IS reported and is genuinely zero still counts as reported.
   */
  const deathFields = [
    event?.deaths_a,
    event?.deaths_b,
    event?.deaths_civilians,
    event?.deaths_unknown,
  ];
  const reportedDeaths = deathFields.filter(
    (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v)),
  );
  const deaths = reportedDeaths.length
    ? reportedDeaths.reduce((sum: number, v) => sum + Number(v), 0)
    : null;

  const sides = [event?.side_a, event?.side_b].filter(Boolean).join(" vs ");
  return {
    id: `ucdp-${event.id}`,
    layer: "conflict",
    lat,
    lon,
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
    // "0 recorded fatalities" and "UCDP reported no casualty figure" are
    // different claims, and the marker is sized from this too.
    magnitudeLabel:
      deaths === null ? "casualties not reported by UCDP" : `${deaths} recorded fatality/ies`,
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
export function fromGdeltArticle(
  article: any,
  credibility: number | null = null,
): GeoRecord | null {
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

/**
 * CAMEO EventRootCode (01-20) -> a short human label. GDELT's Events export
 * gives no natural-language headline for a row — this is the only vocabulary
 * upstream provides for what happened, and every one of the twenty root
 * codes is used verbatim, not paraphrased.
 * https://www.gdeltproject.org/data/lookups/CAMEO.eventcodes.txt
 */
export const CAMEO_ROOT_CODE_LABELS: Record<string, string> = {
  "01": "Made a public statement",
  "02": "Made an appeal",
  "03": "Expressed intent to cooperate",
  "04": "Held consultations",
  "05": "Engaged in diplomatic cooperation",
  "06": "Engaged in material cooperation",
  "07": "Provided aid",
  "08": "Yielded",
  "09": "Investigated",
  "10": "Issued a demand",
  "11": "Disapproved",
  "12": "Rejected",
  "13": "Issued a threat",
  "14": "Protested",
  "15": "Exhibited military posture",
  "16": "Reduced relations",
  "17": "Coerced",
  "18": "Assaulted",
  "19": "Fought",
  "20": "Engaged in unconventional mass violence",
};

/**
 * One tab-separated row from a GDELT 2.0 Events export CSV — 61 fixed
 * columns, no header row. Fetched from
 * data.gdeltproject.org/gdeltv2/<TIMESTAMP>.export.CSV.zip, with the latest
 * timestamp discovered via .../lastupdate.txt. GDELT's REST query endpoints
 * (api/v2/events/events, api/v2/geo/geo) both return 404 — verified live —
 * this periodic export is the real, working mechanism; see geo-sources.ts.
 *
 * Column indices used here (0-based; GDELT's own documentation is 1-based):
 *   0  GLOBALEVENTID         30 GoldsteinScale        56 ActionGeo_Lat
 *   26 EventCode             31 NumMentions            57 ActionGeo_Long
 *   28 EventRootCode         34 AvgTone                59 DATEADDED (YYYYMMDDHHMMSS)
 *                            51 ActionGeo_Type          52 ActionGeo_FullName
 *                                                        60 SOURCEURL
 *
 * ActionGeo_Type: 1=COUNTRY, 2=USSTATE, 3=USCITY, 4=WORLDCITY, 5=WORLDSTATE.
 * Mapped conservatively — type 1 to "country", every other type to "city" —
 * the same collapse-to-coarser-bucket approach fromUcdpEvent uses for UCDP's
 * own finer where_prec scale. GDELT supplies no device-level fix, so this
 * adapter never produces "exact".
 */
export function fromGdeltEvent(columns: string[]): GeoRecord | null {
  if (!Array.isArray(columns) || columns.length < 61) return null;

  const lat = Number(columns[56]);
  const lon = Number(columns[57]);
  if (!isRealCoordinate(lat, lon)) return null;

  const rawDate = String(columns[59] ?? "");
  const normalised = /^\d{14}$/.test(rawDate)
    ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}T${rawDate.slice(8, 10)}:${rawDate.slice(10, 12)}:${rawDate.slice(12, 14)}Z`
    : rawDate;
  const time = iso(normalised);
  if (!time) return null;

  const geoType = Number(columns[51]);
  const precision: GeoPrecision = geoType === 1 ? "country" : "city";
  const placeName = String(columns[52] ?? "").trim() || "unnamed location";

  const rootCode = String(columns[28] ?? "").trim();
  const rootLabel = CAMEO_ROOT_CODE_LABELS[rootCode] ?? null;
  const eventCode = String(columns[26] ?? "").trim();

  const numMentions = Number(columns[31]);
  const magnitude = Number.isFinite(numMentions) ? numMentions : null;

  const goldstein = Number(columns[30]);
  const avgTone = Number(columns[34]);

  const globalEventId = String(columns[0] ?? "").trim();
  const sourceUrl = String(columns[60] ?? "").trim();

  return {
    id: `gdelt-event-${globalEventId || `${lat},${lon},${rawDate}`}`,
    layer: "gdeltEvents",
    lat,
    lon,
    precision,
    locates:
      geoType === 1
        ? `GDELT's geocoded action country (${placeName}) — not a specific site`
        : `GDELT's geocoded action location (${placeName})`,
    title: rootLabel
      ? `${rootLabel} — ${placeName}`
      : `Event code ${eventCode || "unclassified"} — ${placeName}`,
    source: "GDELT 2.0 Events",
    url: sourceUrl,
    timestamp: time,
    magnitude,
    magnitudeLabel:
      magnitude === null
        ? "mention count not reported by GDELT"
        : `${magnitude} mention(s) across monitored sources`,
    detail: {
      eventCode: eventCode || "unknown",
      eventRootCode: rootCode || "unknown",
      ...(Number.isFinite(goldstein) ? { goldsteinScale: goldstein } : {}),
      ...(Number.isFinite(avgTone) ? { avgTone: Number(avgTone.toFixed(2)) } : {}),
      actionGeoType: Number.isFinite(geoType) ? geoType : "unknown",
    },
    credibility: null,
  };
}

/**
 * One row of OpenSky Network's `/states/all` response — a fixed positional
 * array (OpenSky does not name these fields in the JSON itself):
 *   0 icao24, 1 callsign, 2 origin_country, 3 time_position, 4 last_contact,
 *   5 longitude, 6 latitude, 7 baro_altitude, 8 on_ground, 9 velocity,
 *   10 true_track, 11 vertical_rate, 12 sensors, 13 geo_altitude,
 *   14 squawk, 15 spi, 16 position_source.
 * Verified live against the real endpoint. `time_position` (not
 * `last_contact`) is used as the timestamp — it is null whenever the
 * position itself is stale, which is exactly when this adapter should
 * refuse to plot a fresh-looking pin for an old fix.
 */
export function fromOpenSkyState(state: unknown[]): GeoRecord | null {
  if (!Array.isArray(state) || state.length < 17) return null;

  const lon = state[5];
  const lat = state[6];
  if (typeof lat !== "number" || typeof lon !== "number" || !isRealCoordinate(lat, lon)) {
    return null;
  }

  const timePosition = state[3];
  if (typeof timePosition !== "number") return null;
  const time = iso(timePosition * 1000);
  if (!time) return null;

  const icao24 = String(state[0] ?? "unknown");
  const callsign = String(state[1] ?? "").trim() || null;
  const originCountry = String(state[2] ?? "unknown");
  const onGround = state[8] === true;
  const velocity = typeof state[9] === "number" ? state[9] : null;
  const trueTrack = typeof state[10] === "number" ? state[10] : null;
  const geoAltitude = typeof state[13] === "number" ? state[13] : null;
  const baroAltitude = typeof state[7] === "number" ? state[7] : null;
  const altitude = geoAltitude ?? baroAltitude;
  const squawk = state[14] !== null && state[14] !== undefined ? String(state[14]) : null;

  return {
    id: `opensky-${icao24}-${timePosition}`,
    layer: "assetTracks",
    lat,
    lon,
    precision: "exact",
    locates: "the aircraft's ADS-B transponder-reported position at time_position",
    title: `${callsign ?? icao24} (${originCountry})${onGround ? " — on ground" : ""}`,
    source: "OpenSky Network",
    url: "https://opensky-network.org",
    timestamp: time,
    magnitude: velocity,
    magnitudeLabel: velocity === null ? "groundspeed not reported" : `${velocity.toFixed(0)} m/s groundspeed`,
    detail: {
      icao24,
      originCountry,
      onGround: onGround ? "true" : "false",
      headingDeg: trueTrack ?? "not reported",
      altitudeM: altitude ?? "not reported",
      squawk: squawk ?? "not reported",
    },
    credibility: null,
  };
}

/**
 * ReliefWeb API disaster / humanitarian crisis report.
 *
 * The ReliefWeb API returns a `country` array on each report. We take the
 * primary country (index 0) and place the record at its centroid — country
 * precision only, because the API does not supply event coordinates. This is
 * the same approach used for GDELT; both are labelled honestly in `locates`
 * so the analyst sees "country-level only" rather than a precise-looking pin.
 *
 * Fields used: `fields.title`, `fields.date.created`, `fields.country[0].iso3`,
 * `fields.disaster_type[0].name`, `fields.url_alias`.
 */
export function fromReliefWebReport(report: unknown): GeoRecord | null {
  const fields = (report as Record<string, unknown>)?.fields as Record<string, unknown> | undefined;
  if (!fields) return null;

  // Primary country — ISO3 code maps to a centroid
  const countries = Array.isArray(fields.country) ? fields.country : [];
  const primaryIso3 =
    countries.length > 0
      ? String((countries[0] as Record<string, unknown>)?.iso3 ?? "").toUpperCase()
      : "";
  // Attempt a direct COUNTRY_CENTROIDS lookup; the table is keyed by ISO2/name,
  // so also try the `name` field.
  const countryName =
    countries.length > 0
      ? String((countries[0] as Record<string, unknown>)?.name ?? "")
      : "";
  const centroid = COUNTRY_CENTROIDS[primaryIso3] ?? COUNTRY_CENTROIDS[countryName];
  if (!centroid) return null;

  const rawDate = String((fields.date as Record<string, unknown>)?.created ?? "");
  const time = iso(rawDate);
  if (!time) return null;

  const disasterTypes = Array.isArray(fields.disaster_type) ? fields.disaster_type : [];
  const disasterLabel =
    disasterTypes.length > 0
      ? String((disasterTypes[0] as Record<string, unknown>)?.name ?? "Crisis")
      : "Crisis";

  const title = String(fields.title ?? "Untitled report");
  const url = String(fields.url_alias ?? "https://reliefweb.int");
  const id = String((report as Record<string, unknown>)?.id ?? `rw-${primaryIso3}-${rawDate}`);

  return {
    id: `reliefweb-${id}`,
    layer: "reliefweb",
    lat: centroid[0],
    lon: centroid[1],
    precision: "country",
    locates: `the affected COUNTRY centroid (${countryName || primaryIso3}) — not a pinpoint event location`,
    title,
    source: "ReliefWeb (UN OCHA)",
    url,
    timestamp: time,
    magnitude: null,
    magnitudeLabel: "no magnitude measured for humanitarian reports",
    detail: {
      disasterType: disasterLabel,
      country: countryName || primaryIso3,
    },
    credibility: null,
  };
}

/**
 * One zone's row from a Kpler Supply & Demand balances response (grains,
 * LNG or gas — all three share this shape: a `zone` name, a period, and a
 * flat `metrics` object of numeric fields).
 */
export interface KplerBalanceRow {
  domain: "grains" | "lng" | "gas";
  /** "Corn" / "Soybean" / "Wheat" for grains; "LNG" or "Gas" otherwise. */
  product: string;
  zone: string;
  startDate: string;
  endDate: string;
  metrics: Record<string, unknown>;
  /** metric name -> unit string, from the response's `metadata.units`. */
  units: Record<string, string>;
}

/**
 * Kpler Supply & Demand balance row -> GeoRecord.
 *
 * Kpler's `zone` is a country/region NAME ("Argentina"), so this is
 * country-centroid precision like GDELT/ReliefWeb above — a marker here
 * locates the COUNTRY the balance sheet describes, never a specific farm,
 * port, terminal or gas field. `magnitude` is the domain's headline supply
 * figure (grains: total supply; LNG/gas: supply) for marker sizing —
 * everything else Kpler reported for the row goes into `detail` verbatim,
 * with its real unit, rather than picking a handful of "important" fields
 * and silently dropping the rest of a balance sheet.
 */
export function fromKplerBalance(row: KplerBalanceRow): GeoRecord | null {
  const centroid = COUNTRY_CENTROIDS[row.zone];
  if (!centroid) return null;
  const time = iso(row.startDate);
  if (!time) return null;

  const headlineKey = row.domain === "grains" ? "supplyTotal" : "supply";
  const headlineRaw = row.metrics[headlineKey];
  const magnitude = typeof headlineRaw === "number" ? headlineRaw : null;
  const headlineUnit = row.units[headlineKey] ?? "";
  const magnitudeLabel =
    magnitude === null
      ? `${headlineKey} not reported by Kpler for this period`
      : `${magnitude.toLocaleString()} ${headlineUnit} ${row.domain === "grains" ? "total supply" : "supply"}`;

  const detail: Record<string, string | number> = {
    zone: row.zone,
    product: row.product,
    period: `${row.startDate} to ${row.endDate}`,
  };
  for (const [key, value] of Object.entries(row.metrics)) {
    if (typeof value !== "number") continue;
    const unit = row.units[key];
    detail[key] = unit ? `${value} ${unit}` : value;
  }

  return {
    id: `kpler-${row.domain}-${row.product}-${row.zone}-${row.startDate}`,
    layer: "supplyDemand",
    lat: centroid[0],
    lon: centroid[1],
    precision: "country",
    locates:
      `${row.zone}'s national ${row.product} supply & demand balance sheet — a country-level ` +
      `aggregate, not a specific farm, port, terminal or field`,
    title: `${row.product} balance — ${row.zone}`,
    source: "Kpler Supply & Demand API",
    url: "",
    timestamp: time,
    magnitude,
    magnitudeLabel,
    detail,
    credibility: null,
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
    if (list) list.push(r);
    else cells.set(key, [r]);
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

/**
 * Milliseconds for a record, or null when it carries no usable time.
 *
 * The explicit null check matters: `new Date(null).getTime()` is 0, which is
 * finite, so an undated record would otherwise be silently dated to 1 Jan 1970
 * and drag the slider's extent back fifty-six years.
 */
function recordTimeMs(record: GeoRecord): number | null {
  if (!record.timestamp) return null;
  const t = new Date(record.timestamp).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Earliest and latest timestamps present, or null when nothing is dated. */
export function timeExtent(records: GeoRecord[]): TimeExtent | null {
  const times = records.map(recordTimeMs).filter((t): t is number => t !== null);
  if (times.length === 0) return null;
  return { fromMs: Math.min(...times), toMs: Math.max(...times) };
}

/**
 * Records inside the window.
 *
 * Undated records are KEPT. Excluding them would hide real observations on the
 * strength of a field the source never supplied, which is the same mistake as
 * inventing the field — it just fails quiet instead of loud. The record's own
 * card states that it carries no date.
 */
export function filterByTime(records: GeoRecord[], fromMs: number, toMs: number): GeoRecord[] {
  return records.filter((r) => {
    const t = recordTimeMs(r);
    if (t === null) return true;
    return t >= fromMs && t <= toMs;
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
    parts.push(
      `${failed.length} layer(s) could not be collected: ${failed.map((f) => f.layer).join(", ")}.`,
    );
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

// ─── Basemap tile disclosure ───────────────────────────────────────────────

/**
 * Web-Mercator tile arithmetic. It lives in this pure module for the same
 * reason everything else here does: the claim it supports has to be checkable.
 *
 * A raster basemap tile request is not metadata ABOUT a location, it IS the
 * location. The path carries z/x/y, and z/x/y is a bounded square on the
 * ground. Both maps in this app used to request CARTO tiles unconditionally,
 * so opening a geotagged photograph on /images fetched
 * `a.basemaps.cartocdn.com/dark_all/15/23411/13663.png` for a fix at
 * 28.613889, 77.208889 — a 1.07 km square, logged with the analyst's IP
 * address, on a page that states the file is never uploaded.
 *
 * These functions exist so a consent control can print the exact path and the
 * exact ground footprint for the coordinate in front of the analyst instead of
 * a generic privacy sentence.
 */
export interface TileIndex {
  z: number;
  x: number;
  y: number;
}

/** The slippy-map tile containing a coordinate (OSM/Google/CARTO scheme). */
export function webMercatorTile(lat: number, lon: number, zoom: number): TileIndex {
  const z = Math.max(0, Math.min(22, Math.floor(zoom)));
  const n = 2 ** z;
  // Web Mercator is undefined at the poles; every slippy map clamps here.
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const rad = (clamped * Math.PI) / 180;
  const wrapped = (((lon + 180) % 360) + 360) % 360;
  const x = Math.min(n - 1, Math.floor((wrapped / 360) * n));
  const y = Math.min(
    n - 1,
    Math.max(0, Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n)),
  );
  return { z, x, y };
}

/** Ground extent of a tile — the square its path narrows a coordinate to. */
export function tileFootprintKm(tile: TileIndex): { widthKm: number; heightKm: number } {
  const n = 2 ** tile.z;
  const lonWest = (tile.x / n) * 360 - 180;
  const lonEast = ((tile.x + 1) / n) * 360 - 180;
  const latNorth = (180 / Math.PI) * Math.atan(Math.sinh(Math.PI * (1 - (2 * tile.y) / n)));
  const latSouth = (180 / Math.PI) * Math.atan(Math.sinh(Math.PI * (1 - (2 * (tile.y + 1)) / n)));
  const midRad = (((latNorth + latSouth) / 2) * Math.PI) / 180;
  return {
    widthKm: (lonEast - lonWest) * 111.32 * Math.cos(midRad),
    heightKm: (latNorth - latSouth) * 110.57,
  };
}

export interface TileRequestDisclosure extends TileIndex {
  /** Exact path the browser would request for this coordinate. */
  path: string;
  widthKm: number;
  heightKm: number;
  /** e.g. "1.07 km × 1.07 km" — what the log entry narrows the location to. */
  footprint: string;
}

const formatKm = (v: number): string =>
  v < 1 ? `${Math.round(v * 1000)} m` : `${v.toFixed(2)} km`;

/**
 * The tile request a coordinate produces, ready to print in a consent control.
 * `pathTemplate` is the provider's path with {z}/{x}/{y} placeholders.
 */
export function describeTileRequest(
  lat: number,
  lon: number,
  zoom: number,
  pathTemplate = "/{z}/{x}/{y}.png",
): TileRequestDisclosure {
  const tile = webMercatorTile(lat, lon, zoom);
  const { widthKm, heightKm } = tileFootprintKm(tile);
  return {
    ...tile,
    path: pathTemplate
      .replace("{z}", String(tile.z))
      .replace("{x}", String(tile.x))
      .replace("{y}", String(tile.y)),
    widthKm,
    heightKm,
    footprint: `${formatKm(widthKm)} × ${formatKm(heightKm)}`,
  };
}

/**
 * Graticule spacing in degrees for a zoom level, chosen so a viewport holds a
 * handful of lines rather than none or thousands. With third-party tiles off
 * the grid and the scale bar are the only scale references on the map.
 */
export function graticuleStepDegrees(zoom: number): number {
  if (zoom >= 17) return 0.002;
  if (zoom >= 15) return 0.01;
  if (zoom >= 13) return 0.05;
  if (zoom >= 11) return 0.1;
  if (zoom >= 9) return 0.5;
  if (zoom >= 7) return 1;
  if (zoom >= 5) return 2;
  if (zoom >= 3) return 10;
  return 30;
}
