import { describe, expect, mock, test } from "bun:test";

/**
 * Hermetic, ground-truth end-to-end test of the real OCSP/CRL pipeline in
 * pdf-revocation-client.ts — mirrors file-provenance-signature.test.ts's own
 * approach (forge signs, this project's code verifies) but with pkijs on
 * both sides: a hand-built CA issues a real leaf certificate with real
 * AIA/CRLDP extensions, then signs a real OCSPResponse and a real CRL
 * against it. `checkRevocationEndpoint` (the network hop) is mocked at the
 * module boundary — see pdf-revocation-server.ts for why that hop can't run
 * in a `bun test` process at all (it's a `createServerFn`, and there is no
 * live TanStack Start server here) — everything ELSE, including every byte
 * of ASN.1/OCSP/CRL construction and verification, is real.
 *
 * The live, actually-networked version of this exact flow (real request
 * built, POSTed to ocsp.digicert.com, real response parsed and its
 * signature verified against DigiCert's own issuing certificate) was run
 * directly during development — see PROJECT_MEMORY.md's 2026-08-31
 * revocation-checking milestone. This test exists so that verification
 * survives as a regression check, not just a one-time manual result.
 */

let mockCheckRevocationEndpoint: (args: { data: { url: string; method: string; bodyBase64: string | null; contentType: string | null } }) => Promise<any>;

// mock.module replaces the module GLOBALLY for the rest of this bun test
// process, not just this file — tests/pdf-revocation-server.test.ts imports
// `fetchRevocationEndpoint` from this exact same module path directly, and
// would silently break if the mock factory below only returned
// `checkRevocationEndpoint`. Importing the real module first and spreading
// it keeps every other export (fetchRevocationEndpoint included) genuinely
// real for any other test file that runs in this same process.
const realServerModule = await import("../src/utils/pdf-revocation-server");

// mock.module can return a Promise (async registration) — awaiting it
// matters: without awaiting, pdf-revocation-client.ts's own static import of
// checkRevocationEndpoint can resolve to the REAL module before the mock is
// actually installed.
await mock.module("../src/utils/pdf-revocation-server", () => ({
  ...realServerModule,
  checkRevocationEndpoint: (args: any) => mockCheckRevocationEndpoint(args),
}));

const { checkCertificateRevocation } = await import("../src/utils/pdf-revocation-client");

async function buildPki() {
  const pkijs = await import("pkijs");
  const asn1js = await import("asn1js");
  pkijs.setEngine("test", new pkijs.CryptoEngine({ name: "test", crypto: globalThis.crypto as any, subtle: globalThis.crypto.subtle as any }));

  const OCSP_URL = "http://ocsp.test.invalid/";
  const CRL_URL = "http://crl.test.invalid/ca.crl";

  async function makeKeyPair() {
    return globalThis.crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, [
      "sign",
      "verify",
    ]) as Promise<CryptoKeyPair>;
  }

  // --- CA (self-signed) ---
  const caKeys = await makeKeyPair();
  const ca = new pkijs.Certificate();
  ca.version = 2;
  ca.serialNumber = new asn1js.Integer({ value: 1 });
  ca.issuer.typesAndValues.push(new pkijs.AttributeTypeAndValue({ type: "2.5.4.3", value: new asn1js.BmpString({ value: "Test Root CA" }) }));
  ca.subject.typesAndValues.push(new pkijs.AttributeTypeAndValue({ type: "2.5.4.3", value: new asn1js.BmpString({ value: "Test Root CA" }) }));
  ca.notBefore.value = new Date(Date.now() - 86400000);
  ca.notAfter.value = new Date(Date.now() + 86400000);
  // BasicConstraints cA:true matters, not just decoration — pkijs's real
  // CertificateChainValidationEngine (used by both BasicOCSPResponse.verify
  // and CertificateRevocationList.verify) requires it to recognise a
  // certificate as a valid trust anchor at all; without it, verify() fails
  // even against a cryptographically-genuine self-signature. Confirmed via a
  // minimal isolated repro during development — real production CA
  // certificates always carry this, so it's a test-fixture completeness
  // requirement, not a gap in the application code being tested.
  const basicConstraints = new pkijs.BasicConstraints({ cA: true });
  ca.extensions = [
    new pkijs.Extension({ extnID: "2.5.29.19", critical: true, extnValue: basicConstraints.toSchema().toBER(false), parsedValue: basicConstraints }),
  ];
  await ca.subjectPublicKeyInfo.importKey(caKeys.publicKey);
  await ca.sign(caKeys.privateKey, "SHA-256");
  const caDer = new Uint8Array(ca.toSchema(true).toBER(false));

  // --- Leaf, issued by the CA, with real AIA (OCSP) + CRLDP extensions ---
  const leafKeys = await makeKeyPair();
  const leaf = new pkijs.Certificate();
  leaf.version = 2;
  leaf.serialNumber = new asn1js.Integer({ value: 42 });
  leaf.issuer.typesAndValues.push(new pkijs.AttributeTypeAndValue({ type: "2.5.4.3", value: new asn1js.BmpString({ value: "Test Root CA" }) }));
  leaf.subject.typesAndValues.push(new pkijs.AttributeTypeAndValue({ type: "2.5.4.3", value: new asn1js.BmpString({ value: "Test Signer" }) }));
  leaf.notBefore.value = new Date(Date.now() - 86400000);
  leaf.notAfter.value = new Date(Date.now() + 86400000);
  await leaf.subjectPublicKeyInfo.importKey(leafKeys.publicKey);

  const aia = new pkijs.InfoAccess({
    accessDescriptions: [
      new pkijs.AccessDescription({ accessMethod: "1.3.6.1.5.5.7.48.1", accessLocation: new pkijs.GeneralName({ type: 6, value: OCSP_URL }) }),
    ],
  });
  const crlDp = new pkijs.CRLDistributionPoints({
    distributionPoints: [
      new pkijs.DistributionPoint({ distributionPoint: [new pkijs.GeneralName({ type: 6, value: CRL_URL })] }),
    ],
  });
  leaf.extensions = [
    new pkijs.Extension({ extnID: "1.3.6.1.5.5.7.1.1", critical: false, extnValue: aia.toSchema().toBER(false), parsedValue: aia }),
    new pkijs.Extension({ extnID: "2.5.29.31", critical: false, extnValue: crlDp.toSchema().toBER(false), parsedValue: crlDp }),
  ];
  await leaf.sign(caKeys.privateKey, "SHA-256");
  const leafDer = new Uint8Array(leaf.toSchema(true).toBER(false));

  return { pkijs, asn1js, ca, caKeys, caDer, leaf, leafDer, OCSP_URL, CRL_URL };
}

function base64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

describe("checkCertificateRevocation — real pkijs OCSP/CRL round trip, network mocked", () => {
  test("a real OCSP response saying 'good', signed by the CA, verifies and reports good", async () => {
    const { pkijs, ca, caKeys, caDer, leaf, leafDer, OCSP_URL } = await buildPki();

    const asn1jsMod = await import("asn1js");
    async function buildGoodOcspResponse(): Promise<string> {
      const basicResp = new pkijs.BasicOCSPResponse();
      basicResp.tbsResponseData.responderID = ca.subject;
      basicResp.tbsResponseData.producedAt = new Date();
      const certId = await pkijs.CertID.create(leaf, { hashAlgorithm: "SHA-1", issuerCertificate: ca });
      basicResp.tbsResponseData.responses = [
        new pkijs.SingleResponse({ certID: certId, certStatus: new asn1jsMod.Primitive({ idBlock: { tagClass: 3, tagNumber: 0 } }), thisUpdate: new Date() }),
      ];
      await basicResp.sign(caKeys.privateKey, "SHA-256");
      const ocspResp = new pkijs.OCSPResponse({ responseStatus: new asn1jsMod.Enumerated({ value: 0 }) });
      ocspResp.responseBytes = new pkijs.ResponseBytes({ responseType: "1.3.6.1.5.5.7.48.1.1", response: new asn1jsMod.OctetString({ valueHex: basicResp.toSchema().toBER(false) }) });
      return base64(new Uint8Array(ocspResp.toSchema().toBER(false)));
    }

    mockCheckRevocationEndpoint = mock(async ({ data }) => {
      if (data.url !== OCSP_URL) return { ok: false, status: 0, contentType: null, bodyBase64: null, error: "unexpected URL in this test" };
      return { ok: true, status: 200, contentType: "application/ocsp-response", bodyBase64: await buildGoodOcspResponse(), error: null };
    });

    const results = await checkCertificateRevocation(leafDer, caDer);
    const ocsp = results.find((r) => r.method === "ocsp")!;
    expect(ocsp.status).toBe("good");
    expect(ocsp.signatureVerified).toBe(true);
  });

  test("an OCSP response that embeds its own responder certificate (basicResponse.certs) verifies against the REAL issuing CA, not against itself", async () => {
    // Ground-truth test for a real bug caught by reading pkijs's own
    // verify() source directly: an earlier version of checkOcsp passed
    // `trustedCerts: basicResponse.certs` — the response's own embedded
    // certs used as their own trust anchor, which validates against ANY
    // self-consistent chain a malicious responder cares to embed. The fix
    // is `trustedCerts: [issuer]`, the independently-known real CA. This
    // test exercises exactly the code path that bug was in (`certs` IS
    // populated, unlike the other OCSP test above where it's absent).
    const { pkijs, ca, caKeys, caDer, leaf, leafDer, OCSP_URL } = await buildPki();
    const asn1jsMod = await import("asn1js");

    mockCheckRevocationEndpoint = mock(async ({ data }) => {
      if (data.url !== OCSP_URL) return { ok: false, status: 0, contentType: null, bodyBase64: null, error: "unexpected URL in this test" };
      const basicResp = new pkijs.BasicOCSPResponse();
      basicResp.tbsResponseData.responderID = ca.subject;
      basicResp.tbsResponseData.producedAt = new Date();
      basicResp.certs = [ca]; // embeds the real CA as its own "responder cert" — the common, legitimate shape
      const certId = await pkijs.CertID.create(leaf, { hashAlgorithm: "SHA-1", issuerCertificate: ca });
      basicResp.tbsResponseData.responses = [
        new pkijs.SingleResponse({ certID: certId, certStatus: new asn1jsMod.Primitive({ idBlock: { tagClass: 3, tagNumber: 0 } }), thisUpdate: new Date() }),
      ];
      await basicResp.sign(caKeys.privateKey, "SHA-256");
      const ocspResp = new pkijs.OCSPResponse({ responseStatus: new asn1jsMod.Enumerated({ value: 0 }) });
      ocspResp.responseBytes = new pkijs.ResponseBytes({ responseType: "1.3.6.1.5.5.7.48.1.1", response: new asn1jsMod.OctetString({ valueHex: basicResp.toSchema().toBER(false) }) });
      return { ok: true, status: 200, contentType: "application/ocsp-response", bodyBase64: base64(new Uint8Array(ocspResp.toSchema().toBER(false))), error: null };
    });

    const results = await checkCertificateRevocation(leafDer, caDer);
    const ocsp = results.find((r) => r.method === "ocsp")!;
    expect(ocsp.status).toBe("good");
    expect(ocsp.signatureVerified).toBe(true);
  });

  test("an OCSP response embedding a FORGED, self-issued responder cert (not signed by the real CA) is rejected, never reported as a real status", async () => {
    // The direct negative case for the bug fix above: a malicious responder
    // signs with its own key and embeds its own self-signed cert as if it
    // were a legitimate delegated responder. Trusting `basicResponse.certs`
    // as its own anchor would validate this; trusting only the real,
    // independently-known issuer must reject it.
    const { pkijs, ca, caDer, leaf, leafDer, OCSP_URL } = await buildPki();
    const asn1jsMod = await import("asn1js");

    const forgedKeys = await globalThis.crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );
    const forgedResponder = new pkijs.Certificate();
    forgedResponder.version = 2;
    forgedResponder.serialNumber = new asn1jsMod.Integer({ value: 999 });
    forgedResponder.issuer.typesAndValues.push(new pkijs.AttributeTypeAndValue({ type: "2.5.4.3", value: new asn1jsMod.BmpString({ value: "Attacker" }) }));
    forgedResponder.subject.typesAndValues.push(new pkijs.AttributeTypeAndValue({ type: "2.5.4.3", value: new asn1jsMod.BmpString({ value: "Attacker" }) }));
    forgedResponder.notBefore.value = new Date(Date.now() - 86400000);
    forgedResponder.notAfter.value = new Date(Date.now() + 86400000);
    await forgedResponder.subjectPublicKeyInfo.importKey(forgedKeys.publicKey);
    await forgedResponder.sign(forgedKeys.privateKey, "SHA-256"); // self-signed by the attacker, never touches the real CA key

    mockCheckRevocationEndpoint = mock(async ({ data }) => {
      if (data.url !== OCSP_URL) return { ok: false, status: 0, contentType: null, bodyBase64: null, error: "unexpected URL in this test" };
      const basicResp = new pkijs.BasicOCSPResponse();
      basicResp.tbsResponseData.responderID = forgedResponder.subject;
      basicResp.tbsResponseData.producedAt = new Date();
      basicResp.certs = [forgedResponder];
      // A realistic attacker builds a CertID that correctly matches the REAL
      // certificate/issuer being asked about (they can see the request) —
      // only the signer identity and signature are forged, not the CertID
      // hashes, which is what makes this a meaningful negative test rather
      // than one that trivially fails for the wrong reason.
      const certId = await pkijs.CertID.create(leaf, { hashAlgorithm: "SHA-1", issuerCertificate: ca });
      basicResp.tbsResponseData.responses = [
        new pkijs.SingleResponse({ certID: certId, certStatus: new asn1jsMod.Primitive({ idBlock: { tagClass: 3, tagNumber: 0 } }), thisUpdate: new Date() }),
      ];
      await basicResp.sign(forgedKeys.privateKey, "SHA-256");
      const ocspResp = new pkijs.OCSPResponse({ responseStatus: new asn1jsMod.Enumerated({ value: 0 }) });
      ocspResp.responseBytes = new pkijs.ResponseBytes({ responseType: "1.3.6.1.5.5.7.48.1.1", response: new asn1jsMod.OctetString({ valueHex: basicResp.toSchema().toBER(false) }) });
      return { ok: true, status: 200, contentType: "application/ocsp-response", bodyBase64: base64(new Uint8Array(ocspResp.toSchema().toBER(false))), error: null };
    });

    const results = await checkCertificateRevocation(leafDer, caDer);
    const ocsp = results.find((r) => r.method === "ocsp")!;
    expect(ocsp.status).toBe("unreachable");
    expect(ocsp.signatureVerified).toBe(false);
  });

  test("a real CRL that DOES list the leaf's serial reports revoked", async () => {
    const { pkijs, asn1js, caKeys, caDer, leaf, leafDer, CRL_URL } = await buildPki();

    mockCheckRevocationEndpoint = mock(async ({ data }) => {
      if (data.url !== CRL_URL) return { ok: false, status: 0, contentType: null, bodyBase64: null, error: "unexpected URL in this test" };
      const crl = new pkijs.CertificateRevocationList();
      crl.version = 1;
      crl.issuer.typesAndValues.push(new pkijs.AttributeTypeAndValue({ type: "2.5.4.3", value: new asn1js.BmpString({ value: "Test Root CA" }) }));
      crl.thisUpdate.value = new Date();
      crl.revokedCertificates = [new pkijs.RevokedCertificate({ userCertificate: leaf.serialNumber, revocationDate: new pkijs.Time({ value: new Date() }) })];
      await crl.sign(caKeys.privateKey, "SHA-256");
      return { ok: true, status: 200, contentType: "application/pkix-crl", bodyBase64: base64(new Uint8Array(crl.toSchema().toBER(false))), error: null };
    });

    const results = await checkCertificateRevocation(leafDer, caDer);
    const crlResult = results.find((r) => r.method === "crl")!;
    expect(crlResult.status).toBe("revoked");
    expect(crlResult.signatureVerified).toBe(true);
  });

  test("an unparseable/oversized CRL response is reported as unsupported, never crashes or reports a false status", async () => {
    const { caDer, leafDer, CRL_URL, OCSP_URL } = await buildPki();

    mockCheckRevocationEndpoint = mock(async ({ data }) => {
      if (data.url === CRL_URL) {
        return { ok: true, status: 200, contentType: "application/pkix-crl", bodyBase64: base64(new Uint8Array([0x00, 0x01, 0x02])), error: null };
      }
      return { ok: false, status: 0, contentType: null, bodyBase64: null, error: "simulated network failure" };
    });

    const results = await checkCertificateRevocation(leafDer, caDer);
    const crlResult = results.find((r) => r.method === "crl")!;
    expect(crlResult.status).toBe("unsupported");
    const ocsp = results.find((r) => r.method === "ocsp")!;
    expect(ocsp.status).toBe("unreachable");
    expect(ocsp.detail).toContain("simulated network failure");
  });
});
