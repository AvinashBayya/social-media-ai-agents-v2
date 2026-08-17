import { readFileSync } from "fs";
import { join } from "path";

// Expected exports in core utility files to ensure Claude never deletes them during updates
const REQUIRED_EXPORTS: Record<string, string[]> = {
  "src/types/core.ts": [
    "ArticleSchema",
    "PostSchema",
    "EntitySchema",
    "FindingSchema",
    "MediaAssetSchema",
    "VideoAssetSchema",
    "ContractViolationError",
    "parseMany",
  ],
  "src/types/core-adapters.ts": [
    "toAnalysisArticle",
    "fromAnalysisArticle",
    "toSocialPost",
    "fromSocialPost",
    "toGeoPoint",
    "PostDegradation",
    "toGpsJamFinding",
    "CONTRACT_MEDIA_LIMITATION",
  ],
  "src/utils/llm.ts": [
    "chat",
    "chatJson",
    "summariseText",
    "extractEntitiesFrom",
    "assessLanguageOf",
    "getLlmStats",
    "llmStatsSnapshot",
    "LlmUnavailableError",
  ],
  "src/utils/credibility.ts": [
    "scoreArticle",
    "scoreCorpus",
    "defaultFactors",
    "TIER_SCORES",
    "DOMAIN_REPUTATION",
  ],
  "src/utils/credibility-llm.ts": [
    "assessArticleLanguage",
    "assessLanguageFor",
    "assessmentSummary",
  ],
  "src/utils/social.ts": [
    "eventToPost",
    "monitorMatches",
    "assessSpike",
    "bucketise",
    "readMonitor",
    "fetchProfile",
    "fetchProfiles",
    "fetchAuthorFeed",
    "redditCredentials",
    "resolveRedditCredentials",
    "resetRedditToken",
    "fetchRedditSearch",
    "fetchTelegramChannel",
    "fetchBlueskySearch",
    "resetBlueskySession",
    "mastodonStatusToPost",
    "fetchMastodonSearch",
    // Media extraction, added 2026-08-12. Each was captured from a live
    // response; the Bluesky pair covers the two different shapes (raw Jetstream
    // record vs resolved AppView view) and must not be collapsed into one.
    "blueskyMediaFromRecord",
    "blueskyMediaFromView",
    "redditMediaFrom",
    "telegramMediaFrom",
    "mastodonMediaFrom",
    "splitTelegramMessages",
    "telegramBlockToPost",
  ],
  "src/utils/collection-policy.ts": [
    "COLLECTION_POLICIES",
    "MODE_LABELS",
    "BASIS_LABELS",
    "BASIS_DETAIL",
    "policyFor",
    "policyById",
    "allowsAutomatedCollection",
    "policySummary",
  ],
  "src/utils/manual-evidence.ts": [
    "AttestationError",
    "CAPTURE_PLATFORM_LABELS",
    "CAPTURE_CAVEATS",
    "ATTRIBUTION_LIMITATION",
    "isPublicPostUrl",
    "buildAttestedCapture",
    "attestedCaptureToMediaAsset",
  ],
  "src/utils/evidence.ts": [
    "EvidenceIntegrityError",
    "sha256OfFile",
    "bytesToHex",
    "isSha256",
    "HASH_MEANING",
  ],
  // The single owner of the `sentinel_evidence` key. Two files used to write it
  // with two independently-declared shapes; if either half of this is dropped,
  // that duplication comes straight back.
  "src/utils/evidence-store.ts": [
    "EVIDENCE_KEY",
    "withoutSeeded",
    "getEvidence",
    "saveEvidence",
    "appendEvidence",
    "deleteEvidence",
    "setEvidenceCase",
    "nextEvidenceId",
  ],
  "src/utils/investigations-store.ts": [
    "INVESTIGATIONS_CHANGED_EVENT",
    "getInvestigations",
    "saveInvestigations",
    "createInvestigation",
    "deleteInvestigation",
    "pinToInvestigation",
    "pinToInvestigationWithId",
    "removeEvidence",
    "updateAnalystNotes",
    "caseMetrics",
    "sourcesFromEvidence",
  ],
  "src/utils/bookmark-store.ts": [
    "BOOKMARK_KEY",
    "migrateBookmarks",
    "getBookmarks",
    "saveBookmarks",
    "isBookmarked",
    "toggleBookmark",
    "removeBookmark",
    "setBookmarkCase",
    "shortlisted",
    "pinnedBookmarks",
  ],
  "src/utils/live-filters.ts": [
    "DATE_WINDOWS",
    "DEFAULT_WINDOW_ID",
    "windowHours",
    "withinWindow",
    "WINDOW_REACH_NOTE",
  ],
  // Module 2's graph layer. `layoutGraph` must stay deterministic and
  // `COOCCURRENCE_CAVEAT` must stay on screen — see the module header.
  "src/utils/graph-build.ts": [
    "ENTITY_TYPES",
    "normaliseEntityType",
    "entityKey",
    "buildEntityGraph",
    "degreeCentrality",
    "shortestPath",
    "layoutGraph",
    "nodeRadius",
    "COOCCURRENCE_CAVEAT",
  ],
  "src/utils/watchlist-store.ts": [
    "getWatchlists",
    "saveWatchlists",
    "createWatchlist",
    "deleteWatchlist",
    "getWatchlistMatches",
    "bucketMatchesByHour",
  ],
  "src/utils/credential-vault.ts": [
    "CREDENTIAL_PROVIDERS",
    "CredentialVaultError",
    "providerById",
    "normaliseStatus",
    "normaliseEntry",
    "normaliseVault",
    "maskSecret",
    "secretTail",
    "redactEntry",
    "redactVault",
    "normaliseHost",
    "readVault",
    "writeVault",
    "VAULT_BACKUP_PATH",
    "resolveCredential",
    "recordCredentialUse",
    "verifyProviderCredential",
    "buildCapabilityMatrix",
    "githubHeaders",
  ],
  "src/utils/cib.ts": [
    "analyseCib",
    "assessCluster",
    "temporalSynchrony",
    "contentDuplication",
    "accountMaturity",
    "handlePatterns",
    "amplification",
  ],
  "src/utils/imaging.ts": [
    "pHash",
    "hammingDistance",
    "interpretExif",
    "interpretC2pa",
    "interpretOcr",
    "assessProvenance",
  ],
  "src/utils/reports.ts": [
    "sourcesFromArticles",
    "sourcesFromSocial",
    "sourcesFromImages",
    "sourcesFromGeo",
    "renumber",
    "buildSourceContext",
    "validateCitations",
    "citedSourceNumbers",
    "generateProduct",
    "toMarkdown",
  ],
  "src/utils/geo.ts": ["isRealCoordinate", "fromUsgsFeature", "fromUcdpEvent", "GEO_LAYERS"],
  "src/utils/geo-sources.ts": [
    "collectSeismic",
    "collectConflict",
    "collectNewsGeo",
    "collectGeoLayers",
    "collectGpsJamming",
    "collectRadiation",
  ],
  "src/utils/gps-interference.ts": [
    "fetchGpsInterference",
    "classifyGpsRegion",
    "groupGpsHexesByRegion",
  ],
  "src/utils/radiation.ts": ["fetchRadiationFeed", "classifyRadiationLevel"],
  "src/utils/cyber-intel.ts": ["fetchCyberIntel"],
  "src/utils/social-velocity.ts": ["calculateSocialVelocity"],
  "src/utils/threat-classifier.ts": ["classifyThreatText"],
  "src/utils/focal-point.ts": ["detectFocalPoints"],
  // Corrected 2026-08-12: this listed fetchYoutubeMetadata /
  // fetchYoutubeSubtitles / downloadYoutubeVideo, which the module has never
  // exported under those names — the public symbols are the createServerFn
  // wrappers below, over private _getMetadata / _getSubtitles / _getDownloadUrl.
  // The audit had therefore failed on every run since the YouTube feature
  // landed, which is worse than not running it: a permanently red gate is one
  // nobody reads, and a real deletion would have hidden among these three.
  "src/utils/youtube-collector.ts": [
    "serverFetchYoutubeMetadata",
    "serverFetchYoutubeSubtitles",
    "serverDownloadYoutubeVideo",
    "isYoutubeUrl",
    "extractYoutubeId",
    // Added 2026-08-12 with the InnerTube rewrite. The parsers are the pure,
    // testable half — parseTimedTextXml in particular is what stands between a
    // 93KB caption track and a false "no subtitles available".
    "fmtUploadDate",
    "YT_INNERTUBE_CLIENTS",
    "muxedFormats",
    "captionTracksOf",
    "captionTracksToLangs",
    "decodeXmlEntities",
    "parseVttSegments",
    "parseTimedTextXml",
    "parseSubtitleBody",
  ],
};

let missingCount = 0;
let totalChecked = 0;

console.log("🔍 Checking codebase export integrity...\n");

for (const [filePath, exports] of Object.entries(REQUIRED_EXPORTS)) {
  const fullPath = join(process.cwd(), filePath);
  let content = "";
  try {
    content = readFileSync(fullPath, "utf-8");
  } catch {
    console.error(`❌ File not found: ${filePath}`);
    missingCount++;
    continue;
  }

  for (const exp of exports) {
    totalChecked++;
    // Matches export function, export const, export type, export interface, export class, export enum
    const regex = new RegExp(
      `export\\s+(async\\s+)?(function|const|let|var|type|interface|class|enum)\\s+${exp}\\b`,
    );
    if (!regex.test(content)) {
      console.error(`❌ MISSING EXPORT in ${filePath}: ${exp}`);
      missingCount++;
    }
  }
}

if (missingCount === 0) {
  console.log(
    `✅ Export integrity audit PASSED. Checked ${totalChecked} core exported symbols across ${Object.keys(REQUIRED_EXPORTS).length} files.`,
  );
  process.exit(0);
} else {
  console.error(`\n🚨 AUDIT FAILED: Found ${missingCount} missing exported symbols!`);
  process.exit(1);
}
