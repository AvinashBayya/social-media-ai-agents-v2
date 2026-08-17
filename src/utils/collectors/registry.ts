/**
 * Collector registry — OSINT-INTEGRATION-PLAN.md §9.
 *
 * The future orchestrator (§11, P1) asks this "which collectors support this
 * target?" rather than hard-coding tool logic through route files — this is
 * the piece that makes that possible. Nothing registers a real collector
 * here yet; that starts with the P1 adapters (§31 "P1 — Existing adapters").
 */

import type { Collector, TargetType } from "./types";

/** Thrown by `register()` on a duplicate id — a silent overwrite would let a later import shadow an earlier collector without either side knowing. */
export class DuplicateCollectorError extends Error {
  constructor(readonly collectorId: string) {
    super(`A collector with id "${collectorId}" is already registered.`);
    this.name = "DuplicateCollectorError";
  }
}

export class CollectorRegistry {
  private readonly collectors = new Map<string, Collector>();

  register(collector: Collector): void {
    if (this.collectors.has(collector.id)) {
      throw new DuplicateCollectorError(collector.id);
    }
    this.collectors.set(collector.id, collector);
  }

  /** For tests and hot-reload scenarios where re-registering the same id is expected. */
  unregister(collectorId: string): void {
    this.collectors.delete(collectorId);
  }

  get(collectorId: string): Collector | undefined {
    return this.collectors.get(collectorId);
  }

  list(): Collector[] {
    return [...this.collectors.values()];
  }

  /** The query the orchestrator (§11) is meant to run instead of hard-coding per-target tool selection. */
  findByTargetType(type: TargetType): Collector[] {
    return this.list().filter((c) => c.supportedTargetTypes.includes(type));
  }

  findByCategory(category: Collector["category"]): Collector[] {
    return this.list().filter((c) => c.category === category);
  }

  clear(): void {
    this.collectors.clear();
  }
}

/** Process-wide registry. Adapters register themselves into this instance when they're added (P1) — nothing does yet. */
export const collectorRegistry = new CollectorRegistry();
