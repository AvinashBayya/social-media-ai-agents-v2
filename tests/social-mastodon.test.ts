import { afterEach, describe, expect, test } from "bun:test";
import {
  fetchMastodonTag,
  mastodonLinks,
  stripMastodonHtml,
  MASTODON_INSTANCES,
  MASTODON_DEFAULT_INSTANCE,
  PLATFORM_NOTES,
  SocialUnavailableError,
} from "../src/utils/social";

/**
 * Mastodon collection.
 *
 * The federated case has a failure mode the other platforms do not: an instance
 * can decline to serve anonymous readers (HTTP 422) while the hashtag is busy
 * elsewhere on the network. Reporting that as an empty timeline would state
 * something false about the tag rather than about the instance, so most of these
 * tests pin that distinction.
 */

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(make: (url: string) => Response) {
  globalThis.fetch = (async (input: RequestInfo | URL) => make(String(input))) as typeof fetch;
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const status = (over: Record<string, unknown> = {}) => ({
  id: "111",
  created_at: "2026-08-10T11:00:00.000Z",
  url: "https://mastodon.social/@someone/111",
  content: "<p>A post about something</p>",
  language: "en",
  account: { acct: "someone" },
  ...over,
});

// ─── HTML handling ─────────────────────────────────────────────────────────

describe("stripMastodonHtml", () => {
  test("recovers readable text from the HTML the API serves", () => {
    expect(stripMastodonHtml("<p>First line</p><p>Second line</p>")).toBe(
      "First line\n\nSecond line",
    );
    expect(stripMastodonHtml("<p>Broken<br/>across lines</p>")).toBe("Broken\nacross lines");
  });

  test("decodes the entities the API emits", () => {
    expect(stripMastodonHtml("<p>a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;</p>")).toBe(
      `a & b <c> "d" 'e'`,
    );
  });

  test("&amp; is decoded last so &amp;lt; does not become a tag", () => {
    // Decoding & first would turn "&amp;lt;" into "&lt;" and then into "<",
    // silently inventing markup that was never in the post.
    expect(stripMastodonHtml("<p>&amp;lt;script&amp;gt;</p>")).toBe("&lt;script&gt;");
  });
});

describe("mastodonLinks", () => {
  test("collects body links and the link card", () => {
    const html = `<p>see <a href="https://example.com/a">this</a></p>`;
    expect(mastodonLinks(html, "https://example.com/card")).toEqual([
      "https://example.com/a",
      "https://example.com/card",
    ]);
  });

  test("excludes hashtag and mention anchors — they are navigation, not amplification", () => {
    const html =
      `<a href="https://mastodon.social/tags/osint">#osint</a>` +
      `<a href="https://mastodon.social/@someone">@someone</a>` +
      `<a href="https://real.example/story">story</a>`;
    expect(mastodonLinks(html)).toEqual(["https://real.example/story"]);
  });

  test("deduplicates when the card repeats a body link", () => {
    const html = `<a href="https://example.com/x">x</a>`;
    expect(mastodonLinks(html, "https://example.com/x")).toEqual(["https://example.com/x"]);
  });
});

// ─── Failure modes stay distinguishable ────────────────────────────────────

describe("fetchMastodonTag — refusal is never an empty timeline", () => {
  test("422 says the instance declined, and names an alternative", async () => {
    stubFetch(() => new Response("nope", { status: 422 }));
    const err = await fetchMastodonTag("osint", "infosec.exchange").catch((e) => e);
    expect(err).toBeInstanceOf(SocialUnavailableError);
    expect(err.message).toMatch(/does not serve this timeline to unauthenticated readers/i);
    expect(err.message).toMatch(/not the same as the hashtag being unused/i);
    expect(err.status).toBe(422);
  });

  test("429 is reported as a rate limit, not as no posts", async () => {
    stubFetch(() => new Response("slow", { status: 429 }));
    const err = await fetchMastodonTag("osint").catch((e) => e);
    expect(err.message).toMatch(/rate limited/i);
    expect(err.message).toMatch(/not\s+the same as no matching posts/i);
  });

  test("a network failure throws and preserves the cause", async () => {
    stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    await expect(fetchMastodonTag("osint")).rejects.toThrow(/ECONNREFUSED/);
  });

  test("a non-array payload throws rather than yielding nothing", async () => {
    stubFetch(() => jsonRes({ error: "unexpected" }));
    await expect(fetchMastodonTag("osint")).rejects.toThrow(/unexpected payload/i);
  });

  test("an empty tag or instance is rejected before any request", async () => {
    let called = false;
    stubFetch(() => {
      called = true;
      return jsonRes([]);
    });
    await expect(fetchMastodonTag("  ")).rejects.toThrow(/no hashtag/i);
    await expect(fetchMastodonTag("osint", "  ")).rejects.toThrow(/no mastodon instance/i);
    expect(called).toBe(false);
  });

  test("an empty timeline resolves to [] — the one case that legitimately does", async () => {
    stubFetch(() => jsonRes([]));
    await expect(fetchMastodonTag("a-tag-nobody-uses")).resolves.toEqual([]);
  });
});

// ─── Mapping ───────────────────────────────────────────────────────────────

/**
 * The collector caches on `instance:tag:limit` for two minutes, in a module-level
 * map shared across this whole file. Reusing a tag between tests silently serves
 * the previous test's stub, so every case below takes a distinct tag — which also
 * exercises the cache key rather than working around it.
 */
describe("fetchMastodonTag — mapping", () => {
  test("maps a status onto the shared SocialPost shape", async () => {
    stubFetch(() => jsonRes([status()]));
    const [post] = await fetchMastodonTag("map-shape");

    expect(post.platform).toBe("mastodon");
    expect(post.text).toBe("A post about something");
    expect(post.createdAt).toBe("2026-08-10T11:00:00.000Z");
    expect(post.langs).toEqual(["en"]);
  });

  test("a local handle is qualified with its instance", async () => {
    // "someone" on two instances is two accounts. Leaving handles bare would
    // merge them, and CIB clustering would report one actor where there are two.
    stubFetch(() => jsonRes([status({ account: { acct: "someone" } })]));
    const [post] = await fetchMastodonTag("map-local-handle", "mstdn.social");
    expect(post.authorId).toBe("someone@mstdn.social");
    expect(post.author).toBe("@someone@mstdn.social");
  });

  test("an already-qualified remote handle is left alone", async () => {
    stubFetch(() => jsonRes([status({ account: { acct: "other@example.social" } })]));
    const [post] = await fetchMastodonTag("map-remote-handle");
    expect(post.authorId).toBe("other@example.social");
  });

  test("post ids are namespaced by instance so two instances cannot collide", async () => {
    stubFetch(() => jsonRes([status({ id: "999" })]));
    const [post] = await fetchMastodonTag("map-id-ns", "mstdn.social");
    expect(post.id).toBe("mastodon:mstdn.social:999");
  });

  test("statuses missing an id, handle or text are skipped, not faked", async () => {
    stubFetch(() =>
      jsonRes([
        status({ id: undefined }),
        status({ account: {} }),
        status({ content: "<p></p>" }),
        status({ id: "keep" }),
      ]),
    );
    const posts = await fetchMastodonTag("map-skips");
    expect(posts).toHaveLength(1);
    expect(posts[0].id).toBe("mastodon:mastodon.social:keep");
  });

  test("a missing language yields [] rather than a guessed locale", async () => {
    stubFetch(() => jsonRes([status({ language: null })]));
    const [post] = await fetchMastodonTag("map-no-lang");
    expect(post.langs).toEqual([]);
  });

  test("the instance host is normalised out of a pasted URL", async () => {
    let requested = "";
    stubFetch((url) => {
      requested = url;
      return jsonRes([]);
    });
    await fetchMastodonTag("map-host-norm", "https://mstdn.social/explore");
    expect(requested).toStartWith("https://mstdn.social/api/v1/timelines/tag/map-host-norm");
  });

  test("a leading # on the tag is accepted and stripped", async () => {
    let requested = "";
    stubFetch((url) => {
      requested = url;
      return jsonRes([]);
    });
    await fetchMastodonTag("#map-hash-strip");
    expect(requested).toContain("/timelines/tag/map-hash-strip?");
  });

  test("a repeated query is served from cache without a second request", async () => {
    let calls = 0;
    stubFetch(() => {
      calls++;
      return jsonRes([status()]);
    });
    await fetchMastodonTag("map-cache-hit");
    await fetchMastodonTag("map-cache-hit");
    expect(calls).toBe(1);
  });
});

// ─── Declaration ───────────────────────────────────────────────────────────

describe("Mastodon is declared honestly", () => {
  test("the default instance is one of the known-good instances", () => {
    expect(MASTODON_INSTANCES).toContain(MASTODON_DEFAULT_INSTANCE);
  });

  test("PLATFORM_NOTES states the per-instance coverage limit", () => {
    const note = PLATFORM_NOTES.find((p) => p.platform === "Mastodon")!;
    expect(note.available).toBe(true);
    // The federation caveat is the thing an evaluator will probe: a tag timeline
    // is one instance's view, not the network's.
    expect(note.limitation).toMatch(/federated/i);
    expect(note.limitation).toMatch(/422/);
  });
});
