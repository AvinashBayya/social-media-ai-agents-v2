/**
 * PDF signature revocation checking (CRL/OCSP) — pure interpretation layer.
 *
 * Real-world finding this design is built around, verified directly against
 * live infrastructure rather than assumed (2026-08-31): neither OCSP nor CRL
 * endpoints set CORS headers (tested against ocsp.digicert.com and
 * ocsp.sectigo.com directly — a POST preflight gets 501/404 with no
 * Access-Control-Allow-Origin, and even a plain GET's 200 response carries
 * none either), so this check CANNOT run purely client-side the way the rest
 * of file-provenance can. The actual network fetch happens through a small
 * server function (`pdf-revocation-server.ts`) that this module's caller
 * (`pdf-revocation-client.ts`) proxies through — only a certificate's own
 * serial/issuer bytes cross that boundary, never the uploaded file's content.
 *
 * A second real finding, also verified rather than assumed: a genuinely
 * valid, large production CRL (DigiCert's EV RSA CA G2 list, 658KB /
 * 17,729 entries — confirmed well-formed DER via `openssl crl`) fails to
 * parse in `asn1js` (pkijs's own ASN.1 dependency), while a smaller CRL
 * (85KB / 2,322 entries) parses through the identical code path with zero
 * issues. OCSP has no equivalent problem — its response size is constant
 * (~500 bytes) regardless of how many certificates a CA has ever revoked.
 * That is why OCSP, not CRL, is the reliable check here despite the
 * industry's broader move toward CRL-only (Let's Encrypt shut its OCSP
 * responders down entirely on 2025-08-06). CRL is still attempted as a
 * secondary check, and a parse failure is reported as exactly that — "too
 * large for this tool to parse" — never silently swallowed into "not
 * revoked".
 *
 * This is an OPT-IN check, run only when an analyst explicitly asks for it
 * per signature — unlike everything else in file-provenance.ts /
 * file-provenance-client.ts, it makes a real network call, breaking the
 * "this file was analysed entirely inside this browser tab" property that
 * holds for every other check. Mirrors the existing opt-in pattern for
 * Sarvam transcription/tone-analysis elsewhere in this project.
 */

import type { ProvenanceField } from "./file-provenance";

export type RevocationMethod = "ocsp" | "crl";

/**
 * "unsupported" = the certificate doesn't declare this check's endpoint at
 * all (no AIA/CRLDP extension), a parse failure, or a signature that failed
 * to verify — genuinely could not be determined, never guessed.
 * "unreachable" = the endpoint was contacted but the request/response
 * itself failed (network error, non-success responseStatus, wrong cert
 * answered).
 */
export type RevocationStatus = "good" | "revoked" | "unknown" | "unsupported" | "unreachable";

export interface RevocationCheckResult {
  method: RevocationMethod;
  status: RevocationStatus;
  responderUrl: string | null;
  detail: string;
  /** Whether the OCSP response / CRL's own signature verified against the issuing CA's key. Null when no response was ever obtained to verify. */
  signatureVerified: boolean | null;
}

function fieldFor(result: RevocationCheckResult): ProvenanceField {
  const label = `${result.method.toUpperCase()} revocation check`;
  const id = `revocation.${result.method}`;
  const origin = result.responderUrl ?? "Certificate extensions (no endpoint declared)";

  switch (result.status) {
    case "revoked":
      return { id, label, value: "REVOKED", status: "present", origin, note: result.detail, severity: "notable" };
    case "unknown":
      return { id, label, value: "Unknown to the responder", status: "present", origin, note: result.detail, severity: "notable" };
    case "good":
      return { id, label, value: "Not revoked", status: "present", origin, note: result.detail, severity: "info" };
    case "unsupported":
      return { id, label, value: null, status: "absent", origin, note: result.detail, severity: "info" };
    case "unreachable":
      return { id, label, value: "Could not be checked", status: "unreadable", origin, note: result.detail, severity: "info" };
  }
}

/** Builds one field per result — OCSP and CRL are reported as separate, independent findings, never merged into a single verdict. */
export function interpretRevocationChecks(results: RevocationCheckResult[]): ProvenanceField[] {
  return results.map(fieldFor);
}
