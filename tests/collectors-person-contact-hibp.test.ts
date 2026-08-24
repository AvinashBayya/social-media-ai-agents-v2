import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { contactHibpCollector } from "../src/utils/collectors/person/contact-hibp";

const ENV = "HIBP_API_KEY";
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

function stubFetch(make: () => Response | Promise<Response>) {
  globalThis.fetch = (async () => make()) as typeof fetch;
}

describe("contactHibpCollector.execute — key-gated, exposure flag only", () => {
  test("no key configured reports no-credential, never a fabricated zero-breach result", async () => {
    const outcome = await contactHibpCollector.execute({ type: "email", value: "john@example.com" });
    expect(outcome.raw).toBeNull();
    expect(outcome.execution.error?.reason).toBe("no-credential");
  });

  test("HIBP's documented 404 (not found in any breach) is a real, measured negative", async () => {
    process.env[ENV] = "test-key";
    stubFetch(() => new Response(null, { status: 404 }));
    const outcome = await contactHibpCollector.execute({ type: "email", value: "clean@example.com" });
    expect(outcome.execution.status).toBe("completed");
    expect(outcome.raw?.exposed).toBe(false);
    expect(outcome.raw?.breachCount).toBe(0);
  });

  test("a real breach list collapses to exposed + count only — no breach names ever reach raw", async () => {
    process.env[ENV] = "test-key";
    stubFetch(
      () =>
        new Response(
          JSON.stringify([{ Name: "AdobeBreach" }, { Name: "LinkedInBreach" }]),
          { status: 200 },
        ),
    );
    const outcome = await contactHibpCollector.execute({ type: "email", value: "exposed@example.com" });
    expect(outcome.raw).toEqual({ email: "exposed@example.com", exposed: true, breachCount: 2 });
    expect(JSON.stringify(outcome.raw)).not.toContain("Adobe");
    expect(JSON.stringify(outcome.raw)).not.toContain("LinkedIn");
  });

  test("a rejected key (401) is distinguishable from no key at all", async () => {
    process.env[ENV] = "bad-key";
    stubFetch(() => new Response(null, { status: 401 }));
    const outcome = await contactHibpCollector.execute({ type: "email", value: "john@example.com" });
    expect(outcome.execution.error?.reason).toBe("no-credential");
    expect(outcome.execution.error?.message).toContain("401");
  });

  test("a rate limit (429) is its own distinguishable reason, not a generic failure", async () => {
    process.env[ENV] = "test-key";
    stubFetch(() => new Response(null, { status: 429 }));
    const outcome = await contactHibpCollector.execute({ type: "email", value: "john@example.com" });
    expect(outcome.execution.error?.reason).toBe("rate-limited");
  });
});

describe("contactHibpCollector.normalize — no breach content leaks into evidence either", () => {
  test("exposed evidence carries only { exposed, breachCount }", async () => {
    process.env[ENV] = "test-key";
    stubFetch(() => new Response(JSON.stringify([{ Name: "SomeBreach" }]), { status: 200 }));
    const outcome = await contactHibpCollector.execute({ type: "email", value: "exposed@example.com" });
    const result = contactHibpCollector.normalize(outcome);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0].rawValue).toEqual({ exposed: true, breachCount: 1 });
    expect(JSON.stringify(result.evidence[0])).not.toContain("SomeBreach");
  });

  test("a no-credential failure normalizes via the shared empty-result path", async () => {
    const outcome = await contactHibpCollector.execute({ type: "email", value: "john@example.com" });
    const result = contactHibpCollector.normalize(outcome);
    expect(result.entities).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe("contactHibpCollector.healthCheck", () => {
  test("reports no-credential when unset", async () => {
    const health = await contactHibpCollector.healthCheck();
    expect(health.state).toBe("no-credential");
  });

  test("reports ready when a key is configured", async () => {
    process.env[ENV] = "test-key";
    const health = await contactHibpCollector.healthCheck();
    expect(health.state).toBe("ready");
  });
});
