/**
 * Module 5 — GIS collectors. Server-side fetches for the geospatial layers.
 *
 * Every upstream here was verified live on 2026-08-04, and two of the sources
 * the brief assumed were available are not:
 *
 *   UCDP GED  — now returns 401 with "API token required. Add header:
 *               x-ucdp-access-token". Every dataset version (23.1, 24.1, 25.1)
 *               refuses. The existing collector swallowed this and returned an
 *               empty array, so the conflict panel had been silently empty. It
 *               is wired up properly and reports the missing token as a
 *               configuration state rather than as "no events".
 *   GDELT GEO — api/v2/geo/geo returns 404. The geocoded-mentions endpoint is
 *               gone, so GDELT can only supply the publishing outlet's country,
 *               which is not an event location and is treated accordingly.
 *
 * What does work without a key: USGS (precise epicentres) and GDELT DOC
 * (outlet country only). Both are used; neither is padded to look like more.
 */

import { createServerFn } from "@tanstack/react-start";
import { recordCredentialUse, resolveCredential } from "./credential-vault";
import {
  fromGdeltArticle,
  fromGdeltEvent,
  fromLocationMention,
  fromOpenSkyState,
  fromReliefWebReport,
  fromUcdpEvent,
  fromUsgsFeature,
  isRealCoordinate,
  type GeoRecord,
  type LayerResult,
} from "./geo";
import { extractEntities } from "./analysis-llm";
import type { Article } from "./analysis";
import { fetchNews } from "../routes/news";

/**
 * Server-side gate for the GIS v2 additions (GDELT Events layer, RSS
 * aggregation, Timeline). Unset (the default) keeps every new layer/panel
 * fully off — the same "config, never code, unset means off" convention as
 * `personInvestigationEnabled()`. Unlike Person Investigation this touches
 * no PII, but it is still new, unverified-at-scale surface area, so it stays
 * opt-in rather than on-by-default until exercised against the live feeds.
 */
export function gisV2Enabled(): boolean {
  return process.env.GIS_V2_ENABLED === "true";
}

const TIMEOUT_MS = 12_000;
/** GDELT is consistently slower than the others and times out at 12s. */
const GDELT_TIMEOUT_MS = 25_000;
/**
 * Plain fetch() applies undici's own internal TCP-connect timeout
 * (`ConnectTimeoutError`, defaulting to 10s), a separate ceiling the
 * request-level AbortSignal above does not touch. api.gdeltproject.org's own
 * TCP handshake from this environment routinely takes 13-20s — verified live
 * 2026-08-19 against this exact host, including confirming a plain
 * `{ connectTimeout }` fetch-init property is silently ignored. The only
 * mechanism that actually works: an explicit undici `Agent` with a raised
 * `connect.timeout`, passed as `dispatcher` — shared with image-sources.ts,
 * which hits this same host for a different collector.
 *
 * `undici` is loaded via a runtime `await import(...)`, never a top-level
 * `import` — a static import pulled `undici` (Node-only; its `Agent`
 * touches `net`/`tls` internals) into the CLIENT bundle too, since this
 * module is reachable from gis.tsx/reports.tsx, and crashed the entire app
 * in the browser the moment any route loaded. Verified live, reverted
 * immediately. Matches the pattern collectGpsJamming below already uses for
 * the identical reason (`await import("./gps-interference")`).
 */
const GDELT_CONNECT_TIMEOUT_MS = 20_000;
/**
 * The Events export zip is a whole 15-minute file, not a small JSON response
 * like collectNewsGeo's — give it more headroom than GDELT_TIMEOUT_MS.
 */
const GDELT_EVENTS_ZIP_TIMEOUT_MS = 40_000;
let gdeltDispatcherPromise: Promise<any> | null = null;
async function gdeltDispatcher(): Promise<any> {
  if (!gdeltDispatcherPromise) {
    gdeltDispatcherPromise = import("undici").then(
      ({ Agent }) => new Agent({ connect: { timeout: GDELT_CONNECT_TIMEOUT_MS } }),
    );
  }
  return gdeltDispatcherPromise;
}

async function getJson(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = TIMEOUT_MS,
  dispatcher?: any,
): Promise<any> {
  const res = await fetch(url, {
    headers: { accept: "application/json", ...headers },
    signal: AbortSignal.timeout(timeoutMs),
    ...(dispatcher ? { dispatcher } : {}),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * USGS earthquakes, magnitude 2.5+ over the past week.
 *
 * Not a conflict source, and included honestly as what it is: the only open,
 * keyless dataset of precisely located, timestamped, magnitude-bearing events.
 * It is what makes the precision handling, the time slider and the
 * magnitude-scaled markers demonstrable on real data rather than on fixtures.
 */
export async function collectSeismic(): Promise<LayerResult> {
  try {
    const data = await getJson(
      "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson",
    );
    const features: any[] = data?.features ?? [];
    const records: GeoRecord[] = [];
    let unplaceable = 0;
    for (const f of features) {
      const r = fromUsgsFeature(f);
      if (r) records.push(r);
      else unplaceable += 1;
    }
    return { layer: "seismic", records, unplaceable, error: null };
  } catch (err: any) {
    return {
      layer: "seismic",
      records: [],
      unplaceable: 0,
      error: `USGS feed unavailable: ${err?.message ?? String(err)}`,
    };
  }
}

/**
 * UCDP GED conflict events.
 *
 * Token-gated since some point before 2026-08-04. Set UCDP_API_TOKEN to enable;
 * without it the layer reports that plainly instead of appearing to have found
 * no conflicts anywhere in the world, which is what an empty array would imply.
 */
export async function collectConflict(): Promise<LayerResult> {
  // Environment first, then the operator's credentials vault — the same
  // resolution order every other credential-gated collector uses. An analyst
  // adding the token on the Settings page enables this layer without a redeploy.
  const resolved = await resolveCredential("ucdp");
  const token = resolved?.secret;
  if (!token) {
    return {
      layer: "conflict",
      records: [],
      unplaceable: 0,
      error:
        "UCDP requires an API token (the endpoint returns 401 without one). Set UCDP_API_TOKEN, " +
        "or add a UCDP token on the Settings page, to enable this layer. No events are shown — " +
        "which is a missing credential, not a finding that no conflicts occurred.",
    };
  }

  try {
    const data = await getJson("https://ucdpapi.pcr.uu.se/api/gedevents/24.1?pagesize=200", {
      "x-ucdp-access-token": token,
    });
    await recordCredentialUse("ucdp", resolved.entryId);
    const events: any[] = data?.Result ?? [];
    const records: GeoRecord[] = [];
    let unplaceable = 0;
    for (const e of events) {
      const r = fromUcdpEvent(e);
      if (r) records.push(r);
      else unplaceable += 1;
    }
    return { layer: "conflict", records, unplaceable, error: null };
  } catch (err: any) {
    return {
      layer: "conflict",
      records: [],
      unplaceable: 0,
      error: `UCDP unavailable: ${err?.message ?? String(err)}`,
    };
  }
}

/**
 * GDELT DOC API.
 *
 * Supplies the publishing outlet's country and nothing more — see the note in
 * fromGdeltArticle. Every record it produces is country-precision and labelled
 * as the outlet's location.
 */
export async function collectNewsGeo(query: string): Promise<LayerResult> {
  try {
    const q = encodeURIComponent(query.trim() || "conflict");
    const data = await getJson(
      `https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&mode=ArtList&format=JSON&maxrecords=50&timespan=3d`,
      {},
      GDELT_TIMEOUT_MS,
      await gdeltDispatcher(),
    );
    const articles: any[] = data?.articles ?? [];
    const records: GeoRecord[] = [];
    let unplaceable = 0;
    for (const a of articles) {
      const r = fromGdeltArticle(a);
      // Null here means the outlet country was absent or not in the centroid
      // table — the article is real, we just cannot place it.
      if (r) records.push(r);
      else unplaceable += 1;
    }
    return { layer: "news", records, unplaceable, error: null };
  } catch (err: any) {
    const message = err?.message ?? String(err);
    return {
      layer: "news",
      records: [],
      unplaceable: 0,
      // GDELT enforces one request per 5 seconds and says so in the body. Passing
      // that through means an analyst sees "wait and retry" rather than
      // concluding the source is down.
      error: message.includes("429")
        ? `GDELT rate limit: it accepts one request every 5 seconds. Wait and retry. (${message.slice(0, 120)})`
        : `GDELT unavailable: ${message}`,
    };
  }
}

/**
 * GDELT 2.0 Events — the real, working mechanism. GDELT's REST query
 * endpoints (api/v2/events/events, api/v2/geo/geo) both return 404, verified
 * live; the periodic 15-minute export at data.gdeltproject.org/gdeltv2/ is
 * what actually exists. lastupdate.txt names the current export as three
 * lines of "<size> <hash> <url>"; this reads only the `.export.CSV.zip`
 * line (the sibling `.mentions.CSV.zip`/`.gkg.csv.zip` are different GDELT
 * tables, not events, and are not fetched).
 *
 * Gated behind GIS_V2_ENABLED — new, unverified-at-scale surface area,
 * off by default, self-reporting like every other credential/flag-gated
 * layer here rather than being silently excluded from collectGeoLayers.
 */
export async function collectGdeltEvents(): Promise<LayerResult> {
  if (!gisV2Enabled()) {
    return {
      layer: "gdeltEvents",
      records: [],
      unplaceable: 0,
      error: "GDELT Events is disabled. Set GIS_V2_ENABLED=true to enable this layer.",
    };
  }

  try {
    const dispatcher = await gdeltDispatcher();

    const listRes = await fetch("http://data.gdeltproject.org/gdeltv2/lastupdate.txt", {
      signal: AbortSignal.timeout(GDELT_TIMEOUT_MS),
      ...(dispatcher ? { dispatcher } : {}),
    });
    if (!listRes.ok) throw new Error(`lastupdate.txt HTTP ${listRes.status}`);
    const listing = await listRes.text();

    const exportLine = listing
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.endsWith(".export.CSV.zip"));
    if (!exportLine) {
      throw new Error("lastupdate.txt did not list an .export.CSV.zip file");
    }
    const zipUrl = exportLine.split(/\s+/).pop();
    if (!zipUrl) throw new Error("could not parse a URL from the lastupdate.txt export line");

    const zipRes = await fetch(zipUrl, {
      signal: AbortSignal.timeout(GDELT_EVENTS_ZIP_TIMEOUT_MS),
      ...(dispatcher ? { dispatcher } : {}),
    });
    if (!zipRes.ok) throw new Error(`${zipUrl} HTTP ${zipRes.status}`);
    const zipBytes = new Uint8Array(await zipRes.arrayBuffer());

    const { unzipSync } = await import("fflate");
    const files = unzipSync(zipBytes);
    const csvName = Object.keys(files).find((n) => n.toLowerCase().endsWith(".csv"));
    if (!csvName) throw new Error("export zip contained no CSV file");

    const csvText = new TextDecoder("utf-8").decode(files[csvName]);
    const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);

    const records: GeoRecord[] = [];
    let unplaceable = 0;
    for (const line of lines) {
      const r = fromGdeltEvent(line.split("\t"));
      if (r) records.push(r);
      else unplaceable += 1;
    }
    return { layer: "gdeltEvents", records, unplaceable, error: null };
  } catch (err: any) {
    return {
      layer: "gdeltEvents",
      records: [],
      unplaceable: 0,
      error: `GDELT Events unavailable: ${err?.message ?? String(err)}`,
    };
  }
}

/**
 * Optional OpenSky Network flight-track layer — "assets/tracks" in the
 * brief's terms. Networked-only, off by default (a separate flag from
 * GIS_V2_ENABLED, matching the brief's own "clearly optional" framing for
 * OpenSky/AIS specifically). Public REST, no key required for a
 * bounded-area query — verified live. Defaults to a bounding box over South
 * Asia rather than the entire globe's traffic, which would be tens of
 * thousands of aircraft on every collection cycle; every bound is
 * overridable via env var.
 */
export function openSkyTracksEnabled(): boolean {
  return process.env.OPENSKY_TRACKS_ENABLED === "true";
}

function openSkyBoundingBox() {
  const num = (v: string | undefined, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    lamin: num(process.env.OPENSKY_BBOX_LAMIN, 6),
    lomin: num(process.env.OPENSKY_BBOX_LOMIN, 68),
    lamax: num(process.env.OPENSKY_BBOX_LAMAX, 37),
    lomax: num(process.env.OPENSKY_BBOX_LOMAX, 98),
  };
}

export async function collectAssetTracks(): Promise<LayerResult> {
  if (!openSkyTracksEnabled()) {
    return {
      layer: "assetTracks",
      records: [],
      unplaceable: 0,
      error:
        "OpenSky asset tracks are disabled. Set OPENSKY_TRACKS_ENABLED=true to enable this " +
        "networked-only layer.",
    };
  }

  try {
    const { lamin, lomin, lamax, lomax } = openSkyBoundingBox();
    const data = await getJson(
      `https://opensky-network.org/api/states/all?lamin=${lamin}&lomin=${lomin}&lamax=${lamax}&lomax=${lomax}`,
      {},
      15_000,
    );
    const states: unknown[][] = Array.isArray(data?.states) ? data.states : [];
    const records: GeoRecord[] = [];
    let unplaceable = 0;
    for (const s of states) {
      const r = fromOpenSkyState(s);
      if (r) records.push(r);
      else unplaceable += 1;
    }
    return { layer: "assetTracks", records, unplaceable, error: null };
  } catch (err: any) {
    return {
      layer: "assetTracks",
      records: [],
      unplaceable: 0,
      error: `OpenSky unavailable: ${err?.message ?? String(err)}`,
    };
  }
}

export async function collectGpsJamming(): Promise<LayerResult> {
  try {
    const { fetchGpsInterference } = await import("./gps-interference");
    const data = await fetchGpsInterference();
    if (!data || !data.hexes.length) {
      return { layer: "gpsjam", records: [], unplaceable: 0, error: null };
    }
    const records: GeoRecord[] = data.hexes.slice(0, 100).map((h) => ({
      id: `gpsjam-${h.h3}`,
      title: `GPS Interference (${h.level.toUpperCase()}) — ${h.pct.toFixed(1)}% aircraft affected`,
      locates: "H3 Hex Aircraft Navigation Interference Area",
      layer: "gpsjam",
      source: "GPSJam ADS-B Exchange",
      url: "https://gpsjam.org",
      lat: h.lat,
      lon: h.lon,
      precision: "city",
      timestamp: data.fetchedAt,
      magnitude: h.pct,
      magnitudeLabel: `${h.pct.toFixed(1)}% affected`,
      detail: { hex: h.h3, affected: h.affectedAircraft, total: h.totalAircraft },
      // null, not 0.9/0.6. The UI labels this field "Module 1 credibility",
      // and Module 1 has never scored these records — the numbers were a
      // severity level re-badged as a credibility assessment.
      credibility: null,
    }));
    return { layer: "gpsjam", records, unplaceable: 0, error: null };
  } catch (err: any) {
    return {
      layer: "gpsjam",
      records: [],
      unplaceable: 0,
      error: `GPSJam feed unavailable: ${err?.message ?? String(err)}`,
    };
  }
}

export async function collectRadiation(): Promise<LayerResult> {
  try {
    const { fetchRadiationFeed } = await import("./radiation");
    const data = await fetchRadiationFeed();
    if (!data || !data.stations.length) {
      return { layer: "radiation", records: [], unplaceable: 0, error: null };
    }
    const records: GeoRecord[] = data.stations.map((s) => ({
      id: s.id,
      title: `Radiation Level (${s.status.toUpperCase()}): ${s.usvPerHour} µSv/h`,
      locates: `Environmental Radiation Sensor: ${s.name}`,
      layer: "radiation",
      source: s.source,
      url: "https://safecast.org",
      lat: s.lat,
      lon: s.lon,
      precision: "exact",
      timestamp: s.measuredAt,
      magnitude: s.usvPerHour,
      magnitudeLabel: `${s.usvPerHour} µSv/h`,
      detail: { station: s.name, status: s.status },
      // null for the same reason as GPS jamming: a reading's status band is
      // not a Module 1 credibility score, and rendering it under that label
      // asserted an assessment nothing performed.
      credibility: null,
    }));
    return { layer: "radiation", records, unplaceable: 0, error: null };
  } catch (err: any) {
    return {
      layer: "radiation",
      records: [],
      unplaceable: 0,
      error: `Radiation feed unavailable: ${err?.message ?? String(err)}`,
    };
  }
}

export interface GeoCollection {
  layers: LayerResult[];
  collectedAt: string;
}

/**
 * ReliefWeb humanitarian crisis and disaster events.
 *
 * Requires a free `appname` registered at reliefweb.int/developers. The appname
 * is sent as a query parameter on each request. Without it the layer reports a
 * configuration gap rather than returning an empty set.
 *
 * API: https://api.reliefweb.int/v1/disasters?appname=<appname>&limit=50
 * The `disasters` endpoint gives recent events with country, disaster type and
 * date. Coordinates are country-level centroids from COUNTRY_CENTROIDS.
 */
export async function collectReliefWebEvents(): Promise<LayerResult> {
  const resolved = await resolveCredential("reliefweb");
  // ReliefWeb uses the appname as both identifier and credential.
  const appname = resolved?.identifier?.trim() || resolved?.secret?.trim();
  if (!appname) {
    return {
      layer: "reliefweb",
      records: [],
      unplaceable: 0,
      error:
        "ReliefWeb requires a free appname (registered at reliefweb.int/developers). " +
        "Set RELIEFWEB_APP_NAME or add a ReliefWeb credential on the Settings page to " +
        "enable this layer. No events are shown — which is a missing credential, not a " +
        "finding that no humanitarian crises exist.",
    };
  }

  try {
    const url =
      `https://api.reliefweb.int/v1/disasters?appname=${encodeURIComponent(appname)}` +
      `&limit=50&fields[include][]=title&fields[include][]=date` +
      `&fields[include][]=country&fields[include][]=disaster_type` +
      `&fields[include][]=url_alias&sort[]=date.created:desc`;
    const data = await getJson(url);
    await recordCredentialUse("reliefweb", resolved!.entryId);
    const reports: unknown[] = data?.data ?? [];
    const records: GeoRecord[] = [];
    let unplaceable = 0;
    for (const r of reports) {
      const geo = fromReliefWebReport(r);
      if (geo) records.push(geo);
      else unplaceable += 1;
    }
    return { layer: "reliefweb", records, unplaceable, error: null };
  } catch (err: unknown) {
    const message = (err as Error)?.message ?? String(err);
    return {
      layer: "reliefweb",
      records: [],
      unplaceable: 0,
      error: `ReliefWeb unavailable: ${message}`,
    };
  }
}

// ─── Target mentions: real text -> real LLM location extraction -> real geocode ─
//
// Nothing here invents a place or a coordinate. A place is only ever a
// LOCATION-type entity a real LLM call (extractEntities, the same function
// /entities uses) found actually written in real collected text; a
// coordinate is only ever what Nominatim's own API returned for that real
// place name. If either step fails or returns nothing, the record is
// dropped — never guessed.

/**
 * OpenStreetMap Nominatim — free, keyless geocoding, no registration.
 * Its usage policy (operations.osmfoundation.org/policies/nominatim/) caps
 * this at 1 request/second and requires a descriptive User-Agent identifying
 * the application; both are honoured. Results are cached for the life of
 * this server process — re-geocoding the same real place name on every
 * search would be both wasteful and impolite to a free public service, the
 * same norm this file already applies to GDELT/crt.sh's own rate limits.
 */
const geocodeCache = new Map<string, { lat: number; lon: number } | null>();
let lastNominatimRequestAt = 0;
const NOMINATIM_MIN_INTERVAL_MS = 1100;
const NOMINATIM_USER_AGENT =
  "SentinelAI-OSINT-Demo/1.0 (ADITI 4.0 / iDEX PS-18 pre-selection demonstrator; non-commercial)";

async function geocodePlace(placeName: string): Promise<{ lat: number; lon: number } | null> {
  const key = placeName.trim().toLowerCase();
  if (!key) return null;
  if (geocodeCache.has(key)) return geocodeCache.get(key)!;

  const wait = NOMINATIM_MIN_INTERVAL_MS - (Date.now() - lastNominatimRequestAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastNominatimRequestAt = Date.now();

  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(placeName)}&format=json&limit=1`;
    const data = await getJson(url, { "user-agent": NOMINATIM_USER_AGENT }, 8_000);
    const hit = Array.isArray(data) ? data[0] : null;
    const lat = hit ? Number(hit.lat) : NaN;
    const lon = hit ? Number(hit.lon) : NaN;
    const point = isRealCoordinate(lat, lon) ? { lat, lon } : null;
    geocodeCache.set(key, point);
    return point;
  } catch {
    // Not cached on network/HTTP failure — a transient Nominatim outage
    // shouldn't permanently blacklist a real place for this process's life.
    return null;
  }
}

interface MentionSource {
  text: string;
  article: Article;
  title: string;
  source: string;
  url: string;
  timestamp: string | null;
}

/** Bounded sample — an LLM call per item, so this stays small and fast rather than processing every collected article. */
const MENTIONS_SAMPLE_SIZE = 8;
/** Nominatim is free and rate-limited to 1 req/s; only the most-mentioned real places are worth a real lookup per search. */
const MENTIONS_MAX_GEOCODED = 6;

/**
 * Real news content already collected for the current target, run through
 * real LLM entity extraction for LOCATION mentions, then the
 * highest-frequency real place names geocoded for real coordinates.
 *
 * News only, deliberately — see the comment inside about why
 * fetchSocialIntelligence is not called here.
 */
export async function collectTargetMentions(query: string): Promise<LayerResult> {
  const layer = "mentions" as const;
  if (!query.trim()) {
    return { layer, records: [], unplaceable: 0, error: null };
  }

  try {
    // News only — deliberately NOT calling fetchSocialIntelligence. Its
    // `mentions` path reads a `data/social_cache.json` cache and, on a
    // cache miss, shells out via `child_process.exec` to a Python scraper
    // with only a quote-escape on user-controlled input (a real command-
    // injection surface), and the cached results appear to include
    // Facebook/Instagram content, which CLAUDE.md explicitly forbids
    // re-adding scrapers for. That code is the user's own in-progress work
    // (uncommitted `news.tsx`) and was already flagged to them rather than
    // edited. Wiring it into an AUTOMATIC layer that fires on every GIS
    // page load — as an earlier version of this function did — would have
    // given that exact vulnerable path a new, more prominent, unrequested
    // trigger. News is real, safe, and sufficient for real location
    // extraction on its own.
    const newsRes = await fetchNews({ data: { query } }).catch(() => null);

    const items: MentionSource[] = [];
    const stories: any[] = Array.isArray((newsRes as any)?.stories)
      ? (newsRes as any).stories.slice(0, MENTIONS_SAMPLE_SIZE)
      : [];
    for (const s of stories) {
      const body = `${s.primaryTitle || ""}\n\n${s.body || ""}`.trim();
      if (!body) continue;
      items.push({
        text: body,
        article: {
          id: String(s.id ?? s.primaryLink ?? items.length),
          title: s.primaryTitle || "",
          source: s.primarySource || "",
          url: s.primaryLink || s.url || "",
          pubDate: s.pubDate || "",
          body: s.body || "",
        },
        title: s.primaryTitle || "(untitled)",
        source: s.primarySource || "unknown source",
        url: s.primaryLink || s.url || "",
        timestamp: s.pubDate ?? null,
      });
    }

    if (items.length === 0) {
      return { layer, records: [], unplaceable: 0, error: null };
    }

    const extractions = await Promise.allSettled(items.map((i) => extractEntities(i.article)));

    const byPlace = new Map<string, { count: number; sample: MentionSource }>();
    extractions.forEach((res, idx) => {
      if (res.status !== "fulfilled") return;
      const item = items[idx]!;
      for (const e of res.value.entities) {
        if (e.type !== "LOCATION") continue;
        const placeName = e.entity.trim();
        if (!placeName) continue;
        const key = placeName.toLowerCase();
        const existing = byPlace.get(key);
        if (existing) existing.count += 1;
        else byPlace.set(key, { count: 1, sample: item });
      }
    });

    const topPlaces = [...byPlace.entries()]
      .map(([key, v]) => ({ placeName: key, ...v }))
      .sort((a, b) => b.count - a.count)
      .slice(0, MENTIONS_MAX_GEOCODED);

    const records: GeoRecord[] = [];
    let unplaceable = 0;
    for (const place of topPlaces) {
      const point = await geocodePlace(place.placeName);
      if (!point) {
        unplaceable += 1;
        continue;
      }
      const record = fromLocationMention({
        placeName: place.placeName,
        lat: point.lat,
        lon: point.lon,
        mentionCount: place.count,
        sampleTitle: place.sample.title,
        sampleSource: place.sample.source,
        sampleUrl: place.sample.url,
        sampleTimestamp: place.sample.timestamp,
      });
      if (record) records.push(record);
      else unplaceable += 1;
    }

    return { layer, records, unplaceable, error: null };
  } catch (err: unknown) {
    const message = (err as Error)?.message ?? String(err);
    return { layer, records: [], unplaceable: 0, error: `Target-mentions geocoding failed: ${message}` };
  }
}

/**
 * Collect every server-side layer. Image GPS is added client-side from the
 * Module 4 corpus, which lives in the analyst's browser and never reaches us.
 */
export async function collectGeoLayers(query: string): Promise<GeoCollection> {
  const [seismic, conflict, news, gpsjam, radiation, reliefweb, gdeltEvents, assetTracks, mentions] =
    await Promise.all([
      collectSeismic(),
      collectConflict(),
      collectNewsGeo(query),
      collectGpsJamming(),
      collectRadiation(),
      collectReliefWebEvents(),
      collectGdeltEvents(),
      collectAssetTracks(),
      collectTargetMentions(query),
    ]);
  return {
    layers: [conflict, seismic, news, gpsjam, radiation, reliefweb, gdeltEvents, assetTracks, mentions],
    collectedAt: new Date().toISOString(),
  };
}

export const fetchGeoLayers = createServerFn({ method: "GET" })
  .validator((d: { query?: string } | undefined) => d)
  .handler(async ({ data }) => collectGeoLayers(data?.query ?? ""));
