/**
 * Security response headers.
 *
 * The app previously set exactly one response header — `content-type`, on the
 * 500 page. No CSP, no HSTS, no framing policy, no MIME-sniffing policy.
 *
 * Two classes of header here, treated differently on purpose.
 *
 * THE UNCONDITIONAL ONES cannot break a working page: nosniff, frame denial,
 * referrer policy, permissions policy and HSTS. They are applied to every
 * response, always.
 *
 * CSP IS DIFFERENT and ships in **report-only** mode by default. A policy tight
 * enough to be worth having is also tight enough to white-screen the app if one
 * directive is wrong, and the failure appears only in a real browser — which is
 * not something a unit test or a typecheck can catch. Shipping it enforcing,
 * untested, before a demo would be choosing an unverified control over a
 * working product. `CSP_MODE=enforce` flips it once someone has loaded the app
 * with devtools open and seen a clean console.
 *
 * Every loosening below is load-bearing and is explained where it appears. If
 * one stops being needed, tighten it — but verify in a browser first.
 */

export type CspMode = "report-only" | "enforce" | "off";

/**
 * The policy.
 *
 * `'unsafe-inline'` in script-src is required: TanStack Start serialises the
 * SSR router state into an inline `<script>` at hydration. Removing it needs
 * per-request nonces threaded through `Scripts`, which this framework version
 * does not expose. Documented rather than quietly tolerated.
 */
export function contentSecurityPolicy(): string {
  return [
    "default-src 'self'",

    // Inline scripts: TanStack Start's hydration payload. See above.
    "script-src 'self' 'unsafe-inline'",

    // Inline styles: Tailwind's runtime layer plus the shadcn chart component,
    // which builds a <style> block from its config (ui/chart.tsx).
    "style-src 'self' 'unsafe-inline'",

    // Collected media is displayed by URL from Bluesky, Reddit, Telegram and
    // Mastodon CDNs — the collection policy is deliberate that media is
    // referenced, never re-hosted, so an allowlist of CDN hosts here would have
    // to track every instance in the fediverse. `blob:`/`data:` cover
    // in-browser canvas work in Module 4.
    "img-src 'self' data: blob: https:",

    // WASM workers for c2pa and tesseract are first-party assets, but the
    // worker bootstraps from a blob URL.
    "worker-src 'self' blob:",
    "child-src 'self' blob:",

    // Outbound: the Bluesky Jetstream firehose runs in the BROWSER over wss:
    // (the container scales to zero, so a server-side socket would be torn
    // down between requests), and Module 4 fetches remote media for EXIF.
    "connect-src 'self' https: wss:",

    "font-src 'self' data:",

    // The YouTube module embeds the privacy-mode player.
    "frame-src 'self' https://www.youtube-nocookie.com https://www.youtube.com",

    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

export function cspMode(env: Record<string, string | undefined> = process.env): CspMode {
  const raw = (env.CSP_MODE ?? "report-only").trim().toLowerCase();
  return raw === "enforce" || raw === "off" ? (raw as CspMode) : "report-only";
}

/**
 * Headers applied to every response.
 *
 * HSTS is emitted only when the request arrived over HTTPS. Sending it on a
 * plain-HTTP local dev response would pin `localhost` to HTTPS in the
 * developer's browser and take a while to undo.
 */
export function securityHeaders(
  opts: { https?: boolean; env?: Record<string, string | undefined> } = {},
): Record<string, string> {
  const env = opts.env ?? process.env;

  const headers: Record<string, string> = {
    // Stops a browser second-guessing a declared content type — the mechanism
    // behind "uploaded .txt executes as HTML".
    "x-content-type-options": "nosniff",

    // Clickjacking. Duplicated by CSP frame-ancestors for browsers that honour
    // both; this one is the fallback for those that do not.
    "x-frame-options": "DENY",

    // Analyst navigation reveals what is being investigated. Send an origin at
    // most, and nothing at all when leaving HTTPS.
    "referrer-policy": "strict-origin-when-cross-origin",

    // Module 4 needs none of these, so deny them rather than leave them to a
    // future component to request silently.
    "permissions-policy": "geolocation=(), microphone=(), camera=(), payment=(), usb=()",

    // Keep collected media and OSINT pages out of cross-origin embedding
    // contexts they were never meant for.
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
  };

  if (opts.https) {
    headers["strict-transport-security"] = "max-age=31536000; includeSubDomains";
  }

  const mode = cspMode(env);
  if (mode === "enforce") {
    headers["content-security-policy"] = contentSecurityPolicy();
  } else if (mode === "report-only") {
    headers["content-security-policy-report-only"] = contentSecurityPolicy();
  }

  return headers;
}

/**
 * Apply the headers to a Response without discarding its body or status.
 *
 * A new Response is constructed because a Response returned by the framework
 * may carry immutable headers — mutating those throws, and catching that throw
 * would silently ship a page with no security headers at all.
 *
 * Existing values are never overwritten: a handler that deliberately set its
 * own `content-security-policy` or `x-frame-options` for one route knows
 * something this function does not.
 */
export function withSecurityHeaders(response: Response, https: boolean): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(securityHeaders({ https }))) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Was this request served over HTTPS?
 *
 * Behind Azure Container Apps' ingress the connection to the container is
 * plain HTTP, so `url.protocol` is the wrong thing to read — it would say
 * "http" for every production request and HSTS would never be sent.
 * `x-forwarded-proto` is what the ingress records.
 */
export function isHttpsRequest(request: Request): boolean {
  const proto = request.headers.get("x-forwarded-proto");
  if (proto) return proto.split(",")[0].trim().toLowerCase() === "https";
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}
