/**
 * Collector health — a live reachability probe, not telemetry.
 *
 * This exists because `/crawlers` previously rendered invented figures: six
 * collectors with hardcoded throughput ("12 req/min", "~200 msgs/min"), a
 * "Telemetry Engine Active" banner, a "System Nominal" badge and a pulsing green
 * dot. Nothing measured any of it. Reddit was shown as "POLLING · Every 2m" while
 * it was in fact returning 403 to every request, and a "Meta Social Cache Engine"
 * was listed as an ingestion pipeline for Instagram and Facebook data that the
 * system does not and cannot collect.
 *
 * What can be measured honestly, on demand, inside one request: whether each
 * endpoint answers right now, and with what. That is what this reports.
 *
 * What it deliberately does NOT report:
 *   - Throughput or request rate. Nothing counts requests, and scale-to-zero
 *     means there is no process between requests to count them in.
 *   - Uptime, "last sync" or a polling cadence. There is no scheduler; every
 *     collector runs when an analyst asks it to.
 *   - Any aggregate "system healthy" verdict. A probe says what one endpoint did
 *     once, which is not the health of a system.
 */

import { createServerFn } from "@tanstack/react-start";
import { resolveRedditCredentials } from "./social";
import { resolveCredential } from "./credential-vault";
// The collector's OWN url builder. Imported rather than re-derived so the probe
// and the collector cannot drift apart — that drift is what this bug was.
import { gpsJamUrlForDate } from "./gps-interference";

export type ProbeStatus =
  /** Answered as expected. */
  | "reachable"
  /** Answered, but refused us — auth, blocking or rate limit. Distinct from down. */
  | "refused"
  /** No usable answer: DNS, timeout, connection failure, 5xx. */
  | "unreachable"
  /** Not probed because a required credential is absent. Never "down". */
  | "no-credential"
  /** Cannot be probed server-side at all; see `detail`. */
  | "not-probeable";

export interface CollectorProbe {
  id: string;
  name: string;
  /** PS-18 module this collector feeds. */
  module: "M2" | "M3" | "M5";
  endpoint: string;
  status: ProbeStatus;
  /** Real HTTP status when there was one. null = never got a response. */
  httpStatus: number | null;
  /** Milliseconds to first response. null = no response. */
  latencyMs: number | null;
  detail: string;
  checkedAt: string;
}

const PROBE_TIMEOUT_MS = 12_000;

/**
 * Some upstreams are simply slow, and a probe that times out on them reports a
 * healthy endpoint as unreachable — a false alarm is as misleading as a false
 * "nominal". Measured 2026-08-10: crt.sh answered in 18s, GDELT in 12.8s.
 */
const SLOW_PROBE_TIMEOUT_MS = 30_000;

interface ProbeSpec {
  id: string;
  name: string;
  module: CollectorProbe["module"];
  endpoint: string;
  /** Overrides PROBE_TIMEOUT_MS for known-slow upstreams. */
  timeoutMs?: number;
  /** Status codes that mean "working", beyond the 2xx default. */
  okStatuses?: number[];
  /** Interpret a non-ok status. Returning null falls through to the default. */
  explain?: (status: number) => string | null;
}

const SPECS: ProbeSpec[] = [
  {
    id: "google-news",
    name: "Google News RSS",
    module: "M2",
    endpoint: "https://news.google.com/rss/search?q=test&hl=en-US&gl=US&ceid=US:en",
  },
  {
    id: "bluesky-appview",
    name: "Bluesky public AppView",
    module: "M3",
    endpoint: "https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=bsky.app",
  },
  {
    id: "telegram",
    name: "Telegram public channel preview",
    module: "M3",
    endpoint: "https://t.me/s/BNONews",
  },
  {
    id: "mastodon",
    name: "Mastodon hashtag timeline",
    module: "M3",
    endpoint: "https://mastodon.social/api/v1/timelines/tag/osint?limit=1",
    explain: (s) =>
      s === 422
        ? "This instance does not serve timelines to unauthenticated readers. Instances choose " +
          "individually; another instance may work."
        : null,
  },
  {
    id: "crtsh",
    name: "crt.sh certificate transparency",
    module: "M2",
    // A domain that certainly has logged certificates: an empty result and an
    // unreachable service would otherwise look alike from a probe.
    endpoint: "https://crt.sh/?q=%25.github.com&output=json",
    timeoutMs: SLOW_PROBE_TIMEOUT_MS,
    explain: (s) =>
      s === 404 ? "crt.sh answers 404 when a query matches no logged certificate." : null,
  },
  {
    id: "internetdb",
    name: "Shodan InternetDB",
    module: "M2",
    // 8.8.8.8 is always present in InternetDB, so 404 here would be meaningful.
    endpoint: "https://internetdb.shodan.io/8.8.8.8",
  },
  {
    id: "usgs",
    name: "USGS earthquake feed",
    module: "M5",
    endpoint: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson",
  },
  {
    id: "gdelt",
    name: "GDELT DOC API",
    module: "M5",
    endpoint: "https://api.gdeltproject.org/api/v2/doc/doc?query=test&format=json&maxrecords=1",
    timeoutMs: SLOW_PROBE_TIMEOUT_MS,
    explain: (s) =>
      s === 429
        ? "Rate limited — GDELT accepts one request every 5 seconds. The endpoint is up; it is " +
          "declining this request, which is not the same as no events."
        : null,
  },
  {
    id: "safecast",
    name: "Safecast Radiation API",
    module: "M5",
    endpoint: "https://api.safecast.org/measurements.json?limit=1",
  },
  {
    id: "cisa-kev",
    name: "CISA Known Exploited Vulnerabilities",
    module: "M2",
    endpoint: "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json",
  },
];

async function probeOne(spec: ProbeSpec): Promise<CollectorProbe> {
  const base = {
    id: spec.id,
    name: spec.name,
    module: spec.module,
    endpoint: spec.endpoint,
    checkedAt: new Date().toISOString(),
  };

  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(spec.endpoint, {
      headers: { accept: "*/*" },
      signal: AbortSignal.timeout(spec.timeoutMs ?? PROBE_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ...base,
      status: "unreachable",
      httpStatus: null,
      latencyMs: null,
      detail: `No response: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const latencyMs = Date.now() - started;
  const ok = res.ok || (spec.okStatuses?.includes(res.status) ?? false);

  if (ok) {
    return {
      ...base,
      status: "reachable",
      httpStatus: res.status,
      latencyMs,
      detail: `HTTP ${res.status}`,
    };
  }

  // 401/403/429 mean the endpoint is alive and declining us. Reporting that as
  // "down" would send an analyst chasing an outage that is really an access
  // policy, which is the confusion that hid Reddit's block.
  const refused = res.status === 401 || res.status === 403 || res.status === 429;
  return {
    ...base,
    status: refused ? "refused" : "unreachable",
    httpStatus: res.status,
    latencyMs,
    detail: spec.explain?.(res.status) ?? `HTTP ${res.status}`,
  };
}

/** Collectors that cannot be probed with a server-side fetch, and why. */
function unprobeable(): CollectorProbe[] {
  const checkedAt = new Date().toISOString();
  return [
    {
      id: "jetstream",
      name: "Bluesky Jetstream firehose",
      module: "M3",
      endpoint: "wss://jetstream2.us-east.bsky.network/subscribe",
      status: "not-probeable",
      httpStatus: null,
      latencyMs: null,
      detail:
        "A WebSocket, and it runs in the browser tab by design — the container scales to zero, " +
        "so a server-side socket would be torn down between requests. Its live state is shown " +
        "on the Live and Social pages, which hold the connection.",
      checkedAt,
    },
  ];
}

/** Reddit is credential-gated, so its probe depends on configuration. */
async function redditProbe(): Promise<CollectorProbe> {
  const checkedAt = new Date().toISOString();
  const base = {
    id: "reddit",
    name: "Reddit search",
    module: "M3" as const,
    endpoint: "https://oauth.reddit.com/search",
    httpStatus: null,
    latencyMs: null,
    checkedAt,
  };

  // Async now: the credential may come from the operator's vault as well as the
  // environment, and reading the vault touches the filesystem. Reporting
  // "no-credential" while a working vault entry sits on the Settings page would
  // be exactly the stale-declaration problem this module was built to remove.
  const resolved = await resolveRedditCredentials();
  if (!resolved) {
    return {
      ...base,
      status: "no-credential",
      detail:
        "Unauthenticated Reddit access began returning 403 on every endpoint (2026-08-10). Set " +
        "REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET from a free script app, or add the pair on " +
        "the Settings page, to re-enable search.",
    };
  }
  return {
    ...base,
    status: "not-probeable",
    detail:
      `Credentials are configured (source: ${resolved.source}). Not probed here because a probe ` +
      "would spend a token request and a query against the 100/minute budget; run a Reddit pull " +
      "on the Social page to test it.",
  };
}

/**
 * Bluesky historical search is credential-gated in the same way, and its absence
 * is easy to mistake for the firehose being down. It is reported separately from
 * the Jetstream probe because the two fail independently: the socket can be
 * healthy while search is unavailable, and that is the default state.
 */
async function blueskySearchProbe(): Promise<CollectorProbe> {
  const checkedAt = new Date().toISOString();
  const base = {
    id: "bluesky-search",
    name: "Bluesky keyword search",
    module: "M3" as const,
    endpoint: "https://bsky.social/xrpc/app.bsky.feed.searchPosts",
    httpStatus: null,
    latencyMs: null,
    checkedAt,
  };

  const resolved = await resolveCredential("bluesky");
  if (!resolved) {
    return {
      ...base,
      status: "no-credential",
      detail:
        "app.bsky.feed.searchPosts returns 403 unauthenticated, so historical search is " +
        "unavailable. The Jetstream firehose is unaffected and still collects forward from " +
        "connection. Add a Bluesky app password on the Settings page to enable search.",
    };
  }
  return {
    ...base,
    status: "not-probeable",
    detail:
      `An app password is configured (source: ${resolved.source}). Not probed here because a ` +
      "probe would open a session against the login rate limit; run a search on the Social page " +
      "to test it.",
  };
}

/**
 * UCDP GED, the Module 5 conflict layer.
 *
 * It had no entry in this registry at all, so the one collector in the system
 * that is switched off by a missing credential never appeared on the collector
 * status page — it was neither "down" nor "no-credential", it was simply absent,
 * and the only place its state surfaced was inside the /gis layer card.
 *
 * Not probed when a token IS configured: a probe would spend a request against
 * an academic API on every page load, and the /gis conflict layer already
 * exercises the real call.
 */
async function ucdpProbe(): Promise<CollectorProbe> {
  const checkedAt = new Date().toISOString();
  const base = {
    id: "ucdp",
    name: "UCDP GED conflict events",
    module: "M5" as const,
    endpoint: "https://ucdpapi.pcr.uu.se/api/gedevents/24.1",
    httpStatus: null,
    latencyMs: null,
    checkedAt,
  };

  const resolved = await resolveCredential("ucdp");
  if (!resolved) {
    return {
      ...base,
      status: "no-credential",
      detail:
        "UCDP GED began requiring an access token before 2026-08-04 and answers HTTP 401 " +
        "without one, on every dataset version. Set UCDP_API_TOKEN, or add a token on the " +
        "Settings page, to enable the conflict layer. No events are shown — that is a missing " +
        "credential, not a finding that no conflicts occurred.",
    };
  }
  return {
    ...base,
    status: "not-probeable",
    detail:
      `A token is configured (source: ${resolved.source}). Not probed here because a probe would ` +
      "spend a request against an academic API on every load; the conflict layer on the GIS page " +
      "makes the real call.",
  };
}

/**
 * GPSJam, which cannot be probed with one fixed URL.
 *
 * THIS ENTRY WAS THE EXACT LIE THIS MODULE EXISTS TO PREVENT. It probed
 * `https://gpsjam.org/data/latest.json` — a URL that has never existed and
 * answers 404 — so `/crawlers` rendered "NO RESPONSE · HTTP 404" for a
 * collector that works. Confirmed live on the deployed app 2026-08-17, and
 * `gps-interference.ts`'s own header had ALREADY recorded that `latest.json`
 * 404s; only the probe was never updated to match. The real collector reads
 * `/data/<YYYY-MM-DD>-h3_4.csv`.
 *
 * Why this is a function rather than another `SPECS` row: GPSJam publishes one
 * file per UTC day, and **today's file legitimately 404s until the day is under
 * way** (measured 2026-08-17: today 404, yesterday 200 at 192 KB). A fixed row
 * pointing at today's URL would therefore invent a fresh false alarm every
 * morning — trading one wrong verdict for a recurring one. So this mirrors
 * `fetchGpsInterference`'s own today-then-yesterday fallback and reports WHICH
 * day it actually read.
 *
 * It calls `gpsJamUrlForDate()` rather than rebuilding the path, so the probe
 * and the collector cannot drift apart again. That drift is what produced this
 * bug; a second copy of the URL would reintroduce the cause while fixing the
 * symptom.
 */
async function gpsJamProbe(): Promise<CollectorProbe[]> {
  const checkedAt = new Date().toISOString();
  const base = {
    id: "gpsjam",
    name: "GPSJam ADS-B navigation interference",
    module: "M2" as const,
    checkedAt,
  };

  const now = Date.now();
  const candidates = [
    { label: "today", url: gpsJamUrlForDate(new Date(now)) },
    { label: "yesterday", url: gpsJamUrlForDate(new Date(now - 86_400_000)) },
  ];

  const attempts: string[] = [];
  for (const candidate of candidates) {
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(candidate.url, {
        headers: { accept: "text/csv,*/*" },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
    } catch (err) {
      attempts.push(
        `${candidate.label}: no response (${err instanceof Error ? err.message : String(err)})`,
      );
      continue;
    }
    const latencyMs = Date.now() - started;

    if (res.ok) {
      return [
        {
          ...base,
          endpoint: candidate.url,
          status: "reachable",
          httpStatus: res.status,
          latencyMs,
          detail:
            `HTTP ${res.status} — read ${candidate.label}'s file. GPSJam publishes one CSV per ` +
            `UTC day and the current day's file does not appear until the day is under way, so ` +
            `reading yesterday is normal, not a failure.`,
        },
      ];
    }

    // Today's file being absent is the documented normal case, not a fault.
    attempts.push(`${candidate.label}: HTTP ${res.status}`);
  }

  return [
    {
      ...base,
      endpoint: candidates[candidates.length - 1].url,
      status: "unreachable",
      httpStatus: null,
      latencyMs: null,
      detail:
        `Neither the current nor the previous UTC day's file could be read (${attempts.join("; ")}). ` +
        `Both missing is a real outage — one missing is not.`,
    },
  ];
}

export async function probeCollectors(): Promise<CollectorProbe[]> {
  const [probed, reddit, blueskySearch, ucdp, gpsjam] = await Promise.all([
    Promise.all(SPECS.map(probeOne)),
    redditProbe(),
    blueskySearchProbe(),
    ucdpProbe(),
    gpsJamProbe(),
  ]);
  return [...probed, reddit, blueskySearch, ucdp, ...gpsjam, ...unprobeable()];
}

export const collectorHealth = createServerFn({ method: "GET" })
  .validator((d: undefined) => d)
  .handler(async () => probeCollectors());
