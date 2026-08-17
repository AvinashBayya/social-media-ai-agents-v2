/**
 * Which rate-limit tier each server function belongs to.
 *
 * WHY THIS IS KEYED ON A NAME RATHER THAN A FUNCTION ID.
 *
 * TanStack Start's request middleware receives a `serverFnMeta` field in its
 * TYPE (`start-client-core/dist/esm/createMiddleware.d.ts`, `RequestServerOptions`)
 * that is NOT populated at runtime in 1.168 — `createStartHandler.js` calls
 * `executeMiddleware([...], { request, pathname, handlerType, context })` with
 * no `serverFnMeta` key. FUNCTION middleware does get it, populated at
 * `createServerFn.js:68`. That gap is why tiering lives in the function layer
 * and only a coarse per-IP ceiling lives in the request layer.
 *
 * Server-function *ids* are build-generated hashes and change between builds,
 * so they are useless as a config key. The exported symbol name is stable and
 * is what `serverFnMeta.name` carries.
 *
 * Pure: no TanStack import, no env read. `bun test` covers it directly.
 */

import type { TierName } from "./rate-limit";

/**
 * Exact-name assignments, highest sensitivity first.
 *
 * An unlisted function falls through to the filename heuristic and then to
 * `moderate` — never to `loose`. An unclassified function is a gap, not a
 * licence, which is the same stance `allowsAutomatedCollection()` takes in
 * collection-policy.ts.
 */
export const TIER_BY_FUNCTION_NAME: Record<string, TierName> = {
  // Credential vault — anything that reads, writes or tests a stored secret.
  getCredentials: "strict",
  saveCredentials: "strict",
  addCredential: "strict",
  deleteCredential: "strict",
  revealCredential: "strict",
  verifyCredential: "strict",
  listCredentials: "strict",

  // Metered upstreams: every call spends money or free-tier quota.
  llmSummarise: "expensive",
  llmExtractEntities: "expensive",
  llmAssessLanguage: "expensive",
  llmAnalyseContent: "expensive",
  llmCaseSummary: "expensive",
  llmExecutiveBrief: "expensive",
  llmReport: "expensive",
  aiSummariseArticle: "expensive",
  aiExtractEntities: "expensive",
  aiSummariseCluster: "expensive",
  aiCompareFraming: "expensive",
  generateIntelligenceProduct: "expensive",
  serverDownloadYoutubeVideo: "expensive",
  serverFetchYoutubeSubtitles: "expensive",

  // Fans out to many third-party endpoints per call — the cheapest amplifier
  // in the app, so it is not `loose` despite reading nothing local.
  collectorHealth: "expensive",

  // Local reads and small writes.
  serverLoadProfiles: "loose",
  serverSaveProfiles: "loose",
  serverDeleteProfile: "loose",
  getLlmStats: "loose",
  capabilityMatrix: "loose",
  listCredentialProviders: "loose",
  socialCredentials: "loose",
};

/**
 * Filename fallbacks. A new collector added to one of these modules is
 * throttled from the moment it exists, without anyone remembering to add it
 * to the table above.
 */
const TIER_BY_FILE_FRAGMENT: Array<{ fragment: string; tier: TierName }> = [
  { fragment: "credential-vault", tier: "strict" },
  { fragment: "llm", tier: "expensive" },
  { fragment: "reports", tier: "expensive" },
  { fragment: "youtube-collector", tier: "expensive" },
  { fragment: "social", tier: "moderate" },
  { fragment: "recon-sources", tier: "moderate" },
  { fragment: "attack-surface", tier: "moderate" },
  { fragment: "geo-sources", tier: "moderate" },
  { fragment: "dorks", tier: "moderate" },
  { fragment: "collector-health", tier: "expensive" },
];

export interface ServerFnIdentity {
  name?: string;
  filename?: string;
}

/**
 * Resolve a tier. Unknown functions get `moderate`, never `loose` — see the
 * note on TIER_BY_FUNCTION_NAME.
 */
export function resolveTier(meta: ServerFnIdentity | undefined | null): TierName {
  const name = meta?.name?.trim();
  if (name && name in TIER_BY_FUNCTION_NAME) return TIER_BY_FUNCTION_NAME[name];

  const file = meta?.filename?.replace(/\\/g, "/").toLowerCase() ?? "";
  if (file) {
    for (const { fragment, tier } of TIER_BY_FILE_FRAGMENT) {
      if (file.includes(`/${fragment}.`) || file.includes(`/${fragment}/`)) return tier;
    }
  }

  return "moderate";
}

/**
 * Every function name this module classifies explicitly. Exported so a test
 * can assert the table has not drifted from the actual server-fn inventory.
 */
export function classifiedFunctionNames(): string[] {
  return Object.keys(TIER_BY_FUNCTION_NAME).sort();
}
