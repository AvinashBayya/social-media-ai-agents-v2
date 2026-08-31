/**
 * GEOINT provider registry (2026-08-30, ported from the teammate's fork).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE IS FOR: MAKING "DO NOT BYPASS" STRUCTURAL.
 *
 * Google Lens, TinEye, Yandex Images and GeoSpy all sit behind some combination
 * of CAPTCHA, login, anti-bot controls or a paid key. The rule is simple: use an
 * API where one is available, otherwise support an analyst-assisted workflow,
 * and do NOT automate around CAPTCHA or anti-bot controls.
 *
 * The way that rule gets broken is never a decision to break it — it is a
 * provider quietly acquiring a `fetch()` because someone found an endpoint that
 * worked. So the mode is a declared field, `MANUAL_ASSISTED` providers have no
 * automated code path in this codebase at all, and `assertProviderPermitted()`
 * refuses any attempt to run one automatically.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERY PROVIDER HERE IS CURRENTLY MANUAL_ASSISTED.
 *
 * Not an oversight — a finding, checked directly:
 *   - Google Lens has no public search API. The visual-search surface is a
 *     browser product behind bot detection.
 *   - TinEye has a commercial API only (paid), and its web UI is rate-limited
 *     and CAPTCHA-protected.
 *   - Yandex Images has no permitted reverse-image API and actively blocks
 *     automation.
 *   - GeoSpy is a paid API and requires an account.
 *
 * All four fail the project's zero-budget constraint, the passive-only policy,
 * or both. Each therefore ships as a documented manual-assisted workflow rather
 * than a scraper.
 */

import type { SourceCollectionMode } from "../collectors/types";

export type GeoIntProviderId =
  | "google-lens"
  | "tineye"
  | "yandex-images"
  | "geospy"
  | "local-phash"
  /**
   * The analyst's own reasoning, named as itself.
   *
   * Added because an earlier hypothesis form hardcoded `provider: "geospy"`, so
   * an analyst's own visual reading rendered as `source: "geospy · visual
   * geolocation"` and keyed `hypothesis:geospy:…` — a paid provider this
   * project has never called (declared-not-enabled). That is a string literal
   * presenting as a measurement.
   *
   * An analyst reading a photograph IS a real source. Attributing their work to
   * a tool that never ran is not.
   */
  | "analyst";

export type GeoIntCapability = "reverse-image" | "visual-geolocation";

/**
 * How a provider may be used.
 *
 * `AUTOMATED_PROVIDER` requires a permitted, stable, documented interface AND a
 * configured credential. Anything else is `MANUAL_ASSISTED`, meaning: the
 * analyst performs the search in their own browser under the provider's own
 * terms, and brings the result back as attested evidence.
 */
export type ProviderMode = "AUTOMATED_PROVIDER" | "MANUAL_ASSISTED";

export interface GeoIntProvider {
  id: GeoIntProviderId;
  name: string;
  capability: GeoIntCapability;
  mode: ProviderMode;
  /** The collection mode this maps onto, so `/crawlers` speaks one vocabulary. */
  collectionMode: SourceCollectionMode;
  /** Env var that would enable an automated path, when one legitimately exists. Null when none does. */
  apiKeyEnvVar: string | null;
  /** Where the analyst performs a manual search. Never fetched by this application. */
  manualUrl: string | null;
  /** Why this provider is not automated. Rendered in the UI — an unexplained "manual" reads as laziness. */
  reason: string;
}

export const GEOINT_PROVIDERS: GeoIntProvider[] = [
  {
    id: "analyst",
    name: "Analyst reading",
    capability: "visual-geolocation",
    // MANUAL_ASSISTED because a person did the work by hand. It is not automated
    // and never becomes automated — there is no key that would enable it.
    mode: "MANUAL_ASSISTED",
    collectionMode: "MANUAL_ASSISTED",
    apiKeyEnvVar: null,
    manualUrl: null,
    reason:
      "The analyst's own reading of the image, attributed to them rather than to a tool. It is still a HYPOTHESIS — a trained eye is not a measurement, and the reasoning is recorded so another analyst can disagree with it.",
  },
  {
    id: "local-phash",
    name: "Local perceptual match",
    capability: "reverse-image",
    // The one automated path, because it queries nothing: it compares against
    // images already hashed in this browser.
    mode: "AUTOMATED_PROVIDER",
    collectionMode: "LOCAL_FILE_ANALYSIS",
    apiKeyEnvVar: null,
    manualUrl: null,
    reason:
      "Runs entirely in this browser against images previously analysed here. It never queries the open web, so it finds re-use within this investigation only — not the internet.",
  },
  {
    id: "google-lens",
    name: "Google Lens",
    capability: "reverse-image",
    mode: "MANUAL_ASSISTED",
    collectionMode: "MANUAL_ASSISTED",
    apiKeyEnvVar: null,
    manualUrl: "https://lens.google.com/",
    reason:
      "No public reverse-image search API. The visual-search surface is a browser product behind bot detection; automating it would mean evading those controls.",
  },
  {
    id: "tineye",
    name: "TinEye",
    capability: "reverse-image",
    mode: "MANUAL_ASSISTED",
    collectionMode: "MANUAL_ASSISTED",
    apiKeyEnvVar: "TINEYE_API_KEY",
    manualUrl: "https://tineye.com/",
    reason:
      "Commercial API only — fails the zero-budget constraint. The public web UI is rate-limited and CAPTCHA-protected, so it is analyst-driven or not at all.",
  },
  {
    id: "yandex-images",
    name: "Yandex Images",
    capability: "reverse-image",
    mode: "MANUAL_ASSISTED",
    collectionMode: "MANUAL_ASSISTED",
    apiKeyEnvVar: null,
    manualUrl: "https://yandex.com/images/",
    reason:
      "No permitted reverse-image API, and automated access is actively blocked. Manual-assisted is the only lawful route.",
  },
  {
    id: "geospy",
    name: "GeoSpy",
    capability: "visual-geolocation",
    mode: "MANUAL_ASSISTED",
    collectionMode: "MANUAL_ASSISTED",
    apiKeyEnvVar: "GEOSPY_API_KEY",
    manualUrl: "https://geospy.ai/",
    reason:
      "Paid API requiring an account. Declared but not enabled under the zero-budget constraint. Its output would be a HYPOTHESIS either way.",
  },
];

export function providerById(id: string): GeoIntProvider | null {
  return GEOINT_PROVIDERS.find((p) => p.id === id) ?? null;
}

export function providersFor(capability: GeoIntCapability): GeoIntProvider[] {
  return GEOINT_PROVIDERS.filter((p) => p.capability === capability);
}

/** Thrown when something tries to run a manual-assisted provider automatically. */
export class ProviderNotPermittedError extends Error {
  constructor(
    readonly providerId: string,
    readonly reason: string,
  ) {
    super(
      `Provider "${providerId}" may not be called automatically: ${reason} ` +
        `Use the manual-assisted workflow and ingest the result as attested evidence.`,
    );
    this.name = "ProviderNotPermittedError";
  }
}

/**
 * The gate. Call before any automated provider request.
 *
 * Refuses on two grounds, in order: the provider is declared MANUAL_ASSISTED, or
 * it is automatable in principle but has no configured credential. An unknown
 * provider id is refused rather than treated as permitted — same deny-by-default
 * inversion `passive-policy.ts` uses.
 */
export function assertProviderPermitted(
  providerId: string,
  configuredKeys: Record<string, string | undefined> = {},
): GeoIntProvider {
  const provider = providerById(providerId);
  if (!provider) {
    throw new ProviderNotPermittedError(providerId, "It is not a declared GEOINT provider.");
  }
  if (provider.mode === "MANUAL_ASSISTED") {
    throw new ProviderNotPermittedError(provider.id, provider.reason);
  }
  if (provider.apiKeyEnvVar && !configuredKeys[provider.apiKeyEnvVar]) {
    throw new ProviderNotPermittedError(
      provider.id,
      `${provider.apiKeyEnvVar} is not configured. See MANUAL_ACTIONS.md.`,
    );
  }
  return provider;
}

/** True when a provider could run automatically right now. Drives UI state, never a claim about results. */
export function isProviderAvailable(
  providerId: string,
  configuredKeys: Record<string, string | undefined> = {},
): boolean {
  try {
    assertProviderPermitted(providerId, configuredKeys);
    return true;
  } catch {
    return false;
  }
}

export interface ProviderStatus {
  provider: GeoIntProvider;
  available: boolean;
  /** Operator-facing state: what the analyst can actually do with this provider today. */
  state: "ready" | "manual-only" | "needs-credential";
}

export function providerStatuses(
  configuredKeys: Record<string, string | undefined> = {},
): ProviderStatus[] {
  return GEOINT_PROVIDERS.map((provider) => {
    if (provider.mode === "MANUAL_ASSISTED") {
      return { provider, available: false, state: "manual-only" as const };
    }
    const available = isProviderAvailable(provider.id, configuredKeys);
    return {
      provider,
      available,
      state: available ? ("ready" as const) : ("needs-credential" as const),
    };
  });
}
