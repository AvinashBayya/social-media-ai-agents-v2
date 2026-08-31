/**
 * Browser layer for PDF signature revocation checking (OCSP primary, CRL
 * secondary) — see pdf-revocation.ts for the two real, directly-verified
 * findings this design is built on (no CORS on OCSP/CRL endpoints; asn1js
 * failing to parse a large real-world CRL).
 *
 * pkijs (BSD-3-Clause, PeculiarVentures — also maintainers of the WebCrypto
 * shims this project's other crypto code implicitly relies on) does the real
 * ASN.1/OCSP/CRL work here, not a hand-rolled implementation. That is a
 * deliberate departure from this file's neighbour, file-provenance-client.ts,
 * which hand-rolls CMS/PKCS#7 verification — but ONLY after confirming
 * node-forge's own pkcs7.verify() was an unimplemented stub (see that file's
 * header). Here the opposite check applies: a real, actively maintained,
 * permissively-licensed library for exactly this (OCSP request/response,
 * CRL parsing, signature verification against a supplied issuer certificate)
 * already exists, so building a second one from scratch would just be a
 * second, less battle-tested source of the exact correctness risk a
 * cryptographic revocation check cannot afford to get wrong.
 */

import type { RevocationCheckResult } from "./pdf-revocation";
import { checkRevocationEndpoint } from "./pdf-revocation-server";

const AIA_EXTENSION_OID = "1.3.6.1.5.5.7.1.1";
const OCSP_ACCESS_METHOD_OID = "1.3.6.1.5.5.7.48.1";
const CRL_DISTRIBUTION_POINTS_OID = "2.5.29.31";
/** pkijs's GeneralName.type for a uniformResourceIdentifier (GeneralName ::= CHOICE, tag [6]). */
const GENERAL_NAME_URI_TYPE = 6;

let engineArmed = false;
function ensureCryptoEngine(pkijs: any): void {
  if (engineArmed) return;
  pkijs.setEngine("sentinel-file-provenance", new pkijs.CryptoEngine({ name: "sentinel", crypto: globalThis.crypto, subtle: globalThis.crypto.subtle }));
  engineArmed = true;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function findOcspUrl(cert: any): string | null {
  const ext = cert.extensions?.find((e: any) => e.extnID === AIA_EXTENSION_OID);
  const desc = ext?.parsedValue?.accessDescriptions?.find((d: any) => d.accessMethod === OCSP_ACCESS_METHOD_OID);
  return desc?.accessLocation?.type === GENERAL_NAME_URI_TYPE ? (desc.accessLocation.value as string) : null;
}

function findCrlUrl(cert: any): string | null {
  const ext = cert.extensions?.find((e: any) => e.extnID === CRL_DISTRIBUTION_POINTS_OID);
  const distributionPoints = ext?.parsedValue?.distributionPoints as any[] | undefined;
  for (const dp of distributionPoints ?? []) {
    const names = dp.distributionPoint;
    const uri = Array.isArray(names) ? names.find((n: any) => n.type === GENERAL_NAME_URI_TYPE) : null;
    if (uri) return uri.value as string;
  }
  return null;
}

async function postViaServer(url: string, bodyDer: Uint8Array, contentType: string): Promise<Uint8Array> {
  const result = await checkRevocationEndpoint({ data: { url, method: "POST", bodyBase64: bytesToBase64(bodyDer), contentType } });
  if (!result.ok || !result.bodyBase64) throw new Error(result.error ?? `The responder returned HTTP ${result.status}.`);
  return base64ToBytes(result.bodyBase64);
}

async function getViaServer(url: string): Promise<Uint8Array> {
  const result = await checkRevocationEndpoint({ data: { url, method: "GET", bodyBase64: null, contentType: null } });
  if (!result.ok || !result.bodyBase64) throw new Error(result.error ?? `The distribution point returned HTTP ${result.status}.`);
  return base64ToBytes(result.bodyBase64);
}

async function checkOcsp(pkijs: any, leaf: any, issuer: any): Promise<RevocationCheckResult> {
  const url = findOcspUrl(leaf);
  if (!url) {
    return { method: "ocsp", status: "unsupported", responderUrl: null, detail: "This certificate has no Authority Information Access / OCSP extension — nothing to check against.", signatureVerified: null };
  }

  const request = new pkijs.OCSPRequest();
  await request.createForCertificate(leaf, { hashAlgorithm: "SHA-1", issuerCertificate: issuer });
  const requestDer = new Uint8Array(request.toSchema(true).toBER(false));

  const responseBytes = await postViaServer(url, requestDer, "application/ocsp-request");
  const ocspResponse = pkijs.OCSPResponse.fromBER(responseBytes);
  const responseStatusCode: number = ocspResponse.responseStatus.valueBlock.valueDec;
  if (responseStatusCode !== 0 || !ocspResponse.responseBytes) {
    return {
      method: "ocsp",
      status: "unreachable",
      responderUrl: url,
      detail: `The responder returned OCSPResponseStatus ${responseStatusCode} (not "successful"), per RFC 6960 §4.2.1.`,
      signatureVerified: null,
    };
  }

  const basicResponse = pkijs.BasicOCSPResponse.fromBER(ocspResponse.responseBytes.response.valueBlock.valueHexView);
  const certStatus = await basicResponse.getCertificateStatus(leaf, issuer);
  if (!certStatus.isForCertificate) {
    return { method: "ocsp", status: "unreachable", responderUrl: url, detail: "The response did not answer for the certificate that was actually asked about.", signatureVerified: null };
  }

  // pkijs's own basicResponse.verify() requires an embedded responder
  // certificate (`basicResponse.certs`) and throws otherwise — real, common
  // responses (confirmed live against DigiCert's production responder) sign
  // directly with the issuing CA's own key and never embed one, so that case
  // is verified manually against the already-known issuer's public key.
  let signatureVerified: boolean;
  try {
    if (basicResponse.certs && basicResponse.certs.length > 0) {
      // `trustedCerts` must be the independently-known issuing CA — NOT
      // `basicResponse.certs` itself. Passing the response's own embedded
      // certs as their own trust anchor would let a malicious responder
      // hand back an arbitrary self-signed chain and have it "verify"
      // against itself; pkijs's verify() builds a chain from the embedded
      // delegated-responder cert up to a cert in `trustedCerts`, so this
      // must be the real issuer for the check to mean anything.
      signatureVerified = await basicResponse.verify({ trustedCerts: [issuer] });
    } else {
      const crypto = pkijs.getCrypto(true);
      const tbsDer = basicResponse.tbsResponseData.toSchema().toBER(false);
      signatureVerified = await crypto.verifyWithPublicKey(tbsDer, basicResponse.signature, issuer.subjectPublicKeyInfo, basicResponse.signatureAlgorithm);
    }
  } catch {
    signatureVerified = false;
  }
  if (!signatureVerified) {
    return {
      method: "ocsp",
      status: "unreachable",
      responderUrl: url,
      detail: "The response's own signature did not verify against the issuing certificate authority's key — treated as untrustworthy, never reported as a real status.",
      signatureVerified: false,
    };
  }

  // CertStatus ::= CHOICE { good [0], revoked [1], unknown [2] } — RFC 6960 §4.2.1.
  const status: RevocationCheckResult["status"] = certStatus.status === 0 ? "good" : certStatus.status === 1 ? "revoked" : "unknown";
  return {
    method: "ocsp",
    status,
    responderUrl: url,
    detail: `The responder at ${url} reports this certificate's status as "${status}". The response's signature verified against the issuing certificate authority.`,
    signatureVerified: true,
  };
}

async function checkCrl(pkijs: any, leaf: any, issuer: any): Promise<RevocationCheckResult> {
  const url = findCrlUrl(leaf);
  if (!url) {
    return { method: "crl", status: "unsupported", responderUrl: null, detail: "This certificate has no CRL Distribution Points extension — nothing to check against.", signatureVerified: null };
  }

  const crlBytes = await getViaServer(url);

  let crl: any;
  try {
    crl = pkijs.CertificateRevocationList.fromBER(crlBytes);
  } catch {
    return {
      method: "crl",
      status: "unsupported",
      responderUrl: url,
      detail:
        `This CRL (${crlBytes.byteLength} bytes) could not be parsed. Very large CRLs — tens of thousands of ` +
        "revoked-certificate entries, common among major commercial CAs — are a real, confirmed limitation of the " +
        "ASN.1 parser this check uses; a smaller CRL from the same code path parses correctly. This is a tooling " +
        "limit, not evidence about the certificate itself.",
      signatureVerified: null,
    };
  }

  let signatureVerified: boolean;
  try {
    signatureVerified = await crl.verify({ issuerCertificate: issuer });
  } catch {
    signatureVerified = false;
  }
  if (!signatureVerified) {
    return {
      method: "crl",
      status: "unreachable",
      responderUrl: url,
      detail: "This CRL's own signature did not verify against the issuing certificate authority's key — treated as untrustworthy, never reported as a real status.",
      signatureVerified: false,
    };
  }

  const revoked: boolean = crl.isCertificateRevoked(leaf);
  const thisUpdate = crl.thisUpdate?.value instanceof Date ? crl.thisUpdate.value.toISOString() : "an unknown date";
  return {
    method: "crl",
    status: revoked ? "revoked" : "good",
    responderUrl: url,
    detail: `The CRL at ${url} (last updated ${thisUpdate}) ${revoked ? "lists" : "does not list"} this certificate as revoked. Its signature verified against the issuing certificate authority.`,
    signatureVerified: true,
  };
}

/**
 * Runs both revocation checks for one signature's already-verified leaf/
 * issuer certificates (`PdfSignatureVerification.leafCertificateDer` /
 * `.chainOfTrust.issuerCertificateDer`, from file-provenance-client.ts).
 * Each check fails independently — a network problem with one never hides
 * a real result from the other.
 */
export async function checkCertificateRevocation(leafDer: Uint8Array, issuerDer: Uint8Array): Promise<RevocationCheckResult[]> {
  const pkijs = await import("pkijs");
  ensureCryptoEngine(pkijs);

  // .slice() guarantees a freshly-allocated, plain ArrayBuffer-backed view —
  // TS's stricter BufferSource typing aside, this also protects against
  // either caller-supplied array being a `.subarray()` view sharing a larger
  // buffer whose bounds pkijs has no reason to know about.
  const leaf = pkijs.Certificate.fromBER(leafDer.slice());
  const issuer = pkijs.Certificate.fromBER(issuerDer.slice());

  const [ocsp, crl] = await Promise.all([
    checkOcsp(pkijs, leaf, issuer).catch(
      (err: any): RevocationCheckResult => ({ method: "ocsp", status: "unreachable", responderUrl: findOcspUrl(leaf), detail: err?.message ?? String(err), signatureVerified: null }),
    ),
    checkCrl(pkijs, leaf, issuer).catch(
      (err: any): RevocationCheckResult => ({ method: "crl", status: "unreachable", responderUrl: findCrlUrl(leaf), detail: err?.message ?? String(err), signatureVerified: null }),
    ),
  ]);
  return [ocsp, crl];
}
