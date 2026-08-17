/**
 * Collector error model.
 *
 * OSINT-INTEGRATION-PLAN.md Rule 5: a failed collector must surface as an
 * explicit failure, never as an empty result —
 *
 *   collector: spiderfoot
 *   status: failed
 *   reason: timeout
 *
 * not
 *
 *   collector: spiderfoot
 *   results: 0
 *
 * `CollectorError` is what every `Collector.execute()` throws (or resolves
 * into `CollectorExecutionMeta.error`, see `result.ts`) so a caller can never
 * mistake "the tool declined to answer" for "the tool answered zero".
 */

/** Why a collector run did not produce a normal completed result. */
export const COLLECTOR_ERROR_REASONS = [
  /** Execution exceeded its allotted time budget. */
  "timeout",
  /** The tool/service is not installed, not running, or not reachable. */
  "unavailable",
  /** A required credential is absent or invalid. */
  "no-credential",
  /** The target does not match what this collector accepts. */
  "invalid-target",
  /** Upstream declined the request under rate limiting. */
  "rate-limited",
  /** Upstream responded, but with an error or an unparseable payload. */
  "upstream-error",
  /** The run was cancelled before it completed. */
  "cancelled",
  /** A cause that doesn't fit the above; `message` carries the detail. */
  "unknown",
] as const;

export type CollectorErrorReason = (typeof COLLECTOR_ERROR_REASONS)[number];

/**
 * Plain-data shape of a collector failure, suitable for embedding in
 * `CollectorExecutionMeta.error` (see `result.ts`) and for serialising across
 * a job/worker boundary — a thrown `CollectorError` does not survive that
 * crossing, but this shape does.
 */
export interface CollectorErrorInfo {
  collector: string;
  reason: CollectorErrorReason;
  message: string;
}

/**
 * Thrown by a collector's `execute()` when it cannot produce a result.
 *
 * Deliberately carries `collectorId` and `reason` as first-class fields
 * rather than folding them into the message string — a caller building the
 * `status: failed / reason: timeout` report Rule 5 requires should never need
 * to parse an error message to get there.
 */
export class CollectorError extends Error {
  constructor(
    readonly collectorId: string,
    readonly reason: CollectorErrorReason,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "CollectorError";
  }

  toInfo(): CollectorErrorInfo {
    return { collector: this.collectorId, reason: this.reason, message: this.message };
  }
}

/** Convenience factory for the timeout case — the reason `execute()` hits most. */
export function collectorTimeout(collectorId: string, timeoutMs: number): CollectorError {
  return new CollectorError(
    collectorId,
    "timeout",
    `${collectorId} timed out after ${timeoutMs}ms`,
  );
}

/** Convenience factory for an unavailable external tool/service. */
export function collectorUnavailable(collectorId: string, detail: string): CollectorError {
  return new CollectorError(collectorId, "unavailable", `${collectorId} is unavailable: ${detail}`);
}

/** Convenience factory for a missing/invalid credential. */
export function collectorNoCredential(collectorId: string, detail: string): CollectorError {
  return new CollectorError(
    collectorId,
    "no-credential",
    `${collectorId} requires a credential: ${detail}`,
  );
}
