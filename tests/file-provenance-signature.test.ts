import { describe, expect, test } from "bun:test";
import forge from "node-forge";
import { verifyChainAgainstStore, verifyDetachedCms } from "../src/utils/file-provenance-client";

/**
 * Ground-truth tests for the hand-rolled CMS/PKCS#7 signature verifier.
 *
 * node-forge's own pkcs7.js `verify()` is an unimplemented stub — confirmed
 * by reading node_modules/node-forge/lib/pkcs7.js directly — so
 * verifyDetachedCms() hand-navigates the parsed ASN.1 tree instead. These
 * tests cross-validate that implementation against forge's OWN signing
 * (`p7.sign()`, which IS fully implemented) as an independent ground truth,
 * rather than only checking the verifier is internally self-consistent:
 * genuine forge-signed content must verify "valid", and content tampered
 * after signing — the exact scenario this feature exists to catch — must
 * verify "invalid", never a false "valid".
 */

const EXTRACTED_AT = "2026-08-28T00:00:00.000Z";

// RSA keygen is the expensive part (hundreds of ms); one keypair/cert is
// reused across every test in this file to keep the suite fast.
const keys = forge.pki.rsa.generateKeyPair(2048);
const cert = forge.pki.createCertificate();
cert.publicKey = keys.publicKey;
cert.serialNumber = "01";
cert.validity.notBefore = new Date("2024-01-01T00:00:00Z");
cert.validity.notAfter = new Date("2030-01-01T00:00:00Z");
const subjectAttrs = [
  { name: "commonName", value: "Sentinel Test Signer" },
  { name: "organizationName", value: "Sentinel AI Test Rig" },
];
cert.setSubject(subjectAttrs);
cert.setIssuer(subjectAttrs);
cert.sign(keys.privateKey, forge.md.sha256.create());

function textBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function signContent(content: string, detached: boolean): Uint8Array {
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(content, "utf8");
  p7.addCertificate(cert);
  const signerOpts: any = { key: keys.privateKey, certificate: cert, digestAlgorithm: forge.pki.oids.sha256 };
  if (detached) {
    signerOpts.authenticatedAttributes = [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date("2026-01-01T00:00:00Z") },
    ];
  }
  p7.addSigner(signerOpts);
  p7.sign({ detached: true });
  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
  return forge.util.binary.raw.decode(der);
}

const REAL_CONTENT = "This is the exact byte range a PDF's /ByteRange would name, signed for real.";

describe("verifyDetachedCms — genuine signatures (ground truth: forge's own p7.sign())", () => {
  test("a genuine signature WITH authenticatedAttributes verifies valid", async () => {
    const cms = signContent(REAL_CONTENT, true);
    const result = await verifyDetachedCms(textBytes(REAL_CONTENT), cms, EXTRACTED_AT);
    expect(result.status).toBe("valid");
    expect(result.certificateSubject).toContain("Sentinel Test Signer");
    expect(result.certificateIssuer).toContain("Sentinel Test Signer");
    expect(result.certificateCurrentlyValid).toBe(true);
    // verifyDetachedCms's production chain-of-trust path loads the real
    // vendored CA bundle via a `?raw` import (Bun supports this loader
    // suffix natively under `bun test` too, confirmed empirically — no dev
    // server or fetch required), so this exercises the REAL bundled trust
    // store end to end. The test cert here is a throwaway self-signed one,
    // genuinely absent from any real root store, so "untrusted" is the
    // correct, honest answer — never a false "trusted". See
    // verifyChainAgainstStore's own tests below for direct, isolated proof of
    // the chain-verification logic against a hand-built hierarchy.
    expect(result.chainOfTrust?.status).toBe("untrusted");
  });

  test("a genuine signature WITHOUT authenticatedAttributes (signature directly over the content digest) verifies valid", async () => {
    const cms = signContent(REAL_CONTENT, false);
    const result = await verifyDetachedCms(textBytes(REAL_CONTENT), cms, EXTRACTED_AT);
    expect(result.status).toBe("valid");
  });

  test("a real-world zero-padded /Contents (fixed-size placeholder, final signature shorter than reserved) still verifies valid", async () => {
    // Real signed PDFs reserve a fixed-size /Contents hex placeholder before
    // the exact signature size is known, then pad the unused tail with zero
    // bytes — this is spec-legal and near-universal in practice, not a
    // contrived edge case. verifyDetachedCms must tolerate it (see the
    // parseAllBytes: false comment at its DER parse) rather than rejecting
    // real, validly-signed PDFs as "unsupported".
    const cms = signContent(REAL_CONTENT, true);
    const padded = new Uint8Array(cms.length + 500); // simulates an oversized reserved placeholder
    padded.set(cms, 0); // trailing 500 bytes stay zero, exactly like real PDF /Contents padding
    const result = await verifyDetachedCms(textBytes(REAL_CONTENT), padded, EXTRACTED_AT);
    expect(result.status).toBe("valid");
  });

  test("certificateCurrentlyValid is false when extractedAt falls outside the certificate's validity window", async () => {
    const cms = signContent(REAL_CONTENT, true);
    const result = await verifyDetachedCms(textBytes(REAL_CONTENT), cms, "2035-01-01T00:00:00.000Z");
    expect(result.status).toBe("valid"); // the crypto verdict is independent of certificate validity dates
    expect(result.certificateCurrentlyValid).toBe(false);
  });
});

describe("verifyDetachedCms — tampering must be caught, never silently pass (the dangerous failure mode is a false valid)", () => {
  test("content altered after signing, WITH authenticatedAttributes, is reported invalid via messageDigest mismatch", async () => {
    const cms = signContent(REAL_CONTENT, true);
    const tampered = REAL_CONTENT.slice(0, -1) + "X"; // one byte changed
    const result = await verifyDetachedCms(textBytes(tampered), cms, EXTRACTED_AT);
    expect(result.status).toBe("invalid");
    expect(result.detail).toContain("does not match the digest");
  });

  test("content altered after signing, WITHOUT authenticatedAttributes, is reported invalid via direct RSA verify failure", async () => {
    const cms = signContent(REAL_CONTENT, false);
    const tampered = REAL_CONTENT.slice(0, -1) + "X";
    const result = await verifyDetachedCms(textBytes(tampered), cms, EXTRACTED_AT);
    expect(result.status).toBe("invalid");
  });

  test("a corrupted signature value (one flipped byte in encryptedDigest) is reported invalid, not valid", async () => {
    const cms = signContent(REAL_CONTENT, true);
    // Flip the last byte, which — for a well-formed DER CMS SignedData ending
    // in the SignerInfo's encryptedDigest OCTET STRING — lands inside the
    // signature bytes themselves, corrupting the signature without touching
    // structure.
    const corrupted = new Uint8Array(cms);
    corrupted[corrupted.length - 1] ^= 0xff;
    const result = await verifyDetachedCms(textBytes(REAL_CONTENT), corrupted, EXTRACTED_AT);
    expect(["invalid", "unsupported"]).toContain(result.status); // a flipped byte may corrupt DER structure itself rather than just the signature — either way, never "valid"
    expect(result.status).not.toBe("valid");
  });
});

// ─── Chain-of-trust (forge.pki.verifyCertificateChain against a real, hand-built CA store) ───
//
// verifyChainAgainstStore is tested directly against a real, hand-built CA
// store rather than through verifyDetachedCms's production loadTrustedCaStore
// path, because that path fetches the vendored asset via Vite's `?url` +
// `fetch()` — real and correct in the actual browser, but there is no dev
// server or asset pipeline under `bun test`, so it fails there for reasons
// that have nothing to do with chain-verification correctness (confirmed:
// checkChainOfTrust honestly reports "unsupported", not a wrong "trusted"/
// "untrusted", when the trust store itself can't load — see its own code
// comment). This split keeps the actual chain-verification LOGIC unit-tested
// for real.

/** A CA cert must be PEM round-tripped before its subject is reused as a child's issuer — the DN's ASN.1 string tag class (e.g. UTF8String) is only pinned down by a real DER encode/decode cycle, and a subject/issuer hash mismatch from skipping this makes forge.pki.verifyCertificateChain wrongly report "not trusted" even for a correctly-signed chain. Found empirically while writing this test. */
function pemRoundTrip(cert: forge.pki.Certificate): forge.pki.Certificate {
  return forge.pki.certificateFromPem(forge.pki.certificateToPem(cert));
}

function makeCa(commonName: string): { cert: forge.pki.Certificate; keys: forge.pki.KeyPair } {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date("2024-01-01T00:00:00Z");
  cert.validity.notAfter = new Date("2030-01-01T00:00:00Z");
  const attrs = [{ name: "commonName", value: commonName }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { cert: pemRoundTrip(cert), keys };
}

function makeSigned(commonName: string, serialNumber: string, issuer: { cert: forge.pki.Certificate; keys: forge.pki.KeyPair }, isCa: boolean): { cert: forge.pki.Certificate; keys: forge.pki.KeyPair } {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serialNumber;
  cert.validity.notBefore = new Date("2024-01-01T00:00:00Z");
  cert.validity.notAfter = new Date("2030-01-01T00:00:00Z");
  cert.setSubject([{ name: "commonName", value: commonName }]);
  cert.setIssuer(issuer.cert.subject.attributes);
  cert.setExtensions(
    isCa
      ? [{ name: "basicConstraints", cA: true }, { name: "keyUsage", keyCertSign: true, cRLSign: true }]
      : [{ name: "basicConstraints", cA: false }, { name: "keyUsage", digitalSignature: true }],
  );
  cert.sign(issuer.keys.privateKey, forge.md.sha256.create());
  return { cert: pemRoundTrip(cert), keys };
}

const CHECK_AT = "2026-08-28T00:00:00.000Z";

describe("verifyChainAgainstStore — real certificate hierarchies, no network dependency", () => {
  test("a leaf signed by a root IN the trust store resolves trusted", () => {
    const root = makeCa("Sentinel Test Root CA");
    const leaf = makeSigned("Sentinel Test Leaf", "10", root, false);
    const caStore = forge.pki.createCaStore([forge.pki.certificateToPem(root.cert)]);
    const result = verifyChainAgainstStore(forge, caStore, leaf.cert, [], CHECK_AT);
    expect(result.status).toBe("trusted");
  });

  test("a 3-level chain (leaf <- intermediate <- root) resolves trusted when the intermediate is passed as an 'other' embedded certificate", () => {
    const root = makeCa("Sentinel Test Root CA");
    const intermediate = makeSigned("Sentinel Test Intermediate CA", "11", root, true);
    const leaf = makeSigned("Sentinel Test Leaf via Intermediate", "12", intermediate, false);
    const caStore = forge.pki.createCaStore([forge.pki.certificateToPem(root.cert)]);
    // Real PDF CMS structures embed the leaf and any intermediates together, in no
    // guaranteed order relative to each other — verifyChainAgainstStore receives
    // them the same way (leaf plus the full "otherCerts" list from the signature).
    const result = verifyChainAgainstStore(forge, caStore, leaf.cert, [intermediate.cert], CHECK_AT);
    expect(result.status).toBe("trusted");
  });

  test("a self-signed certificate NOT in the trust store is reported untrusted, never a false trusted", () => {
    const selfSigned = makeCa("Untrusted Self-Signed");
    const caStore = forge.pki.createCaStore([]); // empty store — nothing is trusted
    const result = verifyChainAgainstStore(forge, caStore, selfSigned.cert, [], CHECK_AT);
    expect(result.status).toBe("untrusted");
  });

  test("a leaf signed by a real CA that is simply absent from the (smaller/different) trust store is reported untrusted", () => {
    const unknownRoot = makeCa("Some Other Root CA");
    const leaf = makeSigned("Leaf Under Unknown Root", "20", unknownRoot, false);
    const caStore = forge.pki.createCaStore([]); // the real signing root is deliberately not added
    const result = verifyChainAgainstStore(forge, caStore, leaf.cert, [], CHECK_AT);
    expect(result.status).toBe("untrusted");
  });

  test("a chain that is otherwise valid but expired as of the check date is reported untrusted", () => {
    const root = makeCa("Sentinel Test Root CA");
    const leaf = makeSigned("Sentinel Test Leaf", "30", root, false); // valid 2024-01-01..2030-01-01
    const caStore = forge.pki.createCaStore([forge.pki.certificateToPem(root.cert)]);
    const result = verifyChainAgainstStore(forge, caStore, leaf.cert, [], "2035-01-01T00:00:00.000Z");
    expect(result.status).toBe("untrusted");
    expect(result.detail.toLowerCase()).toContain("expired");
  });
});

describe("verifyDetachedCms — fails closed on structural problems, never guesses toward valid", () => {
  test("garbage bytes (not DER at all) are reported unsupported", async () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const result = await verifyDetachedCms(textBytes(REAL_CONTENT), garbage, EXTRACTED_AT);
    expect(result.status).toBe("unsupported");
  });

  test("an empty buffer is reported unsupported, not thrown as an uncaught error", async () => {
    const result = await verifyDetachedCms(textBytes(REAL_CONTENT), new Uint8Array(0), EXTRACTED_AT);
    expect(result.status).toBe("unsupported");
  });

  test("a well-formed DER ContentInfo with the wrong content type OID (not SignedData) is reported unsupported", async () => {
    // ContentInfo ::= SEQUENCE { contentType OID(data, not signedData), [0] EXPLICIT content }
    const oidNode = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OID, false, forge.asn1.oidToDer(forge.pki.oids.data).getBytes());
    const inner = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OCTETSTRING, false, "not signed data");
    const explicit0 = forge.asn1.create(forge.asn1.Class.CONTEXT_SPECIFIC, 0, true, [inner]);
    const contentInfo = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [oidNode, explicit0]);
    const der = forge.asn1.toDer(contentInfo).getBytes();
    const bytes = forge.util.binary.raw.decode(der);
    const result = await verifyDetachedCms(textBytes(REAL_CONTENT), bytes, EXTRACTED_AT);
    expect(result.status).toBe("unsupported");
    expect(result.detail).toContain("not a CMS SignedData");
  });
});
