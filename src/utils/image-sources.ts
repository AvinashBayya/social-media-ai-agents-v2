/**
 * Real image-list sources for a free-text target query, used by /images'
 * "Related Images — News & Open Source" panel.
 *
 * Split out of geo-sources.ts (which stays GIS-only, per its own header) once
 * a second non-geo source was added here — two unrelated concerns sharing one
 * file's docblock claim was worse than the churn of moving the first one.
 * Both functions below were added the same day and have exactly one
 * consumer (images.tsx), so relocating them carries no risk to anything else.
 */

import { createServerFn } from "@tanstack/react-start";

const TIMEOUT_MS = 12_000;
/** GDELT is consistently slower than most sources and times out at 25s. */
const GDELT_TIMEOUT_MS = 25_000;
/**
 * Plain fetch() applies undici's own internal TCP-connect timeout
 * (`ConnectTimeoutError`, defaulting to 10s) *underneath* the request-level
 * AbortSignal above — a separate ceiling AbortSignal.timeout does not touch,
 * and a plain `{ connectTimeout }` property on the fetch init object is
 * silently ignored (verified live 2026-08-19: identical failures with and
 * without it). api.gdeltproject.org's own TCP handshake from this
 * environment routinely takes 13-20s, past that 10s default, so requests
 * were being cut off mid-connect regardless of the 25s overall budget. The
 * only mechanism that actually works, confirmed live via a real before/after
 * comparison against this same host: an explicit `undici` `Agent` with a
 * raised `connect.timeout`, passed as `dispatcher`.
 *
 * `undici` is loaded via a runtime `await import(...)` inside
 * gdeltDispatcher(), NEVER a top-level `import` — a static import pulled
 * `undici` (a Node-only package; its `Agent` touches Node's `net`/`tls`
 * internals) into the CLIENT bundle too, since this module is reachable
 * from images.tsx, and crashed the entire app in the browser with
 * "Cannot read properties of undefined (reading 'node')" the moment any
 * route loaded — verified live, then reverted immediately. A dynamic import
 * inside a function body that only ever runs server-side (this is the
 * handler behind a createServerFn) keeps `undici` out of the client graph
 * entirely, the same pattern already used by collectGpsJamming's
 * `await import("./gps-interference")` in geo-sources.ts.
 */
const GDELT_CONNECT_TIMEOUT_MS = 20_000;
let gdeltDispatcherPromise: Promise<any> | null = null;
async function gdeltDispatcher(): Promise<any> {
  if (!gdeltDispatcherPromise) {
    gdeltDispatcherPromise = import("undici").then(
      ({ Agent }) => new Agent({ connect: { timeout: GDELT_CONNECT_TIMEOUT_MS } }),
    );
  }
  return gdeltDispatcherPromise;
}

/**
 * Wikimedia's own API etiquette policy (meta.wikimedia.org/wiki/User-Agent_policy)
 * requires a descriptive User-Agent identifying the tool and how to reach its
 * operator; requests without one are explicitly called out as more likely to
 * be rate-limited or blocked outright, with no warning first. A real 429 from
 * en.wikipedia.org was hit live 2026-08-20 with no UA sent at all — this is
 * the documented fix, applied to every source in this file (not just
 * Wikipedia) since identifying the caller to a third-party API is the same
 * good practice regardless of which one happens to enforce it.
 */
const CLIENT_UA = "SentinelAI/1.0 (OSINT research tool; contact via project repository)";

async function getJson(url: string, timeoutMs = TIMEOUT_MS, dispatcher?: any): Promise<any> {
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": CLIENT_UA },
    signal: AbortSignal.timeout(timeoutMs),
    ...(dispatcher ? { dispatcher } : {}),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await describeErrorBody(res)}`);
  }
  return res.json();
}

/**
 * A rate-limited/blocked request from Wikimedia (and some other upstreams)
 * returns a full HTML error page, not JSON — surfacing that verbatim dumped
 * raw `<!DOCTYPE html>...` markup into the analyst-facing error message
 * (observed live). Strip it to plain text so a failure reads as a failure,
 * not as broken markup soup.
 */
async function describeErrorBody(res: Response): Promise<string> {
  const raw = await res.text().catch(() => "");
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("html")) return raw.slice(0, 200);

  const text = raw
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (text || res.statusText || "no error detail returned").slice(0, 200);
}

/** A bare "fetch failed" hides the real cause in .cause — surface it. */
function describeFetchError(err: any): string {
  const cause = err?.cause?.message ?? err?.cause?.code ?? null;
  return (err?.message ?? String(err)) + (cause ? ` (cause: ${cause})` : "");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface NewsImageResult {
  url: string;
  title: string;
  domain: string;
  articleUrl: string;
  publishedAt: string | null;
}

async function fetchGdeltArticles(query: string): Promise<any[]> {
  const data = await getJson(
    `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=artlist&format=json&maxrecords=50&timespan=7d`,
    GDELT_TIMEOUT_MS,
    await gdeltDispatcher(),
  );
  return data?.articles ?? [];
}

/**
 * Real article thumbnails for a text query, sourced from GDELT DOC's own
 * `socialimage` field — the og:image GDELT extracted at crawl time, when it
 * found one. Coverage is partial by nature (GDELT does not detect a social
 * image for every article), so an article without one is simply skipped
 * here, never given a placeholder.
 *
 * Deliberately NOT sourced from Google News RSS (what /news's fetchNews
 * uses): verified live 2026-08-19 that every <item> in a Google News RSS
 * feed carries neither <enclosure> nor <media:thumbnail>, despite the feed
 * declaring the media RSS namespace at the channel level — there is no
 * per-article image anywhere in that feed to read.
 *
 * GDELT is genuinely flaky from this environment — observed live, across
 * repeated runs on the same query: a clean 429 (its documented 1-req/5s
 * limit), a connect timeout, and a clean success, with no code change
 * between them. One retry after a 6s pause covers both cases the docs
 * already describe as transient ("wait and retry" for the 429) without
 * masking a real, still-failing source — the SECOND failure is what gets
 * surfaced, not a swallowed first attempt.
 */
export async function collectNewsImages(
  query: string,
): Promise<{ results: NewsImageResult[]; error: string | null }> {
  const q = query.trim();
  if (!q) return { results: [], error: null };

  let articles: any[];
  try {
    articles = await fetchGdeltArticles(q);
  } catch (firstErr: any) {
    await sleep(6000);
    try {
      articles = await fetchGdeltArticles(q);
    } catch (secondErr: any) {
      const message = describeFetchError(secondErr);
      return {
        results: [],
        error: message.includes("429")
          ? `GDELT rate limit: it accepts one request every 5 seconds. Wait and retry. (${message.slice(0, 160)})`
          : `GDELT unavailable after a retry: ${message}`,
      };
    }
  }

  const results: NewsImageResult[] = [];
  for (const a of articles) {
    const raw = typeof a?.socialimage === "string" ? a.socialimage.trim() : "";
    if (!raw) continue;
    try {
      const u = new URL(raw);
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    } catch {
      continue;
    }
    // GDELT's seendate is compact ISO: 20260727T144500Z.
    const rawDate = String(a?.seendate ?? "");
    const publishedAt = /^\d{8}T\d{6}Z$/.test(rawDate)
      ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}T${rawDate.slice(9, 11)}:${rawDate.slice(11, 13)}:${rawDate.slice(13, 15)}Z`
      : null;
    results.push({
      url: raw,
      title: String(a?.title ?? "Untitled report"),
      domain: String(a?.domain ?? "unknown"),
      articleUrl: String(a?.url ?? ""),
      publishedAt,
    });
  }
  return { results, error: null };
}

export const fetchNewsImages = createServerFn({ method: "GET" })
  .validator((d: { query: string }) => d)
  .handler(async ({ data }) => collectNewsImages(data.query));

export interface WikipediaImageResult {
  url: string;
  title: string;
  pageUrl: string;
}

/**
 * Real page thumbnails from Wikipedia's own search — keyless, no rate limit
 * observed (unlike GDELT), and a genuinely distinct "open source" corpus
 * from both GDELT (news) and YouTube (video). Verified live 2026-08-19 with
 * and without a custom User-Agent; both returned 200 with real
 * upload.wikimedia.org thumbnail URLs.
 *
 * Not every matched page has a thumbnail (disambiguation pages, stubs,
 * pages with no lead image) — those are skipped, never padded with a
 * placeholder, the same rule collectNewsImages follows above.
 */
export async function collectWikipediaImages(
  query: string,
): Promise<{ results: WikipediaImageResult[]; error: string | null }> {
  const q = query.trim();
  if (!q) return { results: [], error: null };
  try {
    const data = await getJson(
      `https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(q)}&gsrlimit=10&prop=pageimages&piprop=thumbnail&pithumbsize=300&format=json&formatversion=2`,
    );
    const pages: any[] = data?.query?.pages ?? [];
    const results: WikipediaImageResult[] = [];
    for (const p of pages) {
      const raw = typeof p?.thumbnail?.source === "string" ? p.thumbnail.source.trim() : "";
      if (!raw) continue;
      try {
        const u = new URL(raw);
        if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      } catch {
        continue;
      }
      const title = String(p?.title ?? "Untitled page");
      results.push({
        url: raw,
        title,
        pageUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
      });
    }
    return { results, error: null };
  } catch (err: any) {
    return { results: [], error: `Wikipedia unavailable: ${describeFetchError(err)}` };
  }
}

export const fetchWikipediaImages = createServerFn({ method: "GET" })
  .validator((d: { query: string }) => d)
  .handler(async ({ data }) => collectWikipediaImages(data.query));

export interface OpenverseImageResult {
  url: string;
  thumbnailUrl: string | null;
  title: string;
  creator: string | null;
  license: string | null;
  sourcePageUrl: string;
}

/**
 * Openverse (openverse.org, run by WordPress/Automattic) — a search engine
 * over openly-licensed and public-domain media (Flickr Commons, Wikimedia,
 * museum collections, etc.), not a hosting platform of its own. Keyless,
 * no rate limit observed across repeated live testing 2026-08-19 (unlike
 * GDELT), and a genuinely distinct corpus from GDELT (news), YouTube
 * (video) and Wikipedia (encyclopedia lead images) — this is the one
 * source here actually built for open-licence image search as its primary
 * purpose. Every result carries the real `license`/`creator`/attribution
 * Openverse itself reports, since redistributing an openly-licensed image
 * without its attribution would misrepresent what license actually covers
 * it — the analyst needs that to know what they can and cannot do with a
 * given result, not just that it exists.
 */
export async function collectOpenverseImages(
  query: string,
): Promise<{ results: OpenverseImageResult[]; error: string | null }> {
  const q = query.trim();
  if (!q) return { results: [], error: null };
  try {
    const data = await getJson(
      `https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&page_size=10`,
    );
    const items: any[] = data?.results ?? [];
    const results: OpenverseImageResult[] = [];
    for (const it of items) {
      const raw = typeof it?.url === "string" ? it.url.trim() : "";
      if (!raw) continue;
      try {
        const u = new URL(raw);
        if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      } catch {
        continue;
      }
      const thumbRaw = typeof it?.thumbnail === "string" ? it.thumbnail.trim() : "";
      results.push({
        url: raw,
        thumbnailUrl: thumbRaw || null,
        title: String(it?.title ?? "Untitled"),
        creator: it?.creator ? String(it.creator) : null,
        license: it?.license ? String(it.license).toUpperCase() : null,
        sourcePageUrl: String(it?.foreign_landing_url ?? raw),
      });
    }
    return { results, error: null };
  } catch (err: any) {
    return { results: [], error: `Openverse unavailable: ${describeFetchError(err)}` };
  }
}

export const fetchOpenverseImages = createServerFn({ method: "GET" })
  .validator((d: { query: string }) => d)
  .handler(async ({ data }) => collectOpenverseImages(data.query));
