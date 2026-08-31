/**
 * Server-side proxy for OCSP/CRL revocation lookups — see pdf-revocation.ts
 * for why this exists at all: neither endpoint type sets CORS headers
 * (verified directly against ocsp.digicert.com / ocsp.sectigo.com), so a
 * browser tab cannot reach them itself. This is the one and only network
 * hop file-provenance's browser-only feature ever makes, and only when an
 * analyst explicitly opts in per signature.
 *
 * What crosses this boundary: a request built from the certificate's own
 * serial number and issuer-name/key hashes (OCSP), or nothing at all beyond
 * the CRL distribution point URL itself (CRL) — never the uploaded file's
 * bytes or any of its content.
 *
 * SSRF is a real, non-theoretical risk here specifically because the URL
 * this function fetches comes from a certificate embedded in a file an
 * analyst uploaded — untrusted input. A malicious certificate's Authority
 * Information Access or CRL Distribution Points extension could name an
 * internal service or the cloud metadata address. Reuses this project's own
 * existing guard (`isPrivateOrReservedIPv4`, scan-authorization.ts) rather
 * than a second copy — that module is a deliberate zero-import leaf exactly
 * so other modules can safely depend on it.
 */

import { createServerFn } from "@tanstack/react-start";
import { isPrivateOrReservedIPv4 } from "./scan-authorization";

const FETCH_TIMEOUT_MS = 10_000;
/** Generous even for a large CRL — a legitimate OCSP response is under 1KB; this cap exists purely against resource exhaustion, not correctness (the ASN.1 parser's own real size limit is handled separately, at parse time, in pdf-revocation-client.ts). */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface RevocationFetchInput {
  url: string;
  method: "GET" | "POST";
  /** Base64-encoded request body (the DER-encoded OCSPRequest), POST only. */
  bodyBase64: string | null;
  contentType: string | null;
}

export interface RevocationFetchResult {
  ok: boolean;
  status: number;
  contentType: string | null;
  bodyBase64: string | null;
  error: string | null;
}

async function hostnameResolvesToPrivateAddress(hostname: string): Promise<boolean> {
  try {
    const dns = await import("node:dns/promises");
    const { address } = await dns.lookup(hostname, { family: 4 });
    return isPrivateOrReservedIPv4(address);
  } catch {
    // Unresolvable hostname — let the fetch itself fail with a real network
    // error below rather than guessing at a resolution this function
    // couldn't perform.
    return false;
  }
}

export async function fetchRevocationEndpoint(input: RevocationFetchInput): Promise<RevocationFetchResult> {
  const fail = (error: string, status = 0): RevocationFetchResult => ({ ok: false, status, contentType: null, bodyBase64: null, error });

  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return fail("Not a valid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return fail(`Refused: unsupported URL scheme "${parsed.protocol}".`);
  }
  if (isPrivateOrReservedIPv4(parsed.hostname) || (await hostnameResolvesToPrivateAddress(parsed.hostname))) {
    return fail(
      "Refused: this URL is or resolves to a private, loopback, link-local or reserved address — a certificate's " +
        "revocation-endpoint extension is untrusted input and is never fetched blind.",
    );
  }

  try {
    const res = await fetch(parsed.toString(), {
      method: input.method,
      headers: input.contentType ? { "Content-Type": input.contentType } : undefined,
      body: input.method === "POST" && input.bodyBase64 ? Buffer.from(input.bodyBase64, "base64") : undefined,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      // A compromised or misconfigured responder could redirect to a private
      // address AFTER the check above already passed — refuse rather than
      // silently follow, matching the SSRF stance above.
      redirect: "error",
    });
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_RESPONSE_BYTES) {
      return fail(`Response too large (${buf.byteLength} bytes, over the ${MAX_RESPONSE_BYTES}-byte cap).`, res.status);
    }
    return { ok: true, status: res.status, contentType: res.headers.get("content-type"), bodyBase64: buf.toString("base64"), error: null };
  } catch (err: any) {
    return fail(err?.message ?? String(err));
  }
}

export const checkRevocationEndpoint = createServerFn({ method: "POST" })
  .validator((d: RevocationFetchInput) => d)
  .handler(async ({ data }): Promise<RevocationFetchResult> => fetchRevocationEndpoint(data));
