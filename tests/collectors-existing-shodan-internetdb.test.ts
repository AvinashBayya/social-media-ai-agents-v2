import { afterEach, describe, expect, test } from "bun:test";
import { shodanInternetDbCollector } from "../src/utils/collectors/existing/shodan-internetdb";
import type { CollectorRunOutcome } from "../src/utils/collectors/types";
import type { ShodanRaw } from "../src/utils/collectors/existing/shodan-internetdb";
import type { HostSurface } from "../src/utils/attack-surface";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(handler: (url: string) => Response) {
  globalThis.fetch = (async (input: string | URL | Request) =>
    handler(String(input))) as typeof fetch;
}

function scannedHost(overrides: Partial<HostSurface> = {}): HostSurface {
  return {
    ip: "8.8.8.8",
    scanned: true,
    ports: [53, 443],
    cpes: [],
    hostnames: ["dns.google"],
    tags: [],
    vulns: [],
    ...overrides,
  };
}

function completedOutcome(raw: ShodanRaw): CollectorRunOutcome<ShodanRaw> {
  return {
    execution: {
      status: "completed",
      startedAt: "2026-08-14T00:00:00.000Z",
      completedAt: "2026-08-14T00:00:01.000Z",
      durationMs: 1000,
      resultCount: raw.hosts.length,
      error: null,
    },
    raw,
  };
}

describe("shodanInternetDbCollector.execute", () => {
  test("queries a bare IP target directly, no DNS resolution involved", async () => {
    stubFetch((url) => {
      expect(url).toContain("internetdb.shodan.io/8.8.8.8");
      return new Response(
        JSON.stringify({ ports: [53], cpes: [], hostnames: [], tags: [], vulns: [] }),
      );
    });
    const outcome = await shodanInternetDbCollector.execute({ type: "ip", value: "8.8.8.8" });
    expect(outcome.execution.status).toBe("completed");
    expect(outcome.raw!.hosts).toHaveLength(1);
  });

  test("resolves a domain target first, then queries InternetDB for the resulting address(es)", async () => {
    stubFetch((url) => {
      if (url.includes("dns-query")) {
        return new Response(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: "1.2.3.4" }] }));
      }
      return new Response(
        JSON.stringify({ ports: [80], cpes: [], hostnames: [], tags: [], vulns: [] }),
      );
    });
    const outcome = await shodanInternetDbCollector.execute({
      type: "domain",
      value: "example.com",
    });
    expect(outcome.execution.status).toBe("completed");
    expect(outcome.raw!.hosts[0]!.ip).toBe("1.2.3.4");
  });

  test("a 404 (not scanned) is a completed run with scanned:false, never a failure (Rule 6: absence isn't zero)", async () => {
    stubFetch(() => new Response("", { status: 404 }));
    const outcome = await shodanInternetDbCollector.execute({ type: "ip", value: "203.0.113.9" });
    expect(outcome.execution.status).toBe("completed");
    expect(outcome.raw!.hosts[0]).toEqual({
      ip: "203.0.113.9",
      scanned: false,
      ports: [],
      cpes: [],
      hostnames: [],
      tags: [],
      vulns: [],
    });
  });

  test("a 429 fails with reason rate-limited", async () => {
    stubFetch(() => new Response("slow", { status: 429 }));
    const outcome = await shodanInternetDbCollector.execute({ type: "ip", value: "203.0.113.9" });
    expect(outcome.execution.status).toBe("failed");
    expect(outcome.execution.error?.reason).toBe("rate-limited");
  });
});

describe("shodanInternetDbCollector.normalize", () => {
  test("an unscanned host still produces an IP entity, plus a warning naming the absence", () => {
    const raw: ShodanRaw = { hosts: [scannedHost({ scanned: false, ports: [], hostnames: [] })] };
    const result = shodanInternetDbCollector.normalize(completedOutcome(raw));
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]!.metadata.scanned).toBe(false);
    expect(result.warnings[0]).toMatch(/no InternetDB record/i);
  });

  test("reverse hostnames become domain entities linked by RESOLVES_TO", () => {
    const raw: ShodanRaw = { hosts: [scannedHost()] };
    const result = shodanInternetDbCollector.normalize(completedOutcome(raw));
    const domainEntities = result.entities.filter((e) => e.type === "domain");
    expect(domainEntities).toHaveLength(1);
    expect(domainEntities[0]!.value).toBe("dns.google");
    expect(result.relationships).toHaveLength(1);
    expect(result.relationships[0]!.relationshipType).toBe("RESOLVES_TO");
  });

  test("ports/CPEs/vulns are kept as IP-entity metadata, not invented entities", () => {
    const raw: ShodanRaw = { hosts: [scannedHost({ ports: [22, 443], vulns: ["CVE-2026-0001"] })] };
    const result = shodanInternetDbCollector.normalize(completedOutcome(raw));
    const ipEntity = result.entities.find((e) => e.type === "ip")!;
    expect(ipEntity.metadata.ports).toEqual([22, 443]);
    expect(ipEntity.metadata.vulns).toEqual(["CVE-2026-0001"]);
  });
});
