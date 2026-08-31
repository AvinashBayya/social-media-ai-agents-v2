/**
 * Module 5 — intelligence product generation (PS-18 §6.5).
 *
 * §6.5 is the only place the problem statement names the open-source LLM
 * requirement explicitly, so every product carries the model that produced it in
 * a provenance footer. That visibility is compliance evidence, not decoration.
 *
 * This is the convergence layer: sources arrive already scored by Module 1,
 * clustered and entity-extracted by Module 2, carrying Module 3 social signals
 * and Module 4 image findings. The model never collects anything — it
 * synthesises material this system gathered and scored.
 *
 * SOURCING DISCIPLINE is the load-bearing property. An intelligence product
 * whose claims cannot be traced is unusable and, in a defence context,
 * dangerous. So:
 *
 *   - Every judgement and finding must cite numbered sources from the supplied
 *     context.
 *   - Every citation is resolved against the real source list AFTER generation.
 *     A citation to [7] when only six sources were supplied is a fabricated
 *     attribution and fails validation.
 *   - Findings are typed "reported" or "assessment", so an inference is never
 *     rendered as something a source stated.
 *   - A product failing validation is RETRIED ONCE with the specific violations,
 *     then thrown. Partial products are never returned — a brief missing its
 *     sourcing is worse than no brief, because it looks complete.
 *
 * No fallback text anywhere. Failures throw with the real cause.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { chatJson, LlmUnavailableError } from "./llm";
import { bandFor, type CredibilityScore } from "./credibility";
import type { ClaimClass } from "./collectors/result";
import type {
  CaseReportProvenance,
  CollectionCompleteness,
  ReportContradiction,
} from "./cases/case-report";
import {
  COMPLETENESS_CAVEATS,
  CONTRADICTION_CAVEAT,
  NO_CONTRADICTIONS_MESSAGE,
  completenessHeadline,
} from "./cases/case-report";
import type { CrossIntelligenceCorrelation } from "./cases/cross-intelligence";
import {
  CORRELATION_NOT_A_FINDING,
  NO_CORRELATIONS_MESSAGE,
} from "./cases/cross-intelligence";
import type { Article } from "./analysis";
import type { GeoRecord } from "./geo";
import type {
  CollectorEntity,
  CollectorEvidence,
  CollectorRelationship,
} from "./collectors/result";

// ─── Product types ─────────────────────────────────────────────────────────

export type ProductType =
  | "EXECUTIVE_BRIEF"
  | "TARGET_DOSSIER"
  | "EVENT_TIMELINE"
  | "THREAT_ASSESSMENT"
  | "DAILY_SUMMARY";

export interface ProductSpec {
  id: ProductType;
  label: string;
  description: string;
  /** Task framing given to the model. */
  brief: string;
  maxTokens: number;
}

export const PRODUCT_TYPES: ProductSpec[] = [
  {
    id: "EXECUTIVE_BRIEF",
    label: "Executive Brief",
    description: "One page. Bottom line up front, key developments, and why it matters.",
    brief:
      "Write a one-page executive brief. Lead with the bottom line. Cover the key " +
      "developments and their significance for a decision-maker who has not read the " +
      "underlying reporting. Be concise — a senior reader will stop after the judgements.",
    maxTokens: 2800,
  },
  {
    id: "TARGET_DOSSIER",
    label: "Target Dossier",
    description: "Everything the collected material establishes about one entity.",
    brief:
      "Write a dossier on the subject, covering what the supplied material establishes about " +
      "its activity, associations and reporting profile. Where the material is thin on an " +
      "aspect, record that as a gap rather than filling it.",
    maxTokens: 2800,
  },
  {
    id: "EVENT_TIMELINE",
    label: "Event Timeline",
    description: "Chronological reconstruction, each event attributed to its source.",
    brief:
      "Reconstruct the sequence of events chronologically. Each entry must carry its own " +
      "source citation and the time the source reports. Where sources disagree on ordering " +
      "or timing, say so explicitly rather than picking one.",
    maxTokens: 2800,
  },
  {
    id: "THREAT_ASSESSMENT",
    label: "Threat Assessment",
    description: "Structured risk analysis grounded in the collected reporting.",
    brief:
      "Assess the threat picture the supplied material supports. Distinguish clearly between " +
      "what sources report and what you assess from it. Do not assign a numeric risk score — " +
      "no factor in this system computes one and an invented figure would be read as measured.",
    maxTokens: 2800,
  },
  {
    id: "DAILY_SUMMARY",
    label: "Daily Summary",
    description: "What changed across monitored subjects in the collected window.",
    brief:
      "Summarise developments across the supplied material for a daily read. Group related " +
      "reporting. Note where a story is carried by only one source.",
    maxTokens: 2800,
  },
];

export const CLASSIFICATION = "UNCLASSIFIED // DEMONSTRATOR";

// ─── Sources ───────────────────────────────────────────────────────────────

export type ContributingModule =
  | "Module 1 · credibility"
  | "Module 2 · content analysis"
  | "Module 3 · social"
  | "Module 4 · imagery"
  | "Module 5 · GIS";

export interface SourceRef {
  /** Citation number, 1-based, as it appears in the product. */
  n: number;
  title: string;
  outlet: string;
  url: string;
  /** As the source reported it. Empty string when it reported none. */
  publishedAt: string;
  module: ContributingModule;
  /** Module 1 score, 0-1, or null when the item could not be scored. */
  credibility: number | null;
  /** Why it scored what it did — the auditable half. */
  credibilityRationale: string;
  /** Text actually given to the model for this source. */
  excerpt: string;
  /**
   * Provenance back into a case's own evidence (2026-08-30, ported).
   *
   * Optional and additive: every pre-existing producer (`sourcesFromArticles`,
   * `sourcesFromSocial`, …) predates these and sets none, so requiring them
   * would break sources that legitimately have no collector evidence behind
   * them. Their ABSENCE means "not sourced from case evidence" — it is never
   * filled in with a plausible-looking id.
   */
  evidenceId?: string;
  collector?: string;
  claimClass?: ClaimClass;
  /** The case this source belongs to, so a citation cannot be traced to the wrong run. */
  caseId?: string;
}

const EXCERPT_CHARS = 600;

/** Articles scored by Module 1 into numbered, citable sources. */
export function sourcesFromArticles(
  articles: Article[],
  scores: CredibilityScore[],
  startAt = 1,
): SourceRef[] {
  const byId = new Map(scores.map((s) => [s.article.id, s]));
  return articles.map((a, i) => {
    const score = byId.get(a.id);
    return {
      n: startAt + i,
      title: a.title,
      outlet: a.source,
      url: a.url,
      publishedAt: a.pubDate,
      module: "Module 1 · credibility" as const,
      credibility: score?.score ?? null,
      credibilityRationale:
        score?.explanation ?? "Not scored — no credibility factor could be computed for this item.",
      excerpt: (a.body || a.title).slice(0, EXCERPT_CHARS),
    };
  });
}

/** Social posts, carrying their Module 3 context. */
export function sourcesFromSocial(
  posts: {
    id: string;
    author: string;
    text: string;
    url: string;
    createdAt: string;
    platform: string;
  }[],
  context: Record<string, { cibScore: number | null; maturityConcern: number | null }> = {},
  startAt = 1,
): SourceRef[] {
  return posts.map((p, i) => {
    const c = context[p.id];
    const notes: string[] = [];
    if (c?.cibScore != null) notes.push(`coordination signals ${c.cibScore.toFixed(2)}`);
    if (c?.maturityConcern != null)
      notes.push(`account maturity concern ${c.maturityConcern.toFixed(2)}`);
    return {
      n: startAt + i,
      title: p.text.slice(0, 120),
      outlet: `${p.author} (${p.platform})`,
      url: p.url,
      publishedAt: p.createdAt,
      module: "Module 3 · social" as const,
      credibility: null,
      credibilityRationale: notes.length
        ? `Social post. ${notes.join("; ")}. Coordination is not inauthenticity — treat as a review prompt.`
        : "Social post. No coordination assessment was run over this post's cluster.",
      excerpt: p.text.slice(0, EXCERPT_CHARS),
    };
  });
}

/** Images analysed in Module 4 that produced findings worth citing. */
export function sourcesFromImages(
  images: { id: string; name: string; findings: string[]; capturedAt: string | null }[],
  startAt = 1,
): SourceRef[] {
  return images.map((img, i) => ({
    n: startAt + i,
    title: `Image analysis: ${img.name}`,
    outlet: "Module 4 imagery workbench",
    url: "",
    publishedAt: img.capturedAt ?? "",
    module: "Module 4 · imagery" as const,
    credibility: null,
    credibilityRationale:
      "Forensic findings from the image itself. Cryptographic findings (C2PA) are verified; " +
      "metadata findings are self-reported by the writing device and editable.",
    excerpt: img.findings.join(" ").slice(0, EXCERPT_CHARS),
  }));
}

/** Geospatial records with real coordinates. */
export function sourcesFromGeo(records: GeoRecord[], startAt = 1): SourceRef[] {
  return records.map((r, i) => ({
    n: startAt + i,
    title: r.title,
    outlet: r.source,
    url: r.url,
    // Empty rather than null: a GeoRecord can be undated, and the citation
    // block renders an empty date as absent.
    publishedAt: r.timestamp ?? "",
    module: "Module 5 · GIS" as const,
    credibility: r.credibility,
    credibilityRationale: `Geolocated record. Coordinate locates ${r.locates}.`,
    excerpt: `${r.title}. ${r.magnitudeLabel}. Coordinate ${r.lat.toFixed(4)}, ${r.lon.toFixed(4)} (${r.precision}).`,
  }));
}

/** A truncated, real (never invented) rendering of a collector's structured output — the same fallback `recon.tsx`'s evidence list already uses for the same `unknown`-shaped field. */
function summarizeOsintValue(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json && json !== "{}" && json !== "null" ? json : "(no normalized value)";
  } catch {
    return "(not serializable)";
  }
}

/**
 * The PS-18 module a collector's evidence belongs to (2026-08-30, ported).
 *
 * Both `sourcesFromX` functions over collector evidence used to hardcode
 * `"Module 2 · content analysis"` for EVERY record, which was true while every
 * case-reachable collector really was content analysis. It stopped being true
 * once GEOINT records became attachable: an EXIF fix, a perceptual match and a
 * geolocation hypothesis are Module 4 work, and §6.5 makes provenance visibility
 * a compliance artefact — a false module label in the PDF footer is not cosmetic.
 *
 * Content analysis remains the DEFAULT rather than an unknown marker, because it
 * is what every other collector in the registry actually does. Only a collector
 * whose module is genuinely different is mapped away from it.
 */
export function moduleForCollector(collector: string): ContributingModule {
  return collector === "geoint" ? "Module 4 · imagery" : "Module 2 · content analysis";
}

/**
 * OSINT collector evidence (`src/utils/collectors/result.ts`), from
 * `runOsintInvestigation`/`pollOsintInvestigationJob` — every existing
 * collector (DNS, RDAP, crt.sh, Shodan InternetDB, dorks, news, social) and
 * both external tools (theHarvester, SpiderFoot) produce this same shape, so
 * one function covers all of them; there is no separate "external results"
 * path to wire in.
 *
 * The module label comes from `moduleForCollector`, not a literal: content
 * analysis for the collectors that do content analysis, Module 4 for GEOINT.
 * Both values already exist in `ContributingModule`, so the report UI and the
 * PDF footer need learn nothing new.
 */
export function sourcesFromOsintEvidence(evidence: CollectorEvidence[], startAt = 1): SourceRef[] {
  return evidence.map((e, i) => ({
    n: startAt + i,
    title: `${e.collector}: ${summarizeOsintValue(e.normalizedValue).slice(0, 100)}`,
    outlet: e.source,
    url: e.sourceUrl ?? "",
    publishedAt: e.collectedAt,
    module: moduleForCollector(e.collector),
    credibility: e.confidence?.value ?? null,
    credibilityRationale:
      e.confidence && e.confidence.reasons.length > 0
        ? e.confidence.reasons.join("; ")
        : "Not scored — this collector does not compute a confidence value for its evidence.",
    excerpt: summarizeOsintValue(e.normalizedValue).slice(0, EXCERPT_CHARS),
  }));
}

/**
 * Case evidence → numbered sources, WITH the provenance chain intact
 * (2026-08-30, ported).
 *
 * Deliberately separate from `sourcesFromOsintEvidence` above rather than a
 * change to it. That function serves the ad-hoc `/reports` flow where evidence
 * comes from a throwaway investigation and has no case, no evidence id worth
 * citing and no claim class to preserve. Widening it would have meant either
 * optional-everything or fabricating ids for records that have none.
 *
 * The difference that matters: a citation produced here can be walked back to
 * `evidenceId` in a named case. One produced by the older function cannot.
 */
export function sourcesFromCaseEvidence(
  evidence: readonly CollectorEvidence[],
  caseId: string,
  startAt = 1,
): SourceRef[] {
  return evidence.map((e, i) => ({
    n: startAt + i,
    title: `${e.collector}: ${summarizeOsintValue(e.normalizedValue).slice(0, 100)}`,
    outlet: e.source,
    url: e.sourceUrl ?? "",
    publishedAt: e.collectedAt,
    module: moduleForCollector(e.collector),
    credibility: e.confidence?.value ?? null,
    credibilityRationale:
      e.confidence && e.confidence.reasons.length > 0
        ? e.confidence.reasons.join("; ")
        : "Not scored — this collector does not compute a confidence value for its evidence.",
    excerpt: summarizeOsintValue(e.normalizedValue).slice(0, EXCERPT_CHARS),
    // The chain the audit found broken. `evidenceId` is only set when the record
    // actually carries one — never minted, because a citation pointing at an id
    // that does not exist is worse than one that admits it has none.
    ...(e.evidenceId ? { evidenceId: e.evidenceId } : {}),
    collector: e.collector,
    ...(e.claimClass ? { claimClass: e.claimClass } : {}),
    caseId,
  }));
}

/**
 * OSINT relationships as citable facts in their own right ("X RESOLVES_TO
 * Y"), distinct from evidence — a relationship has no `collectedAt`/`sourceUrl`
 * of its own, only the collector that asserted it and, sometimes, a
 * confidence score from entity resolution (§17).
 */
export function sourcesFromOsintRelationships(
  relationships: CollectorRelationship[],
  entities: CollectorEntity[],
  startAt = 1,
): SourceRef[] {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const nameOf = (id: string) => byId.get(id)?.displayName ?? id;
  return relationships.map((r, i) => {
    const text = `${nameOf(r.sourceEntity)} ${r.relationshipType.toLowerCase().replace(/_/g, " ")} ${nameOf(r.targetEntity)}`;
    return {
      n: startAt + i,
      title: text,
      outlet: r.source,
      url: "",
      // Relationships carry no timestamp of their own in the P1 contract.
      publishedAt: "",
      module: "Module 2 · content analysis" as const,
      credibility: r.confidence.value,
      credibilityRationale:
        r.confidence.reasons.length > 0
          ? r.confidence.reasons.join("; ")
          : "Not scored — asserted directly by the collector, not derived from cross-source matching.",
      excerpt: text,
    };
  });
}

/** Renumber a merged source list so citation numbers are contiguous from 1. */
export function renumber(sources: SourceRef[]): SourceRef[] {
  return sources.map((s, i) => ({ ...s, n: i + 1 }));
}

// ─── Model output schema ───────────────────────────────────────────────────

const CitationList = z.array(z.number().int().positive()).min(1);

export const KeyJudgementSchema = z.object({
  judgement: z.string().min(1),
  confidence: z.enum(["high", "moderate", "low"]),
  /**
   * Why that confidence — the part that makes the qualifier meaningful.
   *
   * `confidence` is the MODEL's assessment of how well the sources support the
   * judgement, not the collectors' confidence in the evidence. Those are
   * different quantities. Every renderer must label this
   * `MODEL_CONFIDENCE_LABEL`; the evidence's own scores stay on the source rows
   * where they belong.
   */
  confidenceRationale: z.string().min(1),
  sources: CitationList,
});
export type KeyJudgement = z.infer<typeof KeyJudgementSchema>;

/**
 * How a key judgement's confidence must be labelled wherever it is shown
 * (2026-08-30, ported).
 *
 * A "high confidence" judgement could sit on 0.3-confidence evidence with
 * nothing distinguishing the two numbers. Naming which quantity this is costs
 * nothing and removes the ambiguity.
 */
export const MODEL_CONFIDENCE_LABEL = "Model assessment confidence";
export const MODEL_CONFIDENCE_NOTE =
  "This is the analysis model's own assessment of how well the cited sources support the " +
  "judgement. It is NOT the collectors' confidence in the underlying evidence — those scores " +
  "are shown per source below.";

export const FindingSchema = z.object({
  text: z.string().min(1),
  /**
   * "reported" = a source states it. "assessment" = the model's inference from
   * the sources. Conflating these is how an analytic leap becomes a fact.
   */
  kind: z.enum(["reported", "assessment"]),
  sources: CitationList,
});
export type Finding = z.infer<typeof FindingSchema>;

export const GapSchema = z.object({
  gap: z.string().min(1),
  why: z.string().min(1),
});
export type IntelligenceGap = z.infer<typeof GapSchema>;

export const ProductSchema = z.object({
  bottomLine: z.string().min(1),
  keyJudgements: z.array(KeyJudgementSchema).min(1).max(8),
  findings: z.array(FindingSchema).min(1).max(20),
  gaps: z.array(GapSchema).min(1).max(10),
});
export type ProductBody = z.infer<typeof ProductSchema>;

// ─── The product ───────────────────────────────────────────────────────────

export interface Provenance {
  model: string;
  provider: string;
  cacheHit: boolean;
  generatedAt: string;
  modules: ContributingModule[];
  notice: string;
}

export interface IntelligenceProduct extends ProductBody {
  id: string;
  type: ProductType;
  typeLabel: string;
  subject: string;
  classification: string;
  sources: SourceRef[];
  provenance: Provenance;
  /**
   * Set when the product was built from a stored case run rather than an
   * ad-hoc subject (2026-08-30, ported). All three below are optional so the
   * existing free-subject flow (open-ended topics like "China Taiwan
   * tensions", which have no case) keeps working unchanged.
   */
  caseProvenance?: CaseReportProvenance;
  /** What the run did and did not cover. Rendered whenever present. */
  completeness?: CollectionCompleteness;
  /**
   * Contradictions detected in this case's own data, from the existing
   * contradiction derivation. An EMPTY ARRAY means "none detected"; `undefined`
   * means "not checked". A renderer must not conflate them.
   */
  contradictions?: ReportContradiction[];
  /**
   * Cross-intelligence correlations. Optional and additive, exactly like the
   * two fields above, so no second report model is created.
   *
   * A correlation is NOT a finding and must never render as one: it says two
   * observations share a supported relationship, and the section that prints it
   * says so before printing any.
   */
  correlations?: CrossIntelligenceCorrelation[];
  /**
   * MEDIAINT claims carried from the case. Optional and additive, like every
   * field above it, so there is still ONE `IntelligenceProduct`.
   *
   * A claim is what a publisher SAID. It is never a finding of this system, and
   * the section that prints them says so before printing any. Its class is
   * carried verbatim from the extractor — REPORTED, or OFFICIAL_STATEMENT where
   * the closed marker list matched. Nothing here can produce OBSERVED.
   */
  mediaClaims?: ReportMediaClaim[];
}

/**
 * One media claim as a report renders it (2026-08-30, ported).
 *
 * A flattened projection of the existing `MediaClaim`, carrying exactly the
 * fields a reader needs to check it: the publisher's own words, who it was
 * attributed to, its class, its confidence, when it was published, where it came
 * from and which evidence record it rests on. No field is added that the
 * extractor did not produce, and none is defaulted — `null` means the source did
 * not supply it.
 */
export interface ReportMediaClaim {
  claimId: string;
  claimText: string;
  claimClass: ClaimClass;
  /** "assert" or "deny". Shown because a denial reads as an assertion without it. */
  polarity: string;
  attributedTo: string | null;
  source: string;
  sourceUrl: string | null;
  publisher: string | null;
  publishedAt: string | null;
  /** Null means not measured. Never flattened to zero. */
  confidence: number | null;
  evidenceRef: string | null;
  syndicated: boolean;
  independentSources: number;
  /** True when this claim is one side of a detected disagreement. Both sides carry it. */
  conflicted: boolean;
}

/** Printed ABOVE any claim, never as a footnote. A list under a heading reads as findings. */
export const CLAIMS_NOT_FINDINGS =
  "Every item below is a claim a publisher made, recorded as REPORTED or OFFICIAL_STATEMENT. " +
  "None is a finding of this system and none has been verified. Where two publishers disagree " +
  "both claims are shown and neither is marked correct.";

export const NO_MEDIA_CLAIMS_MESSAGE =
  "No media claim was extracted from this case's evidence. That means no sentence matched the " +
  "extractor's closed attribution vocabulary — not that the coverage makes no assertions.";

export const AI_NOTICE =
  "This product was generated by a large language model from the numbered sources listed " +
  "above and no other material. It is an AI-generated synthesis, not a verified assessment, " +
  "and requires analyst review before use. Judgements marked 'assessment' are model " +
  "inferences, not reported fact.";

// ─── Prompting ─────────────────────────────────────────────────────────────

const ANALYST_SYSTEM =
  "You are an intelligence analyst drafting a formal product. You are SYNTHESISING THE " +
  "SUPPLIED SOURCE MATERIAL ONLY — you are not answering from your own knowledge. Do not " +
  "introduce any fact, name, figure, date or event that does not appear in the supplied " +
  "sources. Every claim must cite the numbered sources it comes from. Where the sources do " +
  "not support something, record it as an intelligence gap instead of filling it. Reply with " +
  "raw JSON only, no markdown fences and no commentary.";

export function buildSourceContext(sources: SourceRef[]): string {
  return sources
    .map((s) => {
      const cred =
        s.credibility === null
          ? "not scored"
          : `${(s.credibility * 100).toFixed(0)}% (${bandFor(s.credibility).label})`;
      return (
        `[${s.n}] ${s.title}\n` +
        `    Outlet: ${s.outlet} | Published: ${s.publishedAt || "undated"} | ` +
        `Contributed by: ${s.module} | Credibility: ${cred}\n` +
        `    ${s.excerpt.replace(/\s+/g, " ")}`
      );
    })
    .join("\n\n");
}

function buildPrompt(
  spec: ProductSpec,
  subject: string,
  sources: SourceRef[],
  corrections?: string[],
): string {
  const base = `${spec.brief}

SUBJECT: ${subject}
PRODUCT TYPE: ${spec.label}

You have ${sources.length} numbered source(s), and ONLY these. Citation numbers must be
between 1 and ${sources.length}. Citing a number outside that range, or citing a source that
does not support the claim, invalidates the product.

Return JSON with exactly these fields:
{
  "bottomLine": "one or two sentences — the single most important thing a reader must take away",
  "keyJudgements": [
    {
      "judgement": "an analytic judgement supported by the sources",
      "confidence": "high" | "moderate" | "low",
      "confidenceRationale": "why that confidence level — source count, source credibility, corroboration, or the lack of it",
      "sources": [1, 3]
    }
  ],
  "findings": [
    {
      "text": "a specific finding",
      "kind": "reported" | "assessment",
      "sources": [2]
    }
  ],
  "gaps": [
    { "gap": "what could NOT be determined from this material", "why": "why the material does not support it" }
  ]
}

Rules that will be checked mechanically after you answer:
- EVERY keyJudgement and EVERY finding must carry at least one source number.
- Every source number must exist in the list below.
- "kind" must be "reported" when a source states the claim, and "assessment" when it is your
  inference from the sources. Do not mark an inference as reported.
- "gaps" must not be empty. Every collection has limits; state them. If the material is
  strong, the gaps are still real — coverage windows, single-source claims, absent
  corroboration, geographic blind spots.
- Do not assign numeric risk, threat or confidence scores. Use the confidence words only.
- The confidence word you give is YOUR OWN assessment of how well the sources support the
  judgement. It is NOT the collectors' confidence in the underlying evidence, which is shown
  separately. Do not restate a source's credibility score as your confidence.

SOURCES:
${buildSourceContext(sources)}`;

  if (!corrections?.length) return base;

  return (
    `Your previous attempt was REJECTED. Fix these problems exactly and return the full JSON again:\n` +
    corrections.map((c, i) => `${i + 1}. ${c}`).join("\n") +
    `\n\n${base}`
  );
}

// ─── Validation ────────────────────────────────────────────────────────────

export interface ValidationProblem {
  where: string;
  problem: string;
}

/**
 * Resolve every citation against the real source list.
 *
 * This is what makes the sourcing discipline real rather than a prompt
 * instruction. A model can be told to cite and still emit [7] when six sources
 * exist; the only way to know is to check afterwards.
 */
export function validateCitations(body: ProductBody, sources: SourceRef[]): ValidationProblem[] {
  const valid = new Set(sources.map((s) => s.n));
  const problems: ValidationProblem[] = [];

  const check = (nums: number[], where: string) => {
    if (nums.length === 0) {
      problems.push({ where, problem: "carries no source citation" });
      return;
    }
    for (const n of nums) {
      if (!valid.has(n)) {
        problems.push({
          where,
          problem: `cites source [${n}], which does not exist (valid range 1-${sources.length})`,
        });
      }
    }
  };

  /**
   * A corroboration claim must be backed by DISTINCT cited sources.
   *
   * Citation-number validation alone was not enough. Both observed runs produced
   * judgements like "Corroborated by two sources (both 38% credibility)
   * reporting the same milestone" and "Multiple sources (3) reporting the same
   * user milestone… suggesting corroboration" — while citing only [3]. The
   * numbers were all in range, so validation passed, and the product asserted
   * corroboration its own source list contradicted.
   *
   * Corroboration is the single most load-bearing claim an intelligence product
   * makes: it is the difference between one outlet's assertion and an
   * independently supported finding.
   */
  const CORROBORATION =
    /\b(corroborat|multiple sources|several sources|two sources|three sources|both sources|independently confirm)/i;

  const checkCorroboration = (rationale: string, cited: number[], where: string) => {
    if (!CORROBORATION.test(rationale)) return;
    const distinct = new Set(cited.filter((n) => valid.has(n)));
    if (distinct.size >= 2) return;
    problems.push({
      where,
      problem:
        `claims corroboration ("${rationale.slice(0, 80)}…") but cites ` +
        `${distinct.size === 0 ? "no valid source" : `only source [${[...distinct][0]}]`}. ` +
        `A corroboration claim requires at least two distinct cited sources, or ` +
        `must be restated as a single-source report.`,
    });
  };

  body.keyJudgements.forEach((kj, i) =>
    checkCorroboration(
      kj.confidenceRationale ?? "",
      kj.sources,
      `Key judgement ${i + 1} ("${kj.judgement.slice(0, 60)}…") confidence basis`,
    ),
  );

  body.keyJudgements.forEach((kj, i) =>
    check(kj.sources, `Key judgement ${i + 1} ("${kj.judgement.slice(0, 60)}…")`),
  );
  body.findings.forEach((f, i) => check(f.sources, `Finding ${i + 1} ("${f.text.slice(0, 60)}…")`));

  if (body.gaps.length === 0) {
    problems.push({ where: "Intelligence gaps", problem: "section is empty" });
  }

  return problems;
}

/** Citation numbers actually used, so unused sources can be reported. */
export function citedSourceNumbers(body: ProductBody): Set<number> {
  const used = new Set<number>();
  for (const kj of body.keyJudgements) for (const n of kj.sources) used.add(n);
  for (const f of body.findings) for (const n of f.sources) used.add(n);
  return used;
}

// ─── Generation ────────────────────────────────────────────────────────────

export interface GenerateInput {
  type: ProductType;
  subject: string;
  sources: SourceRef[];
  /** Optional case context (2026-08-30, ported). Supplying it does NOT trigger any collection. */
  caseProvenance?: CaseReportProvenance;
  completeness?: CollectionCompleteness;
  contradictions?: ReportContradiction[];
  /** Deterministic correlations. The model never authors these. */
  correlations?: CrossIntelligenceCorrelation[];
  /** MEDIAINT claims from the case. Additive, same rationale as `correlations`. */
  mediaClaims?: ReportMediaClaim[];
}

let productCounter = 0;

/**
 * Generate one product.
 *
 * One retry on validation failure, with the specific violations fed back. If the
 * second attempt still fails, this THROWS — a product with broken sourcing is
 * never returned, because it looks complete and is not.
 */
export async function generateProduct(input: GenerateInput): Promise<IntelligenceProduct> {
  const spec = PRODUCT_TYPES.find((p) => p.id === input.type);
  if (!spec) throw new LlmUnavailableError(`Unknown product type: ${input.type}`);

  const sources = renumber(input.sources);
  if (sources.length === 0) {
    throw new LlmUnavailableError(
      `No sources were supplied for "${input.subject}". Refusing to generate — a product ` +
        `written without source material would be the model's invention, not intelligence.`,
    );
  }

  let corrections: string[] | undefined;
  let lastProblems: ValidationProblem[] = [];

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const out = await chatJson(
      buildPrompt(spec, input.subject, sources, corrections),
      ProductSchema,
      {
        system: ANALYST_SYSTEM,
        maxTokens: spec.maxTokens,
      },
    );

    const problems = validateCitations(out.value, sources);
    if (problems.length === 0) {
      productCounter += 1;
      const modules = Array.from(new Set(sources.map((s) => s.module)));
      return {
        ...out.value,
        id: `${input.type}-${Date.now().toString(36)}-${productCounter}`,
        type: input.type,
        typeLabel: spec.label,
        subject: input.subject,
        classification: CLASSIFICATION,
        sources,
        provenance: {
          model: out.model,
          provider: out.provider,
          cacheHit: out.cacheHit,
          generatedAt: new Date().toISOString(),
          modules,
          notice: AI_NOTICE,
        },
        // Carried straight through. These are FACTS ABOUT THE RUN, established
        // before generation — the model neither sees nor influences them, which
        // is exactly why a model failure cannot silently drop the completeness
        // statement.
        ...(input.caseProvenance ? { caseProvenance: input.caseProvenance } : {}),
        ...(input.completeness ? { completeness: input.completeness } : {}),
        ...(input.contradictions ? { contradictions: input.contradictions } : {}),
        ...(input.correlations ? { correlations: input.correlations } : {}),
        // Carried through like the other run facts. Same rationale: MEDIAINT
        // claims are established before generation, the model does not author
        // them, and toMarkdown/the product view already render them. Without
        // this spread they would be silently dropped from every generated product.
        ...(input.mediaClaims ? { mediaClaims: input.mediaClaims } : {}),
      };
    }

    lastProblems = problems;
    corrections = problems.map((p) => `${p.where} ${p.problem}.`);
  }

  throw new LlmUnavailableError(
    `Generation failed source validation twice and was rejected. An intelligence product ` +
      `whose claims cannot be traced to a source is unusable, so no partial product is ` +
      `returned. Problems on the final attempt: ` +
      lastProblems.map((p) => `${p.where} ${p.problem}`).join("; "),
  );
}

// ─── Markdown rendering ────────────────────────────────────────────────────

export function toMarkdown(product: IntelligenceProduct): string {
  const cred = (s: SourceRef) =>
    s.credibility === null
      ? "not scored"
      : `${(s.credibility * 100).toFixed(0)}% ${bandFor(s.credibility).label}`;

  const lines: string[] = [
    `# ${product.typeLabel}`,
    "",
    `**${product.classification}**`,
    "",
    `| | |`,
    `|---|---|`,
    `| Subject | ${product.subject} |`,
    `| Product type | ${product.typeLabel} |`,
    `| Generated | ${product.provenance.generatedAt} |`,
    `| Model | ${product.provenance.model} |`,
    `| Sources | ${product.sources.length} |`,
  ];

  // ── Case provenance. A product built from a case must name it. ──
  if (product.caseProvenance) {
    const cp = product.caseProvenance;
    lines.push(
      `| Case | ${cp.caseId} — ${cp.caseTitle} |`,
      `| Investigation | ${cp.investigationId} |`,
      `| Run | ${cp.runId ?? "not recorded"} |`,
      `| Collected | ${cp.collectedAt} |`,
      `| Run status | ${cp.runStatus ?? "not recorded"} |`,
    );
  }

  // ── Collection completeness. FIRST, before any finding, because a reader
  //    who stops after the bottom line must still have seen it. ──
  if (product.completeness) {
    const c = product.completeness;
    lines.push(
      "",
      `## Collection completeness — ${c.status}`,
      "",
      completenessHeadline(c),
      "",
    );
    if (c.reasons.length > 0) {
      lines.push(`**${c.reasons.length} limitation${c.reasons.length === 1 ? "" : "s"} recorded:**`, "");
      c.reasons.forEach((r) => lines.push(`- **${r.kind}** · ${r.subject} — ${r.detail}`));
      lines.push("");
    }
    lines.push(
      `Collectors that produced evidence (${c.produced.length}): ${c.produced.join(", ") || "none"}`,
      "",
      `Collectors planned but silent (${c.silent.length}): ${c.silent.join(", ") || "none"}`,
      "",
    );
    COMPLETENESS_CAVEATS.forEach((cv) => lines.push(`> ${cv}`, ""));
  }

  lines.push(
    "",
    `## Bottom Line`,
    "",
    product.bottomLine,
    "",
    `## Key Judgements`,
    "",
    `> ${MODEL_CONFIDENCE_NOTE}`,
    "",
  );

  product.keyJudgements.forEach((kj, i) => {
    lines.push(
      // Names WHICH confidence this is. It was previously rendered as bare
      // "(HIGH confidence)", indistinguishable from a collector score.
      `**KJ-${i + 1}. (${MODEL_CONFIDENCE_LABEL}: ${kj.confidence.toUpperCase()})** ${kj.judgement} ` +
        `[${kj.sources.join("][")}]`,
    );
    lines.push("");
    lines.push(`> ${MODEL_CONFIDENCE_LABEL} basis: ${kj.confidenceRationale}`);
    lines.push("");
  });

  lines.push(`## Findings`, "");
  product.findings.forEach((f) => {
    const tag = f.kind === "assessment" ? " *(analyst assessment, not reported fact)*" : "";
    lines.push(`- ${f.text}${tag} [${f.sources.join("][")}]`);
  });
  lines.push("");

  // ── Contradictions. Placed BEFORE the gaps section: a detected conflict
  //    between the product's own sources is a finding about the material, not
  //    a gap in it. ──
  if (product.contradictions) {
    lines.push(`## Contradictions`, "");
    if (product.contradictions.length === 0) {
      // "No contradictions detected in the available case data" — never
      // "no contradictions exist". The detector's blind spots are real.
      lines.push(NO_CONTRADICTIONS_MESSAGE, "");
    } else {
      lines.push(`> ${CONTRADICTION_CAVEAT}`, "");
      product.contradictions.forEach((c, i) => {
        const conf = (v: number | null) =>
          v === null ? "confidence not measured" : `confidence ${Math.round(v * 100)}%`;
        const ref = (r: string | null) => (r ? `evidence ${r}` : "no evidence id");
        const url = (u: string | null) => (u ? ` — ${u}` : "");
        lines.push(
          `**C-${i + 1} · ${c.kind} · ${c.subject}** — status: ${c.status}`,
          "",
          `- **Claim A** (${c.claimClassA ?? "class not recorded"}, ${conf(c.confidenceA)}): ` +
            `"${c.claimA}" — ${c.sourceA}${url(c.sourceUrlA)} · ${ref(c.evidenceRefA)}` +
            `${c.publishedAtA ? ` · ${c.publishedAtA}` : " · no date reported"}`,
          `- **Claim B** (${c.claimClassB ?? "class not recorded"}, ${conf(c.confidenceB)}): ` +
            `"${c.claimB}" — ${c.sourceB}${url(c.sourceUrlB)} · ${ref(c.evidenceRefB)}` +
            `${c.publishedAtB ? ` · ${c.publishedAtB}` : " · no date reported"}`,
          "",
          `> Possible explanation (hypothesis): ${c.explanation}`,
          `> Basis: ${c.explanationBasis}`,
          "",
        );
      });
    }
  }

  // ── Media claims. What publishers SAID, never what is true. The disclaimer
  //    is printed before the first row for the same reason the correlations
  //    section prints its own: a list under a heading reads as findings. ──
  if (product.mediaClaims) {
    lines.push(`## Media claims (MEDIAINT)`, "");
    lines.push(`> ${CLAIMS_NOT_FINDINGS}`, "");
    if (product.mediaClaims.length === 0) {
      lines.push(NO_MEDIA_CLAIMS_MESSAGE, "");
    } else {
      product.mediaClaims.forEach((c, i) => {
        const conf =
          c.confidence === null ? "confidence not measured" : `confidence ${c.confidence}`;
        lines.push(
          `**C-${i + 1} · ${c.claimClass}${c.polarity === "deny" ? " · DENIAL" : ""}` +
            `${c.conflicted ? " · CONFLICTING" : ""}** — ${conf}`,
          "",
          `"${c.claimText}"`,
          "",
        );
        lines.push(
          `- Source: ${c.source}${c.publisher ? ` (${c.publisher})` : ""}` +
            `${c.sourceUrl ? ` — ${c.sourceUrl}` : " — no URL reported"}`,
        );
        lines.push(`- Published: ${c.publishedAt ?? "date not reported"}`);
        if (c.attributedTo) lines.push(`- Attributed to: ${c.attributedTo}`);
        lines.push(`- Evidence: ${c.evidenceRef ?? "no evidence reference recorded"}`);
        lines.push(
          `- Corroboration: ${c.independentSources} independent publisher` +
            `${c.independentSources === 1 ? "" : "s"}` +
            `${c.syndicated ? " (this copy is syndicated)" : ""}`,
        );
        lines.push("");
      });
    }
  }

  // ── Correlations. A correlation is not a finding, and the section says so
  //    before listing any. ──
  if (product.correlations) {
    lines.push(`## Cross-intelligence correlations`, "");
    lines.push(`> ${CORRELATION_NOT_A_FINDING}`, "");
    if (product.correlations.length === 0) {
      lines.push(NO_CORRELATIONS_MESSAGE, "");
    } else {
      product.correlations.forEach((c, i) => {
        lines.push(
          `**X-${i + 1} · ${c.type} · ${c.disciplines.join(" + ")}** — class ${c.claimClass}, ` +
            `${c.confidence.value === null ? "confidence not measured" : `confidence ${c.confidence.value}`}`,
          "",
          c.explanation,
          "",
        );
        if (c.evidenceRefs.length > 0) {
          lines.push(`- Evidence: ${c.evidenceRefs.join(", ")}`);
        }
        if (c.sourceUrls.length > 0) {
          lines.push(`- Sources: ${c.sourceUrls.join(", ")}`);
        }
        c.limitations.forEach((l) => lines.push(`- Limitation: ${l}`));
        lines.push("");
      });
    }
  }

  lines.push(`## Intelligence Gaps`, "");
  product.gaps.forEach((g) => lines.push(`- **${g.gap}** — ${g.why}`));
  lines.push("");

  lines.push(`## Sources`, "");
  product.sources.forEach((s) => {
    lines.push(
      `${s.n}. **${s.title}** — ${s.outlet}${s.publishedAt ? `, ${s.publishedAt}` : ""}` +
        `${s.url ? ` — ${s.url}` : ""}`,
    );
    lines.push(`   - Credibility: ${cred(s)} · ${s.credibilityRationale}`);
    lines.push(`   - Contributed by: ${s.module}`);
  });
  lines.push("");

  lines.push(`---`, "");
  lines.push(
    `**Provenance.** Generated ${product.provenance.generatedAt} by \`${product.provenance.model}\` ` +
      `(${product.provenance.provider}${product.provenance.cacheHit ? ", served from cache" : ""}). ` +
      `Contributing modules: ${product.provenance.modules.join(", ")}.`,
  );
  lines.push("");
  lines.push(`_${product.provenance.notice}_`);

  return lines.join("\n");
}

// ─── Server-function wrapper ───────────────────────────────────────────────

export const generateIntelligenceProduct = createServerFn({ method: "POST" })
  .validator((d: GenerateInput) => d)
  .handler(async ({ data }) => generateProduct(data));
