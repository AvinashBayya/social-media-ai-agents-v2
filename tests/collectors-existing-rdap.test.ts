import { afterEach, describe, expect, test } from "bun:test";
import { rdapCollector } from "../src/utils/collectors/existing/rdap";
import type { CollectorRunOutcome } from "../src/utils/collectors/types";
import type { RdapRaw } from "../src/utils/collectors/existing/rdap";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(make: () => Response | Promise<Response>) {
  globalThis.fetch = (async () => make()) as typeof fetch;
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function completedOutcome(raw: RdapRaw): CollectorRunOutcome<RdapRaw> {
  return {
    execution: {
      status: "completed",
      startedAt: "2026-08-14T00:00:00.000Z",
      completedAt: "2026-08-14T00:00:01.000Z",
      durationMs: 1000,
      resultCount: 1,
      error: null,
    },
    raw,
  };
}

describe("rdapCollector.execute", () => {
  test("extracts registrar (via vcard fn), created/expiration events and nameservers", async () => {
    stubFetch(() =>
      jsonRes({
        entities: [
          {
            roles: ["registrar"],
            vcardArray: [
              "vcard",
              [
                ["version", {}, "text", "4.0"],
                ["fn", {}, "text", "NameCheap, Inc."],
              ],
            ],
          },
        ],
        events: [
          { eventAction: "registration", eventDate: "2019-08-14T00:00:00Z" },
          { eventAction: "expiration", eventDate: "2027-08-14T00:00:00Z" },
        ],
        nameservers: [{ ldhName: "NS1.EXAMPLE.COM" }, { ldhName: "ns2.example.com" }],
      }),
    );
    const outcome = await rdapCollector.execute({ type: "domain", value: "example.com" });
    expect(outcome.execution.status).toBe("completed");
    expect(outcome.raw).toEqual({
      domain: "example.com",
      registered: true,
      registrar: "NameCheap, Inc.",
      createdAt: "2019-08-14T00:00:00Z",
      expiresAt: "2027-08-14T00:00:00Z",
      nameservers: ["ns1.example.com", "ns2.example.com"],
      payload: expect.anything(),
    });
  });

  test("falls back to the registrar entity's handle when vcard carries no fn", async () => {
    stubFetch(() =>
      jsonRes({
        entities: [{ roles: ["registrar"], handle: "REGISTRAR-123" }],
        events: [],
        nameservers: [],
      }),
    );
    const outcome = await rdapCollector.execute({ type: "domain", value: "example.com" });
    expect(outcome.raw!.registrar).toBe("REGISTRAR-123");
  });

  test("a 404 is a completed 'not registered' finding, never a fabricated registrar", async () => {
    stubFetch(() => new Response("", { status: 404 }));
    const outcome = await rdapCollector.execute({ type: "domain", value: "nonexistent.example" });
    expect(outcome.execution.status).toBe("completed");
    expect(outcome.raw).toEqual({
      domain: "nonexistent.example",
      registered: false,
      registrar: null,
      createdAt: null,
      expiresAt: null,
      nameservers: [],
      payload: null,
    });
  });

  test("a 429 fails with reason rate-limited", async () => {
    stubFetch(() => new Response("slow", { status: 429 }));
    const outcome = await rdapCollector.execute({ type: "domain", value: "example.com" });
    expect(outcome.execution.status).toBe("failed");
    expect(outcome.execution.error?.reason).toBe("rate-limited");
  });

  test("a record with no registrar entity leaves registrar null — never a guessed string like 'GoDaddy'", async () => {
    stubFetch(() => jsonRes({ entities: [], events: [], nameservers: [] }));
    const outcome = await rdapCollector.execute({ type: "domain", value: "example.com" });
    expect(outcome.raw!.registrar).toBeNull();
  });
});

describe("rdapCollector.normalize", () => {
  test("a registered domain with full data produces one domain entity and one evidence item", () => {
    const raw: RdapRaw = {
      domain: "example.com",
      registered: true,
      registrar: "NameCheap, Inc.",
      createdAt: "2019-08-14T00:00:00Z",
      expiresAt: "2027-08-14T00:00:00Z",
      nameservers: ["ns1.example.com"],
      payload: { raw: true },
    };
    const result = rdapCollector.normalize(completedOutcome(raw));
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]!.metadata.registrar).toBe("NameCheap, Inc.");
    expect(result.evidence).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  test("an unregistered domain produces a warning naming the 404, not a silent absence", () => {
    const raw: RdapRaw = {
      domain: "nonexistent.example",
      registered: false,
      registrar: null,
      createdAt: null,
      expiresAt: null,
      nameservers: [],
      payload: null,
    };
    const result = rdapCollector.normalize(completedOutcome(raw));
    expect(result.warnings[0]).toMatch(/not registered/i);
  });

  test("a registered domain with no registrar entity warns rather than omitting silently", () => {
    const raw: RdapRaw = {
      domain: "example.com",
      registered: true,
      registrar: null,
      createdAt: null,
      expiresAt: null,
      nameservers: [],
      payload: {},
    };
    const result = rdapCollector.normalize(completedOutcome(raw));
    expect(result.warnings[0]).toMatch(/no registrar entity/i);
  });
});
