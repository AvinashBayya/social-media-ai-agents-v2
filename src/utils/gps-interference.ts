/**
 * GPS Interference & Jamming Intelligence Module
 *
 * Provides real-time ADS-B Exchange / GPSJam hex data processing,
 * regional classification (Levant, Ukraine/Black Sea, Nordics, Persian Gulf),
 * and severity aggregation.
 *
 * Follows strict Data Honesty Policy: unmeasured values are null, no mock data.
 */

export interface GpsJamHex {
  h3: string;
  lat: number;
  lon: number;
  level: "medium" | "high";
  pct: number;
  affectedAircraft: number;
  totalAircraft: number;
}

export interface GpsJamData {
  fetchedAt: string;
  source: string;
  stats: {
    totalHexes: number;
    highCount: number;
    mediumCount: number;
  };
  hexes: GpsJamHex[];
}

let cachedData: GpsJamData | null = null;
let cachedAt = 0;
const CACHE_TTL = 5 * 60 * 1000;

export function getCachedGpsInterference(): GpsJamData | null {
  return cachedData;
}

export function classifyGpsRegion(lat: number, lon: number): string {
  if (lat >= 28 && lat <= 34 && lon >= 29 && lon <= 36) return "israel-sinai";
  if (lat >= 29 && lat <= 42 && lon >= 43 && lon <= 63) return "iran-iraq";
  if (lat >= 31 && lat <= 37 && lon >= 35 && lon <= 43) return "levant";
  if (lat >= 44 && lat <= 53 && lon >= 22 && lon <= 41) return "ukraine-russia";
  if (lat >= 54 && lat <= 70 && lon >= 27 && lon <= 60) return "russia-north";
  if (lat >= 36 && lat <= 42 && lon >= 26 && lon <= 45) return "turkey-caucasus";
  if (lat >= 32 && lat <= 38 && lon >= 63 && lon <= 75) return "afghanistan-pakistan";
  if (lat >= 10 && lat <= 20 && lon >= 42 && lon <= 55) return "yemen-horn";
  if (lat >= 50 && lat <= 72 && lon >= -10 && lon <= 25) return "northern-europe";
  if (lat >= 35 && lat <= 50 && lon >= -10 && lon <= 25) return "western-europe";
  if (lat >= 25 && lat <= 50 && lon >= -125 && lon <= -65) return "north-america";
  return "other";
}

export function groupGpsHexesByRegion(data: GpsJamData): Record<string, GpsJamHex[]> {
  const regions: Record<string, GpsJamHex[]> = {};
  for (const hex of data.hexes) {
    const region = classifyGpsRegion(hex.lat, hex.lon);
    if (!regions[region]) regions[region] = [];
    regions[region].push(hex);
  }
  return regions;
}

/** Parsed CSV row. Exported for tests; no network, no H3 dependency. */
export interface GpsJamCsvRow {
  hex: string;
  good: number;
  bad: number;
}

/**
 * Parse GPSJam's daily CSV.
 *
 * Real shape, verified 2026-08-12:
 *
 *   hex,count_good_aircraft,count_bad_aircraft
 *   8400113ffffffff,1,0
 *
 * Rows whose counts do not parse are DROPPED rather than defaulted to zero — a
 * hex with unreadable counts is not a hex where every aircraft reported good
 * navigation.
 */
export function parseGpsJamCsv(csv: string): GpsJamCsvRow[] {
  if (!csv) return [];
  const out: GpsJamCsvRow[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.toLowerCase().startsWith("hex,")) continue;
    const [hex, goodRaw, badRaw] = trimmed.split(",");
    if (!hex) continue;
    const good = Number(goodRaw);
    const bad = Number(badRaw);
    if (!Number.isFinite(good) || !Number.isFinite(bad)) continue;
    out.push({ hex, good, bad });
  }
  return out;
}

/** Percentage of aircraft in a cell reporting degraded navigation, or null. */
export function interferencePct(row: GpsJamCsvRow): number | null {
  const total = row.good + row.bad;
  // No aircraft observed means no measurement, NOT 0% interference.
  if (total <= 0) return null;
  return (row.bad / total) * 100;
}

/**
 * GPSJam publishes one file per UTC day, named by date.
 *
 * The implementation moved to the dependency-free leaf module `gpsjam-url.ts`
 * so `collector-health.ts` can share it without importing this file — see that
 * file's header for the `bun:sqlite` chunking hazard that forced the split.
 * Re-exported here so every existing caller and test keeps working unchanged.
 */
import { gpsJamUrlForDate } from "./gpsjam-url";

export { gpsJamUrlForDate };

/**
 * Raised when the feed cannot be read. Thrown rather than swallowed, so the UI
 * renders the cause instead of a permanent "Loading…" string.
 */
export class GpsJamUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GpsJamUnavailableError";
  }
}

/**
 * Fetch and normalise the GPSJam daily feed.
 *
 * THREE THINGS WERE WRONG HERE.
 *
 * 1. The endpoint did not exist. `https://gpsjam.org/data/latest.json` returns
 *    404 — verified directly with curl. GPSJam publishes a CSV per UTC day at
 *    `/data/<YYYY-MM-DD>-h3_4.csv`, and the current day's file does not appear
 *    until the day is under way, so this tries today and falls back to
 *    yesterday, reporting which day it actually read.
 *
 * 2. It ran in the BROWSER. Every other collector on /osint is a server
 *    function; this one was imported client-side, so the request was blocked by
 *    CORS ("No 'Access-Control-Allow-Origin' header"). It is server-side now,
 *    where `collector-health.ts` had already proven the host reachable.
 *
 * 3. It SWALLOWED failures — `catch { return cachedData }` with `cachedData`
 *    null, so the page showed "Loading GPSJam telemetry…" forever with no error
 *    and no end. Failures now throw with the real cause.
 *
 * The CSV carries H3 cell indexes and no coordinates, so cells are converted to
 * their centroid with h3-js (Apache 2.0). A cell that fails to convert is
 * dropped, never emitted at 0,0 — which is the exact sentinel `toGeoPoint`
 * exists to reject.
 */
export async function fetchGpsInterference(endpoint?: string): Promise<GpsJamData | null> {
  const now = Date.now();
  if (cachedData && now - cachedAt < CACHE_TTL) return cachedData;

  const today = new Date(now);
  const yesterday = new Date(now - 24 * 60 * 60 * 1000);
  const candidates = endpoint ? [endpoint] : [gpsJamUrlForDate(today), gpsJamUrlForDate(yesterday)];

  const failures: string[] = [];
  for (const url of candidates) {
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": "SentinelAI/1.0 (+OSINT demonstrator)" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!resp.ok) {
        failures.push(`${url} -> HTTP ${resp.status}`);
        continue;
      }
      const csv = await resp.text();
      const rows = parseGpsJamCsv(csv);
      if (rows.length === 0) {
        failures.push(`${url} -> parsed 0 rows`);
        continue;
      }

      const { cellToLatLng } = await import("h3-js");
      const hexes: GpsJamHex[] = [];
      for (const row of rows) {
        const pct = interferencePct(row);
        // Only cells with observed interference are worth plotting, and a cell
        // with no aircraft observed carries no measurement at all.
        if (pct === null || row.bad === 0) continue;
        let lat: number;
        let lon: number;
        try {
          [lat, lon] = cellToLatLng(row.hex);
        } catch {
          continue; // Unconvertible cell: dropped, never emitted at 0,0.
        }
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        hexes.push({
          h3: row.hex,
          lat,
          lon,
          level: pct >= 25 ? "high" : "medium",
          pct,
          affectedAircraft: row.bad,
          totalAircraft: row.good + row.bad,
        });
      }

      hexes.sort((a, b) => b.pct - a.pct);

      cachedData = {
        fetchedAt: new Date().toISOString(),
        source: `GPSJam daily aggregate (${url.split("/").pop()})`,
        stats: {
          totalHexes: hexes.length,
          highCount: hexes.filter((h) => h.level === "high").length,
          mediumCount: hexes.filter((h) => h.level === "medium").length,
        },
        hexes,
      };
      cachedAt = now;
      return cachedData;
    } catch (err: any) {
      failures.push(`${url} -> ${err?.message ?? String(err)}`);
    }
  }

  throw new GpsJamUnavailableError(`GPSJam feed could not be read. Tried: ${failures.join("; ")}`);
}
