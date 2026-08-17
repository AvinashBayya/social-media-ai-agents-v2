import { createStart, createMiddleware, createCsrfMiddleware } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";

import { renderErrorPage } from "./lib/error-page";
import { newCorrelationId, RateLimitedError, sanitiseError, toClientError } from "./utils/operational-error";
import { describeDenial, rateLimitDecision } from "./utils/rate-limit-runtime";

const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
});

const errorMiddleware = createMiddleware().server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (error != null && typeof error === "object" && "statusCode" in error) {
      throw error;
    }
    console.error(error);
    return new Response(renderErrorPage(), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
});

/**
 * Sanitiser — the OUTERMOST function middleware.
 *
 * WHY THE FUNCTION LAYER AND NOT `errorMiddleware` ABOVE. `errorMiddleware` is
 * dead code for all 52 server functions: `server-functions-handler.js` catches
 * their throws itself and *returns* a 500 Response, so by the time `await
 * next()` resolves in a REQUEST middleware there is nothing left to catch. It
 * is kept because it still covers router requests and error pages.
 *
 * WHAT ACTUALLY CROSSES THE WIRE — MEASURED 2026-08-17, NOT ASSUMED.
 * PROJECT_MEMORY records a trap: "TanStack serialises the thrown error with
 * seroval at full feature level, which copies `stack`, absolute container paths
 * included, to the browser." **That does not reproduce in 1.168.** Built the app
 * with this middleware REMOVED, threw a real error from a server function, and
 * read the RPC response in a browser: the payload is tagged `"c":"$TSR/Error"`,
 * a custom serialiser that emits `message` and nothing else. No `stack`, no
 * path — and equally, none of the extra fields `toClientError` attaches
 * (`code`, `correlationId`, `retryAfterMs`) reach the client either. Do not
 * build UI that reads them off the error; only `message` survives.
 *
 * So the leak this closes is through `message`, which DOES cross verbatim — and
 * a raw `message` is routinely built by concatenating upstream text: an undici
 * `ECONNREFUSED 10.0.3.14:8080`, an fs errno with a path, up to 300 characters
 * of a provider's response body. `sanitiseError` replaces that with a reason
 * authored from values we chose. `toClientError` still empties `stack` — cheap,
 * and it stops depending on a serialiser's current feature flags.
 *
 * The untrusted original goes to `console.error` with a correlation id and
 * never crosses to the client; the operator gets the authored reason. Errors
 * carrying `statusCode` (redirect, notFound) are control flow, not failures,
 * and are rethrown untouched — the same guard `errorMiddleware` uses.
 */
const sanitiserMiddleware = createMiddleware({ type: "function" }).server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (error != null && typeof error === "object" && "statusCode" in error) {
      throw error;
    }
    const correlationId = newCorrelationId();
    console.error(`[${correlationId}]`, error);
    throw toClientError(sanitiseError(error, correlationId));
  }
});

/**
 * Rate limiter — runs inside the sanitiser, so its `RateLimitedError` is routed
 * through `sanitiseError` and logged with a correlation id like every other
 * failure. Note what the analyst actually receives: only `message`, per the
 * measurement above. The reason `rate-limit.ts` authors already carries the
 * wait in words ("backoff is active for another 17s"), which is why the UI
 * needs nothing from the dropped `retryAfterMs` field.
 *
 * Tiering lives here rather than in a request middleware because `serverFnMeta`
 * is only populated in the FUNCTION layer in 1.168 — see the header of
 * `utils/rate-limit-tiers.ts` for the exact runtime evidence.
 *
 * Defaults to `observe`: it logs what it would have denied and changes nothing.
 * A wrong `RATE_LIMIT_TRUSTED_PROXY_HOPS` for this ingress collapses every
 * caller into one bucket, and finding that out by locking the demo out is not
 * an acceptable way to find it out. Read the `keySource` in the observe lines,
 * confirm it says `forwarded`, then set `RATE_LIMIT_MODE=enforce`.
 */
const rateLimitMiddleware = createMiddleware({ type: "function" }).server(
  async ({ next, serverFnMeta }) => {
    // Not fatal if unavailable: an unattributable caller falls to
    // UNKNOWN_CLIENT_KEY, which carries the TIGHTER `unknownIp` tier. Absence
    // of a header is never an exemption.
    let headers: { get(name: string): string | null } | null = null;
    try {
      headers = getRequestHeaders();
    } catch {
      headers = null;
    }

    const outcome = rateLimitDecision({
      headers,
      meta: serverFnMeta,
      now: Date.now(),
    });

    if (outcome.mode === "off") return next();

    if (!outcome.decision.allowed) {
      // Logged in both modes: observe exists to produce exactly this line, and
      // enforce still needs it because the client only receives the reason.
      console.warn(describeDenial(outcome));
      if (outcome.mode === "enforce") {
        throw new RateLimitedError(
          outcome.decision.reason,
          outcome.decision.retryAfterMs,
          outcome.tierName,
        );
      }
    }

    return next();
  },
);

export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware, errorMiddleware],
  // Order matters: the sanitiser must wrap the limiter so a rate-limit denial
  // is mapped rather than serialised raw.
  functionMiddleware: [sanitiserMiddleware, rateLimitMiddleware],
}));
