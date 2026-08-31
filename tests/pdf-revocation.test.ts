import { describe, expect, test } from "bun:test";
import { interpretRevocationChecks, type RevocationCheckResult } from "../src/utils/pdf-revocation";

describe("interpretRevocationChecks", () => {
  test("a revoked certificate renders as a notable, present finding", () => {
    const results: RevocationCheckResult[] = [
      { method: "ocsp", status: "revoked", responderUrl: "http://ocsp.example.com", detail: "revoked per responder", signatureVerified: true },
    ];
    const [field] = interpretRevocationChecks(results);
    expect(field.id).toBe("revocation.ocsp");
    expect(field.value).toBe("REVOKED");
    expect(field.status).toBe("present");
    expect(field.severity).toBe("notable");
  });

  test("a good status is present but only informational, not notable", () => {
    const results: RevocationCheckResult[] = [
      { method: "ocsp", status: "good", responderUrl: "http://ocsp.example.com", detail: "not revoked", signatureVerified: true },
    ];
    const [field] = interpretRevocationChecks(results);
    expect(field.status).toBe("present");
    expect(field.severity).toBe("info");
  });

  test("unknown-to-the-responder is notable — genuinely ambiguous, never quietly treated as clean", () => {
    const results: RevocationCheckResult[] = [
      { method: "ocsp", status: "unknown", responderUrl: "http://ocsp.example.com", detail: "responder has no record", signatureVerified: true },
    ];
    const [field] = interpretRevocationChecks(results);
    expect(field.severity).toBe("notable");
  });

  test("unsupported (no declared endpoint, or an unparseable CRL) renders as a real absence, not a failure", () => {
    const results: RevocationCheckResult[] = [
      { method: "crl", status: "unsupported", responderUrl: null, detail: "no CRL distribution point declared", signatureVerified: null },
    ];
    const [field] = interpretRevocationChecks(results);
    expect(field.status).toBe("absent");
    expect(field.value).toBeNull();
  });

  test("unreachable (network/signature failure) is reported as unreadable, never as a real status", () => {
    const results: RevocationCheckResult[] = [
      { method: "ocsp", status: "unreachable", responderUrl: "http://ocsp.example.com", detail: "timed out", signatureVerified: null },
    ];
    const [field] = interpretRevocationChecks(results);
    expect(field.status).toBe("unreadable");
    expect(field.value).not.toBe("Not revoked");
    expect(field.value).not.toBe("REVOKED");
  });

  test("OCSP and CRL results render as two independent fields, never merged into one verdict", () => {
    const results: RevocationCheckResult[] = [
      { method: "ocsp", status: "good", responderUrl: "http://ocsp.example.com", detail: "ok", signatureVerified: true },
      { method: "crl", status: "unsupported", responderUrl: null, detail: "no CRL DP", signatureVerified: null },
    ];
    const fields = interpretRevocationChecks(results);
    expect(fields.map((f) => f.id)).toEqual(["revocation.ocsp", "revocation.crl"]);
  });
});
