import { beforeEach, describe, expect, test } from "bun:test";
import { CollectorRegistry, DuplicateCollectorError } from "../src/utils/collectors/registry";
import type {
  Collector,
  CollectorTarget,
  CollectorRunOutcome,
} from "../src/utils/collectors/types";
import { emptyInvestigationResult } from "../src/utils/collectors/result";

function stubCollector(overrides: Partial<Collector> = {}): Collector {
  return {
    id: "stub",
    name: "Stub Collector",
    category: "search",
    supportedTargetTypes: ["domain"],
    requiresCredentials: false,
    isOptional: true,
    async execute(_target: CollectorTarget): Promise<CollectorRunOutcome<unknown>> {
      const now = new Date().toISOString();
      return {
        execution: {
          status: "completed",
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
      return { state: "ready", detail: "stub", checkedAt: new Date().toISOString() };
    },
    ...overrides,
  };
}

describe("CollectorRegistry", () => {
  let registry: CollectorRegistry;

  beforeEach(() => {
    registry = new CollectorRegistry();
  });

  test("register + get round-trips a collector", () => {
    const collector = stubCollector({ id: "dns" });
    registry.register(collector);
    expect(registry.get("dns")).toBe(collector);
  });

  test("get returns undefined for an unregistered id — never throws, never fabricates a collector", () => {
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  test("register throws DuplicateCollectorError on a second registration with the same id", () => {
    registry.register(stubCollector({ id: "dns" }));
    expect(() => registry.register(stubCollector({ id: "dns" }))).toThrow(DuplicateCollectorError);
  });

  test("list returns every registered collector", () => {
    registry.register(stubCollector({ id: "dns" }));
    registry.register(stubCollector({ id: "rdap" }));
    expect(
      registry
        .list()
        .map((c) => c.id)
        .sort(),
    ).toEqual(["dns", "rdap"]);
  });

  test("findByTargetType returns only collectors that declare support for it (plan §9)", () => {
    registry.register(stubCollector({ id: "dns", supportedTargetTypes: ["domain", "ip"] }));
    registry.register(stubCollector({ id: "social", supportedTargetTypes: ["username"] }));
    expect(registry.findByTargetType("domain").map((c) => c.id)).toEqual(["dns"]);
    expect(registry.findByTargetType("username").map((c) => c.id)).toEqual(["social"]);
    expect(registry.findByTargetType("email")).toEqual([]);
  });

  test("findByCategory filters by category", () => {
    registry.register(stubCollector({ id: "dns", category: "infrastructure" }));
    registry.register(stubCollector({ id: "dorks", category: "search" }));
    expect(registry.findByCategory("infrastructure").map((c) => c.id)).toEqual(["dns"]);
  });

  test("unregister removes a collector", () => {
    registry.register(stubCollector({ id: "dns" }));
    registry.unregister("dns");
    expect(registry.get("dns")).toBeUndefined();
  });

  test("clear empties the registry", () => {
    registry.register(stubCollector({ id: "dns" }));
    registry.register(stubCollector({ id: "rdap" }));
    registry.clear();
    expect(registry.list()).toEqual([]);
  });
});
