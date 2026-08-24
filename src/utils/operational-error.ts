/**
 * Two-field error shape: what the operator sees, and what only the server logs.
 *
 * THE CONSTRAINT THIS HAS TO RESPECT. CLAUDE.md's hard rule is *"If something
 * fails, surface an explicit error… a fake confidence value is worse than a
 * visible failure."* The collectors deliberately distinguish "no credential"
 * from "rate limited" from "genuinely zero results", and that distinction is
 * analytically load-bearing: an empty result set is a finding, a refused
 * request is not. A blanket "something went wrong" would destroy it.
 *
 * So this is NOT a generic-message layer. The correct reading of the rule is:
 * the analyst still learns WHAT failed and WHY in operational terms; only
 * infrastructure identifiers are removed.
 *
 *   KEEP  "mastodon.social refused this timeline to unauthenticated readers
 *          (HTTP 401). No posts were returned — this is not a statement that
 *          the hashtag is unused."
 *   DROP  "...  ECONNREFUSED 10.0.3.14:8080"
 *
 * The second sentence carries no analytical content and hands out the internal
 * network. The first is the whole point of the module it comes from.
 *
 * WHY THE REASON IS AUTHORED, NOT FILTERED. The leaks in this codebase come
 * from building messages by concatenating untrusted upstream text — a response
 * body, an undici `err.message`, an fs errno string. Post-processing such a
 * string with regexes is a losing game. Instead each error class declares a
 * reason built only from values we chose, and the untrusted text goes to
 * `detail`, which never leaves the process.
 */

// ─── Shape ─────────────────────────────────────────────────────────────────

export type OperationalErrorCode =
  | "LLM_UNAVAILABLE"
  | "SOURCE_UNAVAILABLE"
  | "STORE_UNAVAILABLE"
  | "INPUT_REJECTED"
  | "RATE_LIMITED"
  | "NOT_AUTHORISED"
  | "CONTRACT_VIOLATION"
  | "INTERNAL";

export interface SanitisedError {
  /**
   * Operator-facing. Authored per error class. Never contains a host we did
   * not choose, a filesystem path, an IP, or upstream response text.
   */
  reason: string;
  code: OperationalErrorCode;
  /** Ties the operator's screen to the server log line. */
  correlationId: string;
  /**
   * The public subject of the failure, from a fixed vocabulary only: a
   * `Platform` value, an allowlisted host, or a provider LABEL. Never a
   * `baseUrl` — that is infrastructure.
   */
  source?: string;
  retryAfterMs?: number;
}

/**
 * Carries both halves. `detail` is the original error and must never be
 * serialised toward a client — the sanitiser middleware reads it for the log
 * and then throws a fresh Error carrying only `sanitised`.
 */
export class OperationalError extends Error {
  readonly sanitised: SanitisedError;
  readonly detail: unknown;

  constructor(sanitised: SanitisedError, detail?: unknown) {
    super(sanitised.reason);
    this.name = "OperationalError";
    this.sanitised = sanitised;
    this.detail = detail;
  }
}

/** Thrown by the rate limiters. Separate class so the middleware can map a 429. */
export class RateLimitedError extends Error {
  readonly retryAfterMs: number;
  readonly tier: string;

  constructor(message: string, retryAfterMs: number, tier: string) {
    super(message);
    this.name = "RateLimitedError";
    this.retryAfterMs = retryAfterMs;
    this.tier = tier;
  }
}

/** Thrown when a request reaches a gated server function without a session. */
export class NotAuthorisedError extends Error {
  readonly action: string;

  constructor(action: string) {
    super(
      `This action requires an authenticated operator session. ` +
        `No valid session accompanied the request.`,
    );
    this.name = "NotAuthorisedError";
    this.action = action;
  }
}

// ─── Correlation ids ───────────────────────────────────────────────────────

/**
 * 12 hex characters from a UUID.
 *
 * Deliberately NOT a counter and NOT a timestamp: a counter tells an outside
 * observer the deployment's request volume, and a timestamp tells them when it
 * is idle. Both are free reconnaissance.
 */
export function newCorrelationId(): string {
  try {
    return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  } catch {
    // No SubtleCrypto/randomUUID. Return a marker rather than a weak id — a
    // guessable correlation id is worse than an obviously absent one, and this
    // is the same stance evidence.ts takes on hashing.
    return "no-id";
  }
}

// ─── Redaction backstop ────────────────────────────────────────────────────

/**
 * Last-resort scrub for text we did not author.
 *
 * This is a BACKSTOP, not the mechanism. The mechanism is authoring reasons
 * from known values; this exists for the paths not yet migrated, so it is
 * deliberately blunt and deliberately lossy.
 */
export function redactInfrastructure(text: string): string {
  return String(text ?? "")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g, "[address]")
    .replace(/\b[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}\b/gi, "[address]")
    .replace(/(?:[A-Za-z]:)?[\\/](?:[\w.-]+[\\/]){2,}[\w.-]+/g, "[path]")
    .replace(/\b(?:ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ECONNRESET)\b/g, "network error")
    .slice(0, 500);
}

// ─── Mapping ───────────────────────────────────────────────────────────────

/** Status code an error class should produce. */
export function statusForCode(code: OperationalErrorCode): number {
  switch (code) {
    case "RATE_LIMITED":
      return 429;
    case "INPUT_REJECTED":
    case "CONTRACT_VIOLATION":
      return 400;
    case "NOT_AUTHORISED":
      return 401;
    case "LLM_UNAVAILABLE":
    case "SOURCE_UNAVAILABLE":
      return 502;
    case "STORE_UNAVAILABLE":
    case "INTERNAL":
    default:
      return 500;
  }
}

/**
 * Map a thrown value onto the sanitised shape.
 *
 * Dispatches on `error.name` rather than `instanceof`, because the error may
 * have crossed a module boundary where two copies of a class exist, and a
 * failed `instanceof` here would silently downgrade a well-described failure
 * into a generic INTERNAL — losing exactly the signal this module exists to
 * preserve.
 */
export function sanitiseError(error: unknown, correlationId: string): SanitisedError {
  if (error instanceof OperationalError) {
    return { ...error.sanitised, correlationId };
  }

  const name = (error as { name?: string })?.name ?? "";
  const message = (error as { message?: string })?.message ?? "";

  switch (name) {
    case "RateLimitedError": {
      const e = error as RateLimitedError;
      return {
        code: "RATE_LIMITED",
        correlationId,
        retryAfterMs: e.retryAfterMs,
        reason: e.message,
      };
    }

    case "NotAuthorisedError":
      return { code: "NOT_AUTHORISED", correlationId, reason: message };

    case "InputContractError":
      // Already path-only by construction — see validation.ts.
      return { code: "INPUT_REJECTED", correlationId, reason: message };

    case "LlmUnavailableError": {
      // The rich message carries up to 300 chars of the provider's raw response
      // body. That goes to the log via `detail`; the operator gets the fact,
      // the provider LABEL and the status — everything needed to decide whether
      // to retry, nothing about our infrastructure.
      const e = error as { provider?: string; status?: number };
      const provider = e.provider ?? "the configured";
      const status = typeof e.status === "number" ? ` (HTTP ${e.status})` : "";
      return {
        code: "LLM_UNAVAILABLE",
        correlationId,
        source: e.provider,
        reason:
          `The ${provider} model provider did not return an answer${status}. ` +
          `No text was generated — this is a provider failure, not an empty result.`,
      };
    }

    case "SocialUnavailableError": {
      const e = error as { platform?: string; status?: number };
      const platform = e.platform ?? "the source";
      const status = typeof e.status === "number" ? ` (HTTP ${e.status})` : "";
      return {
        code: "SOURCE_UNAVAILABLE",
        correlationId,
        source: e.platform,
        reason:
          `${platform} did not return results${status}. No posts were collected — this is ` +
          `a collection failure, not a statement that nothing matched.`,
      };
    }

    case "ProfileStoreError": {
      // Keep the errno: "the store is full" and "the store is read-only" are
      // genuinely different things for an operator. Drop the path.
      const code = (error as { cause?: NodeJS.ErrnoException })?.cause?.code;
      const errno = extractErrno(message) ?? code;
      return {
        code: "STORE_UNAVAILABLE",
        correlationId,
        reason: errno
          ? `The weight-profile store could not be read or written (${errno}).`
          : `The weight-profile store could not be read or written.`,
      };
    }

    case "CredentialVaultError":
      return {
        code: "STORE_UNAVAILABLE",
        correlationId,
        reason: redactInfrastructure(message),
      };

    case "ContractViolationError":
      return {
        code: "CONTRACT_VIOLATION",
        correlationId,
        reason:
          `A record did not match its frozen data contract and was rejected rather than ` +
          `coerced. See the server log for the failing field paths.`,
      };

    default:
      return {
        code: "INTERNAL",
        correlationId,
        reason:
          `The request could not be completed. Nothing was returned rather than a partial ` +
          `or invented result. Quote reference ${correlationId} when reporting this.`,
      };
  }
}

/** Pull an errno such as ENOSPC out of a node fs error message. */
export function extractErrno(message: string): string | null {
  const match = /\b(E[A-Z]{3,10})\b/.exec(String(message ?? ""));
  return match ? match[1] : null;
}

/**
 * Build the Error actually thrown toward the client.
 *
 * Two properties matter. First, `message` IS `sanitised.reason`, so the ~40
 * existing catch sites doing `setError(err?.message ?? String(err))` keep
 * working unchanged and immediately render safe text. Second, `stack` is
 * emptied: TanStack serialises thrown errors with seroval at full feature
 * level, which copies `stack` — absolute container paths and all — straight to
 * the browser. Deleting it is the only thing that stops that.
 */
export function toClientError(sanitised: SanitisedError): Error {
  const err = new Error(sanitised.reason);
  err.name = "OperationalError";
  Object.defineProperty(err, "stack", { value: "", enumerable: false, writable: true });
  Object.assign(err, {
    code: sanitised.code,
    correlationId: sanitised.correlationId,
    ...(sanitised.source ? { source: sanitised.source } : {}),
    ...(sanitised.retryAfterMs !== undefined ? { retryAfterMs: sanitised.retryAfterMs } : {}),
  });
  return err;
}
