import { describe, expect, test } from "bun:test";
import { dorksCollector } from "../src/utils/collectors/existing/dorks";
import type { CollectorRunOutcome } from "../src/utils/collectors/types";
import type { DorksRaw } from "../src/utils/collectors/existing/dorks";

/**
 * `fetchNewsDorkHits` (the network path `execute()` calls) goes through
 * `rss-parser`, which makes its own request via Node's `http`/`https`
 * modules rather than global `fetch` — confirmed by reading
 * `node_modules/rss-parser/lib/parser.js`. This project's existing tests
 * stub `globalThis.fetch`, which would not intercept that, and there is no
 * established convention here for stubbing `http`/`https` directly. Rather
 * than write a mock against library internals that could silently stop
 * working on an `rss-parser` upgrade, `execute()`'s validation path and
 * `normalize()` (all the actual entity/relationship/evidence logic) are
 * tested directly; the live RSS fetch itself is exercised manually, not by
 * this file.
 */

function completedOutcome(raw: DorksRaw): CollectorRunOutcome<DorksRaw> {
  return {
    execution: {
      status: "completed",
      startedAt: "2026-08-14T00:00:00.000Z",
      completedAt: "2026-08-14T00:00:01.000Z",
      durationMs: 1000,
      resultCount: raw.hits.length,
      error: null,
    },
    raw,
  };
}

describe("dorksCollector.execute — validation path", () => {
  test("an empty target fails as invalid-target without attempting a request", async () => {
    const outcome = await dorksCollector.execute({ type: "person", value: "   " });
    expect(outcome.raw).toBeNull();
    expect(outcome.execution.status).toBe("failed");
    expect(outcome.execution.error?.reason).toBe("invalid-target");
  });
});

describe("dorksCollector.normalize", () => {
  test("emits a target entity, one article entity per hit, and MENTIONED_IN relationships", () => {
    const raw: DorksRaw = {
      targetValue: "Example Corp",
      targetType: "person",
      query: '"Example Corp" -opinion',
      hits: [
        {
          title: "Example Corp announces",
          source: "Reuters",
          url: "https://reuters.com/a",
          pubDate: "2026-08-14T00:00:00Z",
        },
        { title: "Example Corp expands", source: "AP", url: "https://apnews.com/b", pubDate: "" },
      ],
      webDorks: [],
    };
    const result = dorksCollector.normalize(completedOutcome(raw));

    expect(result.entities.filter((e) => e.type === "person")).toHaveLength(1);
    expect(result.entities.filter((e) => e.type === "article")).toHaveLength(2);
    expect(result.relationships).toHaveLength(2);
    expect(result.relationships.every((r) => r.relationshipType === "MENTIONED_IN")).toBe(true);
  });

  test("an empty pubDate is stored as null metadata, never defaulted to today", () => {
    const raw: DorksRaw = {
      targetValue: "Example Corp",
      targetType: "person",
      query: "q",
      hits: [{ title: "t", source: "s", url: "https://example.com/x", pubDate: "" }],
      webDorks: [],
    };
    const result = dorksCollector.normalize(completedOutcome(raw));
    const article = result.entities.find((e) => e.type === "article")!;
    expect(article.metadata.publishedAt).toBeNull();
  });

  test("unexecuted web-scope dorks surface as warnings with their manual URL, never as fabricated results", () => {
    const raw: DorksRaw = {
      targetValue: "example.com",
      targetType: "domain",
      query: "q",
      hits: [],
      webDorks: [
        {
          template: {
            id: "web-login",
            label: "Login and admin portals",
            category: "Infrastructure",
            scope: "web",
            purpose: "p",
            pattern: "p",
          },
          query: "site:example.com inurl:login",
          manualUrl: "https://www.google.com/search?q=site:example.com+inurl:login",
        },
      ],
    };
    const result = dorksCollector.normalize(completedOutcome(raw));
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Login and admin portals");
    expect(result.warnings[0]).toContain("https://www.google.com/search");
  });

  test("failed execution returns an empty result carrying the error", () => {
    const outcome: CollectorRunOutcome<DorksRaw> = {
      execution: {
        status: "failed",
        startedAt: "2026-08-14T00:00:00.000Z",
        completedAt: "2026-08-14T00:00:01.000Z",
        durationMs: 500,
        resultCount: 0,
        error: {
          collector: "dorks",
          reason: "invalid-target",
          message: "A target is required to build a dork.",
        },
      },
      raw: null,
    };
    const result = dorksCollector.normalize(outcome);
    expect(result.entities).toEqual([]);
    expect(result.errors).toEqual(["A target is required to build a dork."]);
  });
});
