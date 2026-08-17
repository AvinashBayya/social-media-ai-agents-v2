import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spiderFootCollector } from "../src/utils/collectors/external/spiderfoot";
import type { CollectorRunOutcome } from "../src/utils/collectors/types";
import type { SpiderFootRaw } from "../src/utils/collectors/external/spiderfoot";

const ENV_KEYS = [
  "SPIDERFOOT_WORKER_URL",
  "SPIDERFOOT_POLL_INTERVAL_MS",
  "SPIDERFOOT_MAX_WAIT_MS",
  "SPIDERFOOT_USE_CASE",
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const originalFetch = globalThis.fetch;

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const k of ENV_KEYS) {
    const v = originalEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Every polling test uses a tiny interval/budget so nothing here waits on a real clock. */
function useFastPolling() {
  process.env.SPIDERFOOT_WORKER_URL = "https://spiderfoot.internal";
  process.env.SPIDERFOOT_POLL_INTERVAL_MS = "5";
  process.env.SPIDERFOOT_MAX_WAIT_MS = "200";
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init)) as typeof fetch;
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function completedOutcome(raw: SpiderFootRaw): CollectorRunOutcome<SpiderFootRaw> {
  return {
    execution: {
      status: "completed",
      startedAt: "2026-08-14T00:00:00.000Z",
      completedAt: "2026-08-14T00:00:01.000Z",
      durationMs: 1000,
      resultCount: raw.events.length,
      error: null,
    },
    raw,
  };
}

describe("spiderFootCollector.execute — unconfigured worker (the default, real state)", () => {
  test("fails as unavailable without attempting any request", async () => {
    const outcome = await spiderFootCollector.execute({ type: "domain", value: "example.com" });
    expect(outcome.raw).toBeNull();
    expect(outcome.execution.error?.reason).toBe("unavailable");
    expect(outcome.execution.error?.message).toContain("SPIDERFOOT_WORKER_URL");
  });
});

describe("spiderFootCollector.execute — configured worker", () => {
  test("starts a scan with the passive use-case by default, polls until FINISHED, then fetches events", async () => {
    useFastPolling();
    let statusCalls = 0;
    stubFetch((url, init) => {
      if (url.endsWith("/startscan")) {
        const body = JSON.parse(String(init?.body));
        expect(body.usecase).toBe("passive");
        expect(body.scantarget).toBe("example.com");
        return jsonRes({ id: "scan-1" });
      }
      if (url.includes("/scanstatus")) {
        statusCalls += 1;
        // RUNNING once, then FINISHED — exercises the poll loop, not just one shot.
        return jsonRes({ status: statusCalls === 1 ? "RUNNING" : "FINISHED" });
      }
      if (url.includes("/scaneventresults")) {
        return jsonRes([
          { type: "EMAILADDR", data: "a@example.com", module: "sfp_dns", source: null },
        ]);
      }
      throw new Error(`unexpected URL: ${url}`);
    });

    const outcome = await spiderFootCollector.execute({ type: "domain", value: "example.com" });
    expect(outcome.execution.status).toBe("completed");
    expect(outcome.raw).toEqual({
      target: "example.com",
      scanId: "scan-1",
      status: "FINISHED",
      events: [{ type: "EMAILADDR", data: "a@example.com", module: "sfp_dns", source: null }],
    });
    expect(statusCalls).toBeGreaterThanOrEqual(2);
  });

  test("an immediate FINISHED status needs no polling loop", async () => {
    useFastPolling();
    stubFetch((url) => {
      if (url.endsWith("/startscan")) return jsonRes({ id: "scan-2" });
      if (url.includes("/scanstatus")) return jsonRes({ status: "FINISHED" });
      if (url.includes("/scaneventresults")) return jsonRes([]);
      throw new Error(`unexpected URL: ${url}`);
    });
    const outcome = await spiderFootCollector.execute({ type: "domain", value: "example.com" });
    expect(outcome.execution.status).toBe("completed");
  });

  test("an ERROR-* status fails the job with the real cause, not an empty result", async () => {
    useFastPolling();
    stubFetch((url) => {
      if (url.endsWith("/startscan")) return jsonRes({ id: "scan-3" });
      if (url.includes("/scanstatus")) return jsonRes({ status: "ERROR-FAILED" });
      throw new Error(`unexpected URL: ${url}`);
    });
    const outcome = await spiderFootCollector.execute({ type: "domain", value: "example.com" });
    expect(outcome.execution.status).toBe("failed");
    expect(outcome.raw).toBeNull();
    expect(outcome.execution.error?.message).toContain("ERROR-FAILED");
  });

  test("never reaching a terminal status within the configured budget fails, rather than hanging or returning empty", async () => {
    useFastPolling();
    stubFetch((url) => {
      if (url.endsWith("/startscan")) return jsonRes({ id: "scan-4" });
      if (url.includes("/scanstatus")) return jsonRes({ status: "RUNNING" });
      throw new Error(`unexpected URL: ${url}`);
    });
    const outcome = await spiderFootCollector.execute({ type: "domain", value: "example.com" });
    expect(outcome.execution.status).toBe("failed");
    expect(outcome.execution.error?.message).toContain("did not finish within");
  });

  test("a malformed /startscan response (no scan id) fails cleanly", async () => {
    useFastPolling();
    stubFetch((url) => {
      if (url.endsWith("/startscan")) return jsonRes({ ok: true });
      throw new Error(`unexpected URL: ${url}`);
    });
    const outcome = await spiderFootCollector.execute({ type: "domain", value: "example.com" });
    expect(outcome.execution.status).toBe("failed");
  });

  test("a rate limit on /startscan fails with reason rate-limited", async () => {
    useFastPolling();
    stubFetch(() => new Response("slow", { status: 429 }));
    const outcome = await spiderFootCollector.execute({ type: "domain", value: "example.com" });
    expect(outcome.execution.error?.reason).toBe("rate-limited");
  });
});

describe("spiderFootCollector.normalize", () => {
  test("a mapped event type (email) produces an entity and a HAS_EMAIL relationship", () => {
    const raw: SpiderFootRaw = {
      target: "example.com",
      scanId: "scan-1",
      status: "FINISHED",
      events: [{ type: "EMAILADDR", data: "a@example.com", module: "sfp_dns", source: null }],
    };
    const result = spiderFootCollector.normalize(completedOutcome(raw));
    expect(result.entities.some((e) => e.type === "email" && e.value === "a@example.com")).toBe(
      true,
    );
    expect(result.relationships.some((r) => r.relationshipType === "HAS_EMAIL")).toBe(true);
  });

  test("an unmapped event type produces evidence but no entity, and is named in a warning", () => {
    const raw: SpiderFootRaw = {
      target: "example.com",
      scanId: "scan-1",
      status: "FINISHED",
      events: [{ type: "SOME_OBSCURE_TYPE", data: "whatever", module: "sfp_x", source: null }],
    };
    const result = spiderFootCollector.normalize(completedOutcome(raw));
    expect(result.entities).toHaveLength(1); // just the queried domain
    expect(result.evidence).toHaveLength(1);
    expect(result.warnings.some((w) => w.includes("SOME_OBSCURE_TYPE"))).toBe(true);
  });

  test("zero events warns rather than silently reporting a clean scan", () => {
    const raw: SpiderFootRaw = {
      target: "example.com",
      scanId: "scan-1",
      status: "FINISHED",
      events: [],
    };
    const result = spiderFootCollector.normalize(completedOutcome(raw));
    expect(result.warnings.some((w) => w.includes("zero events"))).toBe(true);
  });

  test("failed execution (raw null) returns an empty result carrying the error", () => {
    const outcome: CollectorRunOutcome<SpiderFootRaw> = {
      execution: {
        status: "failed",
        startedAt: "2026-08-14T00:00:00.000Z",
        completedAt: "2026-08-14T00:00:01.000Z",
        durationMs: 500,
        resultCount: 0,
        error: {
          collector: "spiderfoot",
          reason: "unavailable",
          message: "SPIDERFOOT_WORKER_URL is not configured.",
        },
      },
      raw: null,
    };
    const result = spiderFootCollector.normalize(outcome);
    expect(result.entities).toEqual([]);
    expect(result.errors).toEqual(["SPIDERFOOT_WORKER_URL is not configured."]);
  });
});

describe("spiderFootCollector.healthCheck", () => {
  test("reports unavailable when no worker is configured — the current, real state", async () => {
    const health = await spiderFootCollector.healthCheck();
    expect(health.state).toBe("unavailable");
  });

  test("reports ready when a configured worker answers /scanlist", async () => {
    process.env.SPIDERFOOT_WORKER_URL = "https://spiderfoot.internal";
    stubFetch((url) => {
      expect(url).toBe("https://spiderfoot.internal/scanlist");
      return jsonRes([]);
    });
    const health = await spiderFootCollector.healthCheck();
    expect(health.state).toBe("ready");
  });
});
