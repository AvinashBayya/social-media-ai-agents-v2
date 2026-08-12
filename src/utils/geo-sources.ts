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
  fromUcdpEvent,
  fromUsgsFeature,
  type GeoRecord,
  type LayerResult,
} from "./geo";

const TIMEOUT_MS = 12_000;
/** GDELT is consistently slower than the others and times out at 12s. */
const GDELT_TIMEOUT_MS = 25_000;

async function getJson(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = TIMEOUT_MS,
): Promise<any> {
  const res = await fetch(url, {
    headers: { accept: "application/json", ...headers },
    signal: AbortSignal.timeout(timeoutMs),
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
 * Collect every server-side layer. Image GPS is added client-side from the
 * Module 4 corpus, which lives in the analyst's browser and never reaches us.
 */
export async function collectGeoLayers(query: string): Promise<GeoCollection> {
  const [seismic, conflict, news, gpsjam, radiation] = await Promise.all([
    collectSeismic(),
    collectConflict(),
    collectNewsGeo(query),
    collectGpsJamming(),
    collectRadiation(),
  ]);
  return {
    layers: [conflict, seismic, news, gpsjam, radiation],
    collectedAt: new Date().toISOString(),
  };
}

export const fetchGeoLayers = createServerFn({ method: "GET" })
  .validator((d: { query?: string } | undefined) => d)
  .handler(async ({ data }) => collectGeoLayers(data?.query ?? ""));
