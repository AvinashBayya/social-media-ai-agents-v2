import { afterEach, describe, expect, test } from "bun:test";
import { crtshCollector } from "../src/utils/collectors/existing/crtsh";
import type { CollectorRunOutcome } from "../src/utils/collectors/types";
import type { CrtShRaw } from "../src/utils/collectors/existing/crtsh";

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

function completedOutcome(raw: CrtShRaw): CollectorRunOutcome<CrtShRaw> {
  return {
    execution: {
      status: "completed",
      startedAt: "2026-08-14T00:00:00.000Z",
      completedAt: "2026-08-14T00:00:01.000Z",
      durationMs: 1000,
      resultCount: raw.length,
      error: null,
    },
    raw,
  };
}

describe("crtshCollector.execute", () => {
  test("rejects a non-domain target without a network call", async () => {
    const outcome = await crtshCollector.execute({ type: "email", value: "a@example.com" });
    expect(outcome.raw).toBeNull();
    expect(outcome.execution.status).toBe("failed");
    expect(outcome.execution.error?.reason).toBe("invalid-target");
  });

  test("completes with findings on a successful lookup", async () => {
    stubFetch(() =>
      jsonRes([{ name_value: "api.example.com", not_before: "2026-01-01T00:00:00" }]),
    );
    const outcome = await crtshCollector.execute({ type: "domain", value: "example.com" });
    expect(outcome.execution.status).toBe("completed");
    expect(outcome.raw).toHaveLength(1);
    expect(outcome.raw![0]!.hostname).toBe("api.example.com");
  });

  test("a rate limit fails with reason rate-limited, not an empty result (Rule 5)", async () => {
    stubFetch(() => new Response("slow down", { status: 429 }));
    const outcome = await crtshCollector.execute({ type: "domain", value: "example.com" });
    expect(outcome.execution.status).toBe("failed");
    expect(outcome.raw).toBeNull();
    expect(outcome.execution.error?.reason).toBe("rate-limited");
  });

  test("a genuinely empty result set is completed with zero findings, not a failure", async () => {
    stubFetch(() => jsonRes([]));
    const outcome = await crtshCollector.execute({ type: "domain", value: "example.com" });
    expect(outcome.execution.status).toBe("completed");
    expect(outcome.raw).toEqual([]);
  });
});

describe("crtshCollector.normalize", () => {
  test("failed execution (raw null) returns an empty, schema-valid result carrying the error", () => {
    const outcome: CollectorRunOutcome<CrtShRaw> = {
      execution: {
        status: "failed",
        startedAt: "2026-08-14T00:00:00.000Z",
        completedAt: "2026-08-14T00:00:01.000Z",
        durationMs: 1000,
        resultCount: 0,
        error: {
          collector: "crtsh",
          reason: "rate-limited",
          message: "crt.sh rate-limited the request",
        },
      },
      raw: null,
    };
    const result = crtshCollector.normalize(outcome);
    expect(result.entities).toEqual([]);
    expect(result.errors).toEqual(["crt.sh rate-limited the request"]);
  });

  test("builds a domain entity per subdomain plus the parent domain, linked by OWNS_DOMAIN", () => {
    const raw: CrtShRaw = [
      {
        hostname: "api.example.com",
        source: "crtsh",
        firstSeen: "2026-01-01",
        issuer: "Let's Encrypt",
      },
      { hostname: "vpn.example.com", source: "crtsh", firstSeen: null, issuer: null },
    ];
    const result = crtshCollector.normalize(completedOutcome(raw));

    const hostnames = result.entities.map((e) => e.value).sort();
    expect(hostnames).toEqual(["api.example.com", "example.com", "vpn.example.com"]);

    const parent = result.entities.find((e) => e.value === "example.com")!;
    expect(result.relationships).toHaveLength(2);
    for (const rel of result.relationships) {
      expect(rel.relationshipType).toBe("OWNS_DOMAIN");
      expect(rel.sourceEntity).toBe(parent.id);
    }
  });

  test("every finding produces an evidence item carrying source, collector and collection time (Rule 6)", () => {
    const raw: CrtShRaw = [
      { hostname: "api.example.com", source: "crtsh", firstSeen: "2026-01-01", issuer: null },
    ];
    const result = crtshCollector.normalize(completedOutcome(raw));
    expect(result.evidence).toHaveLength(1);
    const ev = result.evidence[0]!;
    expect(ev.source).toBe("crt.sh");
    expect(ev.collector).toBe("crtsh");
    expect(ev.collectedAt).toBeTruthy();
    expect(ev.sourceUrl).toContain("crt.sh");
  });

  test("an empty finding list produces no entities and no relationships", () => {
    const result = crtshCollector.normalize(completedOutcome([]));
    expect(result.entities).toEqual([]);
    expect(result.relationships).toEqual([]);
  });
});
