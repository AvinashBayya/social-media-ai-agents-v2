import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { CLAIM_CLASSES, CLAIM_CLASS_DETAIL, confidenceBandOf } from "../collectors/result";
import type { ConfidenceBand } from "../collectors/result";
import { chatJson, LlmUnavailableError } from "../llm";
import type { CaseContext } from "./case-context";
import { citableEvidenceIds } from "./case-context";
import { NO_ADJUDICATION_CAVEAT } from "./case-contradictions";

/**
 * Grounded case analysis (2026-08-30, ported from the teammate's fork).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE RULE THIS LAYER ENFORCES MECHANICALLY.
 *
 * A finding must either cite evidence that exists in THIS case's context, or be
 * classed as an inference and say so. Both halves are checked in code after the
 * model answers — a prompt instruction alone is a request, not a guarantee, and
 * this project already learned that in `reports.ts`, whose `validateCitations`
 * retries once with the violations and then throws rather than returning a
 * product with broken sourcing.
 *
 * The same discipline is applied here, with one difference that matters: the
 * citation space is **evidence ids from the case**, not source numbers minted
 * for a document. A number can be invented plausibly. `EVID-T001` either exists
 * in the supplied context or it does not.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * SEVEN CLAIM CLASSES, NOT TWO.
 *
 * `reports.ts` collapses everything into `reported` / `assessment`. That is
 * coarse but adequate for a document. An agent answering a question about
 * evidence must keep the full vocabulary, because the difference between
 * "crt.sh OBSERVED this certificate" and "these observations may INDICATE a
 * relationship" is the entire analytic content of the answer.
 *
 * The model is given each class's own definition from `CLAIM_CLASS_DETAIL` —
 * the same text the rest of the system uses — rather than a paraphrase.
 */

// ─── Answer contract ────────────────────────────────────────────────────────

export const GroundedFindingSchema = z.object({
  /** The finding, in the analyst's language. */
  statement: z.string().min(1),
  /** Which of the seven classes this is. Enforced against the real vocabulary. */
  claimClass: z.enum(CLAIM_CLASSES),
  /**
   * Evidence ids this rests on. May be empty ONLY for INFERRED/HYPOTHESIS, and
   * even then the validator requires a stated basis — see `validateGroundedAnswer`.
   */
  evidenceRefs: z.array(z.string()).default([]),
  /** Why this class and not a stronger one. The part that makes the label meaningful. */
  basis: z.string().min(1),
});
export type GroundedFinding = z.infer<typeof GroundedFindingSchema>;

export const GroundedAnswerSchema = z.object({
  /** Direct answer to the question, or an explicit statement that the evidence does not support one. */
  answer: z.string().min(1),
  findings: z.array(GroundedFindingSchema).max(12),
  /**
   * What the analyst asked that this case's evidence cannot answer. Mandatory
   * and non-empty for the same reason `reports.ts` requires `gaps`: every
   * collection has limits, and a model that reports none is not reporting.
   */
  notSupported: z.array(z.string()).min(1),
  /**
   * The model's own reading of collection completeness, in its own words. Checked
   * against the real status so a PARTIAL run cannot be described as thorough.
   */
  collectionCaveat: z.string().min(1),
});
export type GroundedAnswer = z.infer<typeof GroundedAnswerSchema>;

/**
 * The confidence of the EVIDENCE a finding cites.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * COMPUTED IN CODE, NEVER BY THE MODEL.
 *
 * `GroundedFinding` deliberately carries no confidence number: the model states
 * a CLAIM CLASS, which is a semantic category, not a score. This is the separate
 * quantity — how well-measured the cited records were — and it is derived from
 * the records themselves after the model answers, so the two can never be
 * conflated or traded off against each other.
 *
 * `band` is `null` when nothing cited carried a measured score. That is
 * "unmeasured", not "low" — the same rule `confidenceBandOf(null)` enforces.
 */
export interface EvidenceConfidenceSummary {
  /** Derived from the WEAKEST cited record: a chain is as strong as its weakest link. */
  band: ConfidenceBand | null;
  /** Lowest and highest measured values among the cited records. Null when none was measured. */
  min: number | null;
  max: number | null;
  /** How many cited records carried no measured confidence at all. */
  unmeasured: number;
  cited: number;
}

/** A finding plus the deterministic confidence of the evidence it rests on. */
export interface GroundedFindingWithEvidence extends GroundedFinding {
  evidenceConfidence: EvidenceConfidenceSummary;
}

/**
 * Summarises the confidence of the records a finding cites.
 *
 * Uses the WEAKEST cited record for the band. A finding resting on one 0.95
 * observation and one 0.30 observation is not a 0.95 finding — the weak link is
 * part of the claim, and reporting the strongest would be the same overstatement
 * `computeMergeConfidence` was corrected for.
 */
export function evidenceConfidenceFor(
  finding: GroundedFinding,
  ctx: CaseContext,
): EvidenceConfidenceSummary {
  const cited = finding.evidenceRefs
    .map((ref) => ctx.evidence.find((e) => e.evidenceId === ref))
    .filter((e): e is CaseContext["evidence"][number] => !!e);

  const measured = cited
    .map((e) => e.confidence)
    .filter((v): v is number => typeof v === "number");

  if (measured.length === 0) {
    return {
      // `confidenceBandOf` checks the CLASS before the null score, so an
      // INFERRED or HYPOTHESIS finding bands as HYPOTHESIS even with nothing
      // measured. Deferring to it keeps one rule instead of two that can drift.
      band: confidenceBandOf(null, finding.claimClass),
      min: null,
      max: null,
      unmeasured: cited.length,
      cited: cited.length,
    };
  }

  const min = Math.min(...measured);
  return {
    // The finding's own class still governs: an INFERRED finding is a
    // hypothesis whatever its evidence scored.
    band: confidenceBandOf({ value: min, reasons: [] }, finding.claimClass),
    min,
    max: Math.max(...measured),
    unmeasured: cited.length - measured.length,
    cited: cited.length,
  };
}

export interface GroundedResult extends GroundedAnswer {
  /**
   * The model's findings, each with the deterministic confidence of its cited
   * evidence attached. Two separate quantities, side by side, never merged.
   */
  findings: GroundedFindingWithEvidence[];
  caseId: string;
  model: string;
  provider: string;
  cacheHit: boolean;
  /** Echoed back so a renderer can show exactly what the model was allowed to cite. */
  citableIds: string[];
}

// ─── Prompt ─────────────────────────────────────────────────────────────────

export const GROUNDED_SYSTEM =
  "You are an intelligence analyst answering a question about ONE investigation case. You are " +
  "reasoning ONLY over the supplied case evidence — not from your own knowledge of the world, " +
  "and not from anything outside this case. Do not introduce any fact, name, figure, date, " +
  "organisation or event that does not appear in the supplied context. Where the evidence does " +
  "not support an answer, say so in `notSupported` instead of filling the gap. Reply with raw " +
  "JSON only, no markdown fences and no commentary.";

function claimClassGuide(): string {
  return CLAIM_CLASSES.map((c) => `- ${c}: ${CLAIM_CLASS_DETAIL[c]}`).join("\n");
}

/**
 * Renders the context for the model.
 *
 * Every section states what it is and what it is not. The limitations block goes
 * FIRST, before the evidence, because a model that reads the evidence first
 * anchors on it and treats the caveats as boilerplate.
 */
export function serializeCaseContext(ctx: CaseContext): string {
  const lines: string[] = [];

  lines.push(`CASE: ${ctx.caseId} — ${ctx.caseTitle}`);
  lines.push(`TARGET: ${ctx.target}`);
  if (ctx.description) lines.push(`ANALYST DESCRIPTION: ${ctx.description}`);
  lines.push(`RUN: ${ctx.runId ?? "not recorded"} · investigation ${ctx.investigationId || "not recorded"}`);
  lines.push(`COLLECTED AT: ${ctx.collectedAt || "not recorded"} · run status ${ctx.runStatus ?? "not recorded"}`);
  lines.push("");

  lines.push(`COLLECTION STATUS: ${ctx.completeness.status}`);
  lines.push("COLLECTION LIMITATIONS — you must respect every one of these:");
  ctx.limitations.forEach((l) => lines.push(`  - ${l}`));
  lines.push("");

  lines.push(`EVIDENCE (${ctx.evidence.length} records). Cite by evidenceId.`);
  if (ctx.evidence.length === 0) {
    lines.push("  (none — this case stored no evidence)");
  }
  ctx.evidence.forEach((e) => {
    const conf = e.confidence === null ? "confidence not measured" : `confidence ${e.confidence}`;
    lines.push(
      `  [${e.evidenceId ?? "no-id"}] collector=${e.collector} source=${e.source}` +
        ` url=${e.sourceUrl ?? "none"} collectedAt=${e.collectedAt}` +
        ` class=${e.claimClass ?? "unclassified"} ${conf}`,
    );
    lines.push(`      ${e.summary}`);
  });
  lines.push("");

  if (ctx.entities.length > 0) {
    lines.push(`ENTITIES (${ctx.entities.length}), each asserted by the named collector:`);
    ctx.entities.forEach((e) =>
      lines.push(
        `  ${e.type}: ${e.value} (from ${e.source}, ${e.confidence === null ? "confidence not measured" : `confidence ${e.confidence}`})`,
      ),
    );
    lines.push("");
  }

  if (ctx.relationships.length > 0) {
    lines.push(`RELATIONSHIPS (${ctx.relationships.length}):`);
    ctx.relationships.forEach((r) =>
      lines.push(`  ${r.from} ${r.type} ${r.to} (asserted by ${r.source})`),
    );
    lines.push("");
  }

  if (ctx.claims.length > 0) {
    lines.push(
      `MEDIA CLAIMS (${ctx.claims.length}). These are things PUBLISHERS SAID. A claim is not an observed fact:`,
    );
    ctx.claims.forEach((c) =>
      lines.push(
        `  [${c.evidenceRef ?? "no-id"}] ${c.claimClass} (${c.polarity}) — "${c.claimText}"` +
          ` — ${c.publisher ?? c.source}${c.publishedAt ? ` on ${c.publishedAt}` : " (no publication date reported)"}` +
          `${c.syndicated ? " [SYNDICATED COPY — not an independent source]" : ""}` +
          ` independentSources=${c.independentSources}`,
      ),
    );
    lines.push("");
  }

  // ── Correlations — deterministic, supplied TO the model ──
  lines.push(`CROSS-INTELLIGENCE CORRELATIONS (${ctx.correlations.length}):`);
  if (ctx.correlations.length === 0) {
    lines.push(
      "  None derived. That is not evidence that no relationship exists — only that no collector asserted one across disciplines in this case.",
    );
  } else {
    ctx.correlations.forEach((c, i) => {
      lines.push(
        `  X${i + 1} [${c.id}] ${c.type} · ${c.disciplines.join(" + ")} · class ${c.claimClass}` +
          ` · ${c.confidence.value === null ? "confidence not measured" : `confidence ${c.confidence.value}`}`,
      );
      lines.push(`      ${c.explanation}`);
      if (c.evidenceRefs.length > 0) {
        lines.push(`      evidence: ${c.evidenceRefs.join(", ")}`);
      }
      c.limitations.forEach((l) => lines.push(`      LIMIT: ${l}`));
    });
  }
  lines.push("");

  lines.push(`CONTRADICTIONS (${ctx.contradictions.length}):`);
  if (ctx.contradictions.length === 0) {
    lines.push("  None detected in the available case data. That is not proof the sources agree.");
  } else {
    lines.push(`  ${NO_ADJUDICATION_CAVEAT}`);
    ctx.contradictions.forEach((c, i) => {
      lines.push(
        `  C${i + 1} ${c.kind} · ${c.subject} · status=${c.status}`,
      );
      lines.push(
        `      A [${c.evidenceRefA ?? "no-id"}] ${c.claimClassA ?? "unclassified"}: "${c.claimA}" — ${c.sourceA}`,
      );
      lines.push(
        `      B [${c.evidenceRefB ?? "no-id"}] ${c.claimClassB ?? "unclassified"}: "${c.claimB}" — ${c.sourceB}`,
      );
    });
  }
  lines.push("");

  if (ctx.timeline.length > 0) {
    lines.push(`TIMELINE (${ctx.timeline.length} events):`);
    ctx.timeline.forEach((t) =>
      lines.push(
        `  ${t.observedAt ?? "no observed date"}${t.positionedByRetrieval ? " (POSITIONED BY RETRIEVAL TIME — the real date is unknown)" : ""}` +
          ` [${t.evidenceId ?? "no-id"}] ${t.collector}: ${t.summary}`,
      ),
    );
    lines.push("");
  }

  return lines.join("\n");
}

export function buildGroundedPrompt(
  ctx: CaseContext,
  question: string,
  corrections?: string[],
): string {
  const citable = [...citableEvidenceIds(ctx)];
  const base = `ANALYST QUESTION: ${question}

Answer using ONLY the case material below.

CLAIM CLASSES — every finding must carry exactly one, and you must not choose a
stronger one than the evidence supports:
${claimClassGuide()}

RULES, CHECKED MECHANICALLY AFTER YOU ANSWER:
- Every finding classed OBSERVED, REPORTED or OFFICIAL_STATEMENT MUST cite at least one
  evidenceId, and that id must appear in the citable list below.
- Findings classed DERIVED or CORRELATED MUST cite the evidence they were derived from.
- Findings classed INFERRED or HYPOTHESIS may cite fewer ids, but must still state in
  \`basis\` which observations led to them.
- You MUST NOT invent an evidenceId. Only these ids exist: ${citable.length > 0 ? citable.join(", ") : "(none — this case has no citable evidence)"}
- You MUST NOT cite evidence from any other case.
- Do not restate a REPORTED claim as an OBSERVED fact. A publisher saying something is
  evidence that they said it, not that it is true.
- Do not resolve a contradiction. Both claims stand; the system has not established which is true.
- CONFIDENCE. Each evidence record shows the COLLECTOR's confidence in its own observation.
  That number is not your confidence, and it is not certainty. A record at 0.30 supports
  "the evidence suggests", never "X is confirmed". A record marked "confidence not measured"
  supports LESS, not more — unmeasured means nobody scored it, not that it is reliable.
  Do not describe any finding as confirmed, proven, certain or definitive.
- Do not assign your own numeric confidence to anything. Your classification IS the claim class;
  the evidence's own confidence is reported separately and is not yours to restate.
- CORRELATIONS. The cross-intelligence correlations above were derived DETERMINISTICALLY from
  relationships collectors already asserted. You may explain, group or question them. You MUST
  NOT invent a new one: do not link two records because their values look similar, and do not
  turn a correlation into ownership, identity or a physical location. A correlation marked
  HYPOTHESIS stays a hypothesis in anything you write about it.
- \`notSupported\` must not be empty. State what this case's evidence cannot answer.
- \`collectionCaveat\` must reflect the real collection status (${ctx.completeness.status}) and must
  not describe the investigation as complete or exhaustive when it is not.

Return JSON:
{
  "answer": "direct answer, or an explicit statement that the evidence does not support one",
  "findings": [
    { "statement": "...", "claimClass": "OBSERVED|REPORTED|OFFICIAL_STATEMENT|DERIVED|CORRELATED|INFERRED|HYPOTHESIS",
      "evidenceRefs": ["EVID-..."], "basis": "why this class and not a stronger one" }
  ],
  "notSupported": ["what the evidence cannot establish"],
  "collectionCaveat": "what the collection status means for this answer"
}

═══ CASE MATERIAL ═══
${serializeCaseContext(ctx)}`;

  if (!corrections?.length) return base;
  return `${base}

Your previous answer was REJECTED for these reasons. Fix them exactly:
${corrections.map((c) => `- ${c}`).join("\n")}`;
}

// ─── Validation ─────────────────────────────────────────────────────────────

export interface GroundedProblem {
  where: string;
  problem: string;
}

/**
 * Words that assert certainty the collected evidence cannot support.
 *
 * A closed list of ASSERTIONS, consumed through `assertsCertainty` below rather
 * than matched raw — because the NEGATED forms are the honest phrasing and must
 * be allowed. "not proven", "unconfirmed" and "cannot be established" say
 * exactly what this rule wants said; only the bare affirmative is a problem.
 */
const CERTAINTY_WORDS =
  /\b(confirmed|confirms|proven|proves|certain|certainty|definitive|definitively|conclusive|conclusively|indisputable|indisputably|established as fact)\b/gi;

/**
 * Negators that flip a certainty word into its opposite.
 *
 * Matched over the words immediately preceding the hit — a short window,
 * because a "not" three clauses earlier does not negate this one. Prefixed
 * forms need no entry here: "unconfirmed" is a single token and never matches
 * `\bconfirmed\b` in the first place.
 */
const NEGATORS =
  /\b(not|never|no|nothing|cannot|can't|isn't|aren't|wasn't|weren't|without|lack|lacks|lacking|far from|neither|nor|yet to be|remains? to be)\s+(?:\w+\s+){0,2}$/i;

/**
 * True when a statement ASSERTS certainty rather than denying it.
 *
 * Exported so the rule is testable directly: the affirmative/negated split is
 * the whole subtlety, and a regex that flags "not proven" would punish the
 * exact wording this phase is trying to encourage.
 */
export function assertsCertainty(statement: string): boolean {
  CERTAINTY_WORDS.lastIndex = 0;
  for (let m = CERTAINTY_WORDS.exec(statement); m; m = CERTAINTY_WORDS.exec(statement)) {
    if (!NEGATORS.test(statement.slice(0, m.index))) return true;
  }
  return false;
}

/**
 * True when the top-level answer is itself a LIMITATION/negative statement
 * ("does not establish", "not adjudicated", "no evidence", "inconclusive")
 * that legitimately needs no citation — the honest no-finding answer this
 * system encourages. It reuses the same negation vocabulary the certainty rule
 * already trusts, so caveat phrasing (including the NO_ADJUDICATION caveat and
 * phrases like "not proven"/"not established") is never mistaken for an
 * uncited affirmative claim.
 */
const LIMITATION_ANSWER =
  /\b(not|no|never|cannot|can't|without|lack|lacks|lacking|insufficient|inconclusive|undetermined|unestablished|unproven|unconfirmed|neither|nor|nothing|none)\b/i;

/** Classes that assert something was actually seen or said, and therefore need a citation. */
const CITATION_REQUIRED: ReadonlySet<string> = new Set([
  "OBSERVED",
  "REPORTED",
  "OFFICIAL_STATEMENT",
  "DERIVED",
  "CORRELATED",
]);

/**
 * Checks a model answer against the context it was given.
 *
 * Mirrors `reports.ts`'s `validateCitations` deliberately — same shape, same
 * retry-then-throw policy in the caller. The differences are the citation space
 * (evidence ids, not source numbers) and the claim-class rules.
 */
export function validateGroundedAnswer(
  answer: GroundedAnswer,
  ctx: CaseContext,
): GroundedProblem[] {
  const problems: GroundedProblem[] = [];
  const citable = citableEvidenceIds(ctx);

  answer.findings.forEach((f, i) => {
    const where = `finding ${i + 1} ("${f.statement.slice(0, 60)}")`;

    for (const ref of f.evidenceRefs) {
      if (!citable.has(ref)) {
        // The single most important check in this file. A fabricated id is
        // indistinguishable from a real one to a reader.
        problems.push({
          where,
          problem: `cites "${ref}", which is not evidence in this case. Only these ids exist: ${[...citable].join(", ") || "(none)"}`,
        });
      }
    }

    if (CITATION_REQUIRED.has(f.claimClass) && f.evidenceRefs.length === 0) {
      problems.push({
        where,
        problem: `is classed ${f.claimClass}, which asserts something was observed or reported, but cites no evidence. Either cite evidence or reclassify it as INFERRED or HYPOTHESIS`,
      });
    }

    if (!f.basis || f.basis.trim().length < 10) {
      problems.push({ where, problem: "gives no usable basis for its claim class" });
    }

    // Certainty language is rejected outright, not just discouraged.
    //
    // The failure this prevents: evidence at 0.30 described as "confirmed". A
    // prompt instruction is a request; this is the enforcement. Checked against
    // the STATEMENT, not the basis, because the basis legitimately discusses
    // why something is NOT certain.
    if (assertsCertainty(f.statement)) {
      problems.push({
        where,
        problem:
          "states the finding as confirmed/proven/certain. Collected evidence supports what a source observed or reported, not certainty — rewrite it as what the evidence shows",
      });
    }

    // A finding classed OBSERVED whose cited evidence carries no measured
    // confidence at all is asserting more than the records support.
    const conf = evidenceConfidenceFor(f, ctx);
    if (f.claimClass === "OBSERVED" && conf.cited > 0 && conf.band === null) {
      problems.push({
        where,
        problem:
          "is classed OBSERVED but every record it cites is unmeasured for confidence. Unmeasured is not strong — reclassify, or cite a record that was scored",
      });
    }
  });

  // The SYNTHESIZED answer.answer is held to the SAME safety contract as each
  // finding. It is rendered to the analyst as the headline, so a certainty
  // claim or an ungrounded affirmative synthesis here is exactly the failure
  // the per-finding checks above prevent — it must not slip through because it
  // lives on the top-level field. Reuses assertsCertainty and the `citable`
  // set already computed; no second validation system is introduced.
  if (assertsCertainty(answer.answer)) {
    problems.push({
      where: "answer",
      problem:
        "states the overall answer as confirmed/proven/certain. Collected evidence supports what a source observed or reported, not certainty — rewrite it as what the evidence shows",
    });
  }
  // An affirmative answer backed by NO findings is ungrounded synthesis — there
  // is nothing for the per-finding citation/class checks above to hold it to. A
  // limitation answer (nothing established / not adjudicated) legitimately needs
  // no findings, so this fires ONLY when the answer makes an affirmative claim.
  // The requirement is findings-non-empty, not a *cited* finding: a HYPOTHESIS or
  // INFERRED finding is uncited by design, and each finding already carries its
  // own citation contract above.
  if (!LIMITATION_ANSWER.test(answer.answer) && answer.findings.length === 0) {
    problems.push({
      where: "answer",
      problem:
        "makes an affirmative claim but presents no findings to support it. Ground it in at least one finding, or state what the evidence does not establish",
    });
  }

  if (answer.notSupported.length === 0) {
    problems.push({
      where: "notSupported",
      problem: "is empty. Every collection has limits; state what this case's evidence cannot establish",
    });
  }

  // A PARTIAL/FAILED run described as complete is a real failure mode that must
  // not reappear through an agent.
  if (ctx.completeness.status !== "COMPLETE") {
    if (/\b(complete|exhaustive|thorough|comprehensive|all available sources)\b/i.test(answer.collectionCaveat)
        && !/\b(not|no longer|incomplete|partial|failed)\b/i.test(answer.collectionCaveat)) {
      problems.push({
        where: "collectionCaveat",
        problem: `describes the collection as complete when its real status is ${ctx.completeness.status}`,
      });
    }
  }

  return problems;
}

// ─── Execution ──────────────────────────────────────────────────────────────

export interface GroundedInput {
  context: CaseContext;
  question: string;
}

/**
 * Runs one grounded analysis.
 *
 * One retry on validation failure with the specific violations fed back, then
 * THROWS. An answer whose citations do not resolve is worse than no answer,
 * because it looks sourced. Same policy as `generateProduct`.
 */
export async function analyseCaseGrounded(input: GroundedInput): Promise<GroundedResult> {
  const ctx = input.context;
  if (!input.question.trim()) {
    throw new LlmUnavailableError("No question was supplied for grounded case analysis.");
  }

  const citableIds = [...citableEvidenceIds(ctx)];
  let corrections: string[] | undefined;
  let last: GroundedProblem[] = [];

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const out = await chatJson(
      buildGroundedPrompt(ctx, input.question, corrections),
      GroundedAnswerSchema,
      { system: GROUNDED_SYSTEM, maxTokens: 2800 },
    );

    const problems = validateGroundedAnswer(out.value, ctx);
    if (problems.length === 0) {
      return {
        ...out.value,
        // Evidence confidence is attached HERE, after validation, so it is
        // demonstrably the code's derivation and not something the model wrote.
        findings: out.value.findings.map((f) => ({
          ...f,
          evidenceConfidence: evidenceConfidenceFor(f, ctx),
        })),
        caseId: ctx.caseId,
        model: out.model,
        provider: out.provider,
        cacheHit: out.cacheHit,
        citableIds,
      };
    }
    last = problems;
    corrections = problems.map((p) => `${p.where} ${p.problem}.`);
  }

  throw new LlmUnavailableError(
    `Grounded analysis failed citation validation twice and was rejected. An answer whose ` +
      `citations do not resolve to this case's evidence is unusable, so no partial answer is ` +
      `returned. Problems on the final attempt: ` +
      last.map((p) => `${p.where} ${p.problem}`).join("; "),
  );
}

/** Thin transport wrapper. All logic is in `analyseCaseGrounded`, so tests call that. */
export const llmAnalyseCaseGrounded = createServerFn({ method: "POST" })
  .validator((d: GroundedInput) => d)
  .handler(async ({ data }) => analyseCaseGrounded(data));
