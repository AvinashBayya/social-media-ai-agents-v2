/**
 * Module 1 — the model-backed half of source credibility (PS-18 §6.1).
 *
 * Sits above credibility.ts exactly as analysis-llm.ts sits above analysis.ts:
 * this file imports the deterministic layer, never the reverse. That one-way
 * arrangement is what guarantees the five deterministic factors keep scoring
 * with the model unreachable — it is structurally impossible for a failure here
 * to take the rest of Module 1 down.
 *
 * WHY ASSESSMENT IS PRE-COMPUTED. `CredibilityFactor.compute` is synchronous by
 * design. Making it async to accommodate one of seven factors would push
 * `async` through scoreArticle, scoreCorpus and the scoring useMemo in
 * sources.tsx, and would make every deterministic score wait on a network call.
 * Instead the caller assesses the articles it wants, then passes the results in
 * through `FactorOptions.language`.
 *
 * WHY IT IS OPT-IN. Assessing a 200-article feed is 200 model calls against a
 * free tier. The analyst asks for the articles they care about. An article that
 * was never assessed is recorded as skipped with that reason — it is never
 * scored as though its language had been checked and found unremarkable.
 *
 * No fallback values anywhere. A failed assessment is reported as a failure and
 * the factor stays skipped, because a neutral tone score for an article nobody
 * assessed is an invented measurement.
 */

import { assessLanguageOf, LlmUnavailableError, type LanguageAssessment } from "./llm";
import type { Article } from "./analysis";

/**
 * Re-exported because this is the module consumers assess through — sources.tsx
 * already imported the type from here, which type-checked as an error nobody
 * saw. Type-only, so it adds no runtime edge from a route to llm.ts.
 */
export type { LanguageAssessment };

/** Text given to the assessor. Title plus body — the tone of a headline counts. */
function assessableText(article: Article): string {
  return `${article.title}\n\n${article.body ?? ""}`.trim();
}

export interface LanguageAssessmentFailure {
  articleId: string;
  title: string;
  /** The real upstream cause, passed through rather than summarised away. */
  reason: string;
}

export interface LanguageAssessmentBatch {
  /** Keyed by article id — pass straight into `FactorOptions.language`. */
  assessments: Record<string, LanguageAssessment>;
  /** Articles that could not be assessed, each with the reason it failed. */
  failures: LanguageAssessmentFailure[];
}

/**
 * Assess one article's language.
 *
 * Throws on failure rather than returning a neutral assessment. Callers that
 * want to keep going over a batch should use `assessLanguageFor`, which
 * collects failures without inventing values for them.
 */
export async function assessArticleLanguage(article: Article): Promise<LanguageAssessment> {
  const text = assessableText(article);
  if (!text) {
    throw new LlmUnavailableError(
      `"${article.title || article.id}" has no text to assess. Most RSS feeds ship no body, ` +
        `so this is a collection limit rather than a property of the article.`,
    );
  }
  return assessLanguageOf({ text });
}

/**
 * Assess a batch, one article at a time.
 *
 * SEQUENTIAL ON PURPOSE. Free-tier providers rate-limit, and firing a whole
 * selection concurrently converts a slow batch into a 429 that fails every item
 * at once. The LRU in llm.ts is keyed on sha256(model + system + prompt), so
 * re-assessing an article already assessed this process costs nothing.
 *
 * One article's failure does not abort the rest — it lands in `failures` with
 * its cause, in the same spirit as the map's unplaceable count and the
 * contract parser's rejects.
 */
export async function assessLanguageFor(articles: Article[]): Promise<LanguageAssessmentBatch> {
  const assessments: Record<string, LanguageAssessment> = {};
  const failures: LanguageAssessmentFailure[] = [];

  for (const article of articles) {
    try {
      assessments[article.id] = await assessArticleLanguage(article);
    } catch (err) {
      failures.push({
        articleId: article.id,
        title: article.title,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { assessments, failures };
}

/**
 * One line an analyst can read about batch coverage.
 *
 * Stated as a proportion rather than a bare success count, because "12 assessed"
 * hides whether that was 12 of 12 or 12 of 200 — and the second case means most
 * of the feed carries no linguistic factor at all.
 */
export function assessmentSummary(batch: LanguageAssessmentBatch, requested: number): string {
  const done = Object.keys(batch.assessments).length;
  if (requested === 0) return "No articles were submitted for language assessment.";
  if (batch.failures.length === 0) {
    return `Language assessed for ${done} of ${requested} article${requested === 1 ? "" : "s"}.`;
  }
  return (
    `Language assessed for ${done} of ${requested} article${requested === 1 ? "" : "s"}. ` +
    `${batch.failures.length} failed and carry no linguistic factor: ` +
    `${batch.failures.map((f) => `${f.title || f.articleId} (${f.reason})`).join("; ")}`
  );
}
