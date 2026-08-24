/**
 * Person Investigation collectors — registration.
 *
 * Only 7 of the task's 8 requested collectors get a new file here.
 * `presence.news` is deliberately NOT a new collector: the existing `news`
 * collector (`collectors/existing/news.ts`) already declares
 * `supportedTargetTypes: ["person", "domain", "location"]` and does exactly
 * what "GDELT + news/web search for name+org; provenanced article links"
 * asks for. Registering a second, near-identical `presence.news` collector
 * alongside it would fire twice on every person investigation and double
 * up article entities/evidence — the wrong shape of "reuse... do not build
 * a parallel stack." `registerPersonCollectors()` below therefore also
 * calls `registerExistingCollectors()`, so `news` (for presence.news) and
 * `rdap` (the RDAP half of contact.domain — this suite's own
 * `contact.domain` only adds the tech-check half) are guaranteed
 * registered whenever the Person Investigation feature is active. See
 * PERSON-INVESTIGATION-ANALYSIS.md §12 for the full reasoning per collector.
 *
 * Gated by `personInvestigationEnabled()` — when the feature flag is off,
 * this function is a no-op and none of these 7 collectors, nor the
 * always-on `news`/`rdap` re-registration, ever touch the shared
 * `collectorRegistry`. Idempotent, matching `existing/index.ts`'s and
 * `external/index.ts`'s own `if (!registry.get(id))` convention exactly.
 */

import type { Collector } from "../types";
import type { CollectorRegistry } from "../registry";
import { collectorRegistry } from "../registry";
import { registerExistingCollectors } from "../existing";
import { personInvestigationEnabled } from "../../osint/person-investigation";
import { identityWebsearchCollector } from "./identity-websearch";
import { contactEmailCollector } from "./contact-email";
import { contactHibpCollector } from "./contact-hibp";
import { contactPhoneCollector } from "./contact-phone";
import { contactDomainCollector } from "./contact-domain";
import { presenceUsernameCollector } from "./presence-username";
import { presenceImageCollector } from "./presence-image";

export {
  identityWebsearchCollector,
  contactEmailCollector,
  contactHibpCollector,
  contactPhoneCollector,
  contactDomainCollector,
  presenceUsernameCollector,
  presenceImageCollector,
};

export const PERSON_COLLECTORS: Collector<any>[] = [
  identityWebsearchCollector,
  contactEmailCollector,
  contactHibpCollector,
  contactPhoneCollector,
  contactDomainCollector,
  presenceUsernameCollector,
  presenceImageCollector,
];

/** Every collector id this suite registers, INCLUDING the reused `news`/`rdap` pair — for the UI's collector-selection list. */
export const PERSON_COLLECTOR_IDS = [
  "identity.websearch",
  "contact.email",
  "contact.hibp",
  "contact.phone",
  "contact.domain",
  "presence.username",
  "presence.news", // alias — this id resolves to the shared "news" collector, see below
  "presence.image",
] as const;

/**
 * Registers the 7 new collectors plus ensures `news`/`rdap` (reused as-is)
 * are present. A no-op unless `PERSON_INVESTIGATION_ENABLED=true`.
 */
export function registerPersonCollectors(registry: CollectorRegistry = collectorRegistry): void {
  if (!personInvestigationEnabled()) return;
  registerExistingCollectors(registry); // ensures "news" and "rdap" exist, idempotent
  for (const collector of PERSON_COLLECTORS) {
    if (!registry.get(collector.id)) registry.register(collector);
  }
}

/**
 * Resolves a `PERSON_COLLECTOR_IDS` entry to the real registry id the
 * orchestrator/UI should actually use — every id maps to itself except the
 * "presence.news" alias, which resolves to the shared "news" collector.
 */
export function resolvePersonCollectorId(id: (typeof PERSON_COLLECTOR_IDS)[number]): string {
  return id === "presence.news" ? "news" : id;
}
