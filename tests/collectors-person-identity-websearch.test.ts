import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { identityWebsearchCollector } from "../src/utils/collectors/person/identity-websearch";

const ENV = "BRAVE_SEARCH_API_KEY";
const originalFetch = globalThis.fetch;
const originalKey = process.env[ENV];

beforeEach(() => {
  delete process.env[ENV];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env[ENV];
  else process.env[ENV] = originalKey;
});

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  globalThis.fetch = ((url: any) => handler(String(url))) as typeof fetch;
}

function braveResponse(results: Array<{ title: string; url: string; description: string }>) {
  return new Response(JSON.stringify({ web: { results } }), { status: 200 });
}

const ARTICLE_HTML = `<!doctype html><html><head><title>John Smith — Example Corp</title></head>
<body><article><h1>John Smith</h1><p>${"John Smith is the CTO of Example Corp, based in Bengaluru. ".repeat(20)}</p></article></body></html>`;

describe("identityWebsearchCollector.execute — a keyless dorks-based fallback exists, so a missing key degrades rather than fails", () => {
  // fetchNewsDorkHits (src/utils/dorks.ts) calls Google News RSS via Node's
  // raw http/https, not the global `fetch`, so stubFetch can't intercept it
  // here. Asserting on live content would make this test flaky depending on
  // network reachability in CI. execute()'s own fallback branch already
  // degrades a dork-fetch failure to a "completed" run with an
  // extractionWarning rather than throwing (see identity-websearch.ts), so
  // this assertion holds either way: real hits, or an honest empty result.
  test("no key configured falls back to the real dorks search — completed, not no-credential", async () => {
    const outcome = await identityWebsearchCollector.execute({ type: "person", value: "John Smith" });
    expect(outcome.execution.status).toBe("completed");
    expect(outcome.execution.error).toBeNull();
    expect(outcome.raw).not.toBeNull();
  });

  test("rejects an empty query", async () => {
    process.env[ENV] = "test-key";
    const outcome = await identityWebsearchCollector.execute({ type: "person", value: "" });
    expect(outcome.execution.error?.reason).toBe("invalid-target");
  });

  test("real hits plus a genuinely extracted top result", async () => {
    process.env[ENV] = "test-key";
    stubFetch((url) => {
      if (url.includes("api.search.brave.com")) {
        return braveResponse([
          { title: "John Smith — Example Corp", url: "https://example.com/john-smith", description: "CTO bio" },
          { title: "John Smith on GitHub", url: "https://github.com/johnsmith", description: "" },
        ]);
      }
      if (url === "https://example.com/john-smith") {
        return new Response(ARTICLE_HTML, { status: 200, headers: { "content-type": "text/html" } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const outcome = await identityWebsearchCollector.execute({ type: "person", value: "John Smith" });
    expect(outcome.execution.status).toBe("completed");
    expect(outcome.raw?.hits).toHaveLength(2);
    expect(outcome.raw?.extracted?.url).toBe("https://example.com/john-smith");
    expect(outcome.raw?.extracted?.text).toContain("Example Corp");
    expect(outcome.raw?.extractionWarning).toBeNull();
  });

  test("a failed extraction degrades to a warning, not a failed collector run — search still succeeded", async () => {
    process.env[ENV] = "test-key";
    stubFetch((url) => {
      if (url.includes("api.search.brave.com")) {
        return braveResponse([{ title: "John Smith", url: "https://example.com/john-smith", description: "" }]);
      }
      return new Response(null, { status: 404 });
    });
    const outcome = await identityWebsearchCollector.execute({ type: "person", value: "John Smith" });
    expect(outcome.execution.status).toBe("completed");
    expect(outcome.raw?.extracted).toBeNull();
    expect(outcome.raw?.extractionWarning).toContain("404");
  });

  test("zero web results still completes — a real, honest 'nothing found', not a failure", async () => {
    process.env[ENV] = "test-key";
    stubFetch((url) => {
      if (url.includes("api.search.brave.com")) return braveResponse([]);
      throw new Error(`unexpected fetch: ${url}`);
    });
    const outcome = await identityWebsearchCollector.execute({ type: "person", value: "Extremely Rare Name Xyz" });
    expect(outcome.execution.status).toBe("completed");
    expect(outcome.raw?.hits).toEqual([]);
  });

  test("a rate limit (429) is its own distinguishable failure reason", async () => {
    process.env[ENV] = "test-key";
    stubFetch(() => new Response(null, { status: 429 }));
    const outcome = await identityWebsearchCollector.execute({ type: "person", value: "John Smith" });
    expect(outcome.execution.error?.reason).toBe("rate-limited");
  });

  test("a rejected key (401) reports no-credential, distinguishable from an unset key by its message", async () => {
    process.env[ENV] = "bad-key";
    stubFetch(() => new Response(null, { status: 401 }));
    const outcome = await identityWebsearchCollector.execute({ type: "person", value: "John Smith" });
    expect(outcome.execution.error?.reason).toBe("no-credential");
    expect(outcome.execution.error?.message).toContain("401");
  });
});

describe("identityWebsearchCollector.normalize", () => {
  test("produces a target person entity, an article entity per hit, and MENTIONED_IN edges", async () => {
    process.env[ENV] = "test-key";
    stubFetch((url) => {
      if (url.includes("api.search.brave.com")) {
        return braveResponse([{ title: "John Smith", url: "https://example.com/john-smith", description: "" }]);
      }
      return new Response(null, { status: 404 }); // extraction fails, harmless here
    });
    const outcome = await identityWebsearchCollector.execute({ type: "person", value: "John Smith" });
    const result = identityWebsearchCollector.normalize(outcome);
    expect(result.entities.some((e) => e.type === "person")).toBe(true);
    expect(result.entities.some((e) => e.type === "article")).toBe(true);
    expect(result.relationships.every((r) => r.relationshipType === "MENTIONED_IN")).toBe(true);
  });

  test("the extracted evidence item carries the real extracted text, others carry only the search snippet", async () => {
    process.env[ENV] = "test-key";
    stubFetch((url) => {
      if (url.includes("api.search.brave.com")) {
        return braveResponse([
          { title: "John Smith — Example Corp", url: "https://example.com/john-smith", description: "CTO bio" },
          { title: "Other hit", url: "https://other.example/page", description: "unrelated" },
        ]);
      }
      if (url === "https://example.com/john-smith") return new Response(ARTICLE_HTML, { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    });
    const outcome = await identityWebsearchCollector.execute({ type: "person", value: "John Smith" });
    const result = identityWebsearchCollector.normalize(outcome);
    const extractedEvidence = result.evidence.find((e) => e.sourceUrl === "https://example.com/john-smith");
    const plainEvidence = result.evidence.find((e) => e.sourceUrl === "https://other.example/page");
    expect((extractedEvidence?.normalizedValue as any).text).toContain("Example Corp");
    expect((plainEvidence?.normalizedValue as any).description).toBe("unrelated");
    expect((plainEvidence?.normalizedValue as any).text).toBeUndefined();
  });
});

describe("identityWebsearchCollector.healthCheck", () => {
  test("reports no-credential when unset", async () => {
    const health = await identityWebsearchCollector.healthCheck();
    expect(health.state).toBe("no-credential");
  });
});
