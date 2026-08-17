/**
 * Shared bookkeeping for adapters wrapping an existing Sentinel utility
 * (OSINT-INTEGRATION-PLAN.md §31 "P1 — Existing adapters"). Not itself a
 * collector — just the execution-timing and error-classification boilerplate
 * every adapter in this directory would otherwise repeat.
 */

import type { CollectorErrorReason } from "../errors";
import { CollectorError } from "../errors";
import type { CollectorExecutionMeta, ExecutionStatus, InvestigationResult } from "../result";
import { emptyInvestigationResult } from "../result";
import type { CollectorRunOutcome } from "../types";

export interface ExecutionClock {
  startedAt: string;
  startedAtMs: number;
}

export function startExecution(): ExecutionClock {
  return { startedAt: new Date().toISOString(), startedAtMs: Date.now() };
}

export function finishExecution(
  clock: ExecutionClock,
  status: ExecutionStatus,
  resultCount: number,
  error: CollectorExecutionMeta["error"] = null,
): CollectorExecutionMeta {
  return {
    status,
    startedAt: clock.startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - clock.startedAtMs,
    resultCount,
    error,
  };
}

/**
 * Best-effort classification of an unknown thrown error into a
 * `CollectorErrorReason`, from the message text — the existing utilities
 * being wrapped throw plain `Error`s, not `CollectorError`s, so this is
 * where Rule 5's `status: failed / reason: X` distinction actually gets
 * made for adapters over pre-existing code. Message-sniffing is inherently
 * approximate; when nothing matches, "unknown" is the honest answer.
 */
export function classifyError(collectorId: string, err: unknown): CollectorError {
  if (err instanceof CollectorError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  let reason: CollectorErrorReason = "unknown";
  if (lower.includes("timed out") || lower.includes("timeout")) reason = "timeout";
  else if (lower.includes("credential") || lower.includes("not configured"))
    reason = "no-credential";
  else if (lower.includes("rate-limit") || lower.includes("rate limited") || lower.includes("429"))
    reason = "rate-limited";
  else if (lower.includes("required") || lower.includes("could not read"))
    reason = "invalid-target";
  else if (lower.includes("unreachable") || lower.includes("failed") || lower.includes("http "))
    reason = "upstream-error";

  return new CollectorError(collectorId, reason, message, err);
}

/** A just-collected timestamp — the moment THIS system observed a fact, distinct from any author-declared date the fact itself carries (which may be null and must stay null when unknown, never defaulted to this). */
export function collectedNow(): string {
  return new Date().toISOString();
}

/**
 * First line of every adapter's `normalize()`: when `execute()` produced no
 * `raw` (a failed or cancelled run), there is nothing to normalize — return
 * an empty result carrying the real execution/error info instead of letting
 * every adapter re-derive that. Returns `undefined` when there IS raw data,
 * so the caller knows to fall through to its own normalization logic.
 */
export function normalizeGuard<TRaw>(
  outcome: CollectorRunOutcome<TRaw>,
): InvestigationResult | undefined {
  if (outcome.raw !== null) return undefined;
  const result = emptyInvestigationResult(outcome.execution);
  if (outcome.execution.error) result.errors.push(outcome.execution.error.message);
  return result;
}
