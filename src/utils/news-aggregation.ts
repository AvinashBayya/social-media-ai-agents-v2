/**
 * Server-side RSS aggregation feeding the Timeline component (adopting
 * sosint's Module 01 in spirit — pattern only, no code, no license to carry
 * over). Deliberately separate from news.tsx's `fetchNews`: that pipeline is
 * query-driven and scores category/threat/propaganda for the News page's own
 * UI. This is a plain, configurable multi-feed reader with a structured
 * per-feed status envelope, fetched server-side with no CORS proxy (no
 * allorigins) — matching this project's existing server-side RSS precedent
 * (`fetchNews`, `dorks.ts`, `live.tsx`, `osint.tsx`).
 *
 * Gated behind GIS_V2_ENABLED — see geo-sources.ts's `gisV2Enabled()`, the
 * single flag covering this whole GIS-v2 initiative (map layer, RSS
 * aggregation, Timeline).
 */

import { createServerFn } from "@tanstack/react-start";
import { gisV2Enabled } from "./geo-sources";

export type FeedFetchStatus = "ok" | "error" | "timeout" | "skipped";

export interface NewsFeedConfig {
  id: string;
  name: string;
  url: string;
  /** Defaults to true. Set false to keep a feed defined but not fetched. */
  enabled?: boolean;
}

export interface NewsItem {
  title: string;
  link: string;
  source: string;
  publishedAt: string | null;
  summary: string | null;
}

export interface FeedFetchResult {
  feedId: string;
  feedName: string;
  status: FeedFetchStatus;
  items: NewsItem[];
  error: string | null;
  fetchedAt: string;
}

export interface NewsAggregationResult {
  feeds: FeedFetchResult[];
  items: NewsItem[];
  collectedAt: string;
  /** Non-null only when the whole aggregation could not run at all. */
  error: string | null;
}

const FEED_TIMEOUT_MS = 15_000;

/**
 * Verified live, individually, this session (curl / WebSearch / a real
 * Playwright browser, per source): Reuters has no working public feed any
 * more (feeds.reuters.com does not resolve), AP's two plausible URLs both
 * redirect to plain homepage HTML with no RSS, and MEA India's
 * rss-feeds.htm renders zero discoverable feed links even JS-rendered. None
 * of the three is substituted with an unofficial third-party RSS-generator
 * proxy — they are simply absent from this list rather than silently faked.
 */
export const DEFAULT_NEWS_FEEDS: NewsFeedConfig[] = [
  { id: "bbc-world", name: "BBC World News", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { id: "aljazeera", name: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml" },
  {
    id: "pib-india",
    name: "PIB India",
    url: "https://pib.gov.in/RssMain.aspx?ModId=6&Lang=1&Regid=3",
  },
  { id: "defense-one", name: "Defense One", url: "https://www.defenseone.com/rss/all/" },
  { id: "usni-news", name: "USNI News", url: "https://news.usni.org/feed" },
  { id: "breaking-defense", name: "Breaking Defense", url: "https://breakingdefense.com/feed/" },
];

/**
 * Feed list is config, never code — the same discipline `leaflet-client.ts`'s
 * `resolveTileProvider()` uses for the tile URL. `NEWS_RSS_FEEDS`, when set,
 * must be a JSON array of `{id, name, url}`; a malformed value throws rather
 * than silently falling back, so a typo'd env var is visible immediately
 * instead of quietly serving the default list under a different name.
 */
export function resolveNewsFeeds(): NewsFeedConfig[] {
  const raw = process.env.NEWS_RSS_FEEDS;
  if (!raw || !raw.trim()) return DEFAULT_NEWS_FEEDS;
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("NEWS_RSS_FEEDS must be a JSON array of {id, name, url}");
  }
  return parsed.map((f: any, i: number) => {
    if (!f?.url || typeof f.url !== "string") {
      throw new Error(`NEWS_RSS_FEEDS[${i}] is missing a url`);
    }
    return {
      id: String(f.id ?? f.url),
      name: String(f.name ?? f.url),
      url: f.url,
      enabled: f.enabled !== false,
    };
  });
}

/**
 * Strips common tracking params and a trailing slash so the same story
 * linked with different query strings dedupes to one entry.
 */
export function normalizeNewsUrl(url: string): string {
  try {
    const u = new URL(url);
    const dropParams = [...u.searchParams.keys()].filter((k) =>
      /^(utm_|ref$|ref_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(k),
    );
    dropParams.forEach((k) => u.searchParams.delete(k));
    u.hash = "";
    let s = u.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

async function fetchOneFeed(feed: NewsFeedConfig): Promise<FeedFetchResult> {
  const fetchedAt = new Date().toISOString();
  if (feed.enabled === false) {
    return { feedId: feed.id, feedName: feed.name, status: "skipped", items: [], error: null, fetchedAt };
  }

  try {
    const res = await fetch(feed.url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; SentinelAI/1.0)" },
      signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
    });
    if (!res.ok) {
      return {
        feedId: feed.id,
        feedName: feed.name,
        status: "error",
        items: [],
        error: `HTTP ${res.status}`,
        fetchedAt,
      };
    }
    const xml = await res.text();
    const Parser = (await import("rss-parser")).default;
    const parser = new Parser();
    const parsed = await parser.parseString(xml);
    const items: NewsItem[] = (parsed.items ?? [])
      .filter((it) => it.title && it.link)
      .map((it) => ({
        title: String(it.title),
        link: String(it.link),
        source: feed.name,
        publishedAt: it.isoDate ?? (it.pubDate ? isoOrNull(it.pubDate) : null),
        summary: it.contentSnippet ? String(it.contentSnippet).trim() : null,
      }));
    return { feedId: feed.id, feedName: feed.name, status: "ok", items, error: null, fetchedAt };
  } catch (err: any) {
    const isTimeout = err?.name === "TimeoutError" || err?.name === "AbortError";
    return {
      feedId: feed.id,
      feedName: feed.name,
      status: isTimeout ? "timeout" : "error",
      items: [],
      error: isTimeout ? `timed out after ${FEED_TIMEOUT_MS}ms` : (err?.message ?? String(err)),
      fetchedAt,
    };
  }
}

function isoOrNull(v: string): string | null {
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/**
 * Fetches every configured, enabled feed in parallel — one feed's failure
 * never drops another's items — then dedupes by normalized URL (keeping the
 * first-seen item for a given URL) and sorts newest-first. Undated items
 * sort after every dated one rather than at "now": `geo.ts`'s `iso()`
 * comment states the same rule — null means not measured, never a
 * fabricated instant.
 */
export async function collectNewsAggregation(
  feeds: NewsFeedConfig[] = resolveNewsFeeds(),
): Promise<NewsAggregationResult> {
  if (!gisV2Enabled()) {
    return {
      feeds: [],
      items: [],
      collectedAt: new Date().toISOString(),
      error: "News/RSS aggregation is disabled. Set GIS_V2_ENABLED=true to enable it.",
    };
  }

  const results = await Promise.all(feeds.map(fetchOneFeed));

  const seen = new Set<string>();
  const items: NewsItem[] = [];
  for (const r of results) {
    for (const item of r.items) {
      const key = normalizeNewsUrl(item.link);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  }
  items.sort((a, b) => {
    if (a.publishedAt && b.publishedAt) return b.publishedAt.localeCompare(a.publishedAt);
    if (a.publishedAt) return -1;
    if (b.publishedAt) return 1;
    return 0;
  });

  return { feeds: results, items, collectedAt: new Date().toISOString(), error: null };
}

export const fetchNewsAggregation = createServerFn({ method: "GET" }).handler(async () =>
  collectNewsAggregation(),
);
