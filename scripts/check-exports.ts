import { readFileSync } from 'fs';
import { join } from 'path';

// Expected exports in core utility files to ensure Claude never deletes them during updates
const REQUIRED_EXPORTS: Record<string, string[]> = {
  'src/types/core.ts': [
    'ArticleSchema',
    'PostSchema',
    'EntitySchema',
    'FindingSchema',
    'MediaAssetSchema',
    'VideoAssetSchema',
    'ContractViolationError',
    'parseMany',
  ],
  'src/types/core-adapters.ts': [
    'toAnalysisArticle',
    'fromAnalysisArticle',
    'toSocialPost',
    'fromSocialPost',
    'toGeoPoint',
    'PostDegradation',
  ],
  'src/utils/llm.ts': [
    'chat',
    'chatJson',
    'summariseText',
    'extractEntitiesFrom',
    'assessLanguageOf',
    'getLlmStats',
    'llmStatsSnapshot',
    'LlmUnavailableError',
  ],
  'src/utils/credibility.ts': [
    'scoreArticle',
    'scoreCorpus',
    'defaultFactors',
    'TIER_SCORES',
    'DOMAIN_REPUTATION',
  ],
  'src/utils/credibility-llm.ts': [
    'assessArticleLanguage',
    'assessLanguageFor',
    'assessmentSummary',
  ],
  'src/utils/social.ts': [
    'eventToPost',
    'monitorMatches',
    'assessSpike',
    'bucketise',
    'readMonitor',
    'fetchProfile',
    'fetchProfiles',
    'fetchAuthorFeed',
    'redditCredentials',
    'resetRedditToken',
    'fetchRedditSearch',
    'fetchTelegramChannel',
  ],
  'src/utils/cib.ts': [
    'analyseCib',
    'assessCluster',
    'temporalSynchrony',
    'contentDuplication',
    'accountMaturity',
    'handlePatterns',
    'amplification',
  ],
  'src/utils/imaging.ts': [
    'pHash',
    'hammingDistance',
    'interpretExif',
    'interpretC2pa',
    'interpretOcr',
    'assessProvenance',
  ],
  'src/utils/reports.ts': [
    'sourcesFromArticles',
    'sourcesFromSocial',
    'sourcesFromImages',
    'sourcesFromGeo',
    'renumber',
    'buildSourceContext',
    'validateCitations',
    'citedSourceNumbers',
    'generateProduct',
    'toMarkdown',
  ],
  'src/utils/geo.ts': [
    'isRealCoordinate',
    'fromUsgsFeature',
    'fromUcdpEvent',
    'GEO_LAYERS',
  ],
  'src/utils/geo-sources.ts': [
    'collectSeismic',
    'collectConflict',
    'collectNewsGeo',
    'collectGeoLayers',
  ],
};

let missingCount = 0;
let totalChecked = 0;

console.log('🔍 Checking codebase export integrity...\n');

for (const [filePath, exports] of Object.entries(REQUIRED_EXPORTS)) {
  const fullPath = join(process.cwd(), filePath);
  let content = '';
  try {
    content = readFileSync(fullPath, 'utf-8');
  } catch {
    console.error(`❌ File not found: ${filePath}`);
    missingCount++;
    continue;
  }

  for (const exp of exports) {
    totalChecked++;
    // Matches export function, export const, export type, export interface, export class, export enum
    const regex = new RegExp(`export\\s+(async\\s+)?(function|const|let|var|type|interface|class|enum)\\s+${exp}\\b`);
    if (!regex.test(content)) {
      console.error(`❌ MISSING EXPORT in ${filePath}: ${exp}`);
      missingCount++;
    }
  }
}

if (missingCount === 0) {
  console.log(`✅ Export integrity audit PASSED. Checked ${totalChecked} core exported symbols across ${Object.keys(REQUIRED_EXPORTS).length} files.`);
  process.exit(0);
} else {
  console.error(`\n🚨 AUDIT FAILED: Found ${missingCount} missing exported symbols!`);
  process.exit(1);
}
