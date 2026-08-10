import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  fetchRedditSearch,
  redditCredentials,
  resetRedditToken,
  PLATFORM_NOTES,
  SocialUnavailableError,
} from "../src/utils/social";

/**
 * Reddit collection after the 2026-08-10 access change.
 *
 * Reddit began refusing every unauthenticated request with 403 and an HTML
 * anti-bot page. The guarantee under test is that the four ways this can now
 * fail — no credential, rejected credential, rate limit, and dead token — stay
 * four distinguishable facts. An analyst does something different for each, and
 * none of them means "no posts matched".
 */

const ID = "REDDIT_CLIENT_ID";
const SECRET = "REDDIT_CLIENT_SECRET";

const originalFetch = globalThis.fetch;
const originalId = process.env[ID];
const originalSecret = process.env[SECRET];

beforeEach(() => {
  resetRedditToken();
  delete process.env[ID];
  delete process.env[SECRET];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetRedditToken();
  if (originalId === undefined) delete process.env[ID];
  else process.env[ID] = originalId;
  if (originalSecret === undefined) delete process.env[SECRET];
  else process.env[SECRET] = originalSecret;
});

function withCredentials() {
  process.env[ID] = "test-id";
  process.env[SECRET] = "test-secret";
}

/** Route by URL so the token exchange and the search can differ. */
function stubFetch(handler: (url: string) => Response) {
  globalThis.fetch = (async (input: any) => handler(String(input))) as typeof fetch;
}

const tokenOk = () =>
  new Response(JSON.stringify({ access_token: "tok-abc", expires_in: 3600 }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const listing = (ids: string[]) =>
  new Response(
    JSON.stringify({
      data: {
        children: ids.map((id) => ({
          data: {
            id,
            author: "someone",
            title: `post ${id}`,
            created_utc: 1_760_000_000,
            permalink: `/r/x/${id}`,
          },
        })),
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

// ─── Credential state ──────────────────────────────────────────────────────

describe("redditCredentials", () => {
  test("null when either half is absent", () => {
    expect(redditCredentials()).toBeNull();
    process.env[ID] = "only-id";
    expect(redditCredentials()).toBeNull();
  });

  test("present only when both are set", () => {
    withCredentials();
    expect(redditCredentials()).toEqual({ id: "test-id", secret: "test-secret" });
  });
});

// ─── The four failure modes stay distinct ──────────────────────────────────

describe("fetchRedditSearch — failures are distinguishable and never []", () => {
  test("no credential names the env vars and the registration route", async () => {
    stubFetch(() => tokenOk());
    const err = await fetchRedditSearch("india").catch((e) => e);
    expect(err).toBeInstanceOf(SocialUnavailableError);
    expect(err.message).toMatch(/REDDIT_CLIENT_ID/);
    expect(err.message).toMatch(/REDDIT_CLIENT_SECRET/);
    expect(err.message).toMatch(/reddit\.com\/prefs\/apps/);
    // The critical distinction: absent credential is not absent posts.
    expect(err.message).toMatch(/not a finding that no posts matched/i);
  });

  test("no credential does not even attempt a request", async () => {
    let called = false;
    stubFetch(() => {
      called = true;
      return tokenOk();
    });
    await fetchRedditSearch("india").catch(() => {});
    expect(called).toBe(false);
  });

  test("rejected credentials are reported as such, not as a rate limit", async () => {
    withCredentials();
    stubFetch(() => new Response("bad creds", { status: 401 }));
    const err = await fetchRedditSearch("india").catch((e) => e);
    expect(err.message).toMatch(/rejected the credentials/i);
    expect(err.status).toBe(401);
  });

  test("a rate limit is reported as a rate limit, not as no results", async () => {
    withCredentials();
    stubFetch((url) =>
      url.includes("access_token") ? tokenOk() : new Response("slow", { status: 429 }),
    );
    const err = await fetchRedditSearch("india").catch((e) => e);
    expect(err.message).toMatch(/rate limited/i);
    expect(err.message).toMatch(/not\s+the same as no matching posts/i);
    expect(err.status).toBe(429);
  });

  test("a 401 on search discards the cached token so the next call re-auths", async () => {
    withCredentials();
    let tokenRequests = 0;
    stubFetch((url) => {
      if (url.includes("access_token")) {
        tokenRequests++;
        return tokenOk();
      }
      return new Response("stale", { status: 401 });
    });

    await fetchRedditSearch("india").catch(() => {});
    await fetchRedditSearch("bharat").catch(() => {});
    // Without the reset the second call would replay a token known to be dead.
    expect(tokenRequests).toBe(2);
  });

  test("a token response with no access_token throws rather than proceeding", async () => {
    withCredentials();
    stubFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const err = await fetchRedditSearch("india").catch((e) => e);
    expect(err.message).toMatch(/no access_token/i);
  });

  test("an empty listing resolves to [] — the one case that legitimately does", async () => {
    withCredentials();
    stubFetch((url) => (url.includes("access_token") ? tokenOk() : listing([])));
    await expect(fetchRedditSearch("nothing-matches-this")).resolves.toEqual([]);
  });
});

// ─── The OAuth path itself ─────────────────────────────────────────────────

describe("fetchRedditSearch — OAuth request shape", () => {
  test("queries oauth.reddit.com with a bearer token, not the blocked public host", async () => {
    withCredentials();
    let searchUrl = "";
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input);
      if (url.includes("access_token")) return tokenOk();
      searchUrl = url;
      expect(init?.headers?.authorization).toBe("Bearer tok-abc");
      return listing(["aaa"]);
    }) as typeof fetch;

    const posts = await fetchRedditSearch("india", 5);
    expect(searchUrl).toStartWith("https://oauth.reddit.com/search");
    expect(searchUrl).not.toMatch(/www\.reddit\.com/);
    expect(posts).toHaveLength(1);
    expect(posts[0].platform).toBe("reddit");
  });

  test("the token is reused across calls rather than re-fetched each time", async () => {
    withCredentials();
    let tokenRequests = 0;
    stubFetch((url) => {
      if (url.includes("access_token")) {
        tokenRequests++;
        return tokenOk();
      }
      return listing(["a"]);
    });

    await fetchRedditSearch("one", 5);
    await fetchRedditSearch("two", 5);
    expect(tokenRequests).toBe(1);
  });
});

// ─── PLATFORM_NOTES must not overstate what is collectable ─────────────────

describe("PLATFORM_NOTES honesty", () => {
  const note = (name: string) => PLATFORM_NOTES.find((p) => p.platform === name)!;

  test("Reddit is not advertised as available without its credential", () => {
    // It read `available: true, method: "public search.json, unauthenticated"`
    // until that route started returning 403 on every request.
    const reddit = note("Reddit");
    expect(reddit.available).toBe(false);
    expect(reddit.requiresCredential).toMatch(/REDDIT_CLIENT_ID/);
    expect(reddit.limitation).toMatch(/403/);
  });

  test("a platform that is unavailable explains why, and one that needs a key names it", () => {
    for (const p of PLATFORM_NOTES) {
      expect(p.limitation.trim().length).toBeGreaterThan(0);
      if (!p.available && p.method !== "none") {
        expect(p.requiresCredential?.trim().length ?? 0).toBeGreaterThan(0);
      }
    }
  });

  test("Meta platforms stay declared uncollectable", () => {
    // The fabricated social cache used to render invented Instagram and Facebook
    // posts directly beside these notes. Both must stay false.
    expect(note("Instagram").available).toBe(false);
    expect(note("Facebook").available).toBe(false);
    expect(note("X / Twitter").available).toBe(false);
  });
});
