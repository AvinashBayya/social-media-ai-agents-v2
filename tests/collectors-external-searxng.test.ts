/**
 * The load-bearing case here is the CAPTCHA one.
 *
 * SearXNG scrapes Google/Bing, and when an upstream engine blocks it the
 * response is an empty `results` array with the engine named in
 * `unresponsive_engines`. If that field is dropped, "Google blocked us" renders
 * identically to "nothing matched" — the exact class of failure this codebase
 * keeps having to fix. Several tests below exist only to hold that line.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  parseSearxngResults,
  parseUnresponsiveEngines,
  searxngCollector,
} from "../src/utils/collectors/external/searxng";
import type { SearxngRaw } from "../src/utils/collectors/external/searxng";
import type { CollectorRunOutcome } from "../src/utils/collectors/types";

const originalFetch = globalThis.fetch;
const originalUrl = process.env.SEARXNG_URL;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.SEARXNG_URL;
  else process.env.SEARXNG_URL = originalUrl;
});

function stubFetch(make: () => Response | Promise<Response>) {
  globalThis.fetch = (async () => make()) as typeof fetch;
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function completedOutcome(raw: SearxngRaw): CollectorRunOutcome<SearxngRaw> {
  return {
    execution: {
      status: "completed",
      startedAt: "2026-08-17T00:00:00.000Z",
      completedAt: "2026-08-17T00:00:01.000Z",
      durationMs: 1000,
      resultCount: raw.results.length,
      error: null,
    },
    raw,
  };
}

describe("configuration state is distinct from a result", () => {
  test("no SEARXNG_URL reports unavailable, not an empty result", async () => {
    delete process.env.SEARXNG_URL;
    const outcome = await searxngCollector.execute({ type: "domain", value: "example.com" });
    expect(outcome.raw).toBeNull();
    expect(outcome.execution.status).toBe("failed");
    expect(outcome.execution.error?.reason).toBe("unavailable");
    expect(outcome.execution.error?.message).toContain("SEARXNG_URL is not configured");
  });

  test("HTTP 403 is reported as the JSON format being disabled", async () => {
    // The single most likely misconfiguration: stock SearXNG ships without the
    // json output format, and 403 is indistinguishable from a refusal unless named.
    process.env.SEARXNG_URL = "http://localhost:8080";
    stubFetch(() => new Response("forbidden", { status: 403 }));
    const outcome = await searxngCollector.execute({ type: "domain", value: "example.com" });
    expect(outcome.execution.error?.message).toContain("search.formats");
    expect(outcome.execution.error?.message).toContain("not a finding that the query matched");
  });

  test("HTTP 429 is classified as rate-limited, not as no results", async () => {
    process.env.SEARXNG_URL = "http://localhost:8080";
    stubFetch(() => new Response("slow down", { status: 429 }));
    const outcome = await searxngCollector.execute({ type: "domain", value: "example.com" });
    expect(outcome.execution.error?.reason).toBe("rate-limited");
  });

  test("an empty query is refused before any request", async () => {
    process.env.SEARXNG_URL = "http://localhost:8080";
    const outcome = await searxngCollector.execute({ type: "domain", value: "   " });
    expect(outcome.execution.error?.reason).toBe("invalid-target");
  });
});

describe("a blocked engine must not read as an empty result", () => {
  test("unresponsive engines become an explicit PARTIAL warning", async () => {
    process.env.SEARXNG_URL = "http://localhost:8080";
    stubFetch(() =>
      jsonRes({
        query: "site:example.com filetype:pdf",
        number_of_results: 0,
        results: [],
        unresponsive_engines: [["google", "CAPTCHA"]],
      }),
    );
    const outcome = await searxngCollector.execute({
      type: "domain",
      value: "site:example.com filetype:pdf",
    });
    const result = searxngCollector.normalize(outcome);
    expect(result.warnings.join(" ")).toContain("PARTIAL");
    expect(result.warnings.join(" ")).toContain("google: CAPTCHA");
    // And it must NOT claim the query genuinely matched nothing.
    expect(result.warnings.join(" ")).not.toContain("genuine empty result");
  });

  test("a genuine empty result says so, and is not confused with a block", async () => {
    process.env.SEARXNG_URL = "http://localhost:8080";
    stubFetch(() => jsonRes({ results: [], unresponsive_engines: [] }));
    const outcome = await searxngCollector.execute({ type: "domain", value: "zzzz" });
    const result = searxngCollector.normalize(outcome);
    expect(result.warnings.join(" ")).toContain("genuine empty result");
  });

  test("parseUnresponsiveEngines accepts both string and tuple shapes", () => {
    // The shape differs across SearXNG versions; neither may render as [object Object].
    expect(parseUnresponsiveEngines(["bing"])).toEqual(["bing"]);
    expect(parseUnresponsiveEngines([["google", "CAPTCHA"]])).toEqual(["google: CAPTCHA"]);
    expect(parseUnresponsiveEngines([{ engine: "x" }])).toEqual([]);
    expect(parseUnresponsiveEngines(undefined)).toEqual([]);
  });
});

describe("result parsing", () => {
  test("a result with no URL is dropped, not emitted with a blank one", () => {
    const parsed = parseSearxngResults([
      { title: "ok", url: "https://a.example.com/x", content: "s", engine: "duckduckgo" },
      { title: "no url", content: "s" },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].url).toBe("https://a.example.com/x");
  });

  test("a missing engine is null, never an invented label", () => {
    const parsed = parseSearxngResults([{ url: "https://a.example.com/", title: "t" }]);
    expect(parsed[0].engine).toBeNull();
    // And a missing title falls back to the URL rather than an empty string.
    expect(parseSearxngResults([{ url: "https://b.example.com/" }])[0].title).toBe(
      "https://b.example.com/",
    );
  });
});

describe("normalisation", () => {
  test("emits url and domain entities with a HOSTED_ON edge", () => {
    const result = searxngCollector.normalize(
      completedOutcome({
        query: "q",
        results: [
          {
            title: "Doc",
            url: "https://docs.example.com/a.pdf",
            content: "snippet",
            engine: "google",
          },
        ],
        unresponsiveEngines: [],
        numberOfResults: 1,
      }),
    );
    expect(result.entities.map((e) => e.type).sort()).toEqual(["domain", "url"]);
    expect(result.relationships[0].relationshipType).toBe("HOSTED_ON");
    expect(result.evidence[0].sourceUrl).toBe("https://docs.example.com/a.pdf");
    expect(result.evidence[0].source).toBe("SearXNG (google)");
  });

  test("an absent snippet is null, not an empty-string measurement", () => {
    const result = searxngCollector.normalize(
      completedOutcome({
        query: "q",
        results: [{ title: "T", url: "https://x.example.com/", content: "", engine: null }],
        unresponsiveEngines: [],
        numberOfResults: null,
      }),
    );
    expect((result.evidence[0].normalizedValue as { snippet: unknown }).snippet).toBeNull();
  });

  test("a failed run normalises to an empty result carrying the error", () => {
    const result = searxngCollector.normalize({
      execution: {
        status: "failed",
        startedAt: "2026-08-17T00:00:00.000Z",
        completedAt: "2026-08-17T00:00:01.000Z",
        durationMs: 1,
        resultCount: 0,
        error: { collector: "searxng", reason: "unavailable", message: "not configured" },
      },
      raw: null,
    });
    expect(result.entities).toHaveLength(0);
    expect(result.errors).toContain("not configured");
  });
});

describe("healthCheck", () => {
  test("unavailable without configuration, and no request is made", async () => {
    delete process.env.SEARXNG_URL;
    globalThis.fetch = (() => {
      throw new Error("healthCheck must not call fetch when unconfigured");
    }) as unknown as typeof fetch;
    const health = await searxngCollector.healthCheck();
    expect(health.state).toBe("unavailable");
  });

  test("403 reports degraded with the settings.yml fix, not unavailable", async () => {
    process.env.SEARXNG_URL = "http://localhost:8080";
    stubFetch(() => new Response("no", { status: 403 }));
    const health = await searxngCollector.healthCheck();
    expect(health.state).toBe("degraded");
    expect(health.detail).toContain("search.formats");
  });

  test("200 reports ready", async () => {
    process.env.SEARXNG_URL = "http://localhost:8080";
    stubFetch(() => jsonRes({ results: [] }));
    expect((await searxngCollector.healthCheck()).state).toBe("ready");
  });
});
