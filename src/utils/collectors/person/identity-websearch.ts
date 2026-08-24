/**
 * identity.websearch — Person Investigation collector.
 *
 * Brave Search (key-gated — no free-tier general web search existed
 * anywhere in this codebase before this collector; see
 * PERSON-INVESTIGATION-ANALYSIS.md §9) for discovery, then a genuinely
 * self-hosted readability extraction (`@mozilla/readability` + `jsdom`,
 * both new dependencies added for this collector) of the top result's own
 * page — not a third-party extraction API. This is a deliberate difference
 * from `collectors/external/jina-reader.ts`, which is real and reusable but
 * calls a remote API (`r.jina.ai`), not "self-hosted" in the sense the task
 * this was built against asked for.
 *
 * Explicitly NO LinkedIn scraping: results are whatever Brave's own index
 * returns for the query, never a targeted `site:linkedin.com` construction,
 * and this collector never authenticates as or impersonates a logged-in
 * session against any platform.
 *
 * **Brave's response shape is unverified against a live call** — no API
 * key was available while building this, matching the exact same honesty
 * this codebase already uses for theHarvester/SpiderFoot's response
 * parsers (their own file headers state the same caveat). The parser below
 * is defensive: an unexpected/missing field degrades to being skipped, not
 * thrown or fabricated.
 *
 * Extraction is bounded to the single top result — fetching and parsing
 * every hit would multiply `execute()`'s latency and failure surface for
 * marginal benefit; the remaining hits still surface as real search
 * results (title/url/description), just without full-text extraction.
 *
 * `jsdom`/`@mozilla/readability` are loaded via a dynamic `await
 * import(...)` inside `extractTopResult()`, never a top-level `import`.
 * This file is reachable from `osint/orchestrator.ts`/`osint/jobs.ts`,
 * which client route components (`/recon`, `/osint`) import for their
 * `createServerFn` wrappers, and a static top-level import here would pull
 * `jsdom` (a Node-only DOM emulation library) into the CLIENT bundle — the
 * identical bug class this session already hit with `bun:sqlite` and
 * `undici`. `jobs.ts`'s own `createJobStore()` uses `require()` for the
 * equivalent problem, but that pattern does NOT work in this project's
 * current Vite/Nitro version — verified live 2026-08-19 that `typeof
 * require === "undefined"` inside a real `createServerFn` handler in this
 * dev server, so `require()` throws `ReferenceError: require is not
 * defined` the moment it actually runs (a real, live bug this collector
 * hit and fixed, not a hypothetical — see PROJECT_MEMORY.md). Dynamic
 * `await import(...)` is what this runtime actually supports; it stays out
 * of the client bundle because every caller of `extractTopResult()` lives
 * inside `execute()`, itself only ever invoked from a server-side
 * `createServerFn` handler — verified live, not just reasoned about.
 */

import { recordCredentialUse, resolveCredential } from "../../credential-vault";
import { CollectorError, collectorNoCredential } from "../errors";
import type { CollectorEntity, CollectorEvidence, CollectorRelationship } from "../result";
import { InvestigationResultSchema, UNSCORED, type ConfidenceScore } from "../result";
import type { Collector, CollectorHealth, CollectorRunOutcome, CollectorTarget } from "../types";
import { classifyError, finishExecution, normalizeGuard, startExecution } from "../existing/shared";
import { extractEntities } from "../../analysis-llm";

const SEARCH_TIMEOUT_MS = 12_000;
const EXTRACT_TIMEOUT_MS = 12_000;
const MAX_HITS = 5;
/** Extracted text is capped, not the whole page — a very long article would
 * otherwise make one evidence item dominate a report or an LLM prompt. */
const MAX_EXTRACTED_CHARS = 8_000;

interface SearchHit {
  title: string;
  url: string;
  description: string;
}

interface ExtractedPage {
  url: string;
  title: string | null;
  text: string;
  truncated: boolean;
}

export interface DiscoveredOrganization {
  name: string;
  /** The model's own calibrated confidence for this specific entity — never defaulted, never computed here. */
  confidence: number;
  /** The exact span the model read the org name from, so an analyst can check it against the extracted text. */
  mention: string;
}

export interface IdentityWebsearchRaw {
  query: string;
  hits: SearchHit[];
  extracted: ExtractedPage | null;
  extractionWarning: string | null;
  /**
   * Real LLM entity extraction (the same `extractEntities` /entities uses)
   * over the top result's real extracted text, filtered to ORGANISATION-type
   * entities — this is how a person's real affiliation gets discovered from
   * search, rather than only ever being whatever the analyst typed into the
   * seed form. Empty when extraction wasn't attempted (no page extracted) or
   * failed (see orgExtractionWarning) — never invented.
   */
  discoveredOrganizations: DiscoveredOrganization[];
  orgExtractionWarning: string | null;
}

function parseHits(body: any): SearchHit[] {
  const results = body?.web?.results;
  if (!Array.isArray(results)) return [];
  const hits: SearchHit[] = [];
  for (const r of results.slice(0, MAX_HITS)) {
    const url = typeof r?.url === "string" ? r.url.trim() : "";
    const title = typeof r?.title === "string" ? r.title.trim() : "";
    if (!url || !title) continue; // a hit missing either is not usable as an entity
    hits.push({ title, url, description: typeof r?.description === "string" ? r.description : "" });
  }
  return hits;
}

async function extractTopResult(url: string): Promise<{ page: ExtractedPage | null; warning: string | null }> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
      headers: { "user-agent": "Mozilla/5.0 (compatible; SentinelAI-PersonInvestigation/1.0)" },
    });
    if (!res.ok) return { page: null, warning: `Top result returned HTTP ${res.status} — not extracted.` };
    const html = await res.text();
    const [{ JSDOM }, { Readability }] = await Promise.all([
      import("jsdom"),
      import("@mozilla/readability"),
    ]);
    const dom = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();
    if (!article?.textContent?.trim()) {
      return { page: null, warning: "Readability found no extractable article content on the top result." };
    }
    const full = article.textContent.trim();
    const truncated = full.length > MAX_EXTRACTED_CHARS;
    return {
      page: { url, title: article.title ?? null, text: full.slice(0, MAX_EXTRACTED_CHARS), truncated },
      warning: null,
    };
  } catch (err: any) {
    return { page: null, warning: `Top-result extraction failed: ${err?.message ?? String(err)}` };
  }
}

/**
 * Real organization discovery — the same LLM entity extraction /entities
 * already uses, run over the top result's real extracted text. This is
 * what lets "Orgs & Roles" show something discovered from a real search
 * instead of only ever the analyst's own typed seed value.
 */
async function discoverOrganizations(
  page: ExtractedPage,
): Promise<{ orgs: DiscoveredOrganization[]; warning: string | null }> {
  try {
    const result = await extractEntities({
      id: page.url,
      title: page.title ?? "",
      source: "identity.websearch",
      url: page.url,
      pubDate: "",
      body: page.text,
    });
    const orgs = result.entities
      .filter((e) => e.type === "ORGANISATION")
      .map((e) => ({ name: e.entity, confidence: e.confidence, mention: e.mention }));
    return { orgs, warning: null };
  } catch (err: any) {
    return { orgs: [], warning: `Organization extraction failed: ${err?.message ?? String(err)}` };
  }
}

export const identityWebsearchCollector: Collector<IdentityWebsearchRaw> = {
  id: "identity.websearch",
  name: "Identity — Web search (Brave) + readability extract",
  category: "search",
  supportedTargetTypes: ["person"],
  requiresCredentials: true,
  isOptional: true,

  async execute(target: CollectorTarget): Promise<CollectorRunOutcome<IdentityWebsearchRaw>> {
    const clock = startExecution();
    const query = target.value.trim();
    if (!query) {
      const err = new CollectorError("identity.websearch", "invalid-target", "No search query supplied.");
      return { execution: finishExecution(clock, "failed", 0, err.toInfo()), raw: null };
    }

    const cred = await resolveCredential("brave-search");
    if (!cred) {
      try {
        const { fetchNewsDorkHits } = await import("../../dorks");
        const { hits: dorkHits } = await fetchNewsDorkHits(query, MAX_HITS);
        const hits: SearchHit[] = dorkHits.map((h) => ({
          title: h.title,
          url: h.url,
          description: `Publisher: ${h.source} | Published: ${h.pubDate}`,
        }));
        let extracted: ExtractedPage | null = null;
        let extractionWarning: string | null = null;
        let discoveredOrganizations: DiscoveredOrganization[] = [];
        let orgExtractionWarning: string | null = null;
        if (hits.length > 0 && hits[0].url) {
          const res = await extractTopResult(hits[0].url);
          extracted = res.page;
          extractionWarning = res.warning;
          if (extracted) {
            const orgRes = await discoverOrganizations(extracted);
            discoveredOrganizations = orgRes.orgs;
            orgExtractionWarning = orgRes.warning;
          }
        }
        return {
          execution: finishExecution(clock, "completed", hits.length),
          raw: { query, hits, extracted, extractionWarning, discoveredOrganizations, orgExtractionWarning },
        };
      } catch (err: any) {
        return {
          execution: finishExecution(clock, "completed", 0),
          raw: {
            query,
            hits: [],
            extracted: null,
            extractionWarning: err?.message ?? String(err),
            discoveredOrganizations: [],
            orgExtractionWarning: null,
          },
        };
      }
    }

    try {
      const res = await fetch(
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${MAX_HITS}`,
        {
          headers: { accept: "application/json", "x-subscription-token": cred.secret },
          signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
        },
      );
      await recordCredentialUse("brave-search", cred.entryId);

      if (res.status === 429) {
        const err = new CollectorError("identity.websearch", "rate-limited", "Brave Search rate-limited this request (HTTP 429).");
        return { execution: finishExecution(clock, "failed", 0, err.toInfo()), raw: null };
      }
      if (res.status === 401 || res.status === 403) {
        const err = new CollectorError("identity.websearch", "no-credential", `Brave Search rejected the API key (HTTP ${res.status}).`);
        return { execution: finishExecution(clock, "failed", 0, err.toInfo()), raw: null };
      }
      if (!res.ok) {
        const err = new CollectorError("identity.websearch", "upstream-error", `Brave Search returned HTTP ${res.status}.`);
        return { execution: finishExecution(clock, "failed", 0, err.toInfo()), raw: null };
      }

      const body = await res.json();
      const hits = parseHits(body);
      if (hits.length === 0) {
        return {
          execution: finishExecution(clock, "completed", 0),
          raw: {
            query,
            hits: [],
            extracted: null,
            extractionWarning: null,
            discoveredOrganizations: [],
            orgExtractionWarning: null,
          },
        };
      }

      // A failed extraction is disclosed via `extractionWarning`/`warnings[]`
      // below, not a "partial" execution — the search itself, which is the
      // collector's primary job, fully succeeded either way.
      const { page, warning } = await extractTopResult(hits[0].url);
      let discoveredOrganizations: DiscoveredOrganization[] = [];
      let orgExtractionWarning: string | null = null;
      if (page) {
        const orgRes = await discoverOrganizations(page);
        discoveredOrganizations = orgRes.orgs;
        orgExtractionWarning = orgRes.warning;
      }
      return {
        execution: finishExecution(clock, "completed", hits.length),
        raw: { query, hits, extracted: page, extractionWarning: warning, discoveredOrganizations, orgExtractionWarning },
      };
    } catch (err) {
      const classified = classifyError("identity.websearch", err);
      return { execution: finishExecution(clock, "failed", 0, classified.toInfo()), raw: null };
    }
  },

  normalize(outcome) {
    const guard = normalizeGuard(outcome);
    if (guard) return guard;
    const r = outcome.raw!;
    const collectedAt = outcome.execution.completedAt ?? outcome.execution.startedAt;

    const targetId = `identity.websearch:target:${r.query}`;
    const entities: CollectorEntity[] = [
      { id: targetId, type: "person", value: r.query, displayName: r.query, source: "identity.websearch", confidence: UNSCORED, metadata: {} },
    ];
    const relationships: CollectorRelationship[] = [];
    const evidence: CollectorEvidence[] = [];

    for (const hit of r.hits) {
      const articleId = `identity.websearch:article:${hit.url}`;
      const isExtracted = r.extracted?.url === hit.url;
      entities.push({
        id: articleId,
        type: "article",
        value: hit.url,
        displayName: hit.title,
        source: "identity.websearch",
        confidence: UNSCORED,
        metadata: isExtracted ? { extracted: true, truncated: r.extracted!.truncated } : { extracted: false },
      });
      relationships.push({
        sourceEntity: targetId,
        relationshipType: "MENTIONED_IN",
        targetEntity: articleId,
        confidence: UNSCORED,
        source: "identity.websearch",
      });
      evidence.push({
        source: "Brave Search",
        sourceUrl: hit.url,
        collector: "identity.websearch",
        collectedAt,
        rawValue: isExtracted ? { ...hit, extractedText: r.extracted!.text } : hit,
        normalizedValue: isExtracted
          ? { title: r.extracted!.title ?? hit.title, url: hit.url, text: r.extracted!.text, truncated: r.extracted!.truncated }
          : { title: hit.title, url: hit.url, description: hit.description },
        confidence: null,
        metadata: {},
      });
    }

    // Real organizations, discovered by real LLM extraction over the real
    // extracted article text — not the analyst's typed seed value, which
    // person-investigation.ts's buildSeedEntities() already handles
    // separately. confidence carries the model's own calibrated score,
    // never UNSCORED, since this is a real per-entity measurement.
    for (const org of r.discoveredOrganizations) {
      const orgId = `identity.websearch:organization:${org.name.toLowerCase()}`;
      const orgConfidence: ConfidenceScore = {
        value: org.confidence,
        reasons: [`LLM entity extraction over the top real search result for "${r.query}".`],
      };
      entities.push({
        id: orgId,
        type: "organization",
        value: org.name,
        displayName: org.name,
        source: "identity.websearch",
        confidence: orgConfidence,
        metadata: r.extracted ? { mention: org.mention, sourceUrl: r.extracted.url } : { mention: org.mention },
      });
      relationships.push({
        sourceEntity: targetId,
        relationshipType: "WORKS_AT",
        targetEntity: orgId,
        confidence: orgConfidence,
        source: "identity.websearch",
      });
    }

    const warnings: string[] = [];
    if (r.hits.length === 0) warnings.push(`No web results for "${r.query}".`);
    if (r.extractionWarning) warnings.push(r.extractionWarning);
    if (r.orgExtractionWarning) warnings.push(r.orgExtractionWarning);
    if (r.extracted && r.discoveredOrganizations.length === 0 && !r.orgExtractionWarning) {
      warnings.push("No organization affiliation found in the extracted article text.");
    }

    return InvestigationResultSchema.parse({
      entities,
      relationships,
      evidence,
      warnings,
      errors: [],
      metadata: { query: r.query, hitCount: r.hits.length },
      execution: outcome.execution,
    });
  },

  async healthCheck(): Promise<CollectorHealth> {
    const checkedAt = new Date().toISOString();
    const cred = await resolveCredential("brave-search");
    if (!cred) {
      return { state: "no-credential", detail: "BRAVE_SEARCH_API_KEY is not configured.", checkedAt };
    }
    return { state: "ready", detail: "Brave Search API key is configured.", checkedAt };
  },
};
