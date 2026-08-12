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
import type { Article } from "./analysis";
import type { GeoRecord } from "./geo";

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

/** Renumber a merged source list so citation numbers are contiguous from 1. */
export function renumber(sources: SourceRef[]): SourceRef[] {
  return sources.map((s, i) => ({ ...s, n: i + 1 }));
}

// ─── Model output schema ───────────────────────────────────────────────────

const CitationList = z.array(z.number().int().positive()).min(1);

export const KeyJudgementSchema = z.object({
  judgement: z.string().min(1),
  confidence: z.enum(["high", "moderate", "low"]),
  /** Why that confidence — the part that makes the qualifier meaningful. */
  confidenceRationale: z.string().min(1),
  sources: CitationList,
});
export type KeyJudgement = z.infer<typeof KeyJudgementSchema>;

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
}

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
    "",
    `## Bottom Line`,
    "",
    product.bottomLine,
    "",
    `## Key Judgements`,
    "",
  ];

  product.keyJudgements.forEach((kj, i) => {
    lines.push(
      `**KJ-${i + 1}. (${kj.confidence.toUpperCase()} confidence)** ${kj.judgement} ` +
        `[${kj.sources.join("][")}]`,
    );
    lines.push("");
    lines.push(`> Confidence basis: ${kj.confidenceRationale}`);
    lines.push("");
  });

  lines.push(`## Findings`, "");
  product.findings.forEach((f) => {
    const tag = f.kind === "assessment" ? " *(analyst assessment, not reported fact)*" : "";
    lines.push(`- ${f.text}${tag} [${f.sources.join("][")}]`);
  });
  lines.push("");

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
