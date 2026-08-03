/**
 * Module 2 — open-source content analysis, LLM-backed layer (PS-18 §6.2).
 *
 * Imports analysis.ts, never the reverse. The deterministic layer must keep
 * working with the model unreachable; making the dependency one-directional is
 * what guarantees that structurally rather than by convention.
 *
 * Prompt discipline throughout: the model reports only what a source states,
 * preserves the source's own hedging, and supplies its own confidence values.
 * Nothing here invents a number. On any failure llm.ts throws
 * LlmUnavailableError and the UI renders an explicit unavailable state.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { chat, chatJson, LlmUnavailableError } from "./llm";
import { detectLanguage, sourceKeyOf, type Article, type StoryCluster } from "./analysis";

// ─── Shared system prompt ──────────────────────────────────────────────────

/**
 * Two rules do the heavy lifting here.
 *
 * "Preserve hedging" matters because stripping "reportedly" from a sentence
 * converts an unverified claim into an assertion. That is the single most
 * dangerous thing a summariser can do to an intelligence product, and models
 * do it by default because clean declarative prose reads better.
 *
 * "Do not add context you know" blocks the other failure: the model filling in
 * background from training data, which then reads to the analyst as though the
 * source said it.
 */
const CONTENT_SYSTEM =
  "You are an OSINT analyst assistant working on open-source reporting. " +
  "State ONLY what the supplied text states. Do not infer, speculate, or add " +
  "background context you happen to know. PRESERVE the source's own hedging " +
  "exactly — if the source says 'reportedly', 'alleged', 'unconfirmed' or " +
  "'sources say', your output must carry the same qualifier. Never upgrade a " +
  "hedged claim into a statement of fact. Reply with raw JSON only, no markdown " +
  "fences and no commentary.";

/** Article text as the model sees it, bounded so one long body cannot blow the budget. */
function articleText(article: Article, limit = 6000): string {
  return `${article.title ?? ""}\n\n${article.body ?? ""}`.trim().slice(0, limit);
}

// ─── 5. Article summary ────────────────────────────────────────────────────

export const ArticleSummarySchema = z.object({
  summary: z.string().min(1),
  /** Verbatim hedging the model found — auditable evidence that it looked. */
  hedgingPresent: z.array(z.string()).max(8).default([]),
  /** The model's own certainty that the summary faithfully reflects the source. */
  faithfulness: z.number().min(0).max(1),
});
export type ArticleSummary = z.infer<typeof ArticleSummarySchema>;

export interface ArticleSummaryResult extends ArticleSummary {
  model: string;
  provider: string;
  cacheHit: boolean;
  /** Deterministic detection, not the model's opinion. */
  sourceLanguage: string;
}

export async function summariseArticle(article: Article): Promise<ArticleSummaryResult> {
  const text = articleText(article);
  if (!text) throw new LlmUnavailableError("Article has no title or body to summarise.");

  const lang = detectLanguage(article);

  const prompt = `Summarise the article below for an intelligence briefing.

Rules:
- 2 to 3 sentences. Factual. No embellishment.
- State ONLY what the source states. If the source is thin, write less.
- Do not infer motive, blame, causation or consequence the text does not state.
- PRESERVE hedging. If the source says "reportedly", "allegedly", "unconfirmed",
  "sources say" or similar, your summary must carry the same qualifier.
- Write the summary in English regardless of the source language.

Also return:
- "hedgingPresent": the hedging words or phrases you found in the source, verbatim.
  Empty array if the source asserts everything flatly.
- "faithfulness": YOUR calibrated certainty (0-1) that the summary reflects the
  source without addition. Lower it when the source is fragmentary.

Return JSON: {"summary": string, "hedgingPresent": string[], "faithfulness": number}

Source publication: ${article.source || "unknown"}
Detected source language: ${lang.name}${lang.ambiguous ? " (script-level detection; language within the script is ambiguous)" : ""}

Article:
"""
${text}
"""`;

  const out = await chatJson(prompt, ArticleSummarySchema, {
    system: CONTENT_SYSTEM,
    maxTokens: 1800,
  });

  return {
    ...out.value,
    model: out.model,
    provider: out.provider,
    cacheHit: out.cacheHit,
    sourceLanguage: lang.name,
  };
}

// ─── 6. Entity extraction ──────────────────────────────────────────────────

export const AnalysisEntitySchema = z.object({
  entity: z.string().min(1),
  type: z.enum(["PERSON", "ORGANISATION", "LOCATION", "EQUIPMENT", "EVENT", "OTHER"]),
  /**
   * The MODEL's confidence. Never computed here, never defaulted — a schema
   * mismatch throws in llm.ts rather than being filled with a plausible number.
   */
  confidence: z.number().min(0).max(1),
  /** The span the entity was read from, so an analyst can check it against the text. */
  mention: z.string().default(""),
});
export const AnalysisEntitiesSchema = z.object({
  entities: z.array(AnalysisEntitySchema).max(40),
});
export type AnalysisEntity = z.infer<typeof AnalysisEntitySchema>;

export interface EntityResult {
  entities: AnalysisEntity[];
  model: string;
  provider: string;
  cacheHit: boolean;
  sourceLanguage: string;
}

export async function extractEntities(article: Article): Promise<EntityResult> {
  const text = articleText(article);
  if (!text) throw new LlmUnavailableError("Article has no title or body for entity extraction.");

  const lang = detectLanguage(article);

  const prompt = `Extract named entities from the text below.

Categories:
- PERSON: named individuals
- ORGANISATION: states, armed forces, agencies, companies, groups
- LOCATION: countries, regions, cities, bases, waterways
- EQUIPMENT: military or industrial materiel — aircraft, vessels, missiles,
  radar, munitions, platforms. Name the specific system where the text names it.
- EVENT: named operations, exercises, incidents, summits
- OTHER: anything named that fits none of the above

Rules:
- Only entities EXPLICITLY present in the text. Do not add entities you associate
  with the topic.
- "confidence" is YOUR calibrated certainty (0-1) that the extraction and its type
  are correct. Do not return a uniform value for every entity.
- "mention" is the exact substring the entity was read from.
- If the text is in a language other than English, return the entity in its
  original form and do not translate it.

Return JSON: {"entities": [{"entity": string, "type": string, "confidence": number, "mention": string}]}

Text:
"""
${text}
"""`;

  const out = await chatJson(prompt, AnalysisEntitiesSchema, {
    system: CONTENT_SYSTEM,
    maxTokens: 2400,
  });

  return {
    entities: out.value.entities,
    model: out.model,
    provider: out.provider,
    cacheHit: out.cacheHit,
    sourceLanguage: lang.name,
  };
}

// ─── 7. Cluster synthesis ──────────────────────────────────────────────────

export const ClusterSynthesisSchema = z.object({
  /** What all sources agree happened. */
  consensus: z.string().min(1),
  /**
   * Where they contradict each other. The most valuable output in the module:
   * an analyst needs to know two outlets give different casualty figures far
   * more than they need a smooth merged paragraph.
   */
  disagreements: z
    .array(
      z.object({
        point: z.string().min(1),
        positions: z
          .array(z.object({ source: z.string().min(1), claim: z.string().min(1) }))
          .min(2),
      }),
    )
    .max(8)
    .default([]),
  /** Facts carried by only one source in the cluster. */
  uncorroborated: z.array(z.string()).max(8).default([]),
  confidence: z.number().min(0).max(1),
});
export type ClusterSynthesis = z.infer<typeof ClusterSynthesisSchema>;

export interface ClusterSynthesisResult extends ClusterSynthesis {
  model: string;
  provider: string;
  cacheHit: boolean;
  /** Distinct detected languages across the cluster's members. */
  languages: string[];
  /** True when the cluster spans more than one language — the Indic capability. */
  crossLingual: boolean;
  sourcesAnalysed: number;
}

/**
 * Synthesise across a story cluster.
 *
 * CROSS-LINGUAL: members are fed to the model in their ORIGINAL language, and
 * the synthesis is produced in English. That is the Indic capability PS-18 asks
 * for — a Tamil report and an English wire story about the same incident are
 * compared directly rather than being translated first and losing whatever the
 * translation drops. Sarvam is the primary provider precisely because it is
 * trained on Indian languages.
 */
export async function summariseCluster(cluster: StoryCluster): Promise<ClusterSynthesisResult> {
  const members = cluster?.members ?? [];
  if (members.length === 0) throw new LlmUnavailableError("Cluster has no members to synthesise.");
  if (members.length === 1) {
    throw new LlmUnavailableError(
      `Only one source (${sourceKeyOf(members[0])}) reports this story. Cross-source ` +
        `synthesis needs at least two; use the per-article summary instead.`,
    );
  }

  const detected = members.map((m) => detectLanguage(m));
  const languages = Array.from(new Set(detected.map((d) => d.name)));
  const crossLingual = languages.length > 1;

  // Bounded per member so a large cluster cannot exceed the context window.
  const perMember = Math.max(600, Math.floor(9000 / members.length));
  const rendered = members
    .map((m, i) => {
      const lang = detected[i];
      return `[${i + 1}] Source: ${sourceKeyOf(m)} | Published: ${m.pubDate} | Language: ${lang.name}
Headline: ${m.title}
${(m.body ?? "").trim().slice(0, perMember)}`;
    })
    .join("\n\n---\n\n");

  const prompt = `Below are ${members.length} reports from different sources about what appears
to be the same event.${crossLingual ? ` They are in DIFFERENT LANGUAGES (${languages.join(", ")}). Read each in its original language; do not assume the English report is authoritative.` : ""}

Produce a cross-source synthesis:

1. "consensus" — what the sources AGREE on. 2 to 4 sentences, in English.
   Preserve hedging: if the sources hedge a claim, so must you.

2. "disagreements" — every point where sources CONTRADICT each other on a fact:
   numbers, dates, locations, attribution, sequence of events. For each, list at
   least two positions with the source name and what that source claims. This is
   the most important field. If sources genuinely agree throughout, return an
   empty array — do not manufacture a disagreement.

3. "uncorroborated" — specific facts asserted by only ONE source and absent from
   the others. Name the source in the string.

4. "confidence" — YOUR calibrated certainty (0-1) that these reports describe the
   same event and that your synthesis is accurate. Lower it if the reports may be
   about different events.

Do not merge contradictions into a single averaged claim. Do not add any fact that
none of the reports contains.

Return JSON: {"consensus": string, "disagreements": [{"point": string, "positions": [{"source": string, "claim": string}]}], "uncorroborated": string[], "confidence": number}

REPORTS:
${rendered}`;

  const out = await chatJson(prompt, ClusterSynthesisSchema, {
    system: CONTENT_SYSTEM,
    // Synthesis is the most demanding call in the module: N documents in, a
    // structured comparison out, on top of the reasoning budget both models
    // consume before writing anything.
    maxTokens: 2800,
  });

  return {
    ...out.value,
    model: out.model,
    provider: out.provider,
    cacheHit: out.cacheHit,
    languages,
    crossLingual,
    sourcesAnalysed: members.length,
  };
}

// ─── Narrative framing comparison ──────────────────────────────────────────
// Prose rather than JSON: how two outlets frame one event is a judgement that
// does not decompose into fields without losing the point.

export async function compareFraming(cluster: StoryCluster): Promise<{
  text: string;
  model: string;
  provider: string;
  cacheHit: boolean;
}> {
  const members = cluster?.members ?? [];
  if (members.length < 2) {
    throw new LlmUnavailableError("Framing comparison needs at least two sources in the cluster.");
  }

  const rendered = members
    .slice(0, 8)
    .map((m) => `- ${sourceKeyOf(m)}: "${m.title}"`)
    .join("\n");

  const prompt = `These headlines all describe the same event, from different outlets:

${rendered}

In under 150 words, describe how the FRAMING differs: word choice, what each
headline foregrounds, what each omits, and whose perspective each adopts. Quote
the specific wording that carries the difference.

Describe only what the headlines show. Do not assess whether any outlet is right,
and do not speculate about motive or ownership.`;

  const res = await chat(prompt, {
    system:
      "You are a media analyst. Ground every observation in the supplied wording. " +
      "Never speculate about intent or ownership.",
    maxTokens: 2000,
  });
  return { text: res.text, model: res.model, provider: res.provider, cacheHit: res.cacheHit };
}

// ─── Server-function wrappers ──────────────────────────────────────────────
// Thin transport only. The logic above stays in plain functions so it is
// testable outside the Start runtime.

export const aiSummariseArticle = createServerFn({ method: "POST" })
  .validator((d: { article: Article }) => d)
  .handler(async ({ data }) => summariseArticle(data.article));

export const aiExtractEntities = createServerFn({ method: "POST" })
  .validator((d: { article: Article }) => d)
  .handler(async ({ data }) => extractEntities(data.article));

export const aiSummariseCluster = createServerFn({ method: "POST" })
  .validator((d: { cluster: StoryCluster }) => d)
  .handler(async ({ data }) => summariseCluster(data.cluster));

export const aiCompareFraming = createServerFn({ method: "POST" })
  .validator((d: { cluster: StoryCluster }) => d)
  .handler(async ({ data }) => compareFraming(data.cluster));
