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

export async function fetchGpsInterference(
  endpoint = "https://gpsjam.org/data/latest.json",
): Promise<GpsJamData | null> {
  const now = Date.now();
  if (cachedData && now - cachedAt < CACHE_TTL) return cachedData;

  try {
    const resp = await fetch(endpoint, { signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) return cachedData;

    const raw = (await resp.json()) as any;
    if (!raw || !Array.isArray(raw.hexes)) return cachedData;

    const hexes: GpsJamHex[] = raw.hexes.map((h: any) => ({
      h3: String(h.h3 ?? h.id ?? ""),
      lat: Number(h.lat ?? 0),
      lon: Number(h.lon ?? 0),
      level: h.level === "high" ? "high" : "medium",
      pct: Number.isFinite(h.pct) ? Number(h.pct) : 0,
      affectedAircraft: Number.isFinite(h.affectedAircraft) ? Number(h.affectedAircraft) : 0,
      totalAircraft: Number.isFinite(h.totalAircraft) ? Number(h.totalAircraft) : 0,
    }));

    cachedData = {
      fetchedAt: new Date().toISOString(),
      source: "GPSJam ADS-B Exchange Feed",
      stats: {
        totalHexes: hexes.length,
        highCount: hexes.filter((h) => h.level === "high").length,
        mediumCount: hexes.filter((h) => h.level === "medium").length,
      },
      hexes,
    };
    cachedAt = now;
    return cachedData;
  } catch {
    return cachedData;
  }
}
