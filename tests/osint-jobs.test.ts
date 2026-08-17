import { describe, expect, test } from "bun:test";
import {
  InMemoryJobStore,
  cancelJob,
  pollInvestigation,
  startInvestigation,
} from "../src/utils/osint/jobs";
import type { JobStore } from "../src/utils/osint/jobs";
import { CollectorRegistry } from "../src/utils/collectors/registry";
import type { Collector, CollectorRunOutcome, TargetType } from "../src/utils/collectors/types";
import { emptyInvestigationResult, UNSCORED } from "../src/utils/collectors/result";
import type { InvestigationResult } from "../src/utils/collectors/result";

/**
 * Every test uses its own isolated `CollectorRegistry` + `InMemoryJobStore`
 * (the default `JobStore` implementation — see `job-store.ts`) and
 * hand-built stub collectors — never the global singletons, and no real
 * `execute()` implementation touches the network or waits on a real clock
 * longer than a few milliseconds.
 */

function completedOutcome(
  entities: InvestigationResult["entities"] = [],
): CollectorRunOutcome<unknown> {
  const now = new Date().toISOString();
  return {
    execution: {
      status: "completed",
      startedAt: now,
      completedAt: now,
      durationMs: 1,
      resultCount: entities.length,
      error: null,
    },
    raw: { entities },
  };
}

function instantCollector(
  id: string,
  targetTypes: TargetType[],
  entities: InvestigationResult["entities"] = [],
): Collector {
  return {
    id,
    name: id,
    category: "search",
    supportedTargetTypes: targetTypes,
    requiresCredentials: false,
    isOptional: false,
    async execute() {
      return completedOutcome(entities);
    },
    normalize(outcome) {
      if (outcome.raw === null) return emptyInvestigationResult(outcome.execution);
      return { ...emptyInvestigationResult(outcome.execution), entities };
    },
    async healthCheck() {
      return { state: "ready" as const, detail: "stub", checkedAt: new Date().toISOString() };
    },
  };
}

/** A collector whose execute() never resolves on its own — the caller controls exactly when, via `resolve`. */
function deferredCollector(id: string, targetTypes: TargetType[]) {
  let resolveExecute!: (outcome: CollectorRunOutcome<unknown>) => void;
  const pending = new Promise<CollectorRunOutcome<unknown>>((resolve) => {
    resolveExecute = resolve;
  });
  const collector: Collector = {
    id,
    name: id,
    category: "search",
    supportedTargetTypes: targetTypes,
    requiresCredentials: false,
    isOptional: false,
    async execute() {
      return pending;
    },
    normalize(outcome) {
      return outcome.raw === null
        ? emptyInvestigationResult(outcome.execution)
        : emptyInvestigationResult(outcome.execution);
    },
    async healthCheck() {
      return { state: "ready" as const, detail: "stub", checkedAt: new Date().toISOString() };
    },
  };
  return { collector, resolveExecute };
}

/** A collector whose execute() never resolves at all — for exercising the outer timeout. */
function hangingCollector(id: string, targetTypes: TargetType[]): Collector {
  return {
    id,
    name: id,
    category: "search",
    supportedTargetTypes: targetTypes,
    requiresCredentials: false,
    isOptional: false,
    execute: () => new Promise(() => {}),
    normalize(outcome) {
      return emptyInvestigationResult(outcome.execution);
    },
    async healthCheck() {
      return { state: "ready" as const, detail: "stub", checkedAt: new Date().toISOString() };
    },
  };
}

async function waitUntilDone(
  investigationId: string,
  store: JobStore,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pollInvestigation(investigationId, store)?.done) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitUntilDone timed out");
}

describe("startInvestigation", () => {
  test("creates one job per planned collector and starts them", async () => {
    const registry = new CollectorRegistry();
    const store = new InMemoryJobStore();
    registry.register(instantCollector("dns", ["domain"]));
    registry.register(instantCollector("rdap", ["domain"]));

    const started = startInvestigation("example.com", registry, store);
    expect(started.jobs.map((j) => j.collector).sort()).toEqual(["dns", "rdap"]);
    await waitUntilDone(started.investigationId, store);
    expect(started.jobs.every((j) => store.getJob(j.id)!.status === "completed")).toBe(true);
  });

  test("collectorIds restricts execution to the given subset (plan §31 P2 'Recon collector selection')", async () => {
    const registry = new CollectorRegistry();
    const store = new InMemoryJobStore();
    registry.register(instantCollector("dns", ["domain"]));
    registry.register(instantCollector("rdap", ["domain"]));
    registry.register(instantCollector("crtsh", ["domain"]));

    const started = startInvestigation("example.com", registry, store, undefined, ["dns", "crtsh"]);
    expect(started.jobs.map((j) => j.collector).sort()).toEqual(["crtsh", "dns"]);
    // The plan itself still reports every candidate the planner found, filtered or not.
    expect(started.plan.collectors.map((c) => c.collectorId).sort()).toEqual([
      "crtsh",
      "dns",
      "rdap",
    ]);
  });

  test("a collectorIds entry that matches nothing in the plan is silently ignored, not an error", () => {
    const registry = new CollectorRegistry();
    const store = new InMemoryJobStore();
    registry.register(instantCollector("dns", ["domain"]));

    const started = startInvestigation("example.com", registry, store, undefined, [
      "dns",
      "nonexistent",
    ]);
    expect(started.jobs.map((j) => j.collector)).toEqual(["dns"]);
  });

  test("an empty collectorIds array starts zero jobs — an explicit 'deselect everything', not the default 'run everything'", () => {
    const registry = new CollectorRegistry();
    const store = new InMemoryJobStore();
    registry.register(instantCollector("dns", ["domain"]));

    const started = startInvestigation("example.com", registry, store, undefined, []);
    expect(started.jobs).toEqual([]);
  });

  test("omitting collectorIds entirely still runs every planned collector (unchanged default behavior)", async () => {
    const registry = new CollectorRegistry();
    const store = new InMemoryJobStore();
    registry.register(instantCollector("dns", ["domain"]));
    registry.register(instantCollector("rdap", ["domain"]));

    const started = startInvestigation("example.com", registry, store);
    expect(started.jobs.map((j) => j.collector).sort()).toEqual(["dns", "rdap"]);
  });

  test("an empty input starts zero jobs", () => {
    const registry = new CollectorRegistry();
    const store = new InMemoryJobStore();
    registry.register(instantCollector("dorks", ["person", "username", "domain"]));

    const started = startInvestigation("   ", registry, store);
    expect(started.jobs).toEqual([]);
  });
});

describe("pollInvestigation", () => {
  test("returns undefined for an unknown investigation id, not an empty poll", () => {
    const store = new InMemoryJobStore();
    expect(pollInvestigation("nonexistent", store)).toBeUndefined();
  });

  test("aggregates entities across jobs once all are done", async () => {
    const registry = new CollectorRegistry();
    const store = new InMemoryJobStore();
    const entityA = {
      id: "a:1",
      type: "domain" as const,
      value: "example.com",
      displayName: "example.com",
      source: "a",
      confidence: UNSCORED,
      metadata: {},
    };
    const entityB = {
      id: "b:1",
      type: "ip" as const,
      value: "1.2.3.4",
      displayName: "1.2.3.4",
      source: "b",
      confidence: UNSCORED,
      metadata: {},
    };
    registry.register(instantCollector("a", ["domain"], [entityA]));
    registry.register(instantCollector("b", ["domain"], [entityB]));

    const started = startInvestigation("example.com", registry, store);
    await waitUntilDone(started.investigationId, store);

    const poll = pollInvestigation(started.investigationId, store)!;
    expect(poll.done).toBe(true);
    expect(poll.entities.map((e) => e.id).sort()).toEqual(["a:1", "b:1"]);
  });

  test("done is false while a job is still running", () => {
    const registry = new CollectorRegistry();
    const store = new InMemoryJobStore();
    const { collector } = deferredCollector("slow", ["domain"]);
    registry.register(collector);

    const started = startInvestigation("example.com", registry, store);
    const poll = pollInvestigation(started.investigationId, store)!;
    expect(poll.done).toBe(false);
    expect(poll.jobs[0]!.status).toBe("running");
  });
});

describe("cancelJob", () => {
  test("returns false for an unknown job id", () => {
    const store = new InMemoryJobStore();
    expect(cancelJob("nonexistent", store)).toBe(false);
  });

  test("returns false for a job that already reached a terminal status", async () => {
    const registry = new CollectorRegistry();
    const store = new InMemoryJobStore();
    registry.register(instantCollector("dns", ["domain"]));
    const started = startInvestigation("example.com", registry, store);
    await waitUntilDone(started.investigationId, store);

    expect(cancelJob(started.jobs[0]!.id, store)).toBe(false);
  });

  test("cancelling a running job discards its eventual result rather than overwriting the cancelled status", async () => {
    const registry = new CollectorRegistry();
    const store = new InMemoryJobStore();
    const { collector, resolveExecute } = deferredCollector("slow", ["domain"]);
    registry.register(collector);

    const started = startInvestigation("example.com", registry, store);
    const jobId = started.jobs[0]!.id;
    expect(store.getJob(jobId)!.status).toBe("running");

    expect(cancelJob(jobId, store)).toBe(true);
    expect(store.getJob(jobId)!.status).toBe("cancelled");

    // Let the underlying (uncancellable) execute() resolve after the fact.
    resolveExecute(completedOutcome());
    await new Promise((r) => setTimeout(r, 20));

    expect(store.getJob(jobId)!.status).toBe("cancelled");
    expect(pollInvestigation(started.investigationId, store)!.done).toBe(true);
  });
});

describe("job timeout", () => {
  test("a collector that never resolves fails with reason timeout, on the configured budget — not left running forever", async () => {
    const registry = new CollectorRegistry();
    const store = new InMemoryJobStore();
    registry.register(hangingCollector("stuck", ["domain"]));

    const started = startInvestigation("example.com", registry, store, 30);
    await waitUntilDone(started.investigationId, store);

    const job = store.getJob(started.jobs[0]!.id)!;
    expect(job.status).toBe("failed");
    expect(job.error?.reason).toBe("timeout");
  });
});
