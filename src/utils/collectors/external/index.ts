/**
 * External-tool collector adapters — OSINT-INTEGRATION-PLAN.md §13-14.
 * Mirrors `collectors/existing/index.ts`'s registration pattern. Both
 * adapters here report `unavailable` unless their worker env var
 * (`THEHARVESTER_WORKER_URL`/`SPIDERFOOT_WORKER_URL`) is configured — see
 * each file's own header for what that means in this deployment.
 *
 * Not auto-registered on import, for the same reason `existing/index.ts`
 * isn't: a module-load side effect would make `collectorRegistry`
 * non-deterministic across test files that import these adapters
 * independently. Call `registerExternalCollectors()` explicitly.
 */

import type { CollectorRegistry } from "../registry";
import { collectorRegistry } from "../registry";
import { spiderFootCollector } from "./spiderfoot";
import { theHarvesterCollector } from "./theharvester";

export { spiderFootCollector } from "./spiderfoot";
export { theHarvesterCollector } from "./theharvester";

export const EXTERNAL_COLLECTORS = [theHarvesterCollector, spiderFootCollector];

export function registerExternalCollectors(registry: CollectorRegistry = collectorRegistry): void {
  for (const collector of EXTERNAL_COLLECTORS) {
    if (!registry.get(collector.id)) registry.register(collector);
  }
}
