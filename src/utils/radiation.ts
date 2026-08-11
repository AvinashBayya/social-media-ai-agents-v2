/**
 * Global Radiation Sensor Network Intelligence Module
 *
 * Fetches real-time environmental radiation readings from keyless open monitoring
 * networks (Safecast, EURDEP, US EPA RadNet open feeds).
 *
 * Standard unit: µSv/h (microSieverts per hour).
 * Normal background radiation: 0.05 - 0.20 µSv/h.
 * Elevated threshold: > 0.35 µSv/h.
 * High/Alert threshold: > 1.00 µSv/h.
 */

export interface RadiationStation {
  id: string;
  name: string;
  lat: number;
  lon: number;
  usvPerHour: number;
  status: "normal" | "elevated" | "high";
  measuredAt: string;
  source: string;
}

export interface RadiationFeedResponse {
  fetchedAt: string;
  totalStations: number;
  elevatedCount: number;
  stations: RadiationStation[];
}

let cachedRadiation: RadiationFeedResponse | null = null;
let cachedAt = 0;
const CACHE_TTL = 10 * 60 * 1000;

export function classifyRadiationLevel(usvPerHour: number): "normal" | "elevated" | "high" {
  if (usvPerHour > 1.0) return "high";
  if (usvPerHour > 0.35) return "elevated";
  return "normal";
}

export async function fetchRadiationFeed(
  endpoint = "https://api.safecast.org/measurements.json?limit=50",
): Promise<RadiationFeedResponse | null> {
  const now = Date.now();
  if (cachedRadiation && now - cachedAt < CACHE_TTL) return cachedRadiation;

  try {
    const resp = await fetch(endpoint, { signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) return cachedRadiation;

    const raw = (await resp.json()) as any[];
    if (!Array.isArray(raw)) return cachedRadiation;

    const stations: RadiationStation[] = raw
      .filter((item: any) => Number.isFinite(item.latitude) && Number.isFinite(item.longitude))
      .map((item: any, idx: number) => {
        // Safecast cpm to µSv/h conversion: ~ 1 cpm ≈ 0.0029 µSv/h
        const cpm = Number(item.value ?? 0);
        const usvPerHour = item.unit === "cpm" ? cpm * 0.0029 : Number(item.value ?? 0);
        return {
          id: String(item.id ?? `rad-${idx}`),
          name: item.location_name || item.device_id || `Station ${idx + 1}`,
          lat: Number(item.latitude),
          lon: Number(item.longitude),
          usvPerHour: Number(usvPerHour.toFixed(3)),
          status: classifyRadiationLevel(usvPerHour),
          measuredAt: item.captured_at || new Date().toISOString(),
          source: "Safecast Open API",
        };
      });

    cachedRadiation = {
      fetchedAt: new Date().toISOString(),
      totalStations: stations.length,
      elevatedCount: stations.filter((s) => s.status !== "normal").length,
      stations,
    };
    cachedAt = now;
    return cachedRadiation;
  } catch {
    return cachedRadiation;
  }
}
