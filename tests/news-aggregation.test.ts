import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  collectNewsAggregation,
  DEFAULT_NEWS_FEEDS,
  normalizeNewsUrl,
  resolveNewsFeeds,
  type NewsFeedConfig,
} from "../src/utils/news-aggregation";

const originalFetch = globalThis.fetch;
const originalFlag = process.env.GIS_V2_ENABLED;
const originalFeeds = process.env.NEWS_RSS_FEEDS;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalFlag === undefined) delete process.env.GIS_V2_ENABLED;
  else process.env.GIS_V2_ENABLED = originalFlag;
  if (originalFeeds === undefined) delete process.env.NEWS_RSS_FEEDS;
  else process.env.NEWS_RSS_FEEDS = originalFeeds;
});

beforeEach(() => {
  process.env.GIS_V2_ENABLED = "true";
  delete process.env.NEWS_RSS_FEEDS;
});

function rss(items: { title: string; link: string; pubDate?: string; description?: string }[]) {
  const body = items
    .map(
      (it) =>
        `<item><title>${it.title}</title><link>${it.link}</link>` +
        (it.pubDate ? `<pubDate>${it.pubDate}</pubDate>` : "") +
        (it.description ? `<description>${it.description}</description>` : "") +
        `</item>`,
    )
    .join("");
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Test</title>${body}</channel></rss>`;
}

function stubFetchByUrl(handler: (url: string) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    return handler(url);
  }) as typeof fetch;
}

describe("resolveNewsFeeds", () => {
  test("returns the verified default seed list when NEWS_RSS_FEEDS is unset", () => {
    expect(resolveNewsFeeds()).toEqual(DEFAULT_NEWS_FEEDS);
  });

  test("parses a valid NEWS_RSS_FEEDS override", () => {
    process.env.NEWS_RSS_FEEDS = JSON.stringify([
      { id: "x", name: "X News", url: "https://x.example/rss" },
    ]);
    const feeds = resolveNewsFeeds();
    expect(feeds).toHaveLength(1);
    expect(feeds[0]).toMatchObject({ id: "x", name: "X News", url: "https://x.example/rss" });
  });

  test("throws on a non-array NEWS_RSS_FEEDS rather than silently falling back", () => {
    process.env.NEWS_RSS_FEEDS = JSON.stringify({ not: "an array" });
    expect(() => resolveNewsFeeds()).toThrow();
  });

  test("throws when an entry is missing a url", () => {
    process.env.NEWS_RSS_FEEDS = JSON.stringify([{ id: "x", name: "X" }]);
    expect(() => resolveNewsFeeds()).toThrow();
  });
});

describe("normalizeNewsUrl", () => {
  test("strips tracking params and a trailing slash", () => {
    expect(normalizeNewsUrl("https://example.com/story/?utm_source=rss&utm_medium=feed")).toBe(
      "https://example.com/story",
    );
  });

  test("two links differing only by tracking params normalize to the same key", () => {
    const a = normalizeNewsUrl("https://example.com/story?utm_source=rss");
    const b = normalizeNewsUrl("https://example.com/story?utm_source=twitter");
    expect(a).toBe(b);
  });

  test("an unparseable string does not throw", () => {
    expect(() => normalizeNewsUrl("not a url")).not.toThrow();
  });
});

describe("collectNewsAggregation", () => {
  test("reports disabled and makes no network call when GIS_V2_ENABLED is not set", async () => {
    delete process.env.GIS_V2_ENABLED;
    let called = false;
    stubFetchByUrl(() => {
      called = true;
      return new Response("", { status: 200 });
    });
    const result = await collectNewsAggregation(DEFAULT_NEWS_FEEDS);
    expect(result.error).toMatch(/disabled/i);
    expect(result.items).toEqual([]);
    expect(called).toBe(false);
  });

  test("merges items from multiple feeds, sorted newest-first", async () => {
    const feeds: NewsFeedConfig[] = [
      { id: "a", name: "Feed A", url: "https://feed-a.example/rss" },
      { id: "b", name: "Feed B", url: "https://feed-b.example/rss" },
    ];
    stubFetchByUrl((url) => {
      if (url.includes("feed-a")) {
        return new Response(
          rss([{ title: "Older story", link: "https://a.example/1", pubDate: "Wed, 01 Jan 2025 00:00:00 GMT" }]),
        );
      }
      return new Response(
        rss([{ title: "Newer story", link: "https://b.example/1", pubDate: "Thu, 01 Jan 2026 00:00:00 GMT" }]),
      );
    });
    const result = await collectNewsAggregation(feeds);
    expect(result.error).toBeNull();
    expect(result.feeds.every((f) => f.status === "ok")).toBe(true);
    expect(result.items.map((i) => i.title)).toEqual(["Newer story", "Older story"]);
  });

  test("dedupes the same story linked with different tracking params, keeping first-seen", async () => {
    const feeds: NewsFeedConfig[] = [
      { id: "a", name: "Feed A", url: "https://feed-a.example/rss" },
      { id: "b", name: "Feed B", url: "https://feed-b.example/rss" },
    ];
    stubFetchByUrl((url) => {
      const link = url.includes("feed-a")
        ? "https://example.com/story?utm_source=rss"
        : "https://example.com/story?utm_source=twitter";
      return new Response(rss([{ title: "Same story", link }]));
    });
    const result = await collectNewsAggregation(feeds);
    expect(result.items).toHaveLength(1);
  });

  test("one feed's HTTP failure does not drop another feed's items", async () => {
    const feeds: NewsFeedConfig[] = [
      { id: "a", name: "Feed A", url: "https://feed-a.example/rss" },
      { id: "b", name: "Feed B", url: "https://feed-b.example/rss" },
    ];
    stubFetchByUrl((url) => {
      if (url.includes("feed-a")) return new Response("server error", { status: 500 });
      return new Response(rss([{ title: "Still here", link: "https://b.example/1" }]));
    });
    const result = await collectNewsAggregation(feeds);
    const failed = result.feeds.find((f) => f.feedId === "a");
    expect(failed?.status).toBe("error");
    expect(failed?.error).toMatch(/500/);
    expect(result.items.map((i) => i.title)).toEqual(["Still here"]);
  });

  test("a feed marked enabled:false is skipped, not fetched", async () => {
    const feeds: NewsFeedConfig[] = [
      { id: "a", name: "Feed A", url: "https://feed-a.example/rss", enabled: false },
    ];
    let called = false;
    stubFetchByUrl(() => {
      called = true;
      return new Response(rss([]));
    });
    const result = await collectNewsAggregation(feeds);
    expect(result.feeds[0]!.status).toBe("skipped");
    expect(called).toBe(false);
  });

  test("an item with no parseable publish date sorts after dated items, never invented as now", async () => {
    const feeds: NewsFeedConfig[] = [{ id: "a", name: "Feed A", url: "https://feed-a.example/rss" }];
    stubFetchByUrl(() =>
      new Response(
        rss([
          { title: "Undated", link: "https://a.example/undated" },
          { title: "Dated", link: "https://a.example/dated", pubDate: "Thu, 01 Jan 2026 00:00:00 GMT" },
        ]),
      ),
    );
    const result = await collectNewsAggregation(feeds);
    expect(result.items.map((i) => i.title)).toEqual(["Dated", "Undated"]);
    expect(result.items.find((i) => i.title === "Undated")?.publishedAt).toBeNull();
  });
});
