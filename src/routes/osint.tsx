import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useEffect, useMemo } from "react";
import { getActiveTarget, setActiveTarget } from "@/utils/active-target";
import { containsWord, matchesQuery, parseQueryCached } from "@/utils/search";
import { buildOverviewModules, formatFeedDate, rssEmptyReason } from "@/utils/osint-summary";

/**
 * Renders a value the collector did not supply.
 *
 * Several fields on this page are now nullable because the upstream feed
 * genuinely does not carry them - an IOC liveness flag, a per-entry
 * timestamp, a UCDP conflict id, a casualty count. Every one of those was
 * previously defaulted to a confident-looking value ("online", "now",
 * "State Conflict", 0). This is the single place that decides how an
 * absence looks, so it cannot drift back into a plausible substitute.
 */
function NotReported({ what = "not reported" }: { what?: string }) {
  return <span className="italic text-[#64748B]">{what}</span>;
}

/**
 * Why a collector panel is showing nothing.
 *
 * Three states, never collapsed into one: still running, failed with a cause,
 * or answered with nothing. The GPS and radiation panels previously rendered a
 * hardcoded "Loading..." string in ALL THREE cases, so a request that had
 * already failed with a CORS error looked like one still in flight — forever.
 */
function CollectorAbsence({
  error,
  loading,
  emptyLabel,
}: {
  error: string | null;
  loading: boolean;
  emptyLabel: string;
}) {
  if (loading) {
    return <div className="py-8 text-center text-[#94A3B8]">Collecting…</div>;
  }
  if (error) {
    return (
      <div className="rounded border border-[#EF4444]/30 bg-[#EF4444]/5 p-4 text-[10px]">
        <div className="font-bold uppercase text-[#EF4444]">Collection failed</div>
        <p className="mt-1 text-[#94A3B8]">
          This is a collection fault, not a finding that nothing is happening.
        </p>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-[#64748B]">{error}</pre>
      </div>
    );
  }
  return <div className="py-8 text-center text-[#94A3B8]">{emptyLabel}</div>;
}

/**
 * Is this failure specifically "no UCDP token"?
 *
 * Matched on the message `collectConflict` produces rather than on a status
 * code, because the error crosses a server-function boundary as a string. A
 * missing credential and a network fault need different things from the analyst,
 * so they must not render the same.
 */
function isMissingUcdpToken(error: string | null): boolean {
  return Boolean(error && error.includes("UCDP requires an API token"));
}

import { createServerFn } from "@tanstack/react-start";
import { fetchOSINT } from "./news";
import { AppShell, PageHeader, Tone } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Search,
  Globe,
  Shield,
  Github,
  FileText,
  Newspaper,
  Link2,
  Database,
  Radio,
  Wifi,
  Compass,
  RefreshCw,
  AlertTriangle,
  ExternalLink,
  Lock,
  BookOpen,
  MapPin,
  Activity,
  Terminal,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";

// ============================================================================
// OSINT Synonym Expander and Keyword Matcher
// ============================================================================

export const SYNONYMS: Record<string, string[]> = {
  "air force": [
    "air force",
    "airforce",
    "aviation",
    "flight",
    "pilot",
    "jet",
    "aircraft",
    "fighter",
    "missile",
    "intercept",
    "baltic airspace",
    "air patrol",
  ],
  army: [
    "army",
    "military",
    "troops",
    "soldier",
    "defense",
    "forces",
    "conflict",
    "armored",
    "border crossing",
    "deploy",
    "war",
    "armed",
    "casualties",
  ],
  navy: ["navy", "maritime", "ship", "sea", "fleet", "choke point", "coastal", "vessel", "naval"],
  cyber: [
    "cyber",
    "ransomware",
    "c2",
    "malware",
    "hack",
    "botnet",
    "exploit",
    "firmware",
    "vulnerability",
    "threat",
    "ip",
    "dns",
    "domain",
  ],
};

/**
 * Synonyms only widen a query that already mentions the domain. The previous
 * `key.includes(qLower)` test ran the comparison backwards, so a two-letter
 * query like "my" matched the key "army" and expanded to every military term,
 * making short searches match almost anything.
 */
const MIN_SYNONYM_QUERY_LENGTH = 3;

export function getSynonymsFor(query: string): string[] {
  const qLower = (query || "").toLowerCase().trim();
  if (qLower.length < MIN_SYNONYM_QUERY_LENGTH) return [];

  const expanded: string[] = [];
  for (const [key, synonyms] of Object.entries(SYNONYMS)) {
    if (containsWord(qLower, key) || qLower === key) expanded.push(...synonyms);
  }
  return Array.from(new Set(expanded));
}

/** Kept for callers that still want the flat term list. */
export function getQueryTerms(query: string): string[] {
  const qLower = (query || "").toLowerCase().trim();
  if (!qLower) return [];
  return Array.from(new Set([qLower, ...getSynonymsFor(qLower)]));
}

/**
 * Word-boundary matching through the shared search core, so operators work here
 * too and "navy" no longer matches "increase" via the substring "sea".
 */
export function matchQuery(text: string, query: string): boolean {
  if (!query) return true;
  return matchesQuery({ title: text, synonyms: getSynonymsFor(query) }, parseQueryCached(query));
}

// ============================================================================
// Server functions (RPC)
// ============================================================================

export const fetchCyberThreats = createServerFn({ method: "GET" })
  .validator((data: { q?: string; query?: string } | undefined) => data)
  .handler(async ({ data }) => {
    let threats: any[] = [];
    const query = data?.query || data?.q || "";

    const fetchFeodo = async () => {
      try {
        const res = await fetch("https://feodotracker.abuse.ch/downloads/ipblocklist.json", {
          signal: AbortSignal.timeout(2500),
        });
        if (res.ok) {
          const data = await res.json();
          const items = Array.isArray(data) ? data.slice(0, 40) : [];
          return (
            items
              // An entry with no address is unusable. Substituting a placeholder IP
              // (the old behaviour) invented an indicator that was never in the feed.
              .filter((item: any) => item?.ip_address || item?.dst_ip)
              .map((item: any) => ({
                ip: item.ip_address || item.dst_ip,
                source: "Feodo Tracker",
                // null, not "Unknown botnet" — that asserted a malware class for an
                // entry that named none.
                malware: item.malware || null,
                // null, never "online". An indicator whose status Feodo did not report
                // was rendering as a LIVE command-and-control server, beside a
                // pulsing green dot. "Not reported" and "confirmed online" are
                // opposite findings.
                status: item.status || null,
                severity:
                  item.status === "online" && /emotet|qakbot/i.test(item.malware || "")
                    ? "critical"
                    : "high",
                date: item.last_online || null,
              }))
          );
        }
      } catch (err) {
        console.error("Feodo fetch failed:", err);
      }
      return [];
    };

    const fetchC2Feeds = async () => {
      try {
        const res = await fetch(
          "https://raw.githubusercontent.com/drb-ra/C2IntelFeeds/master/feeds/IPC2s-30day.csv",
          {
            signal: AbortSignal.timeout(2500),
          },
        );
        if (res.ok) {
          const text = await res.text();
          const lines = text.split("\n").slice(0, 40);
          const list: any[] = [];
          for (const line of lines) {
            if (!line || line.startsWith("#")) continue;
            const parts = line.split(",");
            if (parts.length >= 2) {
              const ip = parts[0].trim();
              const desc = parts[1].trim();
              list.push({
                ip,
                source: "C2IntelFeeds",
                malware: desc.replace("Possible ", "").replace(" C2 IP", ""),
                // The CSV columns parsed here carry no liveness flag and no
                // per-entry timestamp. Both were being invented: every row was
                // stamped "active" and dated to the moment of the fetch, so a
                // 30-day feed rendered as a wall of indicators confirmed live
                // this second. Presence in the feed is the only real fact.
                status: null,
                severity: desc.toLowerCase().includes("cobalt strike") ? "high" : "medium",
                date: null,
              });
            }
          }
          return list;
        }
      } catch (err) {
        console.error("C2IntelFeeds fetch failed:", err);
      }
      return [];
    };

    const [feodoList, c2List] = await Promise.all([fetchFeodo(), fetchC2Feeds()]);
    threats = [...feodoList, ...c2List];

    // Both feeds failing is a collection outage, not an empty threat landscape.
    // Surfacing hardcoded IOCs here would present stale invented indicators as
    // live threat intelligence, so fail loudly instead.
    if (threats.length === 0) {
      throw new Error(
        "Threat intelligence unavailable: both Feodo Tracker and C2IntelFeeds failed to respond.",
      );
    }

    return threats;
  });

export const fetchTelegramOSINT = createServerFn({ method: "GET" })
  .validator((data: { q?: string; query?: string } | undefined) => data)
  .handler(async ({ data }) => {
    const query = data?.query || data?.q || "";
    const channels = ["VahidOnline", "abualiexpress", "BNONews", "OSINTdefender", "vxunderground"];
    let allPosts: any[] = [];

    const scrapeTelegramChannel = async (handle: string) => {
      try {
        const res = await fetch(`https://t.me/s/${handle}`, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          },
          signal: AbortSignal.timeout(2500),
        });
        if (!res.ok) return [];
        const html = await res.text();

        const posts: any[] = [];
        const textRegex = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
        const timeRegex = /<time class="time" datetime="([^"]*)"/g;

        const texts: string[] = [];
        let match;
        while ((match = textRegex.exec(html)) !== null) {
          const rawText = match[1].replace(/<[^>]*>/g, "").trim();
          texts.push(rawText);
        }

        const times: string[] = [];
        while ((match = timeRegex.exec(html)) !== null) {
          times.push(match[1]);
        }

        for (let i = 0; i < Math.min(texts.length, times.length); i++) {
          posts.push({
            id: `${handle}-${i}`,
            channel: handle,
            text: texts[texts.length - 1 - i],
            date: times[times.length - 1 - i] || null,
          });
        }
        return posts;
      } catch (err) {
        console.error(`Scrape failed for telegram channel ${handle}:`, err);
        return [];
      }
    };

    const results = await Promise.all(channels.map((ch) => scrapeTelegramChannel(ch)));
    for (const posts of results) {
      allPosts = allPosts.concat(posts);
    }

    // Undated posts sort last rather than being coerced to the epoch, which
    // would have ranked them as the oldest content in the feed.
    const ts = (v: unknown) => {
      const t = v ? new Date(String(v)).getTime() : NaN;
      return Number.isFinite(t) ? t : -Infinity;
    };
    allPosts.sort((a, b) => ts(b.date) - ts(a.date));

    // An empty result is returned as empty. This used to fall back to four
    // hardcoded "BREAKING" messages — GPS jamming in the Baltic, armour massing
    // at a border, a named ransomware group — each attributed to a REAL channel
    // that had not said any of it. Fabricated intelligence carrying a genuine
    // source name is the worst failure mode this system has.
    return allPosts;
  });

/**
 * GPS interference and radiation, as SERVER functions.
 *
 * Both collectors used to be imported directly into the browser, unlike every
 * other collector on this page. The requests were therefore blocked by CORS —
 * gpsjam.org sends no Access-Control-Allow-Origin at all, and api.safecast.org
 * sends an invalid one — and both helpers swallowed the failure and returned a
 * null cache, so the two tabs showed "Loading..." forever with no error and no
 * end.
 *
 * `collector-health.ts` had already been probing both hosts server-side, where
 * they answer, which is what showed the problem was placement rather than
 * availability.
 *
 * These return a discriminated result rather than throwing across the RPC
 * boundary, so the UI can render the real upstream cause.
 */
export const fetchGpsJamLayer = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const { fetchGpsInterference } = await import("@/utils/gps-interference");
    return { data: await fetchGpsInterference(), error: null as string | null };
  } catch (err: any) {
    return { data: null, error: err?.message ?? String(err) };
  }
});

export const fetchRadiationLayer = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const { fetchRadiationFeed } = await import("@/utils/radiation");
    return { data: await fetchRadiationFeed(), error: null as string | null };
  } catch (err: any) {
    return { data: null, error: err?.message ?? String(err) };
  }
});

export const fetchGeopoliticalSecurity = createServerFn({ method: "GET" })
  .validator((data: { q?: string; query?: string } | undefined) => data)
  .handler(async ({ data }) => {
    const query = data?.query || data?.q || "";

    /*
     * 1. UCDP GED events.
     *
     * This used to be an independent second copy of the collector that hit
     * ucdpapi.pcr.uu.se with ONLY a User-Agent header — no
     * `x-ucdp-access-token`, no `resolveCredential("ucdp")`. UCDP has been
     * token-gated since before 2026-08-04 and answers 401 on every dataset
     * version without one, so this path failed unconditionally EVEN WHEN A
     * TOKEN WAS CONFIGURED. An analyst could add the token on /settings, watch
     * it verify against the live API, and see no change here.
     *
     * It also re-implemented the casualty null-handling that geo.ts:319-325
     * warns was "fixed in osint.tsx's UCDP handler while this copy was missed" —
     * the duplication had already caused one divergence.
     *
     * It now delegates to `collectConflict()`, which resolves the token
     * environment-first-then-vault, records the credential use, maps through the
     * single `fromUcdpEvent`, and returns an explicit missing-credential message
     * rather than an empty array.
     */
    const fetchUcdp = async () => {
      const { collectConflict } = await import("@/utils/geo-sources");
      const layer = await collectConflict();
      if (layer.error) throw new Error(layer.error);
      return layer.records.map((r) => ({
        id: r.id,
        // detail.country is UCDP's own country field. `locates` describes the
        // coordinate's precision, not the place.
        country: (r.detail as any)?.country ?? "country not reported",
        // Already null-vs-zero correct in fromUcdpEvent: null means UCDP
        // reported no casualty figure, which is not the same as zero deaths.
        deaths: r.magnitude,
        latitude: r.lat,
        longitude: r.lon,
        date: r.timestamp,
        // The parties, or UCDP's conflict name. Never a substituted
        // "State Conflict" label for an event UCDP did not classify.
        conflict: r.title,
      }));
    };

    // 2. Fetch GDELT Doc API
    const fetchGdelt = async () => {
      try {
        const apiQuery = query ? encodeURIComponent(query) : "military conflict";
        const res = await fetch(
          `https://api.gdeltproject.org/api/v2/doc/doc?query=${apiQuery}&mode=ArtList&format=JSON&maxrecords=15`,
          {
            signal: AbortSignal.timeout(8000),
          },
        );
        if (res.ok) {
          const data = await res.json();
          const list = data.articles || [];
          return list.map((a: any, idx: number) => ({
            id: idx,
            title: a.title,
            url: a.url,
            // Was `|| "GDELT"`. GDELT is the aggregator that returned the
            // article, not the outlet that published it — naming it as the
            // source attributes the reporting to the wrong organisation. This
            // is the same class of error rss-source.ts exists to fix, where
            // every Google News redirect was scored as news.google.com.
            source: a.source || "publisher not reported",
            date: a.seendate || null,
          }));
        }
      } catch (err) {
        console.error("GDELT fetch failed:", err);
        // Fallback: Query Google News search RSS if GDELT fails or times out
        if (query.trim()) {
          try {
            const Parser = (await import("rss-parser")).default;
            const parser = new Parser();
            const parsedFeed = await parser.parseURL(
              `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US`,
            );
            return (parsedFeed.items || []).slice(0, 10).map((item, idx) => ({
              id: idx,
              title: item.title,
              url: item.link,
              // `|| "Google News"` named the aggregator as the publisher. Every
              // item here is a Google News redirect to some other outlet, so
              // that attributed the reporting to the wrong organisation.
              source:
                typeof item.source === "object"
                  ? (item.source as any).text
                  : item.source || "publisher not reported",
              date: item.pubDate || null,
            }));
          } catch (rssErr) {
            console.error("Geopolitical fallback RSS failed:", rssErr);
          }
        }
      }
      return [];
    };

    // 3. Fetch OpenSky Network
    const fetchOpenSky = async () => {
      try {
        const res = await fetch("https://opensky-network.org/api/states/all", {
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) {
          const data = await res.json();
          if (data && Array.isArray(data.states)) {
            return data.states.length;
          }
        }
      } catch (err) {
        console.error("OpenSky fetch failed:", err);
      }
      // null, never 4290. This was the UNCONDITIONAL error return, so any
      // OpenSky failure produced an invented flight count labelled "Active
      // flights tracked globally via OpenSky API".
      return null;
    };

    // allSettled, not all: each source reports its own outcome. UCDP failing
    // must not take GDELT down with it, and a UCDP 401 must reach the UI as a
    // missing credential rather than as an empty conflict picture.
    const [ucdpSettled, gdeltSettled, openSkySettled] = await Promise.allSettled([
      fetchUcdp(),
      fetchGdelt(),
      fetchOpenSky(),
    ]);
    const ucdpEventsList = ucdpSettled.status === "fulfilled" ? ucdpSettled.value : [];
    const ucdpError =
      ucdpSettled.status === "rejected"
        ? String(ucdpSettled.reason?.message ?? ucdpSettled.reason)
        : null;
    const gdeltStoriesList = gdeltSettled.status === "fulfilled" ? gdeltSettled.value : [];
    const gdeltError =
      gdeltSettled.status === "rejected"
        ? String(gdeltSettled.reason?.message ?? gdeltSettled.reason)
        : null;
    const openSkyFlightCount = openSkySettled.status === "fulfilled" ? openSkySettled.value : null;

    return {
      ucdpEvents: ucdpEventsList,
      // Carried so the panel can say WHY it is empty. UCDP GED returns 401
      // without an access token, and that was rendering as "No conflict events
      // found." - a missing credential shown to the analyst as a peaceful world.
      ucdpError,
      gdeltStories: gdeltStoriesList,
      gdeltError,
      flightCount: openSkyFlightCount,
      // gpsStatus was the fixed string "GPS Jamming High: 14 hotzones active in
      // Baltic / Eastern Europe" and orefAlerts was two hardcoded rocket alerts
      // for Galilee and Tel Aviv, stamped with the CURRENT time so they always
      // looked live. Both were fabricated intelligence attributed to real
      // systems — Israel's Home Front Command among them. No collector produces
      // either, so both are absent.
      gpsStatus: null,
      orefAlerts: [] as { time: string; zone: string; alert: string }[],
    };
  });

export const fetchRSSAggregator = createServerFn({ method: "GET" })
  .validator((data: { q?: string; query?: string } | undefined) => data)
  .handler(async ({ data }) => {
    const Parser = (await import("rss-parser")).default;
    const parser = new Parser();
    const feeds: Record<string, any[]> = {
      politics: [],
      cyber: [],
      military: [],
      finance: [],
      incident: [],
    };

    // A feed that failed to parse and a feed that returned nothing are different
    // facts, and the UI renders them differently. Collectors here may never
    // collapse the first into the second (Recipe C), so every failure is named
    // with its real cause and surfaced alongside the results.
    const errors: Record<string, string[]> = {
      politics: [],
      cyber: [],
      military: [],
      finance: [],
      incident: [],
    };
    const query = data?.query || data?.q || "";

    const causeOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

    // Fetch live incident feed if query is provided
    if (query.trim()) {
      try {
        const incidentUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US`;
        const parsedFeed = await parser.parseURL(incidentUrl);
        feeds.incident = (parsedFeed.items || []).slice(0, 15).map((item) => ({
          title: item.title,
          link: item.link,
          // null, never `new Date()`. Stamping "now" onto an item whose feed
          // carried no date invents a publication time, and the RSS panel sorts
          // and displays that value as though the outlet reported it.
          pubDate: item.pubDate ?? null,
          // Same as above: the aggregator is not the publisher.
          source:
            typeof item.source === "object"
              ? (item.source as any).text
              : item.source || "publisher not reported",
        }));
      } catch (err) {
        console.error("Failed to parse dynamic incident RSS feed:", err);
        errors.incident.push(`Google News search feed: ${causeOf(err)}`);
      }
    }

    const FEEDS_CONFIG = {
      politics: [
        { name: "BBC News", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
        {
          name: "AP News World",
          url: "https://news.google.com/rss/search?q=site:apnews.com+world&hl=en-US",
        },
      ],
      cyber: [
        { name: "Krebs on Security", url: "https://krebsonsecurity.com/feed/" },
        { name: "Dark Reading", url: "https://www.darkreading.com/rss.xml" },
        { name: "CISA Advisories", url: "https://www.cisa.gov/cybersecurity-advisories/all.xml" },
      ],
      military: [
        { name: "War on the Rocks", url: "https://warontherocks.com/feed/" },
        { name: "CSIS Reports", url: "https://www.csis.org/rss.xml" },
      ],
      finance: [
        { name: "Yahoo Finance", url: "https://finance.yahoo.com/news/rssindex" },
        { name: "CNBC Markets", url: "https://www.cnbc.com/id/100003114/device/rss/rss.html" },
      ],
    };

    const parsePromises: Promise<void>[] = [];
    for (const [category, categoryFeeds] of Object.entries(FEEDS_CONFIG)) {
      for (const feed of categoryFeeds) {
        parsePromises.push(
          (async () => {
            try {
              const parsedFeed = await parser.parseURL(feed.url);
              const items = (parsedFeed.items || []).slice(0, 10).map((item) => ({
                title: item.title,
                link: item.link,
                pubDate: item.pubDate ?? null,
                source: feed.name,
              }));
              feeds[category] = feeds[category].concat(items);
            } catch (err) {
              console.error(`Failed to parse RSS feed ${feed.name}:`, err);
              errors[category].push(`${feed.name}: ${causeOf(err)}`);
            }
          })(),
        );
      }
    }
    await Promise.all(parsePromises);

    // No fallbacks. Each category previously substituted one invented headline
    // when its feeds returned nothing — stamped with the current time so it read
    // as fresh, and attributed to a REAL outlet (UN News, CISA, War on the Rocks,
    // Yahoo Finance) that had published no such thing. That is the same failure
    // the Telegram collector above documents removing, and it is the worst one
    // this system has: fabricated reporting carrying a genuine source name.
    //
    // An empty category is returned as empty, with whatever upstream failures
    // produced it, so the panel can say which it is.
    return { feeds, errors };
  });

/** Icons live here rather than on the data, so the summary stays plain and testable. */
const OVERVIEW_ICONS: Record<string, typeof Globe> = {
  dns: Globe,
  certificates: Shield,
  github: Github,
  cyber: ShieldAlert,
  telegram: Radio,
  rss: Newspaper,
};

// ============================================================================
// OSINT Component & Page
// ============================================================================

export const Route = createFileRoute("/osint")({
  head: () => ({ meta: [{ title: "OSINT Intelligence — Sentinel AI" }] }),
  component: Page,
});

function Page() {
  // Three distinct concerns that were previously one piece of state:
  //   searchQuery  the committed target; changing it refetches every feed
  //   targetInput  what is currently typed into the target box
  //   filterText   narrows the already-loaded results, never hits the network
  // Collapsing them meant every keystroke fired five upstream requests, which
  // exhausted GitHub's 60/hour unauthenticated limit within about a minute.
  const [searchQuery, setSearchQuery] = useState(() => getActiveTarget());
  const [targetInput, setTargetInput] = useState(() => getActiveTarget());
  const [filterText, setFilterText] = useState("");
  const [activeTab, setActiveTab] = useState("whois");

  // Dynamic state hooks
  const [cyberThreats, setCyberThreats] = useState<any[]>([]);
  const [telegramPosts, setTelegramPosts] = useState<any[]>([]);
  const [geopoliticalData, setGeopoliticalData] = useState<any | null>(null);
  const [rssFeeds, setRssFeeds] = useState<{
    feeds: Record<string, any[]>;
    errors: Record<string, string[]>;
  } | null>(null);
  const [osintProfile, setOsintProfile] = useState<any>(null);
  const [gpsJamData, setGpsJamData] = useState<any | null>(null);
  const [radiationData, setRadiationData] = useState<any | null>(null);
  // A collector that FAILED and a collector that returned nothing are different
  // findings. Without these the two panels rendered a permanent "Loading..."
  // string for a request that had already failed.
  const [gpsJamError, setGpsJamError] = useState<string | null>(null);
  const [radiationError, setRadiationError] = useState<string | null>(null);
  const [cyberError, setCyberError] = useState<string | null>(null);
  // null = not collected yet; [] = collected and genuinely empty.
  const [telegramLoadFailed, setTelegramLoadFailed] = useState(false);

  const [isLoading, setIsLoading] = useState(true);

  // Sync / Load ALL OSINT data on mount & searchQuery change
  useEffect(() => {
    let isMounted = true;
    const loadAllOsintData = async () => {
      setIsLoading(true);
      try {
        const [profRes, cyberRes, tgRes, geoRes, rssRes, gpsRes, radRes] = await Promise.all([
          fetchOSINT({ data: { query: searchQuery } }).catch(() => null),
          fetchCyberThreats({ data: { query: searchQuery } }).catch((e: any) => {
            setCyberError(e?.message ?? String(e));
            return [];
          }),
          fetchTelegramOSINT({ data: { query: searchQuery } }).catch(() => null),
          fetchGeopoliticalSecurity({ data: { query: searchQuery } }).catch(() => null),
          fetchRSSAggregator({ data: { query: searchQuery } }).catch(() => null),
          fetchGpsJamLayer().catch((e: any) => ({ data: null, error: e?.message ?? String(e) })),
          fetchRadiationLayer().catch((e: any) => ({ data: null, error: e?.message ?? String(e) })),
        ]);

        if (isMounted) {
          if (profRes) setOsintProfile(profRes);
          if (cyberRes) setCyberThreats(cyberRes);
          setTelegramPosts(tgRes ?? []);
          setTelegramLoadFailed(tgRes === null);
          if (geoRes) setGeopoliticalData(geoRes);
          if (rssRes) setRssFeeds(rssRes);
          setGpsJamData(gpsRes?.data ?? null);
          setGpsJamError(gpsRes?.error ?? null);
          setRadiationData(radRes?.data ?? null);
          setRadiationError(radRes?.error ?? null);
        }
      } catch (err) {
        console.error("OSINT loadAllData failed:", err);
      } finally {
        if (isMounted) setIsLoading(false);
      }
    };

    loadAllOsintData();
    return () => {
      isMounted = false;
    };
  }, [searchQuery]);

  // Sync with global target change
  useEffect(() => {
    const initial = getActiveTarget();
    setSearchQuery(initial);

    const handleTargetChange = (e: any) => {
      if (e.detail) {
        setSearchQuery(e.detail);
        setTargetInput(e.detail);
      }
    };
    window.addEventListener("sentinel_target_changed", handleTargetChange);
    return () => window.removeEventListener("sentinel_target_changed", handleTargetChange);
  }, []);

  // Commits the typed target: refetches here and broadcasts so the top bar and
  // every other route follow the same target.
  const commitTarget = () => {
    const next = targetInput.trim();
    if (!next || next === searchQuery) return;
    setSearchQuery(next);
    setActiveTarget(next);
  };

  // These narrow what is already on screen, so they use filterText rather than
  // the committed target and cost nothing to type into.
  const filteredThreats = cyberThreats.filter(
    (t) =>
      !filterText.trim() || t.ip.includes(filterText.trim()) || matchQuery(t.malware, filterText),
  );

  const filteredTelegram = telegramPosts.filter(
    (p) => matchQuery(p.channel, filterText) || matchQuery(p.text, filterText),
  );

  const filteredUcdp = (geopoliticalData?.ucdpEvents || []).filter(
    (e: any) => matchQuery(e.country, filterText) || matchQuery(e.conflict ?? "", filterText),
  );

  const filteredGdelt = (geopoliticalData?.gdeltStories || []).filter((s: any) =>
    matchQuery(s.title, filterText),
  );

  const getFilteredRss = (category: string) => {
    const list = rssFeeds?.feeds?.[category] || [];
    return list.filter((item: any) => matchQuery(item.title, filterText));
  };

  const overviewModules = useMemo(
    () =>
      buildOverviewModules({
        profile: osintProfile,
        cyberThreats,
        telegramPosts,
        rss: rssFeeds,
      }),
    [osintProfile, cyberThreats, telegramPosts, rssFeeds],
  );

  return (
    <AppShell>
      <PageHeader
        title="OSINT Intelligence"
        description="Public-source search across threat intelligence (IOCs), live conflict databases, Telegram feeds, and news aggregates."
      />

      {/* Tabs list container */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="flex flex-wrap h-auto gap-0 border border-[#263548] bg-[#111827] p-0 mb-6 justify-start overflow-x-auto rounded-none font-mono">
          <TabsTrigger
            value="whois"
            className="border-r border-[#263548] px-3.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-[#94A3B8] hover:text-[#F3F4F6] hover:bg-[#1A2332]/50 data-[state=active]:bg-[#1A2332] data-[state=active]:text-[#06B6D4] data-[state=active]:border-b-2 data-[state=active]:border-b-[#06B6D4] transition-colors rounded-none"
          >
            WHOIS / DNS Profile
          </TabsTrigger>
          <TabsTrigger
            value="overview"
            className="border-r border-[#263548] px-3.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-[#94A3B8] hover:text-[#F3F4F6] hover:bg-[#1A2332]/50 data-[state=active]:bg-[#1A2332] data-[state=active]:text-[#06B6D4] data-[state=active]:border-b-2 data-[state=active]:border-b-[#06B6D4] transition-colors rounded-none"
          >
            Overview
          </TabsTrigger>
          <TabsTrigger
            value="cyber"
            className="border-r border-[#263548] px-3.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-[#94A3B8] hover:text-[#F3F4F6] hover:bg-[#1A2332]/50 data-[state=active]:bg-[#1A2332] data-[state=active]:text-[#06B6D4] data-[state=active]:border-b-2 data-[state=active]:border-b-[#06B6D4] transition-colors rounded-none"
          >
            Cyber Threat (IOCs)
          </TabsTrigger>
          <TabsTrigger
            value="telegram"
            className="border-r border-[#263548] px-3.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-[#94A3B8] hover:text-[#F3F4F6] hover:bg-[#1A2332]/50 data-[state=active]:bg-[#1A2332] data-[state=active]:text-[#06B6D4] data-[state=active]:border-b-2 data-[state=active]:border-b-[#06B6D4] transition-colors rounded-none"
          >
            Telegram OSINT
          </TabsTrigger>
          <TabsTrigger
            value="geopolitical"
            className="border-r border-[#263548] px-3.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-[#94A3B8] hover:text-[#F3F4F6] hover:bg-[#1A2332]/50 data-[state=active]:bg-[#1A2332] data-[state=active]:text-[#06B6D4] data-[state=active]:border-b-2 data-[state=active]:border-b-[#06B6D4] transition-colors rounded-none"
          >
            Geopolitical Security
          </TabsTrigger>
          <TabsTrigger
            value="rss"
            className="border-r border-[#263548] px-3.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-[#94A3B8] hover:text-[#F3F4F6] hover:bg-[#1A2332]/50 data-[state=active]:bg-[#1A2332] data-[state=active]:text-[#06B6D4] data-[state=active]:border-b-2 data-[state=active]:border-b-[#06B6D4] transition-colors rounded-none"
          >
            News RSS Aggregator
          </TabsTrigger>
          <TabsTrigger
            value="gpsjam"
            className="border-r border-[#263548] px-3.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-[#94A3B8] hover:text-[#F3F4F6] hover:bg-[#1A2332]/50 data-[state=active]:bg-[#1A2332] data-[state=active]:text-[#06B6D4] data-[state=active]:border-b-2 data-[state=active]:border-b-[#06B6D4] transition-colors rounded-none"
          >
            GPS Interference
          </TabsTrigger>
          <TabsTrigger
            value="radiation"
            className="border-r border-[#263548] px-3.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-[#94A3B8] hover:text-[#F3F4F6] hover:bg-[#1A2332]/50 data-[state=active]:bg-[#1A2332] data-[state=active]:text-[#06B6D4] data-[state=active]:border-b-2 data-[state=active]:border-b-[#06B6D4] transition-colors rounded-none"
          >
            Radiation Sensors
          </TabsTrigger>
        </TabsList>

        {/* Tab content 0: WHOIS / DNS Profile */}
        <TabsContent value="whois" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            {/* 1. WHOIS Registration */}
            <Card className="bg-[#111827] border-[#263548] rounded">
              <CardHeader className="pb-2 border-b border-[#263548] p-3 bg-[#0B1220]/40 flex items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-xs font-bold uppercase text-[#F3F4F6]">
                  <Globe className="size-4 text-[#3B82F6]" /> WHOIS Registration
                </CardTitle>
              </CardHeader>
              <CardContent className="p-3 font-mono text-xs text-[#94A3B8]">
                <Table className="w-full">
                  <TableBody>
                    <TableRow className="border-[#263548]">
                      <TableCell className="text-[#94A3B8] font-semibold py-2">Domain</TableCell>
                      <TableCell className="text-[#F3F4F6] text-right font-mono py-2">
                        {osintProfile?.whois?.Domain || searchQuery}
                      </TableCell>
                    </TableRow>
                    <TableRow className="border-[#263548]">
                      <TableCell className="text-[#94A3B8] font-semibold py-2">Registrar</TableCell>
                      <TableCell className="text-[#F3F4F6] text-right font-mono py-2">
                        {osintProfile?.whois?.Registrar || (
                          <span className="italic text-[#64748B]">not reported</span>
                        )}
                      </TableCell>
                    </TableRow>
                    <TableRow className="border-[#263548]">
                      <TableCell className="text-[#94A3B8] font-semibold py-2">Created</TableCell>
                      <TableCell className="text-[#F3F4F6] text-right font-mono py-2">
                        {osintProfile?.whois?.Created || (
                          <span className="italic text-[#64748B]">not reported</span>
                        )}
                      </TableCell>
                    </TableRow>
                    <TableRow className="border-[#263548]">
                      <TableCell className="text-[#94A3B8] font-semibold py-2">Expires</TableCell>
                      <TableCell className="text-[#F3F4F6] text-right font-mono py-2">
                        {osintProfile?.whois?.Expires || (
                          <span className="italic text-[#64748B]">not reported</span>
                        )}
                      </TableCell>
                    </TableRow>
                    <TableRow className="border-0">
                      <TableCell className="text-[#94A3B8] font-semibold py-2">NS</TableCell>
                      <TableCell className="text-[#F3F4F6] text-right font-mono py-2 truncate max-w-[200px]">
                        {osintProfile?.whois?.NS || (
                          <span className="italic text-[#64748B]">not reported</span>
                        )}
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            {/* 2. DNS Nameservers */}
            <Card className="bg-[#111827] border-[#263548] rounded">
              <CardHeader className="pb-2 border-b border-[#263548] p-3 bg-[#0B1220]/40 flex items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-xs font-bold uppercase text-[#F3F4F6]">
                  <Wifi className="size-4 text-[#06B6D4]" /> DNS Nameservers
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 space-y-4 font-mono text-xs">
                <div>
                  <div className="text-[10px] text-[#94A3B8] font-bold uppercase">A</div>
                  <div className="text-sm font-bold text-[#F3F4F6] mt-0.5">
                    {osintProfile?.dns?.a || (
                      <span className="italic text-[#64748B]">not reported</span>
                    )}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-[#94A3B8] font-bold uppercase">MX</div>
                  <div className="text-sm font-bold text-[#F3F4F6] mt-0.5">
                    {osintProfile?.dns?.mx || (
                      <span className="italic text-[#64748B]">not reported</span>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* 3. GitHub Repositories */}
            <Card className="bg-[#111827] border-[#263548] rounded">
              <CardHeader className="pb-2 border-b border-[#263548] p-3 bg-[#0B1220]/40 flex items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-xs font-bold uppercase text-[#F3F4F6]">
                  <Github className="size-4 text-purple-400" /> GitHub Repositories
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 font-mono text-xs text-[#94A3B8]">
                {osintProfile?.github && osintProfile.github.length > 0 ? (
                  <div className="space-y-2">
                    {osintProfile.github.map((repo: any) => (
                      <a
                        key={repo.url}
                        href={repo.url}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center justify-between p-2 rounded bg-[#0B1220] border border-[#263548] text-[#F3F4F6] hover:border-[#3B82F6]"
                      >
                        <span>{repo.name}</span>
                        <ExternalLink className="size-3 text-[#94A3B8]" />
                      </a>
                    ))}
                  </div>
                ) : (
                  <div className="py-6 text-center text-[#94A3B8]/60">
                    No public repositories found.
                  </div>
                )}
              </CardContent>
            </Card>

            {/* 4. Corporate Registry */}
            <Card className="bg-[#111827] border-[#263548] rounded">
              <CardHeader className="pb-2 border-b border-[#263548] p-3 bg-[#0B1220]/40 flex items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-xs font-bold uppercase text-[#F3F4F6]">
                  <Database className="size-4 text-[#10B981]" /> Corporate Registry
                </CardTitle>
              </CardHeader>
              <CardContent className="p-3 font-mono text-xs text-[#94A3B8]">
                <Table className="w-full">
                  <TableBody>
                    <TableRow className="border-[#263548]">
                      <TableCell className="text-[#94A3B8] font-semibold py-2">status</TableCell>
                      <TableCell className="text-[#F3F4F6] text-right font-mono py-2">
                        {osintProfile?.corporate?.status || "Not found"}
                      </TableCell>
                    </TableRow>
                    <TableRow className="border-[#263548]">
                      <TableCell className="text-[#94A3B8] font-semibold py-2">
                        jurisdiction
                      </TableCell>
                      <TableCell className="text-[#F3F4F6] text-right font-mono py-2">
                        {osintProfile?.corporate?.jurisdiction || "Not found"}
                      </TableCell>
                    </TableRow>
                    <TableRow className="border-[#263548]">
                      <TableCell className="text-[#94A3B8] font-semibold py-2">fileNo</TableCell>
                      <TableCell className="text-[#F3F4F6] text-right font-mono py-2">
                        {osintProfile?.corporate?.fileNo || "Not found"}
                      </TableCell>
                    </TableRow>
                    <TableRow className="border-0">
                      <TableCell className="text-[#94A3B8] font-semibold py-2">hq</TableCell>
                      <TableCell className="text-[#F3F4F6] text-right font-mono py-2">
                        {osintProfile?.corporate?.hq || "Not found"}
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            {/* 5. Subdomain & Certificate Transparency Radar */}
            <Card className="bg-[#111827] border-[#263548] rounded md:col-span-2">
              <CardHeader className="pb-2 border-b border-[#263548] p-3 bg-[#0B1220]/40 flex items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-xs font-bold uppercase text-[#F3F4F6]">
                  <ShieldCheck className="size-4 text-[#10B981]" /> Subdomain Discovery &
                  Certificate Logs (crt.sh)
                </CardTitle>
                <Badge
                  variant="outline"
                  className="text-[10px] font-mono border-[#10B981]/30 text-[#10B981] bg-[#10B981]/10"
                >
                  {osintProfile?.certificates?.length ?? 0} Discovered Subdomains
                </Badge>
              </CardHeader>
              <CardContent className="p-3 font-mono text-xs text-[#94A3B8]">
                {/*
                  Three states, and they must stay distinct. This panel used to
                  fall back to four invented subdomains (api., vpn., auth. and
                  c2-dev.) with invented CA issuers and dates whenever the lookup
                  returned nothing, under a badge reading "4 Discovered
                  Subdomains" — so a failed lookup reported fabricated
                  infrastructure, including one host named like a C2 server.
                */}
                {osintProfile?.certificatesError ? (
                  <div className="flex items-start gap-2 rounded border border-[#EF4444]/30 bg-[#EF4444]/5 p-3">
                    <AlertTriangle className="size-4 shrink-0 text-[#EF4444]" />
                    <span className="font-mono text-[11px] leading-relaxed text-[#EF4444]">
                      Certificate-transparency lookup failed: {osintProfile.certificatesError}
                    </span>
                  </div>
                ) : (osintProfile?.certificates?.length ?? 0) === 0 ? (
                  <div className="rounded border border-[#263548] bg-[#0B1220]/40 p-3 text-[11px] leading-relaxed text-[#94A3B8]">
                    No certificates for this target in the public Certificate Transparency logs.
                    That is a result, not a failure: the target may not be a domain, or it may use
                    no publicly logged certificate.
                  </div>
                ) : (
                  <Table className="w-full">
                    <TableHeader>
                      <TableRow className="border-[#263548]">
                        <TableHead className="text-[#94A3B8] text-[10px] font-bold uppercase">
                          Subdomain / Asset
                        </TableHead>
                        <TableHead className="text-[#94A3B8] text-[10px] font-bold uppercase">
                          CA Issuer
                        </TableHead>
                        <TableHead className="text-[#94A3B8] text-[10px] font-bold uppercase text-right">
                          First Seen
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {osintProfile.certificates.slice(0, 8).map((cert: any, idx: number) => (
                        <TableRow key={cert.hostname ?? idx} className="border-[#263548]/50">
                          <TableCell className="text-[#F3F4F6] font-mono py-1.5 font-bold">
                            {cert.hostname}
                          </TableCell>
                          {/* null = the log record carried no issuer. Never a guessed CA. */}
                          <TableCell className="text-[#94A3B8] py-1.5">
                            {cert.issuer ?? "Not reported"}
                          </TableCell>
                          <TableCell className="text-[#06B6D4] text-right font-mono py-1.5">
                            {cert.firstSeen ?? "Not reported"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}

                {/* Never cap silently: the badge counts all of them, the table shows 8. */}
                {(osintProfile?.certificates?.length ?? 0) > 8 && (
                  <p className="pt-2 text-[10px] text-[#64748B]">
                    Showing the first 8 of {osintProfile.certificates.length}. The full set is
                    available on the Recon page.
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Tab content 1: Overview */}
        <TabsContent value="overview" className="space-y-4">
          <Card className="bg-[#111827] border-[#263548] rounded relative overflow-hidden mb-4">
            <div className="absolute top-0 left-0 h-0.5 w-full bg-[#3B82F6]" />
            <CardContent className="p-4">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[#94A3B8]" />
                <Input
                  placeholder="Analyze domain, email, handle, or wallet..."
                  value={targetInput}
                  onChange={(e) => setTargetInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && commitTarget()}
                  className="h-10 pl-9 pr-24 font-mono text-xs border-[#263548] bg-[#0B1220] text-[#F3F4F6] placeholder:text-[#94A3B8]/40 focus-visible:ring-[#3B82F6] rounded"
                />
                <Button
                  size="sm"
                  onClick={commitTarget}
                  className="absolute right-1 top-1/2 -translate-y-1/2 h-8 px-4 rounded bg-[#3B82F6] hover:bg-[#3B82F6]/90 text-[#F3F4F6] text-[10px] font-bold uppercase tracking-wider font-mono"
                >
                  Search
                </Button>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px] text-[#94A3B8] font-mono">
                <span>Try:</span>
                {/*
                  REMOVED: five example-target chips that had no onClick.
                  They looked like one-click targets and did nothing when
                  pressed. The target box above is the working control.
                */}
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {overviewModules.map((m) => {
              const Icon = OVERVIEW_ICONS[m.key] ?? Database;
              return (
                <Card
                  key={m.key}
                  className="bg-card/75 border border-primary/10 hover:border-primary/25 transition-all"
                >
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2">
                        <span className="grid size-8 place-items-center rounded-md bg-primary/10 text-primary">
                          <Icon className="size-4" />
                        </span>
                        <div>
                          <div className="text-sm font-semibold">{m.name}</div>
                          <div className="text-[11px] text-muted-foreground">
                            {m.count === null ? "not collected" : `${m.count} collected`}
                          </div>
                        </div>
                      </div>
                      <Tone tone={m.tone} />
                    </div>
                    <p className="mt-3 text-xs text-muted-foreground">{m.note}</p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-3 h-7 gap-1 text-xs"
                      disabled={m.count === null}
                      onClick={() => setActiveTab(m.tab)}
                    >
                      <Link2 className="size-3" />
                      Open records
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {/*
              REMOVED: an "Aggregate confidence 74 / 100" panel with a filled
              progress bar, "8 / 12 corroborated", "83% within 30d" and
              "5 domains". Every figure was hardcoded. It sat directly beneath
              the six Overview cards whose counts are genuinely derived from
              collections this page holds, so it read as the same class of
              measurement. There is no corroboration engine behind it.
            */}
        </TabsContent>

        {/* Tab content 2: Cyber Threat IOCs */}
        <TabsContent value="cyber" className="space-y-4">
          <Card>
            <CardHeader className="p-4 border-b">
              <CardTitle className="text-base font-bold flex items-center gap-2">
                <ShieldAlert className="size-5 text-primary" /> Indicators of Compromise (IOCs)
              </CardTitle>
              <CardDescription className="text-xs">
                Feodo Tracker and C2IntelFeeds blocklists, fetched when this tab loads. Entries are
                what those feeds published; liveness and dates are shown only where the feed
                reported them.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-4 space-y-4">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Filter IOCs by IP or malware strain..."
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  className="h-10 pl-9 border"
                />
              </div>

              {isLoading ? (
                <div className="flex justify-center py-20">
                  <RefreshCw className="size-8 animate-spin text-primary" />
                </div>
              ) : filteredThreats.length === 0 ? (
                <div className="text-center py-20 text-xs text-muted-foreground">
                  No threat indicators found.
                </div>
              ) : (
                <div className="rounded-md border overflow-hidden">
                  <Table>
                    <TableHeader className="bg-muted/50">
                      <TableRow>
                        <TableHead className="text-xs font-semibold">IP Address</TableHead>
                        <TableHead className="text-xs font-semibold">Source Feed</TableHead>
                        <TableHead className="text-xs font-semibold">Malware Family</TableHead>
                        <TableHead className="text-xs font-semibold">Status</TableHead>
                        <TableHead className="text-xs font-semibold">Severity</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredThreats.map((threat, index) => (
                        <TableRow key={`${threat.ip}-${index}`}>
                          <TableCell className="font-mono text-xs text-foreground/90">
                            {threat.ip}
                          </TableCell>
                          <TableCell className="text-xs">{threat.source}</TableCell>
                          <TableCell className="text-xs font-semibold text-primary">
                            {threat.malware}
                          </TableCell>
                          <TableCell className="text-xs capitalize">
                            <span className="flex items-center gap-1.5">
                              <span className="size-2 rounded-full bg-emerald-500 animate-pulse" />
                              {threat.status ?? <NotReported />}
                            </span>
                          </TableCell>
                          <TableCell className="text-xs">
                            <span
                              className={`px-2 py-0.5 rounded-full text-[10px] font-semibold capitalize ${
                                threat.severity === "critical"
                                  ? "bg-red-500/10 text-red-500 border border-red-500/20"
                                  : threat.severity === "high"
                                    ? "bg-amber-500/10 text-amber-500 border border-amber-500/20"
                                    : "bg-blue-500/10 text-blue-500 border border-blue-500/20"
                              }`}
                            >
                              {threat.severity}
                            </span>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tab content 3: Telegram OSINT */}
        <TabsContent value="telegram" className="space-y-4">
          <Card>
            <CardHeader className="p-4 border-b">
              <CardTitle className="text-base font-bold flex items-center gap-2">
                <Terminal className="size-5 text-primary" /> Curated Telegram OSINT Channels
              </CardTitle>
              <CardDescription className="text-xs">
                Raw, low-latency intelligence summaries scraped directly from public conflict and
                breaking news channels.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-4 space-y-4">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Filter Telegram feed by keyword or channel..."
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  className="h-10 pl-9 border"
                />
              </div>

              {isLoading ? (
                <div className="flex justify-center py-20">
                  <RefreshCw className="size-8 animate-spin text-primary" />
                </div>
              ) : filteredTelegram.length === 0 ? (
                <CollectorAbsence
                  error={
                    telegramLoadFailed
                      ? "The Telegram collector did not return. Channel previews are scraped from t.me and can fail per channel; a failure here is not a finding that the channels were quiet."
                      : null
                  }
                  loading={isLoading}
                  emptyLabel="Channel previews returned no posts."
                />
              ) : (
                <div className="grid gap-3 md:grid-cols-2">
                  {filteredTelegram.map((post) => (
                    <Card
                      key={post.id}
                      className="bg-card/40 border hover:border-primary/20 transition-all"
                    >
                      <CardContent className="p-4 space-y-3">
                        <div className="flex items-center justify-between border-b pb-2">
                          <span className="text-xs font-bold text-primary">@{post.channel}</span>
                          <span className="text-[10px] text-muted-foreground">
                            {formatFeedDate(post.date)}
                          </span>
                        </div>
                        <p className="text-xs text-foreground/90 leading-relaxed whitespace-pre-wrap">
                          {post.text}
                        </p>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tab content 4: Geopolitical Security */}
        <TabsContent value="geopolitical" className="space-y-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Filter geopolitical dashboard by country, conflict, or event..."
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              className="h-10 pl-9 border"
            />
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <Card className="bg-gradient-to-br from-background to-primary/5 border border-primary/20">
              <CardContent className="p-4 space-y-2">
                <span className="text-[10px] uppercase font-bold text-primary flex items-center gap-1">
                  <Compass className="size-3.5" /> ADS-B Flight Tracking
                </span>
                <div className="text-3xl font-extrabold text-foreground">
                  {geopoliticalData?.flightCount ?? "not collected"}
                </div>
                <p className="text-xs text-muted-foreground">
                  Active flights tracked globally via OpenSky API.
                </p>
              </CardContent>
            </Card>

            <Card className="bg-gradient-to-br from-background to-amber-500/5 border border-amber-500/20">
              <CardContent className="p-4 space-y-2">
                <span className="text-[10px] uppercase font-bold text-amber-500 flex items-center gap-1">
                  <Wifi className="size-3.5" /> GPS Interference
                </span>
                <div className="text-sm font-semibold text-foreground leading-snug">
                  Not collected
                </div>
                <p className="text-xs text-muted-foreground">
                  No GPS-interference feed is wired. GPSJAM and the ADS-B NIC-derived datasets would
                  supply this; neither is connected, so no figure is shown.
                </p>
              </CardContent>
            </Card>

            <Card className="bg-gradient-to-br from-background to-red-500/5 border border-red-500/20">
              <CardContent className="p-4 space-y-2">
                <span className="text-[10px] uppercase font-bold text-red-500 flex items-center gap-1">
                  <AlertTriangle className="size-3.5" /> Israel OREF Alerts
                </span>
                <div className="text-xs font-mono bg-red-500/10 text-red-400 p-2.5 rounded border border-red-500/20 overflow-y-auto max-h-16">
                  {(geopoliticalData?.orefAlerts?.length ?? 0) > 0
                    ? geopoliticalData.orefAlerts.map((a: any, idx: number) => (
                        <div key={idx} className="flex justify-between text-[10px]">
                          <span>{a.zone}</span>
                          <span>{a.time}</span>
                        </div>
                      ))
                    : "No OREF collector is connected. This panel stays empty rather than showing alerts nobody issued."}
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            {/* UCDP Conflict Events */}
            <Card>
              <CardHeader className="p-4 border-b">
                <CardTitle className="text-sm font-bold flex items-center gap-1.5">
                  <Activity className="size-4 text-primary" /> Uppsala Conflict Database (UCDP)
                </CardTitle>
                <CardDescription className="text-xs">
                  Latest armed violence events and casualty metrics logged by country.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-4 space-y-3">
                {isLoading ? (
                  <div className="flex justify-center py-10">
                    <RefreshCw className="size-6 animate-spin text-primary" />
                  </div>
                ) : filteredUcdp.length === 0 ? (
                  isMissingUcdpToken(geopoliticalData?.ucdpError ?? null) ? (
                    /*
                      A missing credential is not a collection failure and is
                      certainly not a finding that no armed conflict occurred.
                      It has one specific remedy, so it gets its own panel that
                      names the variable and links to where the token is entered.
                    */
                    <div className="rounded border border-[#F59E0B]/30 bg-[#F59E0B]/5 p-4 text-[10px]">
                      <div className="font-bold uppercase text-[#F59E0B]">
                        UCDP access token not configured
                      </div>
                      <p className="mt-1 leading-relaxed text-[#94A3B8]">
                        UCDP GED returns HTTP 401 without one, so no events could be requested.
                        <strong className="text-[#F59E0B]">
                          {" "}
                          This is a missing credential, not a finding that no conflicts occurred.
                        </strong>
                      </p>
                      <ul className="mt-2 space-y-1 text-[#64748B]">
                        <li>
                          Set <code className="text-[#06B6D4]">UCDP_API_TOKEN</code> in the
                          deployment environment (the durable path), or
                        </li>
                        <li>
                          add a UCDP token on{" "}
                          <Link to="/settings" className="text-[#3B82F6] hover:underline">
                            Settings
                          </Link>{" "}
                          and press Verify — the provider and its live probe already exist there.
                        </li>
                        <li>
                          Request a token at{" "}
                          <a
                            href="https://ucdp.uu.se/"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[#3B82F6] hover:underline"
                          >
                            ucdp.uu.se
                          </a>
                          .
                        </li>
                      </ul>
                    </div>
                  ) : (
                    <CollectorAbsence
                      error={geopoliticalData?.ucdpError ?? null}
                      loading={isLoading}
                      emptyLabel="UCDP answered; no conflict events matched."
                    />
                  )
                ) : (
                  filteredUcdp.map((event: any, idx: number) => (
                    <div
                      key={idx}
                      className="flex items-start justify-between border-b pb-2 text-xs"
                    >
                      <div>
                        <div className="font-semibold text-foreground/95 flex items-center gap-1">
                          <MapPin className="size-3 text-muted-foreground" /> {event.country}
                        </div>
                        <span className="text-[10px] text-muted-foreground">
                          {event.conflict ?? <NotReported what="conflict id not reported" />}
                        </span>
                      </div>
                      <div className="text-right">
                        <Badge variant="destructive" className="h-5 text-[10px] font-bold">
                          {event.deaths === null ? (
                            <NotReported what="casualties not reported" />
                          ) : (
                            `${event.deaths} casualties`
                          )}
                        </Badge>
                        <div className="text-[9px] text-muted-foreground mt-0.5">
                          {formatFeedDate(event.date)}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            {/* GDELT global headlines */}
            <Card>
              <CardHeader className="p-4 border-b">
                <CardTitle className="text-sm font-bold flex items-center gap-1.5">
                  <Globe className="size-4 text-primary" /> GDELT Document News Stream
                </CardTitle>
                <CardDescription className="text-xs">
                  GDELT DOC query, run on demand for the current filter. GDELT reports the country
                  of the publishing outlet, not the location of the event.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-4 space-y-3">
                {isLoading ? (
                  <div className="flex justify-center py-10">
                    <RefreshCw className="size-6 animate-spin text-primary" />
                  </div>
                ) : filteredGdelt.length === 0 ? (
                  <CollectorAbsence
                    error={geopoliticalData?.gdeltError ?? null}
                    loading={isLoading}
                    emptyLabel="GDELT answered; no reports matched."
                  />
                ) : (
                  filteredGdelt.map((story: any) => (
                    <div key={story.id} className="border-b pb-2 text-xs space-y-1">
                      <a
                        href={story.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium text-primary hover:underline flex items-start gap-1"
                      >
                        {story.title} <ExternalLink className="size-3 inline shrink-0 mt-0.5" />
                      </a>
                      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                        <span>Source: {story.source}</span>
                        <span>{formatFeedDate(story.date)}</span>
                      </div>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Tab content 5: RSS Feed Aggregator */}
        <TabsContent value="rss" className="space-y-4">
          <Card>
            <CardHeader className="p-4 border-b">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
                <div>
                  <CardTitle className="text-base font-bold flex items-center gap-2">
                    <BookOpen className="size-5 text-primary" /> Categorized News & RSS Feeds
                  </CardTitle>
                  <CardDescription className="text-xs">
                    Categorised RSS pulled when this tab loads — politics, cyber threat advisories,
                    military/defence outlets and financial indexes. One pass per load; nothing polls
                    in the background.
                  </CardDescription>
                </div>
                <div className="relative w-full md:w-80 shrink-0">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="Filter RSS feeds by keyword..."
                    value={filterText}
                    onChange={(e) => setFilterText(e.target.value)}
                    className="h-9 pl-9 border"
                  />
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-4">
              {isLoading ? (
                <div className="flex justify-center py-20">
                  <RefreshCw className="size-8 animate-spin text-primary" />
                </div>
              ) : !rssFeeds ? (
                <div className="text-center py-20 text-xs text-muted-foreground">
                  No RSS records parsed.
                </div>
              ) : (
                <div className="grid gap-4 md:grid-cols-2">
                  {/* Politics RSS */}
                  <Card className="bg-card/40 border">
                    <CardHeader className="p-3 border-b">
                      <CardTitle className="text-xs font-bold uppercase tracking-wider text-primary">
                        Politics & Global
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="p-3 space-y-2.5 max-h-[350px] overflow-y-auto">
                      {getFilteredRss("politics").length === 0 ? (
                        <div className="text-xs text-muted-foreground text-center py-4">
                          {rssEmptyReason(rssFeeds, "politics", !!filterText.trim())}
                        </div>
                      ) : (
                        getFilteredRss("politics").map((item: any, idx: number) => (
                          <div key={idx} className="text-xs border-b pb-1.5 space-y-1">
                            <a
                              href={item.link}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="hover:underline hover:text-primary font-medium block"
                            >
                              {item.title}
                            </a>
                            <div className="flex items-center justify-between text-[9px] text-muted-foreground">
                              <span>{item.source}</span>
                              <span>{formatFeedDate(item.pubDate)}</span>
                            </div>
                          </div>
                        ))
                      )}
                    </CardContent>
                  </Card>

                  {/* Cyber RSS */}
                  <Card className="bg-card/40 border">
                    <CardHeader className="p-3 border-b">
                      <CardTitle className="text-xs font-bold uppercase tracking-wider text-primary">
                        Cyber Advisories & Intel
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="p-3 space-y-2.5 max-h-[350px] overflow-y-auto">
                      {getFilteredRss("cyber").length === 0 ? (
                        <div className="text-xs text-muted-foreground text-center py-4">
                          {rssEmptyReason(rssFeeds, "cyber", !!filterText.trim())}
                        </div>
                      ) : (
                        getFilteredRss("cyber").map((item: any, idx: number) => (
                          <div key={idx} className="text-xs border-b pb-1.5 space-y-1">
                            <a
                              href={item.link}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="hover:underline hover:text-primary font-medium block"
                            >
                              {item.title}
                            </a>
                            <div className="flex items-center justify-between text-[9px] text-muted-foreground">
                              <span>{item.source}</span>
                              <span>{formatFeedDate(item.pubDate)}</span>
                            </div>
                          </div>
                        ))
                      )}
                    </CardContent>
                  </Card>

                  {/* Military RSS */}
                  <Card className="bg-card/40 border">
                    <CardHeader className="p-3 border-b">
                      <CardTitle className="text-xs font-bold uppercase tracking-wider text-primary">
                        Military & Defense
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="p-3 space-y-2.5 max-h-[350px] overflow-y-auto">
                      {getFilteredRss("military").length === 0 ? (
                        <div className="text-xs text-muted-foreground text-center py-4">
                          {rssEmptyReason(rssFeeds, "military", !!filterText.trim())}
                        </div>
                      ) : (
                        getFilteredRss("military").map((item: any, idx: number) => (
                          <div key={idx} className="text-xs border-b pb-1.5 space-y-1">
                            <a
                              href={item.link}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="hover:underline hover:text-primary font-medium block"
                            >
                              {item.title}
                            </a>
                            <div className="flex items-center justify-between text-[9px] text-muted-foreground">
                              <span>{item.source}</span>
                              <span>{formatFeedDate(item.pubDate)}</span>
                            </div>
                          </div>
                        ))
                      )}
                    </CardContent>
                  </Card>

                  {/* Finance RSS */}
                  <Card className="bg-card/40 border">
                    <CardHeader className="p-3 border-b">
                      <CardTitle className="text-xs font-bold uppercase tracking-wider text-primary">
                        Markets & Finance
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="p-3 space-y-2.5 max-h-[350px] overflow-y-auto">
                      {getFilteredRss("finance").length === 0 ? (
                        <div className="text-xs text-muted-foreground text-center py-4">
                          {rssEmptyReason(rssFeeds, "finance", !!filterText.trim())}
                        </div>
                      ) : (
                        getFilteredRss("finance").map((item: any, idx: number) => (
                          <div key={idx} className="text-xs border-b pb-1.5 space-y-1">
                            <a
                              href={item.link}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="hover:underline hover:text-primary font-medium block"
                            >
                              {item.title}
                            </a>
                            <div className="flex items-center justify-between text-[9px] text-muted-foreground">
                              <span>{item.source}</span>
                              <span>{formatFeedDate(item.pubDate)}</span>
                            </div>
                          </div>
                        ))
                      )}
                    </CardContent>
                  </Card>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tab content 6: GPS Interference */}
        <TabsContent value="gpsjam" className="space-y-4">
          <Card className="bg-[#111827] border-[#263548] p-4 text-xs font-mono text-[#F3F4F6]">
            <CardHeader className="p-0 pb-3 border-b border-[#263548] mb-3 flex flex-row items-center justify-between">
              <div>
                <CardTitle className="text-sm font-bold text-[#F3F4F6] flex items-center gap-2">
                  <Radio className="size-4 text-[#06B6D4]" /> GPS Interference & ADS-B Jamming Feed
                </CardTitle>
                <CardDescription className="text-[10px] text-[#94A3B8]">
                  Real-time hex map statistics from ADS-B Exchange reporting aircraft navigation
                  disruption.
                </CardDescription>
              </div>
              {gpsJamData && (
                <Badge className="bg-[#06B6D4]/10 text-[#06B6D4] border-[#06B6D4]/30 text-[9px] uppercase">
                  {gpsJamData.stats.totalHexes} Hexes Measured
                </Badge>
              )}
            </CardHeader>
            <CardContent className="p-0 space-y-4">
              {gpsJamData ? (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div className="bg-[#0B1220] border border-[#263548] p-3 rounded">
                    <span className="text-[#94A3B8] text-[10px] block">High Severity Hexes</span>
                    <span className="text-lg font-bold text-[#EF4444]">
                      {gpsJamData.stats.highCount}
                    </span>
                  </div>
                  <div className="bg-[#0B1220] border border-[#263548] p-3 rounded">
                    <span className="text-[#94A3B8] text-[10px] block">Medium Severity Hexes</span>
                    <span className="text-lg font-bold text-[#F59E0B]">
                      {gpsJamData.stats.mediumCount}
                    </span>
                  </div>
                  <div className="bg-[#0B1220] border border-[#263548] p-3 rounded">
                    <span className="text-[#94A3B8] text-[10px] block">Primary Source</span>
                    <span className="text-xs font-semibold text-[#F3F4F6] truncate block">
                      {gpsJamData.source}
                    </span>
                  </div>
                </div>
              ) : (
                <CollectorAbsence
                  error={gpsJamError}
                  loading={isLoading}
                  emptyLabel="GPSJam answered, but reported no cells with observed interference."
                />
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tab content 7: Radiation Sensors */}
        <TabsContent value="radiation" className="space-y-4">
          <Card className="bg-[#111827] border-[#263548] p-4 text-xs font-mono text-[#F3F4F6]">
            <CardHeader className="p-0 pb-3 border-b border-[#263548] mb-3 flex flex-row items-center justify-between">
              <div>
                <CardTitle className="text-sm font-bold text-[#F3F4F6] flex items-center gap-2">
                  <Activity className="size-4 text-[#10B981]" /> Environmental Radiation Sensor
                  Network
                </CardTitle>
                <CardDescription className="text-[10px] text-[#94A3B8]">
                  Open radiation sensor measurements (Safecast/EURDEP) in microSieverts per hour
                  (µSv/h).
                </CardDescription>
              </div>
              {radiationData && (
                <Badge className="bg-[#10B981]/10 text-[#10B981] border-[#10B981]/30 text-[9px] uppercase">
                  {radiationData.totalStations} Active Stations
                </Badge>
              )}
            </CardHeader>
            <CardContent className="p-0 space-y-4">
              {radiationData ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="bg-[#0B1220] border border-[#263548] p-3 rounded">
                    <span className="text-[#94A3B8] text-[10px] block">
                      Elevated / High Stations
                    </span>
                    <span className="text-lg font-bold text-[#F59E0B]">
                      {radiationData.elevatedCount}
                    </span>
                  </div>
                  <div className="bg-[#0B1220] border border-[#263548] p-3 rounded">
                    <span className="text-[#94A3B8] text-[10px] block">Normal Baseline Range</span>
                    <span className="text-xs font-semibold text-[#10B981] block">
                      0.05 – 0.20 µSv/h
                    </span>
                  </div>
                </div>
              ) : (
                <CollectorAbsence
                  error={radiationError}
                  loading={isLoading}
                  emptyLabel="Safecast answered, but returned no usable station readings."
                />
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </AppShell>
  );
}
