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
import { redditCredentials } from "./social";

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
    id: "gpsjam",
    name: "GPSJam ADS-B Exchange Feed",
    module: "M2",
    endpoint: "https://gpsjam.org/data/latest.json",
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
function redditProbe(): CollectorProbe {
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

  if (!redditCredentials()) {
    return {
      ...base,
      status: "no-credential",
      detail:
        "Unauthenticated Reddit access began returning 403 on every endpoint (2026-08-10). Set " +
        "REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET from a free script app to re-enable search.",
    };
  }
  return {
    ...base,
    status: "not-probeable",
    detail:
      "Credentials are configured. Not probed here because a probe would spend a token request " +
      "and a query against the 100/minute budget; run a Reddit pull on the Social page to test it.",
  };
}

export async function probeCollectors(): Promise<CollectorProbe[]> {
  const probed = await Promise.all(SPECS.map(probeOne));
  return [...probed, redditProbe(), ...unprobeable()];
}

export const collectorHealth = createServerFn({ method: "GET" })
  .validator((d: undefined) => d)
  .handler(async () => probeCollectors());
