import { afterEach, describe, expect, test } from "bun:test";
import { newsCollector } from "../src/utils/collectors/existing/news";
import type { CollectorRunOutcome } from "../src/utils/collectors/types";
import type { NewsRaw } from "../src/utils/collectors/existing/news";
import type { GeoRecord } from "../src/utils/geo";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(make: () => Response | Promise<Response>) {
  globalThis.fetch = (async () => make()) as typeof fetch;
}

function record(overrides: Partial<GeoRecord> = {}): GeoRecord {
  return {
    id: "gdelt-1",
    layer: "news",
    lat: 51.5,
    lon: -0.12,
    precision: "country",
    locates: "the publishing outlet's registered country",
    title: "Test headline",
    source: "BBC",
    url: "https://bbc.co.uk/article",
    timestamp: "2026-08-14T00:00:00Z",
    magnitude: null,
    magnitudeLabel: "",
    detail: {},
    credibility: null,
    ...overrides,
  };
}

function completedOutcome(raw: NewsRaw): CollectorRunOutcome<NewsRaw> {
  return {
    execution: {
      status: "completed",
      startedAt: "2026-08-14T00:00:00.000Z",
      completedAt: "2026-08-14T00:00:01.000Z",
      durationMs: 1000,
      resultCount: raw.records.length,
      error: null,
    },
    raw,
  };
}

describe("newsCollector.execute", () => {
  test("rejects an empty query without a network call", async () => {
    const outcome = await newsCollector.execute({ type: "person", value: "  " });
    expect(outcome.raw).toBeNull();
    expect(outcome.execution.error?.reason).toBe("invalid-target");
  });

  test("completes with geo-tagged articles on a successful GDELT query", async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            articles: [
              {
                sourcecountry: "United Kingdom",
                seendate: "20260814T120000Z",
                title: "x",
                url: "https://bbc.co.uk/x",
                domain: "bbc.co.uk",
              },
            ],
          }),
        ),
    );
    const outcome = await newsCollector.execute({ type: "person", value: "test query" });
    expect(outcome.execution.status).toBe("completed");
    expect(outcome.raw).not.toBeNull();
  });

  test("a GDELT rate limit fails with reason rate-limited, not zero results", async () => {
    stubFetch(() => new Response("rate limited", { status: 429 }));
    const outcome = await newsCollector.execute({ type: "person", value: "test query" });
    expect(outcome.execution.status).toBe("failed");
    expect(outcome.execution.error?.reason).toBe("rate-limited");
  });
});

describe("newsCollector.normalize", () => {
  test("emits an article entity and a location entity linked by LOCATED_IN", () => {
    const raw: NewsRaw = { layer: "news", records: [record()], unplaceable: 0, error: null };
    const result = newsCollector.normalize(completedOutcome(raw));
    expect(result.entities.filter((e) => e.type === "article")).toHaveLength(1);
    expect(result.entities.filter((e) => e.type === "location")).toHaveLength(1);
    expect(result.relationships).toHaveLength(1);
    expect(result.relationships[0]!.relationshipType).toBe("LOCATED_IN");
  });

  test("unplaceable articles are surfaced as a warning, never invented as entities", () => {
    const raw: NewsRaw = { layer: "news", records: [], unplaceable: 3, error: null };
    const result = newsCollector.normalize(completedOutcome(raw));
    expect(result.entities).toEqual([]);
    expect(result.warnings[0]).toMatch(/3 article/);
  });

  test("a null credibility record produces null evidence confidence, never a default score", () => {
    const raw: NewsRaw = {
      layer: "news",
      records: [record({ credibility: null })],
      unplaceable: 0,
      error: null,
    };
    const result = newsCollector.normalize(completedOutcome(raw));
    expect(result.evidence[0]!.confidence).toBeNull();
  });

  test("a scored record carries its credibility through as evidence confidence", () => {
    const raw: NewsRaw = {
      layer: "news",
      records: [record({ credibility: 0.72 })],
      unplaceable: 0,
      error: null,
    };
    const result = newsCollector.normalize(completedOutcome(raw));
    expect(result.evidence[0]!.confidence?.value).toBe(0.72);
  });
});
