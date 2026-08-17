import { afterEach, describe, expect, test } from "bun:test";
import { dnsCollector } from "../src/utils/collectors/existing/dns";
import type { CollectorRunOutcome } from "../src/utils/collectors/types";
import type { DnsRaw } from "../src/utils/collectors/existing/dns";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(make: () => Response | Promise<Response>) {
  globalThis.fetch = (async () => make()) as typeof fetch;
}

function dohResponse(status: number, answers: { data: string }[]) {
  return new Response(
    JSON.stringify({ Status: status, Answer: answers.map((a) => ({ type: 1, data: a.data })) }),
    { headers: { "content-type": "application/dns-json" } },
  );
}

function completedOutcome(raw: DnsRaw): CollectorRunOutcome<DnsRaw> {
  return {
    execution: {
      status: "completed",
      startedAt: "2026-08-14T00:00:00.000Z",
      completedAt: "2026-08-14T00:00:01.000Z",
      durationMs: 1000,
      resultCount: raw.addresses.length,
      error: null,
    },
    raw,
  };
}

describe("dnsCollector.execute", () => {
  test("rejects an IP-literal target — that belongs to the Shodan collector", async () => {
    const outcome = await dnsCollector.execute({ type: "domain", value: "8.8.8.8" });
    expect(outcome.raw).toBeNull();
    expect(outcome.execution.error?.reason).toBe("invalid-target");
  });

  test("resolves a domain to its public A records", async () => {
    stubFetch(() => dohResponse(0, [{ data: "93.184.216.34" }]));
    const outcome = await dnsCollector.execute({ type: "domain", value: "example.com" });
    expect(outcome.execution.status).toBe("completed");
    expect(outcome.raw).toEqual({ hostname: "example.com", addresses: ["93.184.216.34"] });
  });

  test("NXDOMAIN fails rather than resolving to an empty address list", async () => {
    stubFetch(() => dohResponse(3, []));
    const outcome = await dnsCollector.execute({ type: "domain", value: "nonexistent.example" });
    expect(outcome.execution.status).toBe("failed");
    expect(outcome.raw).toBeNull();
  });

  test("private-only resolution completes with zero addresses and a warning-worthy state, not a failure", async () => {
    stubFetch(() => dohResponse(0, [{ data: "10.0.0.5" }]));
    const outcome = await dnsCollector.execute({ type: "domain", value: "internal.example" });
    expect(outcome.execution.status).toBe("completed");
    expect(outcome.raw).toEqual({ hostname: "internal.example", addresses: [] });
  });
});

describe("dnsCollector.normalize", () => {
  test("emits a domain entity, one IP entity per address, and RESOLVES_TO relationships", () => {
    const raw: DnsRaw = { hostname: "example.com", addresses: ["93.184.216.34", "93.184.216.35"] };
    const result = dnsCollector.normalize(completedOutcome(raw));

    expect(result.entities.filter((e) => e.type === "domain")).toHaveLength(1);
    expect(result.entities.filter((e) => e.type === "ip")).toHaveLength(2);
    expect(result.relationships).toHaveLength(2);
    expect(result.relationships.every((r) => r.relationshipType === "RESOLVES_TO")).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  test("zero addresses produces a warning, not a fabricated resolution", () => {
    const raw: DnsRaw = { hostname: "internal.example", addresses: [] };
    const result = dnsCollector.normalize(completedOutcome(raw));
    expect(result.entities).toHaveLength(1); // just the domain
    expect(result.relationships).toEqual([]);
    expect(result.warnings[0]).toMatch(/no public A records/i);
  });

  test("failed execution returns an empty result carrying the error, not entities", () => {
    const outcome: CollectorRunOutcome<DnsRaw> = {
      execution: {
        status: "failed",
        startedAt: "2026-08-14T00:00:00.000Z",
        completedAt: "2026-08-14T00:00:01.000Z",
        durationMs: 500,
        resultCount: 0,
        error: {
          collector: "dns",
          reason: "invalid-target",
          message: "does not resolve (NXDOMAIN)",
        },
      },
      raw: null,
    };
    const result = dnsCollector.normalize(outcome);
    expect(result.entities).toEqual([]);
    expect(result.errors).toEqual(["does not resolve (NXDOMAIN)"]);
  });
});
