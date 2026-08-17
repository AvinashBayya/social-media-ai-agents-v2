import { describe, expect, test } from "bun:test";
import { runInvestigation } from "../src/utils/osint/orchestrator";
import { CollectorRegistry } from "../src/utils/collectors/registry";
import type { Collector, CollectorTarget, TargetType } from "../src/utils/collectors/types";
import { emptyInvestigationResult, UNSCORED } from "../src/utils/collectors/result";
import type { InvestigationResult } from "../src/utils/collectors/result";

/**
 * All collectors here are hand-built stubs on an isolated `CollectorRegistry`
 * — never the global one, and no real `execute()` implementation ever
 * touches the network. This intentionally cannot regress into a slow or
 * flaky test by calling crt.sh/Shodan/GDELT/etc. for real.
 */

function completedResult(overrides: Partial<InvestigationResult> = {}): InvestigationResult {
  const now = new Date().toISOString();
  return {
    entities: [],
    relationships: [],
    evidence: [],
    warnings: [],
    errors: [],
    metadata: {},
    execution: {
      status: "completed",
      startedAt: now,
      completedAt: now,
      durationMs: 1,
      resultCount: 0,
      error: null,
    },
    ...overrides,
  };
}

function stubCollector(
  id: string,
  supportedTargetTypes: TargetType[],
  result: InvestigationResult,
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
      return { execution: result.execution, raw: {} };
    },
    normalize(outcome) {
      const guard = outcome.raw === null ? emptyInvestigationResult(outcome.execution) : undefined;
      return guard ?? result;
    },
    async healthCheck() {
      return { state: "ready" as const, detail: "stub", checkedAt: new Date().toISOString() };
    },
    ...overrides,
  };
}

describe("runInvestigation", () => {
  test("runs every collector the plan selects and merges their results", async () => {
    const registry = new CollectorRegistry();
    registry.register(
      stubCollector(
        "dns",
        ["domain"],
        completedResult({
          entities: [
            {
              id: "dns:ip:1.2.3.4",
              type: "ip",
              value: "1.2.3.4",
              displayName: "1.2.3.4",
              source: "dns",
              confidence: UNSCORED,
              metadata: {},
            },
          ],
        }),
      ),
    );
    registry.register(
      stubCollector(
        "rdap",
        ["domain"],
        completedResult({
          entities: [
            {
              id: "rdap:domain:example.com",
              type: "domain",
              value: "example.com",
              displayName: "example.com",
              source: "rdap",
              confidence: UNSCORED,
              metadata: {},
            },
          ],
        }),
      ),
    );

    const investigation = await runInvestigation("example.com", registry);
    expect(investigation.collectorResults.map((r) => r.collectorId).sort()).toEqual([
      "dns",
      "rdap",
    ]);
    expect(investigation.entities).toHaveLength(2);
  });

  test("deduplicates an entity that appears under the identical id from two collectors", async () => {
    const sharedEntity = {
      id: "shared:1",
      type: "domain" as const,
      value: "example.com",
      displayName: "example.com",
      source: "a",
      confidence: UNSCORED,
      metadata: {},
    };
    const registry = new CollectorRegistry();
    registry.register(
      stubCollector("a", ["domain"], completedResult({ entities: [sharedEntity] })),
    );
    registry.register(
      stubCollector("b", ["domain"], completedResult({ entities: [sharedEntity] })),
    );

    const investigation = await runInvestigation("example.com", registry);
    expect(investigation.entities).toHaveLength(1);
  });

  test("does NOT merge two different collectors' differently-namespaced entities for the same real domain (that's entity-resolution's job, not built yet)", async () => {
    const registry = new CollectorRegistry();
    registry.register(
      stubCollector(
        "dns",
        ["domain"],
        completedResult({
          entities: [
            {
              id: "dns:domain:example.com",
              type: "domain",
              value: "example.com",
              displayName: "example.com",
              source: "dns",
              confidence: UNSCORED,
              metadata: {},
            },
          ],
        }),
      ),
    );
    registry.register(
      stubCollector(
        "rdap",
        ["domain"],
        completedResult({
          entities: [
            {
              id: "rdap:domain:example.com",
              type: "domain",
              value: "example.com",
              displayName: "example.com",
              source: "rdap",
              confidence: UNSCORED,
              metadata: {},
            },
          ],
        }),
      ),
    );

    const investigation = await runInvestigation("example.com", registry);
    // Same real-world domain, two entities — deliberately not merged.
    expect(investigation.entities).toHaveLength(2);
  });

  test("evidence is never deduplicated — every source's fact is preserved even if the value is identical", async () => {
    const ev = {
      source: "a",
      sourceUrl: null,
      collector: "a",
      collectedAt: new Date().toISOString(),
      rawValue: {},
      normalizedValue: {},
      confidence: null,
      metadata: {},
    };
    const registry = new CollectorRegistry();
    registry.register(stubCollector("a", ["domain"], completedResult({ evidence: [ev] })));
    registry.register(
      stubCollector("b", ["domain"], completedResult({ evidence: [{ ...ev, collector: "b" }] })),
    );

    const investigation = await runInvestigation("example.com", registry);
    expect(investigation.evidence).toHaveLength(2);
  });

  test("warnings and errors from every collector are all preserved, not just the first", async () => {
    const registry = new CollectorRegistry();
    registry.register(stubCollector("a", ["domain"], completedResult({ warnings: ["a warns"] })));
    registry.register(stubCollector("b", ["domain"], completedResult({ errors: ["b errors"] })));

    const investigation = await runInvestigation("example.com", registry);
    expect(investigation.warnings).toEqual(["a warns"]);
    expect(investigation.errors).toEqual(["b errors"]);
  });

  test("an empty input runs zero collectors and returns a well-formed, empty investigation", async () => {
    const registry = new CollectorRegistry();
    registry.register(stubCollector("dorks", ["person", "username", "domain"], completedResult()));

    const investigation = await runInvestigation("   ", registry);
    expect(investigation.collectorResults).toEqual([]);
    expect(investigation.entities).toEqual([]);
  });

  test("startedAt/completedAt bound the run and are both valid timestamps", async () => {
    const registry = new CollectorRegistry();
    registry.register(stubCollector("dns", ["domain"], completedResult()));
    const investigation = await runInvestigation("example.com", registry);
    expect(new Date(investigation.startedAt).getTime()).not.toBeNaN();
    expect(new Date(investigation.completedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(investigation.startedAt).getTime(),
    );
  });
});
