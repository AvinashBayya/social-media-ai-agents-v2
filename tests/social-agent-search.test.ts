import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("rss-parser", () => ({
  default: class {
    parseURL(url: string) {
      if (url.includes("google.com")) {
        const queryMatch = url.match(/q=([^&]+)/);
        const queryTerm = queryMatch ? decodeURIComponent(queryMatch[1]).split(" ")[0].replace(/^[@#]/, "") : "elonmusk";
        return Promise.resolve({
          title: "Google News",
          items: [
            {
              title: `${queryTerm} Update - Twitter`,
              link: `https://x.com/${queryTerm}/status/100`,
              pubDate: new Date().toISOString(),
            },
            {
              title: `${queryTerm} LinkedIn Profile - LinkedIn`,
              link: `https://linkedin.com/in/${queryTerm}`,
              pubDate: new Date().toISOString(),
            },
          ],
        });
      }
      return Promise.resolve({
        title: "Mock Feed",
        items: [
          {
            title: "Mock RSS Item",
            link: "https://medium.com/@elonmusk/article-1",
            pubDate: new Date().toISOString(),
          },
        ],
      });
    }
  },
}));

import { generateHandleVariations, getSocialIntelligence } from "../src/routes/news";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = (async (url: any) => {
    const urlStr = String(url);
    if (urlStr.includes("wikidata.org")) {
      if (urlStr.includes("elonmusk") || urlStr.includes("Q915")) {
        return new Response(
          JSON.stringify({
            search: [{ id: "Q915" }],
            entities: {
              Q915: {
                claims: {
                  P2002: [{ mainsnak: { datavalue: { value: "elonmusk" } } }],
                  P4264: [{ mainsnak: { datavalue: { value: "company/tesla" } } }],
                  P3984: [{ mainsnak: { datavalue: { value: "elonmusk" } } }],
                  P2003: [{ mainsnak: { datavalue: { value: "elonmusk" } } }],
                  P2013: [{ mainsnak: { datavalue: { value: "elonmusk" } } }],
                  P2397: [{ mainsnak: { datavalue: { value: "UC123456" } } }],
                },
              },
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ search: [], entities: {} }), { status: 200 });
    }
    if (urlStr.includes("firebaseio.com")) {
      return new Response(JSON.stringify({ id: "spez", karma: 15420 }), { status: 200 });
    }
    if (urlStr.includes("algolia.com")) {
      return new Response(
        JSON.stringify({
          hits: [
            {
              title: "SpaceX Launch Success",
              author: "hn_user",
              created_at: "2026-08-25T10:00:00Z",
              points: 150,
              num_comments: 42,
              objectID: "12345",
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (urlStr.includes("t.me")) {
      return new Response(
        `<div class="tgme_channel_info">Preview</div><div class="tgme_widget_message_text">Official update from telegram channel</div>`,
        { status: 200 },
      );
    }
    if (urlStr.includes("reddit.com")) {
      if (urlStr.includes("about.json")) {
        return new Response(JSON.stringify({ data: { name: "spez", total_karma: 15420 } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          data: {
            children: [
              {
                data: {
                  title: "Reddit Announcement",
                  author: "spez",
                  subreddit: "announcements",
                  score: 1200,
                  num_comments: 300,
                  created_utc: 1787654321,
                  permalink: "/r/announcements/comments/123",
                },
              },
            ],
          },
        }),
        { status: 200 },
      );
    }
    return new Response("", { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("getSocialIntelligence — Multi-platform Agent & Username Search", () => {
  test("returns empty profiles and mentions for empty query", async () => {
    const res = await getSocialIntelligence("");
    expect(res).toBeDefined();
    expect(res.profiles).toEqual([]);
    expect(res.mentions).toEqual([]);
  });

  test("populates profiles across all target platforms for a handle query (@elonmusk)", async () => {
    const res = await getSocialIntelligence("@elonmusk");
    expect(res).toBeDefined();
    expect(Array.isArray(res.profiles)).toBe(true);
    expect(res.profiles.length).toBeGreaterThanOrEqual(9);

    const platformNames = res.profiles.map((p: any) => p.platform);
    expect(platformNames).toContain("X / Twitter");
    expect(platformNames).toContain("LinkedIn");
    expect(platformNames).toContain("Instagram");
    expect(platformNames).toContain("Facebook");
    expect(platformNames).toContain("Reddit");
    expect(platformNames).toContain("Hacker News");
    expect(platformNames).toContain("YouTube");
    expect(platformNames).toContain("Telegram");
    expect(platformNames).toContain("Medium");

    const xProfile = res.profiles.find((p: any) => p.platform === "X / Twitter");
    expect(xProfile).toBeDefined();
    expect(xProfile.handle).toBe("@elonmusk");
  });

  test("populates profiles for a standard keyword query (technology)", async () => {
    const res = await getSocialIntelligence("technology");
    expect(res).toBeDefined();
    expect(Array.isArray(res.profiles)).toBe(true);
    expect(Array.isArray(res.mentions)).toBe(true);

    const platformNames = res.profiles.map((p: any) => p.platform);
    expect(platformNames).toContain("X / Twitter");
    expect(platformNames).toContain("LinkedIn");
    expect(platformNames).toContain("Instagram");
    expect(platformNames).toContain("Facebook");
    expect(platformNames).toContain("Reddit");
  });

  test("returns mentions with required properties (platform, text, tone, url)", async () => {
    const res = await getSocialIntelligence("crypto");
    expect(res).toBeDefined();
    expect(Array.isArray(res.mentions)).toBe(true);

    if (res.mentions.length > 0) {
      const first = res.mentions[0];
      expect(first.platform).toBeDefined();
      expect(typeof first.platform).toBe("string");
      expect(first.text).toBeDefined();
      expect(typeof first.text).toBe("string");
      expect(["positive", "negative", "neutral"]).toContain(first.tone);
    }
  });

  test("normalizes reddit username handle u/spez into profile structure", async () => {
    const res = await getSocialIntelligence("u/spez");
    expect(res).toBeDefined();
    const redditProfile = res.profiles.find((p: any) => p.platform === "Reddit");
    expect(redditProfile).toBeDefined();
    expect(redditProfile.handle).toContain("spez");
  });

  test("generates nearest handle variations for username queries", () => {
    const vars = generateHandleVariations("taraka_nadh_253");
    expect(vars).toContain("taraka_nadh_253");
    expect(vars).toContain("tarakanadh253");
    expect(vars).toContain("taraka_nadh");
    expect(vars).toContain("tarakanadh");
  });

  test("returns No public profile found (Inactive) for platforms where no account exists", async () => {
    const res = await getSocialIntelligence("unknown_unregistered_user_99999");
    expect(res).toBeDefined();
    expect(res.profiles.length).toBeGreaterThanOrEqual(9);

    const xProfile = res.profiles.find((p: any) => p.platform === "X / Twitter");
    expect(xProfile).toBeDefined();
    expect(xProfile.handle).toBe("No public profile found");
    expect(xProfile.status).toBe("Inactive");

    const instaProfile = res.profiles.find((p: any) => p.platform === "Instagram");
    expect(instaProfile).toBeDefined();
    expect(instaProfile.handle).toBe("No public profile found");
    expect(instaProfile.status).toBe("Inactive");
  });
});
