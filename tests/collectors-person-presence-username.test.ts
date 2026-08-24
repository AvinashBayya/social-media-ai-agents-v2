import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { presenceUsernameCollector } from "../src/utils/collectors/person/presence-username";

const ENV = "SHERLOCK_WORKER_URL";
const originalFetch = globalThis.fetch;
const originalUrl = process.env[ENV];

beforeEach(() => {
  delete process.env[ENV];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env[ENV];
  else process.env[ENV] = originalUrl;
});

function stubFetch(make: () => Response | Promise<Response>) {
  globalThis.fetch = (async () => make()) as typeof fetch;
}

describe("presenceUsernameCollector.execute — a keyless in-process fallback checks real public APIs when no worker is configured", () => {
  // The four checks below (GitHub/Reddit/HackerNews/Dev.to) each call a real
  // public API directly via the global `fetch`, so a single canned stubFetch
  // response can't distinguish them, and asserting on which sites report
  // "found" would make this test depend on live network reachability. Assert
  // instead on what execute()'s own fallback branch guarantees regardless:
  // it completes (never "unavailable") and always reports sitesChecked === 4.
  test("no worker configured falls back to real existence checks — completed, not unavailable", async () => {
    const outcome = await presenceUsernameCollector.execute({ type: "username", value: "johnsmith" });
    expect(outcome.execution.status).toBe("completed");
    expect(outcome.raw).not.toBeNull();
    expect(outcome.raw?.sitesChecked).toBe(4);
  });

  test("rejects an empty username without even checking the worker URL", async () => {
    process.env[ENV] = "http://localhost:9999";
    const outcome = await presenceUsernameCollector.execute({ type: "username", value: "" });
    expect(outcome.execution.error?.reason).toBe("invalid-target");
  });

  test("a configured worker's found sites become entities, unfound is a real zero — not a fabricated hit", async () => {
    process.env[ENV] = "http://localhost:9999";
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            found: [{ site: "GitHub", url: "https://github.com/johnsmith" }],
            sitesChecked: 300,
          }),
          { status: 200 },
        ),
    );
    const outcome = await presenceUsernameCollector.execute({ type: "username", value: "johnsmith" });
    expect(outcome.execution.status).toBe("completed");
    expect(outcome.raw?.found).toHaveLength(1);
    expect(outcome.raw?.sitesChecked).toBe(300);
  });

  test("a worker error surfaces as upstream-error, never silently treated as zero results", async () => {
    process.env[ENV] = "http://localhost:9999";
    stubFetch(() => new Response(null, { status: 500 }));
    const outcome = await presenceUsernameCollector.execute({ type: "username", value: "johnsmith" });
    expect(outcome.execution.error?.reason).toBe("upstream-error");
  });
});

describe("presenceUsernameCollector.normalize — existence only, never profile content", () => {
  test("a found site becomes a social_account entity plus a USES_USERNAME edge", async () => {
    process.env[ENV] = "http://localhost:9999";
    stubFetch(
      () =>
        new Response(
          JSON.stringify({ found: [{ site: "GitHub", url: "https://github.com/johnsmith" }] }),
          { status: 200 },
        ),
    );
    const outcome = await presenceUsernameCollector.execute({ type: "username", value: "johnsmith" });
    const result = presenceUsernameCollector.normalize(outcome);
    expect(result.entities.some((e) => e.type === "social_account")).toBe(true);
    expect(result.relationships.some((r) => r.relationshipType === "USES_USERNAME")).toBe(true);
  });

  test("evidence carries only site+url — never bio text, follower counts, or any profile content field", async () => {
    process.env[ENV] = "http://localhost:9999";
    stubFetch(
      () =>
        new Response(
          JSON.stringify({ found: [{ site: "GitHub", url: "https://github.com/johnsmith" }] }),
          { status: 200 },
        ),
    );
    const outcome = await presenceUsernameCollector.execute({ type: "username", value: "johnsmith" });
    const result = presenceUsernameCollector.normalize(outcome);
    expect(Object.keys(result.evidence[0].rawValue as object).sort()).toEqual(["site", "url"]);
  });

  test("zero found sites produces a clear warning, not a silently empty result", async () => {
    process.env[ENV] = "http://localhost:9999";
    stubFetch(() => new Response(JSON.stringify({ found: [], sitesChecked: 300 }), { status: 200 }));
    const outcome = await presenceUsernameCollector.execute({ type: "username", value: "johnsmith" });
    const result = presenceUsernameCollector.normalize(outcome);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe("presenceUsernameCollector.healthCheck", () => {
  test("reports unavailable when no worker is configured", async () => {
    const health = await presenceUsernameCollector.healthCheck();
    expect(health.state).toBe("unavailable");
  });
});
