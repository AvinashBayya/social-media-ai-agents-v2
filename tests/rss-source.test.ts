import { describe, expect, test } from "bun:test";
import {
  isAggregatorUrl,
  publisherUrlsFromRss,
  resolvePublisherUrl,
  rssItemBlocks,
} from "../src/utils/rss-source";

/**
 * These guard the fix for the single most consequential functional defect the
 * browser audit found: Module 1 rating `news.google.com` for every article in a
 * queried corpus, because every `<link>` in the Google News search feed is a
 * redirect through the aggregator.
 *
 * The load-bearing property is INDEX ALIGNMENT. The publisher list is paired
 * positionally against `feed.items`, so an item that declares no `<source>` must
 * still occupy its slot — dropping it would shift every later publisher onto the
 * wrong article, which is worse than the bug being fixed.
 */

// Shaped exactly like the live feed, verified against
// news.google.com/rss/search on 2026-08-12.
const GOOGLE_NEWS_XML = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>reuters - Google News</title>
  <item>
    <title>Putin Pardons Former U.S. Marine - The Moscow Times</title>
    <link>https://news.google.com/rss/articles/CBMirAFBVV95cUxNck04a25Na0h</link>
    <source url="https://www.themoscowtimes.com">The Moscow Times</source>
  </item>
  <item>
    <title>An item whose publisher the feed did not declare</title>
    <link>https://news.google.com/rss/articles/CBMiZZZ</link>
  </item>
  <item>
    <title>Markets update - Yahoo Finance</title>
    <link>https://news.google.com/rss/articles/CBMiQQQ</link>
    <source url="https://finance.yahoo.com">Yahoo Finance</source>
  </item>
</channel></rss>`;

// A direct publisher feed, which links straight to the article.
const DIRECT_FEED_XML = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item>
    <title>Krebs on a breach</title>
    <link>https://krebsonsecurity.com/2026/08/a-breach/</link>
  </item>
</channel></rss>`;

describe("rssItemBlocks", () => {
  test("returns one block per item, in document order", () => {
    const blocks = rssItemBlocks(GOOGLE_NEWS_XML);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toContain("Moscow Times");
    expect(blocks[2]).toContain("Yahoo Finance");
  });

  test("empty or malformed input yields no blocks rather than throwing", () => {
    expect(rssItemBlocks("")).toEqual([]);
    expect(rssItemBlocks("<rss><channel></channel></rss>")).toEqual([]);
  });
});

describe("publisherUrlsFromRss", () => {
  test("extracts the declared publisher URL for each item", () => {
    expect(publisherUrlsFromRss(GOOGLE_NEWS_XML)).toEqual([
      "https://www.themoscowtimes.com",
      null,
      "https://finance.yahoo.com",
    ]);
  });

  test("KEEPS THE SLOT for an item with no <source>, so indices stay aligned", () => {
    // If the middle null were dropped, Yahoo Finance would be attributed to the
    // second article — a publisher silently moved onto someone else's story,
    // which then feeds Module 1's rating of it.
    const urls = publisherUrlsFromRss(GOOGLE_NEWS_XML);
    expect(urls).toHaveLength(rssItemBlocks(GOOGLE_NEWS_XML).length);
    expect(urls[1]).toBeNull();
  });

  test("decodes XML entities in the URL", () => {
    const xml = `<rss><channel><item>
      <source url="https://example.com/feed?a=1&amp;b=2">Example</source>
    </item></channel></rss>`;
    expect(publisherUrlsFromRss(xml)).toEqual(["https://example.com/feed?a=1&b=2"]);
  });

  test("single quotes and extra attributes are handled", () => {
    const xml = `<rss><channel><item>
      <source foo="bar" url='https://example.org'>Example</source>
    </item></channel></rss>`;
    expect(publisherUrlsFromRss(xml)).toEqual(["https://example.org"]);
  });
});

describe("isAggregatorUrl", () => {
  test("recognises Google News links in the forms the feed emits", () => {
    expect(isAggregatorUrl("https://news.google.com/rss/articles/CBMiXXX")).toBe(true);
    expect(isAggregatorUrl("https://news.google.com/")).toBe(true);
    expect(isAggregatorUrl("http://news.google.com")).toBe(true);
  });

  test("does not match real publishers", () => {
    expect(isAggregatorUrl("https://www.reuters.com/world/article")).toBe(false);
    expect(isAggregatorUrl("https://krebsonsecurity.com/feed/")).toBe(false);
    // Guard against a naive substring test matching an unrelated host.
    expect(isAggregatorUrl("https://mynews.google.company.example.com/x")).toBe(false);
  });

  test("null and empty are not aggregator URLs", () => {
    expect(isAggregatorUrl(null)).toBe(false);
    expect(isAggregatorUrl(undefined)).toBe(false);
    expect(isAggregatorUrl("")).toBe(false);
  });
});

describe("resolvePublisherUrl", () => {
  test("prefers the declared source URL", () => {
    expect(
      resolvePublisherUrl("https://www.reuters.com", "https://news.google.com/rss/articles/X"),
    ).toBe("https://www.reuters.com");
  });

  test("falls back to the item link on a direct publisher feed", () => {
    const [declared] = publisherUrlsFromRss(DIRECT_FEED_XML);
    expect(resolvePublisherUrl(declared, "https://krebsonsecurity.com/2026/08/a-breach/")).toBe(
      "https://krebsonsecurity.com/2026/08/a-breach/",
    );
  });

  test("NEVER returns the aggregator — that is the whole bug", () => {
    // With no declared source and only a redirect link, the honest answer is
    // "no publisher identified". Returning the link would put news.google.com
    // back into Module 1 as though it were the publisher.
    expect(resolvePublisherUrl(null, "https://news.google.com/rss/articles/CBMiZZZ")).toBeNull();
    expect(
      resolvePublisherUrl("https://news.google.com/x", "https://news.google.com/y"),
    ).toBeNull();
  });

  test("nothing supplied yields null", () => {
    expect(resolvePublisherUrl(null, null)).toBeNull();
    expect(resolvePublisherUrl(undefined, undefined)).toBeNull();
  });
});
