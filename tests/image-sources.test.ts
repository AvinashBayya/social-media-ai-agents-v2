import { afterEach, describe, expect, test } from "bun:test";
import { collectOpenverseImages, collectWikipediaImages } from "../src/utils/image-sources";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(handler: (url: string, init: any) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    return handler(url, init ?? {});
  }) as typeof fetch;
}

// The real Wikimedia rate-limit page returned live 2026-08-20 for a 429 —
// full HTML, not JSON. Trimmed to the load-bearing shape for the test.
const WIKIMEDIA_ERROR_HTML =
  '<!DOCTYPE html>\n<html lang="en">\n<meta charset="utf-8">\n<title>Wikimedia Error</title>\n' +
  '<style>\n* { margin: 0; padding: 0; }\nbody { background: #fff; font: 15px/1.6 sans-serif; ' +
  'color: #333; }\n.content { margin: 7% auto 0; padding: 2em 1em 1em; max-width: 640px; }\n' +
  "</style>\n<div class=\"content\">\n<p>Our servers are currently under maintenance or " +
  "experiencing a technical issue.</p>\n</div>\n</html>";

describe("collectWikipediaImages", () => {
  test("sends a descriptive User-Agent — Wikimedia's API etiquette policy requires one", async () => {
    let seenUA: string | undefined;
    stubFetch((_url, init) => {
      seenUA = init.headers?.["user-agent"];
      return new Response(JSON.stringify({ query: { pages: [] } }));
    });
    await collectWikipediaImages("test");
    expect(seenUA).toBeTruthy();
    expect(seenUA).toContain("SentinelAI");
  });

  test("a 429 HTML error page is stripped to plain text, never dumped as raw markup", async () => {
    stubFetch(
      () =>
        new Response(WIKIMEDIA_ERROR_HTML, {
          status: 429,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );
    const result = await collectWikipediaImages("test");
    expect(result.results).toEqual([]);
    expect(result.error).toContain("HTTP 429");
    expect(result.error).not.toContain("<!DOCTYPE");
    expect(result.error).not.toContain("<style>");
    expect(result.error).not.toContain("<div");
    expect(result.error).toContain("Our servers are currently under maintenance");
  });

  test("a JSON error body still passes through as before (no regression from the HTML handling)", async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ error: "invalid search" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    );
    const result = await collectWikipediaImages("test");
    expect(result.error).toContain("HTTP 400");
    expect(result.error).toContain("invalid search");
  });

  test("a real page result still parses normally", async () => {
    stubFetch(() =>
      new Response(
        JSON.stringify({
          query: {
            pages: [
              {
                title: "Test Page",
                thumbnail: { source: "https://upload.wikimedia.org/thumb.jpg" },
              },
            ],
          },
        }),
      ),
    );
    const result = await collectWikipediaImages("test");
    expect(result.error).toBeNull();
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.url).toBe("https://upload.wikimedia.org/thumb.jpg");
  });
});

describe("collectOpenverseImages", () => {
  test("also sends the descriptive User-Agent", async () => {
    let seenUA: string | undefined;
    stubFetch((_url, init) => {
      seenUA = init.headers?.["user-agent"];
      return new Response(JSON.stringify({ results: [] }));
    });
    await collectOpenverseImages("test");
    expect(seenUA).toContain("SentinelAI");
  });

  test("an HTML error page is stripped here too", async () => {
    stubFetch(
      () =>
        new Response("<html><body><h1>503 Service Unavailable</h1></body></html>", {
          status: 503,
          headers: { "content-type": "text/html" },
        }),
    );
    const result = await collectOpenverseImages("test");
    expect(result.error).toContain("HTTP 503");
    expect(result.error).not.toContain("<html>");
    expect(result.error).toContain("503 Service Unavailable");
  });
});
