/**
 * Recovering the real publisher from a Google News RSS feed.
 *
 * WHY THIS EXISTS. Module 1's flagship factor is `domain_tier`: it rates the
 * publisher of an article. It reads the domain out of `article.url`. But when
 * /sources loads a corpus it calls `fetchNews` with a query, which routes to the
 * Google News *search* feed, and every `<link>` in that feed is a
 * `news.google.com/rss/articles/CBMi...` redirect.
 *
 * So `domainOf(article.url)` returned `news.google.com` for EVERY article. The
 * audit observed the same evidence string repeated verbatim 35 times —
 * "news.google.com Low credibility (0.38)" — with Securelist, 9to5Google and
 * Reuters all rated identically. The most complete module in the system was
 * rating the aggregator, over and over, instead of the publisher.
 *
 * The feed does carry the real publisher, in an element rss-parser discards:
 *
 *     <source url="https://www.reuters.com">Reuters</source>
 *
 * rss-parser drops the `url` attribute (a `customFields` mapping yields only the
 * text, and overriding its xml2js options breaks feed detection outright), so
 * these functions read it out of the raw XML instead. `fetchNews` already has
 * the text — it fetches, then hands the same string to `parser.parseString`.
 *
 * Pairing is BY INDEX against `feed.items`, which rss-parser emits in document
 * order. `publisherUrlsFromRss` therefore returns one entry per `<item>`
 * including nulls, so the caller's indices stay aligned; dropping the misses
 * would silently shift every publisher onto the wrong article.
 */

/** One `<item>` block's raw inner XML, in document order. */
export function rssItemBlocks(xml: string): string[] {
  if (!xml) return [];
  const blocks: string[] = [];
  const re = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) blocks.push(m[1]);
  return blocks;
}

/**
 * The publisher URL each item declares, or null where it declares none.
 *
 * Length always equals the number of `<item>` elements, so the result indexes
 * 1:1 against `feed.items`.
 */
export function publisherUrlsFromRss(xml: string): (string | null)[] {
  return rssItemBlocks(xml).map((block) => {
    const m = /<source\b[^>]*\burl\s*=\s*["']([^"']+)["']/i.exec(block);
    if (!m) return null;
    const url = decodeXmlEntities(m[1].trim());
    return url || null;
  });
}

/** `&amp;` and friends, which appear in feed URLs. */
function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * True when a URL points at the aggregator rather than a publisher.
 *
 * Used to decide whether a link can stand in for the publisher at all. A
 * `news.google.com` link identifies the aggregator and nothing else.
 */
export function isAggregatorUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return /(^|\/\/|\.)news\.google\.com([/:?]|$)/i.test(url);
}

/**
 * The best available publisher URL for one item.
 *
 * Order of preference:
 *   1. The `<source url>` the feed declared.
 *   2. The item's own link, but ONLY when it is not an aggregator redirect —
 *      the non-search feeds (BBC, Krebs, CISA) link straight to the publisher.
 *   3. null. Never the Google redirect, because Module 1 would then score the
 *      aggregator and report it as the publisher's rating.
 */
export function resolvePublisherUrl(
  declaredSourceUrl: string | null | undefined,
  itemLink: string | null | undefined,
): string | null {
  if (declaredSourceUrl && !isAggregatorUrl(declaredSourceUrl)) return declaredSourceUrl;
  if (itemLink && !isAggregatorUrl(itemLink)) return itemLink;
  return null;
}
