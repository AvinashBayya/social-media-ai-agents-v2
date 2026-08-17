/**
 * Adapters over Sentinel's pre-existing collectors — OSINT-INTEGRATION-PLAN.md
 * §31 "P1 — Existing adapters". Each wraps working code (or, for `rdap`, the
 * same free public endpoint an existing route already validated) without
 * changing its behavior; see each file's own header for what it wraps and
 * why.
 *
 * Not auto-registered on import — a module-load side effect would make
 * `collectorRegistry` non-deterministic across test files that import these
 * adapters independently. Call `registerExistingCollectors()` explicitly
 * (the orchestrator's bootstrap will, once it exists — P1 "Orchestrator" is
 * a separate, not-yet-started task).
 */

import type { CollectorRegistry } from "../registry";
import { collectorRegistry } from "../registry";
import { crtshCollector } from "./crtsh";
import { dnsCollector } from "./dns";
import { dorksCollector } from "./dorks";
import { newsCollector } from "./news";
import { rdapCollector } from "./rdap";
import { shodanInternetDbCollector } from "./shodan-internetdb";
import { socialCollector } from "./social";

export { crtshCollector } from "./crtsh";
export { dnsCollector } from "./dns";
export { dorksCollector } from "./dorks";
export { newsCollector } from "./news";
export { rdapCollector } from "./rdap";
export { shodanInternetDbCollector } from "./shodan-internetdb";
export { socialCollector } from "./social";

export const EXISTING_COLLECTORS = [
  dorksCollector,
  dnsCollector,
  rdapCollector,
  crtshCollector,
  shodanInternetDbCollector,
  newsCollector,
  socialCollector,
];

export function registerExistingCollectors(registry: CollectorRegistry = collectorRegistry): void {
  for (const collector of EXISTING_COLLECTORS) {
    if (!registry.get(collector.id)) registry.register(collector);
  }
}
