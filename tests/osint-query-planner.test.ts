import { describe, expect, test } from "bun:test";
import { detectTargetType, planInvestigation } from "../src/utils/osint/query-planner";
import { CollectorRegistry } from "../src/utils/collectors/registry";
import type { Collector, CollectorTarget, TargetType } from "../src/utils/collectors/types";
import { emptyInvestigationResult } from "../src/utils/collectors/result";

function stubCollector(
  id: string,
  supportedTargetTypes: TargetType[],
  overrides: Partial<Collector> = {},
): Collector {
  return {
    id,
    name: id,
    category: "search",
    supportedTargetTypes,
    requiresCredentials: false,
    isOptional: false,
    async execute(_target: CollectorTarget) {
      const now = new Date().toISOString();
      return {
        execution: {
          status: "completed" as const,
          startedAt: now,
          completedAt: now,
          durationMs: 0,
          resultCount: 0,
          error: null,
        },
        raw: {},
      };
    },
    normalize(outcome) {
      return emptyInvestigationResult(outcome.execution);
    },
    async healthCheck() {
      return { state: "ready" as const, detail: "stub", checkedAt: new Date().toISOString() };
    },
    ...overrides,
  };
}

describe("detectTargetType", () => {
  test("an IPv4 address is detected unambiguously", () => {
    expect(detectTargetType("8.8.8.8")).toEqual({ primaryType: "ip", alternateTypes: [] });
  });

  test("a URL is detected as url, with domain as a plausible alternate", () => {
    expect(detectTargetType("https://example.com/path")).toEqual({
      primaryType: "url",
      alternateTypes: ["domain"],
    });
  });

  test("an email is detected unambiguously", () => {
    expect(detectTargetType("john@example.com")).toEqual({
      primaryType: "email",
      alternateTypes: [],
    });
  });

  test("a bare domain is detected unambiguously", () => {
    expect(detectTargetType("example.com")).toEqual({ primaryType: "domain", alternateTypes: [] });
  });

  test("a digit string long enough to be a phone number is detected as phone", () => {
    expect(detectTargetType("+1 555-123-4567")).toEqual({
      primaryType: "phone",
      alternateTypes: [],
    });
  });

  test("a bare single word is ambiguous between username and person", () => {
    expect(detectTargetType("johnsmith")).toEqual({
      primaryType: "username",
      alternateTypes: ["person"],
    });
  });

  test("multi-word free text is ambiguous between person and username", () => {
    expect(detectTargetType("John Smith")).toEqual({
      primaryType: "person",
      alternateTypes: ["username"],
    });
  });

  test("empty input defaults to person with no alternates, never throws", () => {
    expect(detectTargetType("   ")).toEqual({ primaryType: "person", alternateTypes: [] });
  });

  test("an IP is never misdetected as a domain", () => {
    expect(detectTargetType("192.168.1.1").primaryType).toBe("ip");
  });
});

describe("planInvestigation", () => {
  test("selects only collectors whose supportedTargetTypes include the detected type", () => {
    const registry = new CollectorRegistry();
    registry.register(stubCollector("dns", ["domain"]));
    registry.register(stubCollector("social", ["username", "person"]));

    const plan = planInvestigation("example.com", registry);
    expect(plan.collectors.map((c) => c.collectorId)).toEqual(["dns"]);
  });

  test("an ambiguous bare word plans collectors for both the primary and alternate type, deduped", () => {
    const registry = new CollectorRegistry();
    registry.register(stubCollector("social", ["username"]));
    registry.register(stubCollector("news", ["person"]));
    registry.register(stubCollector("dorks", ["person", "username"])); // matches both — must appear once

    const plan = planInvestigation("johnsmith", registry);
    const ids = plan.collectors.map((c) => c.collectorId).sort();
    expect(ids).toEqual(["dorks", "news", "social"]);
  });

  test("infrastructure collectors never get planned for a person-shaped input", () => {
    const registry = new CollectorRegistry();
    registry.register(stubCollector("dns", ["domain"]));
    registry.register(stubCollector("shodan-internetdb", ["ip", "domain"]));

    const plan = planInvestigation("John Smith", registry);
    expect(plan.collectors).toEqual([]);
  });

  test("an empty input plans zero collectors regardless of what's registered", () => {
    const registry = new CollectorRegistry();
    registry.register(stubCollector("dorks", ["person", "username", "domain", "email"]));
    const plan = planInvestigation("   ", registry);
    expect(plan.collectors).toEqual([]);
    expect(plan.input).toBe("");
  });

  test("a credential-gated collector is still planned, but its reason says so", () => {
    const registry = new CollectorRegistry();
    registry.register(stubCollector("gated", ["domain"], { requiresCredentials: true }));
    const plan = planInvestigation("example.com", registry);
    expect(plan.collectors[0]!.reason).toContain("requires credentials");
  });

  test("uses the default global registry when none is supplied", () => {
    // Just confirms the call doesn't throw and returns a well-formed plan —
    // the global registry may be empty or populated depending on what else
    // has run in this process, so no assertion on collector count.
    const plan = planInvestigation("example.com");
    expect(plan.input).toBe("example.com");
    expect(Array.isArray(plan.collectors)).toBe(true);
  });
});
