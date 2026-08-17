import { afterEach, describe, expect, test } from "bun:test";
import { jinaReaderCollector } from "../src/utils/collectors/external/jina-reader";
import type { JinaReaderRaw } from "../src/utils/collectors/external/jina-reader";
import type { CollectorRunOutcome } from "../src/utils/collectors/types";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
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

function completedOutcome(raw: JinaReaderRaw): CollectorRunOutcome<JinaReaderRaw> {
  return {
    execution: {
      status: "completed",
      startedAt: "2026-08-17T00:00:00.000Z",
      completedAt: "2026-08-17T00:00:01.000Z",
      durationMs: 1000,
      resultCount: 1,
      error: null,
    },
    raw,
  };
}

// Response shapes below are what r.jina.ai actually returned when verified
// live against https://example.com during development — not guessed.
const REAL_SUCCESS_BODY = {
  code: 200,
  status: 200,
  data: {
    title: "Example Domain",
    description: "",
    url: "https://example.com/",
    content: "This domain is for use in documentation examples without needing permission.",
    publishedTime: "Wed, 12 Aug 2026 20:17:18 GMT",
    metadata: { lang: "en" },
    httpStatus: 200,
    httpStatusText: "",
  },
};

const REAL_TARGET_404_BODY = {
  code: 200,
  status: 200,
  data: {
    title: "Example Domain",
    description: "",
    url: "https://example.com/this-page-does-not-exist-xyz123",
    content: "This domain is for use in documentation examples without needing permission.",
    warning: "Target URL returned error 404: Not Found",
    metadata: { lang: "en" },
    httpStatus: 404,
    httpStatusText: "",
  },
};

const REAL_MALFORMED_URL_BODY = {
  data: null,
  path: "url",
  code: 422,
  name: "SubmittedDataMalformedError",
  status: 42203,
  message: "Domain 'not-a-real-url' could not be resolved",
  readableMessage: "SubmittedDataMalformedError: Domain 'not-a-real-url' could not be resolved",
};

describe("jinaReaderCollector.execute", () => {
  test("rejects a non-http(s) target without a network call", async () => {
    let called = false;
    stubFetch(() => {
      called = true;
      return jsonRes({});
    });
    const outcome = await jinaReaderCollector.execute({ type: "url", value: "example.com" });
    expect(called).toBe(false);
    expect(outcome.raw).toBeNull();
    expect(outcome.execution.status).toBe("failed");
    expect(outcome.execution.error?.reason).toBe("invalid-target");
  });

  test("completes with real-shaped content on a clean fetch", async () => {
    stubFetch(() => jsonRes(REAL_SUCCESS_BODY));
    const outcome = await jinaReaderCollector.execute({
      type: "url",
      value: "https://example.com",
    });
    expect(outcome.execution.status).toBe("completed");
    expect(outcome.raw?.title).toBe("Example Domain");
    expect(outcome.raw?.content).toContain("documentation examples");
    expect(outcome.raw?.targetHttpStatus).toBe(200);
    expect(outcome.raw?.warning).toBeNull();
  });

  test("a target 404 still completes (r.jina.ai itself answered 200) but carries the real target status", async () => {
    stubFetch(() => jsonRes(REAL_TARGET_404_BODY));
    const outcome = await jinaReaderCollector.execute({
      type: "url",
      value: "https://example.com/this-page-does-not-exist-xyz123",
    });
    expect(outcome.execution.status).toBe("completed");
    expect(outcome.raw?.targetHttpStatus).toBe(404);
    expect(outcome.raw?.warning).toContain("404");
  });

  test("a malformed URL (422 at the outer HTTP layer) is a real execute() failure", async () => {
    stubFetch(() => jsonRes(REAL_MALFORMED_URL_BODY, 422));
    const outcome = await jinaReaderCollector.execute({
      type: "url",
      value: "https://not-a-real-url",
    });
    expect(outcome.raw).toBeNull();
    expect(outcome.execution.status).toBe("failed");
    expect(outcome.execution.error?.reason).toBe("upstream-error");
    expect(outcome.execution.error?.message).toContain("could not be resolved");
  });

  test("a 429 is classified as rate-limited, not a generic failure", async () => {
    stubFetch(() => jsonRes({ message: "rate limit exceeded" }, 429));
    const outcome = await jinaReaderCollector.execute({
      type: "url",
      value: "https://example.com",
    });
    expect(outcome.execution.error?.reason).toBe("rate-limited");
  });

  test("a response with no data.content is a failure, not a fabricated empty article", async () => {
    stubFetch(() => jsonRes({ code: 200, data: { title: "X" } }));
    const outcome = await jinaReaderCollector.execute({
      type: "url",
      value: "https://example.com",
    });
    expect(outcome.raw).toBeNull();
    expect(outcome.execution.status).toBe("failed");
  });

  test("a network-level throw is classified, not left to crash the caller", async () => {
    stubFetch(() => {
      throw new Error("fetch failed: unreachable");
    });
    const outcome = await jinaReaderCollector.execute({
      type: "url",
      value: "https://example.com",
    });
    expect(outcome.raw).toBeNull();
    expect(outcome.execution.status).toBe("failed");
  });
});

describe("jinaReaderCollector.normalize", () => {
  test("a failed outcome normalizes to an empty result carrying the real error", () => {
    const result = jinaReaderCollector.normalize({
      execution: {
        status: "failed",
        startedAt: "2026-08-17T00:00:00.000Z",
        completedAt: "2026-08-17T00:00:01.000Z",
        durationMs: 1000,
        resultCount: 0,
        error: { collector: "jina-reader", reason: "invalid-target", message: "not a URL" },
      },
      raw: null,
    });
    expect(result.entities).toEqual([]);
    expect(result.errors).toContain("not a URL");
  });

  test("a clean fetch produces an article entity, a domain entity, and a HOSTED_ON relationship", () => {
    const outcome = completedOutcome({
      requestedUrl: "https://example.com",
      resolvedUrl: "https://example.com/",
      title: "Example Domain",
      content: "This domain is for use in documentation examples.",
      publishedTime: "Wed, 12 Aug 2026 20:17:18 GMT",
      targetHttpStatus: 200,
      warning: null,
    });
    const result = jinaReaderCollector.normalize(outcome);
    expect(result.entities).toHaveLength(2);
    const article = result.entities.find((e) => e.type === "article")!;
    const domain = result.entities.find((e) => e.type === "domain")!;
    expect(article.displayName).toBe("Example Domain");
    expect(domain.value).toBe("example.com");
    expect(result.relationships).toHaveLength(1);
    expect(result.relationships[0]!.relationshipType).toBe("HOSTED_ON");
    expect(result.relationships[0]!.sourceEntity).toBe(article.id);
    expect(result.relationships[0]!.targetEntity).toBe(domain.id);
    expect(result.warnings).toEqual([]);
  });

  test("a null title falls back to the resolved URL as the display name, never a fabricated title", () => {
    const outcome = completedOutcome({
      requestedUrl: "https://example.com/page",
      resolvedUrl: "https://example.com/page",
      title: null,
      content: "body text",
      publishedTime: null,
      targetHttpStatus: 200,
      warning: null,
    });
    const result = jinaReaderCollector.normalize(outcome);
    const article = result.entities.find((e) => e.type === "article")!;
    expect(article.displayName).toBe("https://example.com/page");
  });

  test("a non-2xx target status produces an honest warning, not a silently-presented stale page", () => {
    const outcome = completedOutcome({
      requestedUrl: "https://example.com/gone",
      resolvedUrl: "https://example.com/gone",
      title: "Example Domain",
      content: "fallback content",
      publishedTime: null,
      targetHttpStatus: 404,
      warning: "Target URL returned error 404: Not Found",
    });
    const result = jinaReaderCollector.normalize(outcome);
    expect(result.warnings.some((w) => w.includes("404"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("Jina Reader: Target URL returned"))).toBe(true);
  });

  test("no publishedTime means no publishedTime in metadata — never defaulted to collection time", () => {
    const outcome = completedOutcome({
      requestedUrl: "https://example.com",
      resolvedUrl: "https://example.com",
      title: "X",
      content: "body",
      publishedTime: null,
      targetHttpStatus: 200,
      warning: null,
    });
    const result = jinaReaderCollector.normalize(outcome);
    const article = result.entities.find((e) => e.type === "article")!;
    expect(article.metadata).toEqual({});
  });

  test("evidence carries the full extracted content and the real source URL", () => {
    const outcome = completedOutcome({
      requestedUrl: "https://example.com",
      resolvedUrl: "https://example.com/",
      title: "Example Domain",
      content: "the full extracted body",
      publishedTime: null,
      targetHttpStatus: 200,
      warning: null,
    });
    const result = jinaReaderCollector.normalize(outcome);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]!.sourceUrl).toBe("https://example.com/");
    expect(result.evidence[0]!.normalizedValue).toMatchObject({
      content: "the full extracted body",
    });
  });
});

describe("jinaReaderCollector.healthCheck", () => {
  test("reports ready on a healthy response", async () => {
    stubFetch(() => new Response("ok", { status: 200 }));
    const health = await jinaReaderCollector.healthCheck();
    expect(health.state).toBe("ready");
  });

  test("reports degraded on a non-ok response, unavailable never confused with a config gap", async () => {
    stubFetch(() => new Response("error", { status: 503 }));
    const health = await jinaReaderCollector.healthCheck();
    expect(health.state).toBe("degraded");
  });

  test("reports unavailable when the request throws", async () => {
    stubFetch(() => {
      throw new Error("network down");
    });
    const health = await jinaReaderCollector.healthCheck();
    expect(health.state).toBe("unavailable");
  });
});

describe("jinaReaderCollector metadata", () => {
  test("requires no credentials — it is a free, keyless public API", () => {
    expect(jinaReaderCollector.requiresCredentials).toBe(false);
  });

  test("only supports url targets", () => {
    expect(jinaReaderCollector.supportedTargetTypes).toEqual(["url"]);
  });
});
