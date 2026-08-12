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
  /** As the network reported it. Null when it reported none. */
  measuredAt: string | null;
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

/**
 * Raised when the feed cannot be read. Thrown rather than swallowed, so the UI
 * renders the cause instead of a permanent "Loading..." string.
 */
export class RadiationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RadiationUnavailableError";
  }
}

/** Safecast cpm -> uSv/h. Null when the reading carries no usable value. */
export function toMicroSievertsPerHour(value: unknown, unit: unknown): number | null {
  const n = Number(value);
  // `Number(undefined ?? 0)` used to make this 0, which classifyRadiationLevel
  // then reported as "normal" background - an unreported reading published as a
  // safe measurement.
  if (!Number.isFinite(n)) return null;
  if (String(unit).toLowerCase() === "cpm") return Number((n * 0.0029).toFixed(3));
  return Number(n.toFixed(3));
}

/**
 * Fetch and normalise the Safecast measurement feed.
 *
 * WHAT WAS WRONG. This ran in the BROWSER, so the request was blocked by CORS
 * ("the 'Access-Control-Allow-Origin' header contains the invalid value
 * 'safecast.org'"), and the catch returned a null cache — leaving the Radiation
 * Sensors tab showing "Loading radiation sensor network data..." forever, with
 * no error and no end. It is server-side now, where collector-health.ts had
 * already proven the host answers 200.
 *
 * Three values were also being invented per station: a missing reading became
 * `0` and was classified "normal"; a missing timestamp became "now"; and a
 * missing coordinate became 0,0. All three are now dropped or null.
 */
export async function fetchRadiationFeed(
  endpoint = "https://api.safecast.org/measurements.json?limit=100",
): Promise<RadiationFeedResponse> {
  const now = Date.now();
  if (cachedRadiation && now - cachedAt < CACHE_TTL) return cachedRadiation;

  let resp: Response;
  try {
    resp = await fetch(endpoint, {
      headers: { "User-Agent": "SentinelAI/1.0 (+OSINT demonstrator)" },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err: any) {
    throw new RadiationUnavailableError(`Safecast request failed: ${err?.message ?? String(err)}`);
  }
  if (!resp.ok) {
    throw new RadiationUnavailableError(`Safecast returned HTTP ${resp.status}.`);
  }

  const raw = (await resp.json()) as any[];
  if (!Array.isArray(raw)) {
    throw new RadiationUnavailableError("Safecast returned a payload that is not a list.");
  }

  const stations: RadiationStation[] = [];
  for (const [idx, item] of raw.entries()) {
    const lat = Number(item?.latitude);
    const lon = Number(item?.longitude);
    // No coordinate means no marker. 0,0 is the missing-value sentinel the GIS
    // layer rejects, so a station is dropped rather than plotted there.
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat === 0 && lon === 0) continue;

    const usvPerHour = toMicroSievertsPerHour(item?.value, item?.unit);
    // A station whose reading did not parse carries no measurement to report.
    if (usvPerHour === null) continue;

    stations.push({
      id: String(item?.id ?? `rad-${idx}`),
      name: item?.location_name || item?.device_id || `Station ${idx + 1}`,
      lat,
      lon,
      usvPerHour,
      status: classifyRadiationLevel(usvPerHour),
      // null, never "now". A reading the network did not timestamp was being
      // stamped with the moment of the fetch, and that value drives the GIS
      // time slider and renders as "Reported:".
      measuredAt: item?.captured_at ?? null,
      source: "Safecast Open API",
    });
  }

  cachedRadiation = {
    fetchedAt: new Date().toISOString(),
    totalStations: stations.length,
    elevatedCount: stations.filter((s) => s.status !== "normal").length,
    stations,
  };
  cachedAt = now;
  return cachedRadiation;
}
