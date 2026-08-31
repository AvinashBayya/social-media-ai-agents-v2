/**
 * External-tool collector adapters — OSINT-INTEGRATION-PLAN.md §13-14, §31 P3.
 * Mirrors `collectors/existing/index.ts`'s registration pattern. theHarvester
 * and SpiderFoot report `unavailable` unless their worker env var
 * (`THEHARVESTER_WORKER_URL`/`SPIDERFOOT_WORKER_URL`) is configured — see
 * each file's own header for what that means in this deployment. Jina Reader
 * differs from both: it's a free, keyless public API with no worker to
 * configure, so it's never `unavailable` for a missing-config reason.
 *
 * Not auto-registered on import, for the same reason `existing/index.ts`
 * isn't: a module-load side effect would make `collectorRegistry`
 * non-deterministic across test files that import these adapters
 * independently. Call `registerExternalCollectors()` explicitly.
 */

import type { CollectorRegistry } from "../registry";
import { collectorRegistry } from "../registry";
import { ivreCollector } from "./ivre";
import { jinaReaderCollector } from "./jina-reader";
import { searxngCollector } from "./searxng";
import { sherlockCollector } from "./sherlock";
import { spiderFootCollector } from "./spiderfoot";
import { theHarvesterCollector } from "./theharvester";

export { ivreCollector } from "./ivre";
export { jinaReaderCollector } from "./jina-reader";
export { searxngCollector } from "./searxng";
export { sherlockCollector } from "./sherlock";
export { spiderFootCollector } from "./spiderfoot";
export { theHarvesterCollector } from "./theharvester";

export const EXTERNAL_COLLECTORS = [
  theHarvesterCollector,
  spiderFootCollector,
  jinaReaderCollector,
  searxngCollector,
  ivreCollector,
  sherlockCollector,
];

export function registerExternalCollectors(registry: CollectorRegistry = collectorRegistry): void {
  for (const collector of EXTERNAL_COLLECTORS) {
    if (!registry.get(collector.id)) registry.register(collector);
  }
}
