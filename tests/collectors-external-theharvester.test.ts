import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_SOURCES,
  parseHostEntry,
  theHarvesterCollector,
} from "../src/utils/collectors/external/theharvester";
import type { CollectorRunOutcome } from "../src/utils/collectors/types";
import type { TheHarvesterRaw } from "../src/utils/collectors/external/theharvester";

const WORKER_URL = "THEHARVESTER_WORKER_URL";
const originalUrl = process.env[WORKER_URL];
const originalFetch = globalThis.fetch;

beforeEach(() => {
  delete process.env[WORKER_URL];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env[WORKER_URL];
  else process.env[WORKER_URL] = originalUrl;
});

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init)) as typeof fetch;
}

function completedOutcome(raw: TheHarvesterRaw): CollectorRunOutcome<TheHarvesterRaw> {
  return {
    execution: {
      status: "completed",
      startedAt: "2026-08-14T00:00:00.000Z",
      completedAt: "2026-08-14T00:00:01.000Z",
      durationMs: 1000,
      resultCount: raw.emails.length + raw.hosts.length + raw.ips.length + raw.urls.length,
      error: null,
    },
    raw,
  };
}

describe("parseHostEntry", () => {
  test("splits hostname:ip", () => {
    expect(parseHostEntry("mail.example.com:1.2.3.4")).toEqual({
      hostname: "mail.example.com",
      ip: "1.2.3.4",
    });
  });

  test("a bare hostname with no ip suffix leaves ip null, never fabricated", () => {
    expect(parseHostEntry("mail.example.com")).toEqual({ hostname: "mail.example.com", ip: null });
  });
});

describe("theHarvesterCollector.execute — unconfigured worker (the default, real state)", () => {
  test("fails as unavailable without attempting any request when THEHARVESTER_WORKER_URL is unset", async () => {
    const outcome = await theHarvesterCollector.execute({ type: "domain", value: "example.com" });
    expect(outcome.raw).toBeNull();
    expect(outcome.execution.status).toBe("failed");
    expect(outcome.execution.error?.reason).toBe("unavailable");
    expect(outcome.execution.error?.message).toContain("THEHARVESTER_WORKER_URL");
  });
});

describe("theHarvesterCollector.execute — configured worker", () => {
  beforeEach(() => {
    process.env[WORKER_URL] = "https://harvester.internal";
  });

  test("posts domain + default (non-'all') sources, parses the JSON response", async () => {
    stubFetch((url, init) => {
      expect(url).toBe("https://harvester.internal/harvest");
      const body = JSON.parse(String(init?.body));
      expect(body.domain).toBe("example.com");
      expect(body.sources).toEqual(DEFAULT_SOURCES);
      expect(body.sources).not.toContain("all");
      return new Response(
        JSON.stringify({
          emails: ["a@example.com"],
          hosts: ["mail.example.com:1.2.3.4"],
          ips: ["5.6.7.8"],
          urls: ["https://example.com/x"],
        }),
      );
    });

    const outcome = await theHarvesterCollector.execute({ type: "domain", value: "example.com" });
    expect(outcome.execution.status).toBe("completed");
    expect(outcome.raw).toEqual({
      domain: "example.com",
      sources: DEFAULT_SOURCES,
      emails: ["a@example.com"],
      hosts: ["mail.example.com:1.2.3.4"],
      ips: ["5.6.7.8"],
      urls: ["https://example.com/x"],
    });
  });

  test("a rate limit fails with reason rate-limited, not an empty result (Rule 5)", async () => {
    stubFetch(() => new Response("slow", { status: 429 }));
    const outcome = await theHarvesterCollector.execute({ type: "domain", value: "example.com" });
    expect(outcome.execution.status).toBe("failed");
    expect(outcome.execution.error?.reason).toBe("rate-limited");
  });

  test("a malformed/non-array field degrades to an empty array rather than throwing", async () => {
    stubFetch(() => new Response(JSON.stringify({ emails: "not-an-array", hosts: null })));
    const outcome = await theHarvesterCollector.execute({ type: "domain", value: "example.com" });
    expect(outcome.execution.status).toBe("completed");
    expect(outcome.raw!.emails).toEqual([]);
    expect(outcome.raw!.hosts).toEqual([]);
  });

  test("a network failure fails the job, never silently returns zero findings", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const outcome = await theHarvesterCollector.execute({ type: "domain", value: "example.com" });
    expect(outcome.execution.status).toBe("failed");
    expect(outcome.raw).toBeNull();
  });
});

describe("theHarvesterCollector.normalize", () => {
  test("emails become HAS_EMAIL edges from the queried domain", () => {
    const raw: TheHarvesterRaw = {
      domain: "example.com",
      sources: DEFAULT_SOURCES,
      emails: ["a@example.com"],
      hosts: [],
      ips: [],
      urls: [],
    };
    const result = theHarvesterCollector.normalize(completedOutcome(raw));
    expect(result.entities.filter((e) => e.type === "email")).toHaveLength(1);
    expect(result.relationships).toHaveLength(1);
    expect(result.relationships[0]!.relationshipType).toBe("HAS_EMAIL");
  });

  test("a host with an ip suffix produces both a domain entity and an ip entity, linked by RESOLVES_TO", () => {
    const raw: TheHarvesterRaw = {
      domain: "example.com",
      sources: DEFAULT_SOURCES,
      emails: [],
      hosts: ["mail.example.com:1.2.3.4"],
      ips: [],
      urls: [],
    };
    const result = theHarvesterCollector.normalize(completedOutcome(raw));
    expect(result.entities.some((e) => e.type === "domain" && e.value === "mail.example.com")).toBe(
      true,
    );
    expect(result.entities.some((e) => e.type === "ip" && e.value === "1.2.3.4")).toBe(true);
    expect(result.relationships.some((r) => r.relationshipType === "RESOLVES_TO")).toBe(true);
  });

  test("a bare host with no ip suffix produces a domain entity but no RESOLVES_TO edge (nothing to link)", () => {
    const raw: TheHarvesterRaw = {
      domain: "example.com",
      sources: DEFAULT_SOURCES,
      emails: [],
      hosts: ["mail.example.com"],
      ips: [],
      urls: [],
    };
    const result = theHarvesterCollector.normalize(completedOutcome(raw));
    expect(result.relationships).toEqual([]);
  });

  test("an entirely empty result warns rather than silently returning nothing", () => {
    const raw: TheHarvesterRaw = {
      domain: "example.com",
      sources: DEFAULT_SOURCES,
      emails: [],
      hosts: [],
      ips: [],
      urls: [],
    };
    const result = theHarvesterCollector.normalize(completedOutcome(raw));
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("example.com");
  });

  test("failed execution (raw null) returns an empty result carrying the error", () => {
    const outcome: CollectorRunOutcome<TheHarvesterRaw> = {
      execution: {
        status: "failed",
        startedAt: "2026-08-14T00:00:00.000Z",
        completedAt: "2026-08-14T00:00:01.000Z",
        durationMs: 500,
        resultCount: 0,
        error: {
          collector: "theharvester",
          reason: "unavailable",
          message: "THEHARVESTER_WORKER_URL is not configured.",
        },
      },
      raw: null,
    };
    const result = theHarvesterCollector.normalize(outcome);
    expect(result.entities).toEqual([]);
    expect(result.errors).toEqual(["THEHARVESTER_WORKER_URL is not configured."]);
  });
});

describe("theHarvesterCollector.healthCheck", () => {
  test("reports unavailable when no worker is configured — the current, real state", async () => {
    const health = await theHarvesterCollector.healthCheck();
    expect(health.state).toBe("unavailable");
    expect(health.detail).toContain("THEHARVESTER_WORKER_URL");
  });

  test("reports ready when a configured worker answers /health", async () => {
    process.env[WORKER_URL] = "https://harvester.internal";
    stubFetch((url) => {
      expect(url).toBe("https://harvester.internal/health");
      return new Response("ok");
    });
    const health = await theHarvesterCollector.healthCheck();
    expect(health.state).toBe("ready");
  });
});
