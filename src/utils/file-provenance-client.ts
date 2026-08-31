/**
 * File provenance forensics — browser layer for PDF / Word (OOXML) / ODF /
 * video containers. Mirrors imaging-client.ts's split exactly: everything
 * here runs IN THE BROWSER, nothing is uploaded anywhere, and every heavy
 * import (pdf-lib, fflate) is DYNAMIC so it never lands in the initial page
 * load or the SSR bundle — this module is reachable from the global search
 * bar, which renders on all 27 routes.
 *
 * Image handling reuses imaging-client.ts's readExif/readC2pa VERBATIM,
 * rather than re-implementing EXIF/C2PA extraction a second time.
 *
 * Three empirically-verified pdf-lib traps this file exists to avoid (see
 * PROJECT_MEMORY.md for the full verification):
 *   1. PDFDocument.load() defaults updateMetadata:true, which OVERWRITES the
 *      Info dictionary's /Producer and /ModDate with a fabricated "pdf-lib"
 *      string and the current timestamp BEFORE they can be read. Always
 *      pass { updateMetadata: false }.
 *   2. PDFString/PDFHexString's own .decodeDate() invents a UTC midnight for
 *      a date-only value ("D:20240302" -> decodeDate() returns
 *      2024-03-02T00:00:00.000Z, a time and a UTC-ness the file never
 *      recorded) and throws on a malformed date. Never call it — decode the
 *      RAW TEXT via .decodeText() and parse it with this project's own
 *      parsePdfDate(), which preserves real precision and never invents one.
 *   3. pdf-lib is a writer first; real-world linearized or damaged PDFs can
 *      throw on load. That failure is reported as a real error, never
 *      silently swallowed into an empty report.
 */

import {
  assessFileProvenance,
  cannotDetermineFor,
  classifyZipEntries,
  countPdfEofMarkers,
  findRiffChunkBytes,
  interpretCfbfDocument,
  interpretEbmlContainer,
  interpretGifInfo,
  interpretId3Tags,
  interpretOdfMeta,
  interpretOfficeDocument,
  interpretOoxmlMacrosAndTemplates,
  interpretPdfDates,
  interpretPdfHiddenActions,
  interpretPdfInfoDict,
  interpretRiffContainer,
  interpretTrailingData,
  interpretVideoContainer,
  OOXML_ABSENCE_NOTE,
  parseCfbfHeader,
  parseEbmlContainer,
  parseGifBlocks,
  parseId3v1Tag,
  parseId3v2Tags,
  parseIlstTags,
  parseIsoBmffBoxes,
  parseJpegTrailer,
  parseMvhd,
  parseOdfMeta,
  parseOlepsPropertySet,
  parseOoxmlAppProps,
  parseOoxmlCoreProps,
  parseOoxmlCustomProps,
  parsePdfDate,
  parsePngTrailer,
  parseRelationshipsXml,
  parseRiffContainer,
  parseXmpPacket,
  readCfbfStream,
  sniffContainer,
  type ContainerIdentity,
  type FileProvenanceReport,
  type PdfEmbeddedFileInfo,
  type PdfSignatureCertificatePair,
  type ProvenanceField,
  type ProvenanceTimestamp,
  type XmpProperties,
} from "./file-provenance";
import { readC2pa, readExif } from "./imaging-client";

export class FileProvenanceError extends Error {
  readonly stage: string;
  constructor(message: string, stage: string) {
    super(message);
    this.name = "FileProvenanceError";
    this.stage = stage;
  }
}

export const FILE_PROVENANCE_ACCEPT =
  ".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp,.jpg,.jpeg,.png,.gif,.webp,.heic,.heif,.avif," +
  ".mp4,.mov,.m4v,.webm,.mkv,.avi,.wav,.wave,.mp3," +
  "application/pdf,image/jpeg,image/png,image/gif,image/webp,image/heic,image/heif,image/avif," +
  "video/mp4,video/quicktime,video/webm,video/x-matroska,video/x-msvideo,audio/wav,audio/wave,audio/mpeg";

/** How many header bytes to sniff. Comfortably covers every magic-byte check in sniffContainer. */
const SNIFF_HEAD_BYTES = 64;

/**
 * Hex SHA-256 of raw bytes, for hashing an embedded-file stream's content —
 * mirrors evidence.ts's `sha256OfFile`, but over already-decoded bytes rather
 * than a File/Blob. Returns null (never a fabricated digest) when SubtleCrypto
 * is unavailable or the digest itself throws, matching how every other field
 * in this file degrades to "unreadable" rather than guessing.
 */
async function sha256HexOfBytes(bytes: Uint8Array): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null;
  try {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return null;
  }
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────

export async function readFileProvenance(file: File): Promise<FileProvenanceReport> {
  const head = new Uint8Array(await file.slice(0, Math.min(SNIFF_HEAD_BYTES, file.size)).arrayBuffer());
  const container = sniffContainer(head, file.name, file.type);
  const extractedAt = new Date().toISOString();

  try {
    switch (container.kind) {
      case "pdf":
        return await readPdfProvenance(file, container, extractedAt);
      case "zip-unknown":
        return await readOfficeProvenance(file, container, extractedAt);
      case "ole2":
        return await readCfbfProvenance(file, container, extractedAt);
      case "image-jpeg":
      case "image-png":
      case "iso-bmff-heif":
        return await readImageProvenance(file, container, extractedAt);
      case "iso-bmff":
        return await readVideoContainerProvenance(file, container, extractedAt);
      case "ebml":
        return await readEbmlProvenance(file, container, extractedAt);
      case "riff-avi":
      case "riff-wave":
        return await readRiffProvenance(file, container, extractedAt);
      case "riff-webp":
        return await readWebpProvenance(file, container, extractedAt);
      case "gif":
        return await readGifProvenance(file, container, extractedAt);
      case "mp3":
        return await readMp3Provenance(file, container, extractedAt);
      default:
        return unsupportedReport(container, extractedAt, [
          "This file's container could not be identified from its content (magic bytes), so no " +
            "provenance extraction was attempted.",
        ]);
    }
  } catch (err: any) {
    if (err instanceof FileProvenanceError) throw err;
    throw new FileProvenanceError(`Could not read this file: ${err?.message ?? String(err)}`, "dispatch");
  }
}

function unsupportedReport(container: ContainerIdentity, extractedAt: string, errors: string[]): FileProvenanceReport {
  return {
    kind: "unsupported",
    container,
    fields: [],
    timestamps: [],
    raw: [],
    errors,
    cannotDetermine: cannotDetermineFor("unsupported"),
    method: "Container identified from magic bytes; no extraction is implemented for this format.",
    extractedAt,
  };
}

function xmpFieldsFrom(xmp: XmpProperties): ProvenanceField[] {
  const fields: ProvenanceField[] = [];
  const get = (k: string): string | null => {
    const v = xmp.values[k];
    return typeof v === "string" ? v : Array.isArray(v) ? v.join("; ") : null;
  };
  const push = (id: string, label: string, value: string | null, origin: string, note: string, severity: "info" | "notable" = "info") => {
    fields.push({ id, label, value, status: value ? "present" : "absent", origin, note, severity });
  };

  push("xmp.creatorTool", "XMP Creator Tool", get("xmp:CreatorTool"), "XMP packet xmp:CreatorTool", "The application that wrote this file's XMP metadata.", "notable");
  push("xmp.createDate", "XMP Create Date", get("xmp:CreateDate"), "XMP packet xmp:CreateDate", "As recorded in the XMP packet, W3CDTF format.");
  push("xmp.modifyDate", "XMP Modify Date", get("xmp:ModifyDate"), "XMP packet xmp:ModifyDate", "As recorded in the XMP packet.");
  push("xmp.producer", "XMP Producer", get("pdf:Producer"), "XMP packet pdf:Producer", "May duplicate or differ from the Info dictionary's Producer field above.");

  if (xmp.documentId) {
    fields.push({
      id: "xmp.documentId",
      label: "XMP Document ID",
      value: xmp.documentId,
      status: "present",
      origin: "XMP packet xmpMM:DocumentID",
      note:
        "Persists across saves and exports of this specific document lineage. Two files sharing " +
        "the same Document ID is strong evidence they descend from the same source document.",
      severity: "notable",
    });
  }
  if (xmp.originalDocumentId && xmp.originalDocumentId !== xmp.documentId) {
    fields.push({
      id: "xmp.originalDocumentId",
      label: "XMP Original Document ID",
      value: xmp.originalDocumentId,
      status: "present",
      origin: "XMP packet xmpMM:OriginalDocumentID",
      note: "The Document ID this file was originally derived from, before a later Save As changed its own ID.",
      severity: "notable",
    });
  }
  if (xmp.history.length) {
    fields.push({
      id: "xmp.history",
      label: "Edit history",
      value: xmp.history
        .map((h) => `${h.action}${h.softwareAgent ? ` (${h.softwareAgent})` : ""}${h.when ? ` at ${h.when}` : ""}`)
        .join("; "),
      status: "present",
      origin: "XMP packet xmpMM:History",
      note: `An explicit, self-reported edit chain of ${xmp.history.length} event(s), declared by the authoring software.`,
      severity: "notable",
    });
  }

  return fields;
}

// ─── PDF digital signature verification (CMS/PKCS#7) ───────────────────────
//
// node-forge's own pkcs7.js `verify()` is an unimplemented stub (confirmed
// by reading node_modules/node-forge/lib/pkcs7.js directly: `throw new
// Error('PKCS#7 signature verification not yet implemented.')`) — this
// hand-navigates the parsed ASN.1 tree using forge's lower-level, well-tested
// primitives (forge.asn1, forge.pki, forge.md) instead, per RFC 5652 §5.4/§5.6.
// node-forge 1.4.0+ carries the CVE-2022-24771 fix for lenient PKCS#1 v1.5
// signature checking — confirmed via `npm view node-forge version` (1.4.0
// installed) and a clean `npm audit` for this dependency.
//
// Scope, stated honestly rather than silently: RSA PKCS#1 v1.5 signatures
// only (the overwhelming majority of real-world PDF signing certificates) —
// ECDSA/DSA report "unsupported", never a guessed verdict. Exactly one
// SignerInfo is supported — a PDF signature field's /Contents is its own
// independent CMS blob, so real multi-signer SignedData here would be
// unusual and is reported unsupported rather than silently checked against
// only the first signer. When more than one certificate is embedded, the
// signing certificate is matched to the SignerInfo's issuerAndSerialNumber
// by serial number; if that match is ambiguous, this reports unsupported
// rather than guessing which certificate to trust.
//
// This checks CRYPTOGRAPHIC SELF-CONSISTENCY: does the embedded certificate's
// own public key validate this exact signature over this exact byte range.
// "valid" here means "this content has not been altered since it was signed
// with this certificate" — that alone never means "signed by someone this
// tool vouches for", which is why chain-of-trust is a SEPARATE, independent
// verdict (`chainOfTrust`, below), never folded into `status`.
//
// Chain-of-trust validation, added 2026-08-28: `forge.pki.verifyCertificateChain`
// (a real, fully-implemented RFC 3280 path-validation algorithm — unlike
// pkcs7.js's verify() stub above, confirmed by reading x509.js directly)
// checks the embedded certificate against a real, freshly-fetched Mozilla CA
// bundle (curl.se/ca/cacert.pem, dated 2026-08-13, vendored as a first-party
// asset — see loadTrustedCaStore below), never a CDN or a live fetch per
// signature. **What this still cannot establish, stated plainly**: no CRL/OCSP
// revocation checking (forge's own implementation marks this a TODO; checking
// it would also mean a live network call per signature, which this feature's
// "nothing leaves this browser tab" promise does not currently make) — a
// chain can validate to a trusted root even if the certificate was later
// revoked. The trust store is a dated snapshot, not a live registry: a CA
// added or distrusted after 2026-08-13 will not be reflected until the
// bundle is refreshed. **A real parsing limit found while wiring this up,
// not assumed**: forge.pki.publicKeyFromAsn1 only supports RSA, and the real
// Mozilla bundle genuinely includes ECDSA/Ed25519 roots (e.g. ISRG Root X2)
// — 41 of the bundle's 121 certificates fail to parse and are skipped rather
// than aborting the whole store (confirmed live: an unfiltered
// createCaStore(pems) call threw "Cannot read public key. OID is not RSA."
// and lost every RSA root along with the non-RSA ones). This is consistent
// with, not an added limitation beyond, this module's own RSA-only signature
// scope above — a PDF signed with a non-RSA certificate already reports
// "unsupported" upstream, before chain-of-trust is even reached.
//
// Certificate subject/issuer/validity are still reported as pure
// informational fields, never folded into `status`. Fails closed on every
// ambiguity (unsupported algorithm, malformed structure, missing or
// ambiguous certificate, untrusted/unverifiable chain) — the only actively
// dangerous failure mode here is a false "valid" or a false "trusted".

export type PdfSignatureStatus = "valid" | "invalid" | "unsupported";
export type ChainOfTrustStatus = "trusted" | "untrusted" | "unsupported";

export interface ChainOfTrustResult {
  status: ChainOfTrustStatus;
  detail: string;
  /**
   * DER bytes of whichever certificate directly issued the checked leaf — an
   * embedded intermediate if the CMS structure carried one, otherwise a
   * subject-DN match found in the bundled trust store. This is deliberately
   * NOT "a trusted root exists somewhere up the chain" (that's `status`
   * above) — revocation checking (OCSP/CRL) needs the actual direct issuer,
   * since that is whose key signs the OCSP response / CRL and whose AIA the
   * CertID hash is computed against. Null when no issuer could be resolved
   * at all, e.g. a self-signed or otherwise unmatched certificate.
   */
  issuerCertificateDer: Uint8Array | null;
}

export interface PdfSignatureVerification {
  status: PdfSignatureStatus;
  detail: string;
  certificateSubject: string | null;
  certificateIssuer: string | null;
  certificateNotBefore: string | null;
  certificateNotAfter: string | null;
  certificateCurrentlyValid: boolean | null;
  chainOfTrust: ChainOfTrustResult | null;
  /** DER bytes of the signing certificate itself — the other half `checkCertificateRevocation` (pdf-revocation-client.ts) needs alongside `chainOfTrust.issuerCertificateDer`. Null only when this signature is "unsupported" and no certificate was ever resolved. */
  leafCertificateDer: Uint8Array | null;
}

let trustedCaStorePromise: Promise<any> | null = null;

/**
 * Loads the vendored Mozilla CA bundle (see the header comment above for
 * provenance) and builds a real `forge.pki` CA store, memoized module-wide so
 * the ~120-certificate bundle is only parsed once per page session no matter
 * how many signatures are checked.
 */
function loadTrustedCaStore(forge: any): Promise<any> {
  if (!trustedCaStorePromise) {
    trustedCaStorePromise = (async () => {
      // .txt, not .pem — Vite's server.fs.deny blocks *.{crt,pem} by default
      // (a real security control against accidentally serving TLS secrets),
      // reproduced live 2026-08-28 as a 403. This file is genuinely public,
      // non-secret data (root CA certificates are meant to be public), so the
      // fix is a non-denied extension, not weakening that control.
      // `?raw` (not `?url` + fetch) — a plain `.txt` isn't in Vite's default
      // asset-extension list either, so its resolved `?url` path 404s at the
      // dev server outside Vite's own module-transform layer (also
      // reproduced live); `?raw` inlines the file's text content directly at
      // import time instead, sidestepping the need for it to be separately
      // servable as a URL at all.
      const pemText = (await import("../assets/mozilla-ca-bundle.txt?raw")).default;
      const pems = pemText.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
      if (pems.length === 0) throw new Error("The bundled CA trust store contained no parseable certificates.");
      // Parsed individually, not handed to forge.pki.createCaStore(pems) as raw
      // PEM strings: the real Mozilla bundle includes genuine ECDSA/Ed25519
      // root CAs (e.g. ISRG Root X2), and forge.pki.publicKeyFromAsn1 only
      // supports RSA — one non-RSA cert would otherwise throw and abort the
      // ENTIRE store, silently losing every RSA root along with it (confirmed
      // live: "Cannot read public key. OID is not RSA." on the unfiltered
      // bundle). Skipping just the unparseable ones is consistent with this
      // module's own RSA-only signature-verification scope — a PDF signed
      // with a non-RSA cert is already reported "unsupported" upstream, so a
      // non-RSA root being absent from the trust store changes nothing for
      // any chain this tool can otherwise verify.
      const certs: any[] = [];
      for (const pem of pems) {
        try {
          certs.push(forge.pki.certificateFromPem(pem));
        } catch {
          // A handful of non-RSA roots are expected and skipped — not an error.
        }
      }
      if (certs.length === 0) throw new Error("No RSA root certificates could be parsed from the bundled trust store.");
      return forge.pki.createCaStore(certs);
    })();
  }
  return trustedCaStorePromise;
}

/**
 * The actual chain-of-trust check, given an already-loaded CA store — split
 * out from `checkChainOfTrust` below so it can be unit-tested directly
 * against a real, hand-built `forge.pki.createCaStore(...)` (a genuine root +
 * intermediate + leaf hierarchy under this test's own control) rather than
 * only through the real ~80-certificate Mozilla bundle, which would leave no
 * way to construct a positive "trusted" case without a real CA's private
 * key. See tests/file-provenance-signature.test.ts.
 */
/** Converts a parsed forge certificate object back to its raw DER bytes — the wire format pkijs (a separate library, used for OCSP/CRL) needs, since forge and pkijs share no common in-memory object model. */
function certificateToDer(forge: any, cert: any): Uint8Array {
  const derBinaryString: string = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  return forge.util.binary.raw.decode(derBinaryString);
}

/**
 * Finds whichever certificate actually issued `leaf` — checked FIRST among
 * `otherCerts` (an intermediate embedded alongside the leaf in the same CMS
 * structure, the common case for a real signed PDF), falling back to a
 * subject-DN match in the trust store via forge's own `caStore.getIssuer`.
 * Deliberately independent of whether the resulting chain is `trusted`: an
 * intermediate not chaining to one of our bundled roots is still the real,
 * correct issuer to revocation-check against.
 */
function resolveIssuerCertificateDer(forge: any, caStore: any, leaf: any, otherCerts: any[]): Uint8Array | null {
  const leafIssuerDn = forgeDnToString(leaf.issuer);
  const embedded = otherCerts.find((c) => c !== leaf && forgeDnToString(c.subject) === leafIssuerDn);
  let issuer = embedded ?? null;
  if (!issuer) {
    try {
      issuer = caStore.getIssuer(leaf) || null;
    } catch {
      issuer = null;
    }
  }
  if (!issuer) return null;
  try {
    return certificateToDer(forge, issuer);
  } catch {
    return null;
  }
}

export function verifyChainAgainstStore(forge: any, caStore: any, leaf: any, otherCerts: any[], extractedAt: string): ChainOfTrustResult {
  const issuerCertificateDer = resolveIssuerCertificateDer(forge, caStore, leaf, otherCerts);
  try {
    const chain = [leaf, ...otherCerts.filter((c) => c !== leaf)];
    forge.pki.verifyCertificateChain(caStore, chain, { validityCheckDate: new Date(extractedAt) });
    return {
      status: "trusted",
      detail:
        "This certificate chains to a root certificate authority in the bundled Mozilla trust store " +
        "(curl.se/ca/cacert.pem, dated 2026-08-13). Revocation status (CRL/OCSP) is not checked here " +
        "— see the separate, opt-in Signature Revocation Check.",
      issuerCertificateDer,
    };
  } catch (err: any) {
    const message = typeof err?.message === "string" ? err.message : String(err);
    return {
      status: "untrusted",
      detail: `This certificate does not chain to any root in the bundled trust store: ${message}`,
      issuerCertificateDer,
    };
  }
}

/**
 * A trust-store LOAD failure (asset missing, fetch failure, unparseable
 * bundle) is a different, infrastructure-level problem from a certificate
 * genuinely not chaining to a trusted root — conflating the two into one
 * "untrusted" status would misreport "we could not check" as "we checked and
 * it failed", so a load failure reports "unsupported" instead.
 */
async function checkChainOfTrust(forge: any, leaf: any, otherCerts: any[], extractedAt: string): Promise<ChainOfTrustResult> {
  let caStore: any;
  try {
    caStore = await loadTrustedCaStore(forge);
  } catch (err: any) {
    return {
      status: "unsupported",
      detail: `The bundled CA trust store could not be loaded, so chain-of-trust could not be checked: ${err?.message ?? String(err)}`,
      issuerCertificateDer: null,
    };
  }
  return verifyChainAgainstStore(forge, caStore, leaf, otherCerts, extractedAt);
}

const RSA_SIGNATURE_OID_NAMES = [
  "rsaEncryption",
  "sha1WithRSAEncryption",
  "sha256WithRSAEncryption",
  "sha384WithRSAEncryption",
  "sha512WithRSAEncryption",
] as const;

function forgeDigestCreator(forge: any, oid: string): (() => any) | null {
  if (oid === forge.pki.oids.sha256) return forge.md.sha256.create;
  if (oid === forge.pki.oids.sha1) return forge.md.sha1.create;
  if (oid === forge.pki.oids.sha384) return forge.md.sha384.create;
  if (oid === forge.pki.oids.sha512) return forge.md.sha512.create;
  return null;
}

function forgeDnToString(dn: any): string | null {
  const parts = (dn?.attributes ?? []).map((a: any) => `${a.shortName || a.name || a.type}=${a.value}`);
  return parts.length ? parts.join(", ") : null;
}

/**
 * Verifies a detached CMS/PKCS#7 SignedData (as used by PDF's
 * adbe.pkcs7.detached / ETSI.CAdES.detached SubFilters) over `signedContent`
 * — the caller is responsible for assembling exactly the bytes named by the
 * PDF's own /ByteRange from the ORIGINAL uploaded file bytes, never a
 * pdf-lib-reserialized copy (which would change every offset and invalidate
 * the check). Exported standalone, with no Blob/File dependency, so it can be
 * tested directly against node-forge's own p7.sign() output as independent
 * ground truth — see tests/file-provenance-signature.test.ts.
 */
export async function verifyDetachedCms(
  signedContent: Uint8Array,
  cmsDer: Uint8Array,
  extractedAt: string,
): Promise<PdfSignatureVerification> {
  // node-forge ships no type declarations and none are installed (avoiding an
  // extra dependency for a module this project already treats as untyped
  // ASN.1/PKI internals below) — explicitly `any`, not an implicit one.
  const forge: any = await import("node-forge");
  const unsupported = (detail: string): PdfSignatureVerification => ({
    status: "unsupported",
    detail,
    certificateSubject: null,
    certificateIssuer: null,
    certificateNotBefore: null,
    certificateNotAfter: null,
    certificateCurrentlyValid: null,
    chainOfTrust: null,
    leafCertificateDer: null,
  });

  let asn1: any;
  try {
    // parseAllBytes: false — real-world signed PDFs reserve a fixed-size
    // /Contents placeholder before the final signature size is known, then
    // pad the unused tail with zero bytes. That padding is spec-legal and
    // extremely common; a strict "no trailing bytes" parse would reject
    // most genuinely valid signed PDFs. The ContentInfo SEQUENCE's own DER
    // length prefix is what actually bounds the real structure — anything
    // after it is deliberately ignored, not blindly trusted.
    asn1 = forge.asn1.fromDer(forge.util.binary.raw.encode(cmsDer), { strict: true, parseAllBytes: false });
  } catch (err: any) {
    return unsupported(`This signature's CMS/PKCS#7 structure could not be parsed as DER: ${err?.message ?? String(err)}`);
  }
  if (!asn1?.value || !Array.isArray(asn1.value) || asn1.value.length < 2) {
    return unsupported("Malformed CMS structure — expected a ContentInfo SEQUENCE with a content type and content.");
  }

  let contentTypeOid: string;
  try {
    contentTypeOid = forge.asn1.derToOid(asn1.value[0].value);
  } catch {
    return unsupported("Malformed CMS structure — could not read the ContentInfo content type.");
  }
  if (contentTypeOid !== forge.pki.oids.signedData) {
    return unsupported(`This is not a CMS SignedData structure (content type OID ${contentTypeOid}).`);
  }

  const signedData = asn1.value[1]?.value?.[0];
  if (!signedData || !Array.isArray(signedData.value)) {
    return unsupported("Malformed CMS structure — SignedData content was not found.");
  }

  let certsNode: any = null;
  let signerInfosNode: any = null;
  for (const child of signedData.value) {
    if (child.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && child.type === 0) certsNode = child;
    else if (child.tagClass === forge.asn1.Class.UNIVERSAL && child.type === forge.asn1.Type.SET) signerInfosNode = child;
  }
  if (!certsNode || !Array.isArray(certsNode.value) || certsNode.value.length === 0) {
    return unsupported("No certificate is embedded in this signature — nothing to verify against.");
  }
  if (!signerInfosNode || !Array.isArray(signerInfosNode.value) || signerInfosNode.value.length === 0) {
    return unsupported("No SignerInfo was found in this signature.");
  }
  if (signerInfosNode.value.length > 1) {
    return unsupported(
      `This signature has ${signerInfosNode.value.length} signers — multi-signer CMS structures are not verified by this tool.`,
    );
  }

  const signerInfo = signerInfosNode.value[0];
  if (!Array.isArray(signerInfo.value) || signerInfo.value.length < 5) {
    return unsupported("Malformed SignerInfo structure.");
  }

  // Parse every embedded certificate once — the rest of the chain (any
  // intermediates) is needed for chain-of-trust validation below, not just
  // the signer's own leaf certificate.
  let allCerts: any[];
  try {
    allCerts = certsNode.value.map((n: any) => forge.pki.certificateFromAsn1(n));
  } catch (err: any) {
    return unsupported(`The embedded certificate(s) could not be parsed: ${err?.message ?? String(err)}`);
  }

  // Resolve the signing certificate: trivial when exactly one is embedded
  // (the common case for PDF signatures); otherwise match by serial number
  // against the SignerInfo's issuerAndSerialNumber, and refuse to guess if
  // that match is ambiguous.
  let certificate: any;
  if (allCerts.length === 1) {
    certificate = allCerts[0];
  } else {
    const sidNode = signerInfo.value[1];
    const serialNode = Array.isArray(sidNode?.value) ? sidNode.value[1] : null;
    const serialHex = serialNode ? forge.util.bytesToHex(serialNode.value).toLowerCase().replace(/^0+(?=.)/, "") : null;
    const matches = serialHex ? allCerts.filter((c: any) => c.serialNumber.toLowerCase().replace(/^0+(?=.)/, "") === serialHex) : [];
    if (matches.length !== 1) {
      return unsupported(
        `This signature embeds ${allCerts.length} certificates and the signing certificate could not be ` +
          "unambiguously matched by serial number — refusing to guess which one to verify against.",
      );
    }
    certificate = matches[0];
  }

  const chainOfTrust = await checkChainOfTrust(forge, certificate, allCerts, extractedAt);
  let leafCertificateDer: Uint8Array | null;
  try {
    leafCertificateDer = certificateToDer(forge, certificate);
  } catch {
    leafCertificateDer = null;
  }
  const certFields = {
    certificateSubject: forgeDnToString(certificate.subject),
    certificateIssuer: forgeDnToString(certificate.issuer),
    certificateNotBefore: certificate.validity.notBefore.toISOString(),
    certificateNotAfter: certificate.validity.notAfter.toISOString(),
    certificateCurrentlyValid:
      new Date(extractedAt) >= certificate.validity.notBefore && new Date(extractedAt) <= certificate.validity.notAfter,
    chainOfTrust,
    leafCertificateDer,
  };

  let idx = 2; // skip version(0) and sid/issuerAndSerialNumber(1) — sid was only needed above, for cert matching
  const digestAlgNode = signerInfo.value[idx++];
  let digestAlgOid: string;
  try {
    digestAlgOid = forge.asn1.derToOid(digestAlgNode.value[0].value);
  } catch {
    return { ...unsupported("Malformed SignerInfo — could not read the digest algorithm."), ...certFields };
  }

  let authAttrsNode: any = null;
  if (signerInfo.value[idx] && signerInfo.value[idx].tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && signerInfo.value[idx].type === 0) {
    authAttrsNode = signerInfo.value[idx];
    idx += 1;
  }
  const digestEncAlgNode = signerInfo.value[idx++];
  let digestEncOid: string;
  try {
    digestEncOid = forge.asn1.derToOid(digestEncAlgNode.value[0].value);
  } catch {
    return { ...unsupported("Malformed SignerInfo — could not read the signature algorithm."), ...certFields };
  }
  const encryptedDigestNode = signerInfo.value[idx++];
  if (!encryptedDigestNode || encryptedDigestNode.type !== forge.asn1.Type.OCTETSTRING) {
    return { ...unsupported("Malformed SignerInfo — no signature value found."), ...certFields };
  }
  const signatureBytes: string = encryptedDigestNode.value;

  const rsaOids = new Set(RSA_SIGNATURE_OID_NAMES.map((n) => forge.pki.oids[n]));
  if (!rsaOids.has(digestEncOid)) {
    return {
      ...unsupported(`Unsupported signature algorithm (OID ${digestEncOid}) — only RSA PKCS#1 v1.5 signatures are verified.`),
      ...certFields,
    };
  }
  const mdCreate = forgeDigestCreator(forge, digestAlgOid);
  if (!mdCreate) {
    return { ...unsupported(`Unsupported digest algorithm (OID ${digestAlgOid}).`), ...certFields };
  }

  const contentDigest = (() => {
    const md = mdCreate();
    md.update(forge.util.binary.raw.encode(signedContent));
    return md.digest().getBytes();
  })();

  let toVerify: string;
  if (authAttrsNode) {
    let attrDigestValue: string | null = null;
    for (const attr of authAttrsNode.value ?? []) {
      let oid: string;
      try {
        oid = forge.asn1.derToOid(attr.value[0].value);
      } catch {
        continue;
      }
      if (oid === forge.pki.oids.messageDigest) attrDigestValue = attr.value?.[1]?.value?.[0]?.value ?? null;
    }
    if (attrDigestValue === null) {
      return { ...unsupported("The signed attributes did not include a messageDigest value."), ...certFields };
    }
    if (attrDigestValue !== contentDigest) {
      return {
        status: "invalid",
        detail:
          "The document's actual content does not match the digest recorded in this signature's signed attributes " +
          "— the signed byte range has been altered since signing.",
        ...certFields,
      };
    }
    const setNode = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, authAttrsNode.value);
    const setDer = forge.asn1.toDer(setNode).getBytes();
    const md = mdCreate();
    md.update(setDer);
    toVerify = md.digest().getBytes();
  } else {
    toVerify = contentDigest;
  }

  let sigOk = false;
  try {
    sigOk = certificate.publicKey.verify(toVerify, signatureBytes);
  } catch (err: any) {
    return { ...unsupported(`Signature verification could not be completed: ${err?.message ?? String(err)}`), ...certFields };
  }

  return {
    status: sigOk ? "valid" : "invalid",
    detail: sigOk
      ? "This signature cryptographically verifies against its embedded certificate's public key, over the exact " +
        "signed byte range — the content has not been altered since it was signed with this certificate. See the " +
        "separate chain-of-trust field below for whether that certificate itself is backed by a recognised authority."
      : "This signature does NOT cryptographically verify against its embedded certificate's public key. The " +
        "signed content may have been altered, or the signature is malformed.",
    ...certFields,
  };
}

// ─── PDF ─────────────────────────────────────────────────────────────────

export async function readPdfProvenance(
  file: Blob,
  container: ContainerIdentity,
  extractedAt: string,
): Promise<FileProvenanceReport> {
  const { PDFDocument, PDFDict, PDFName, PDFArray, PDFNumber, PDFStream, PDFRawStream, decodePDFRawStream } = await import("pdf-lib");
  const bytes = new Uint8Array(await file.arrayBuffer());

  let doc;
  try {
    doc = await PDFDocument.load(bytes, {
      updateMetadata: false, // mandatory — see this file's header comment, trap #1
      ignoreEncryption: true,
      throwOnInvalidObject: false,
    });
  } catch (err: any) {
    return {
      kind: "pdf",
      container,
      fields: [],
      timestamps: [],
      raw: [],
      errors: [`This PDF's structure could not be parsed: ${err?.message ?? String(err)}`],
      cannotDetermine: cannotDetermineFor("pdf"),
      method: "pdf-lib PDFDocument.load (updateMetadata: false).",
      extractedAt,
    };
  }

  const errors: string[] = [];
  const isEncrypted = Boolean(doc.isEncrypted);
  const pageCount = (() => {
    try {
      return doc.getPageCount();
    } catch {
      return null;
    }
  })();

  const entries: Record<string, string> = {};
  if (!isEncrypted) {
    try {
      const infoDict = doc.context.lookup(doc.context.trailerInfo.Info, PDFDict);
      for (const [key, val] of infoDict.entries()) {
        const k = key.toString().replace(/^\//, "");
        // decodeText() (not decodeDate() — trap #2) works for PDFString and
        // PDFHexString alike, and yields the raw recorded text for every field
        // including dates, which parsePdfDate() then interprets honestly.
        const decoded = typeof (val as any)?.decodeText === "function" ? (val as any).decodeText() : null;
        if (decoded !== null) entries[k] = decoded;
      }
    } catch (err: any) {
      errors.push(`Info dictionary could not be read: ${err?.message ?? String(err)}`);
    }
  }

  let signatureFieldCount = 0;
  const sigFieldDicts: { fieldName: string | null; sigDict: any }[] = [];
  try {
    const acroFormRef = doc.catalog.get(PDFName.of("AcroForm"));
    if (acroFormRef) {
      const acroForm = doc.context.lookup(acroFormRef, PDFDict);
      const fieldsRef = acroForm.get(PDFName.of("Fields"));
      if (fieldsRef) {
        const fieldArr = doc.context.lookup(fieldsRef, PDFArray);
        for (let i = 0; i < fieldArr.size(); i += 1) {
          const field = doc.context.lookup(fieldArr.get(i), PDFDict);
          const ft = field.get(PDFName.of("FT"));
          if (ft?.toString() !== "/Sig") continue;
          signatureFieldCount += 1;
          const vRef = field.get(PDFName.of("V"));
          if (!vRef) continue; // an unsigned /Sig field (a signature placeholder) — nothing to verify yet
          try {
            const sigDict = doc.context.lookup(vRef, PDFDict);
            const tField = field.get(PDFName.of("T"));
            const fieldName = typeof (tField as any)?.decodeText === "function" ? (tField as any).decodeText() : null;
            sigFieldDicts.push({ fieldName, sigDict });
          } catch {
            // This one field's signature dictionary is unreadable — the rest can still be checked.
          }
        }
      }
    }
  } catch {
    // An unusual /AcroForm shape just means signature fields can't be counted — not fatal.
  }

  const signatureFields: ProvenanceField[] = [];
  const signatureTimestamps: ProvenanceTimestamp[] = [];
  const signatureCertificates: PdfSignatureCertificatePair[] = [];
  for (let sigIdx = 0; sigIdx < sigFieldDicts.length; sigIdx += 1) {
    const { fieldName, sigDict } = sigFieldDicts[sigIdx];
    const label = `Signature ${sigIdx + 1}${fieldName ? ` (${fieldName})` : ""}`;
    const idPrefix = `pdf.signature.${sigIdx}`;

    const getName = (key: string): string | null => {
      const v = sigDict.get(PDFName.of(key));
      return v ? v.toString().replace(/^\//, "") : null;
    };
    const getText = (key: string): string | null => {
      const v = sigDict.get(PDFName.of(key));
      if (!v) return null;
      try {
        const resolved = doc.context.lookup(v);
        return typeof (resolved as any)?.decodeText === "function" ? (resolved as any).decodeText() : null;
      } catch {
        return null;
      }
    };

    const subFilter = getName("SubFilter");
    const reason = getText("Reason");
    const location = getText("Location");
    const signerName = getText("Name");
    const mRaw = getText("M");
    if (mRaw) signatureTimestamps.push(parsePdfDate(`${idPrefix}.signingTime`, `${label} — claimed signing time (/M)`, "/AcroForm signature field V/M", mRaw));

    let byteRange: number[] | null = null;
    try {
      const brRef = sigDict.get(PDFName.of("ByteRange"));
      if (brRef) {
        const arr = doc.context.lookup(brRef, PDFArray);
        const nums: number[] = [];
        for (let i = 0; i < arr.size(); i += 1) nums.push(doc.context.lookup(arr.get(i), PDFNumber).asNumber());
        if (nums.length === 4) byteRange = nums;
      }
    } catch {
      // handled below via the null check
    }

    let contentsBytes: Uint8Array | null = null;
    try {
      const cRef = sigDict.get(PDFName.of("Contents"));
      if (cRef) {
        const resolved = doc.context.lookup(cRef);
        if (typeof (resolved as any)?.asBytes === "function") contentsBytes = (resolved as any).asBytes();
      }
    } catch {
      // handled below via the null check
    }

    signatureFields.push({
      id: `${idPrefix}.subFilter`,
      label: `${label} — format`,
      value: subFilter,
      status: subFilter ? "present" : "absent",
      origin: "/AcroForm signature field V/SubFilter",
      note: "The CMS/PKCS#7 encoding this signature uses. Self-reported by the signing software, like every field in this report.",
      severity: "info",
    });
    if (reason) signatureFields.push({ id: `${idPrefix}.reason`, label: `${label} — stated reason`, value: reason, status: "present", origin: "/AcroForm signature field V/Reason", note: "Free text entered by the signer at signing time — not verified.", severity: "info" });
    if (location) signatureFields.push({ id: `${idPrefix}.location`, label: `${label} — stated location`, value: location, status: "present", origin: "/AcroForm signature field V/Location", note: "Free text entered by the signer at signing time — not verified.", severity: "info" });
    if (signerName) signatureFields.push({ id: `${idPrefix}.name`, label: `${label} — stated signer name`, value: signerName, status: "present", origin: "/AcroForm signature field V/Name", note: "Free text entered by the signer, distinct from the certificate's own subject name below — not verified.", severity: "info" });

    if (!byteRange || !contentsBytes) {
      signatureFields.push({
        id: `${idPrefix}.status`,
        label: `${label} — cryptographic validity`,
        value: "Not checked",
        status: "unreadable",
        origin: "/AcroForm signature field V (/ByteRange, /Contents)",
        note: "This signature dictionary is missing a usable /ByteRange or /Contents entry, so no verification could be attempted.",
        severity: "notable",
      });
      continue;
    }

    const coversWholeFile = byteRange[0] === 0 && byteRange[2] + byteRange[3] === bytes.length;
    signatureFields.push({
      id: `${idPrefix}.coversWholeFile`,
      label: `${label} — covers the entire file`,
      value: coversWholeFile ? "Yes — no bytes were appended after this signature" : "No — bytes exist after this signature's /ByteRange, e.g. a later incremental update or another signature",
      status: "present",
      origin: "/AcroForm signature field V/ByteRange, compared against the file's real length",
      note: "A signature can be perfectly valid over its own byte range and still not cover later changes to the file.",
      severity: "notable",
    });

    if (subFilter && subFilter !== "adbe.pkcs7.detached" && subFilter !== "ETSI.CAdES.detached") {
      signatureFields.push({
        id: `${idPrefix}.status`,
        label: `${label} — cryptographic validity`,
        value: `Not checked (${subFilter})`,
        status: "unreadable",
        origin: "/AcroForm signature field V/SubFilter",
        note: `Only adbe.pkcs7.detached and ETSI.CAdES.detached are verified by this tool; ${subFilter} is a different, unsupported encoding.`,
        severity: "notable",
      });
      continue;
    }

    const signedContent = new Uint8Array(byteRange[1] + byteRange[3]);
    signedContent.set(bytes.subarray(byteRange[0], byteRange[0] + byteRange[1]), 0);
    signedContent.set(bytes.subarray(byteRange[2], byteRange[2] + byteRange[3]), byteRange[1]);

    let verification: PdfSignatureVerification;
    try {
      verification = await verifyDetachedCms(signedContent, contentsBytes, extractedAt);
    } catch (err: any) {
      verification = {
        status: "unsupported",
        detail: `Signature verification threw an unexpected error: ${err?.message ?? String(err)}`,
        certificateSubject: null,
        certificateIssuer: null,
        certificateNotBefore: null,
        certificateNotAfter: null,
        certificateCurrentlyValid: null,
        chainOfTrust: null,
        leafCertificateDer: null,
      };
    }

    if (verification.leafCertificateDer && verification.chainOfTrust?.issuerCertificateDer) {
      signatureCertificates.push({ signatureIndex: sigIdx, leafDer: verification.leafCertificateDer, issuerDer: verification.chainOfTrust.issuerCertificateDer });
    }

    const statusLabel = verification.status === "valid" ? "Valid" : verification.status === "invalid" ? "INVALID" : "Not verified";
    signatureFields.push({
      id: `${idPrefix}.status`,
      label: `${label} — cryptographic validity`,
      value: `${statusLabel}${verification.status === "unsupported" ? ` — ${verification.detail}` : ""}`,
      status: "present",
      origin: "CMS/PKCS#7 signature over the file's own /ByteRange bytes",
      note: verification.detail,
      severity: "notable",
    });
    if (verification.certificateSubject || verification.certificateIssuer) {
      signatureFields.push({
        id: `${idPrefix}.certificate`,
        label: `${label} — certificate`,
        value: `Subject: ${verification.certificateSubject ?? "unknown"} | Issuer: ${verification.certificateIssuer ?? "unknown"}`,
        status: "present",
        origin: "The X.509 certificate embedded in this signature's CMS structure",
        note:
          "Identity claims exactly as the certificate states them — see the separate chain-of-trust field below " +
          "for whether a certificate authority backs this identity, and the cryptographic validity field above " +
          "for whether the signature itself checks out.",
        severity: "notable",
      });
      const validityBits: string[] = [];
      if (verification.certificateNotBefore) validityBits.push(`valid from ${verification.certificateNotBefore}`);
      if (verification.certificateNotAfter) validityBits.push(`to ${verification.certificateNotAfter}`);
      if (verification.certificateCurrentlyValid !== null) {
        validityBits.push(verification.certificateCurrentlyValid ? "within its validity period as of extraction" : "OUTSIDE its validity period as of extraction");
      }
      signatureFields.push({
        id: `${idPrefix}.certificateValidity`,
        label: `${label} — certificate validity period`,
        value: validityBits.join(", ") || null,
        status: validityBits.length ? "present" : "absent",
        origin: "The certificate's own notBefore/notAfter fields",
        note: "Whether the certificate's stated validity window covers the moment of extraction — informational, not part of the pass/fail verdict above.",
        severity: "info",
      });
      if (verification.chainOfTrust) {
        const trustLabel =
          verification.chainOfTrust.status === "trusted" ? "Trusted" : verification.chainOfTrust.status === "untrusted" ? "NOT TRUSTED" : "Not checked";
        signatureFields.push({
          id: `${idPrefix}.chainOfTrust`,
          label: `${label} — chain of trust`,
          value: `${trustLabel} — ${verification.chainOfTrust.detail}`,
          status: "present",
          origin: "forge.pki.verifyCertificateChain against a vendored Mozilla CA bundle (curl.se/ca/cacert.pem, dated 2026-08-13)",
          note: "Whether this certificate resolves to a recognised root certificate authority. Revocation (CRL/OCSP) is NOT checked — a trusted chain does not mean the certificate wasn't later revoked.",
          severity: "notable",
        });
      }
    }
  }

  let xmpXml: string | null = null;
  try {
    const metadataRef = doc.catalog.get(PDFName.of("Metadata"));
    if (metadataRef) {
      const stream = doc.context.lookup(metadataRef, PDFStream);
      if (stream instanceof PDFRawStream) {
        const decoded = decodePDFRawStream(stream).decode();
        xmpXml = typeof decoded === "string" ? decoded : new TextDecoder("utf-8", { fatal: false }).decode(decoded as Uint8Array);
      } else {
        errors.push("This PDF's /Metadata stream is compressed with a filter this tool does not decode.");
      }
    }
  } catch (err: any) {
    errors.push(`Embedded XMP metadata could not be read: ${err?.message ?? String(err)}`);
  }

  // ── Hidden actions / embedded files ──────────────────────────────────────
  // Skipped entirely for an encrypted PDF: string/stream decoding is NOT real
  // decryption (pdf-lib was loaded with ignoreEncryption: true), so decoding
  // an encrypted action's /JS or an encrypted Filespec's /F would silently
  // return ciphertext that merely LOOKS like text — exactly the fabrication
  // risk this project's own hard constraints forbid. See interpretPdfHiddenActions's `checked` flag.
  const incrementalUpdateCount = countPdfEofMarkers(bytes);
  let hasOpenAction = false;
  const javascriptActions: string[] = [];
  let launchActionCount = 0;
  let submitFormActionCount = 0;
  let importDataActionCount = 0;
  const embeddedFiles: PdfEmbeddedFileInfo[] = [];

  if (!isEncrypted) {
    try {
      hasOpenAction = Boolean(doc.catalog.get(PDFName.of("OpenAction")));
    } catch {
      // leave false — an unusual catalog shape, not a fatal read failure
    }

    const decodeTextOrStream = (val: any): string | null => {
      if (!val) return null;
      try {
        const resolved = doc.context.lookup(val);
        if (typeof (resolved as any)?.decodeText === "function") return (resolved as any).decodeText();
        if (resolved instanceof PDFRawStream) {
          const decoded = decodePDFRawStream(resolved).decode();
          return typeof decoded === "string" ? decoded : new TextDecoder("utf-8", { fatal: false }).decode(decoded as Uint8Array);
        }
      } catch {
        // this one action's /JS could not be decoded — skip it, don't guess
      }
      return null;
    };

    try {
      for (const [, obj] of doc.context.enumerateIndirectObjects()) {
        if (!(obj instanceof PDFDict)) continue;

        const subtypeVal = obj.get(PDFName.of("S"));
        const subtype = subtypeVal ? subtypeVal.toString().replace(/^\//, "") : null;
        if (subtype === "JavaScript") {
          const src = decodeTextOrStream(obj.get(PDFName.of("JS")));
          if (src !== null) javascriptActions.push(src);
        } else if (subtype === "Launch") {
          launchActionCount += 1;
        } else if (subtype === "SubmitForm") {
          submitFormActionCount += 1;
        } else if (subtype === "ImportData") {
          importDataActionCount += 1;
        }

        const typeVal = obj.get(PDFName.of("Type"));
        const objType = typeVal ? typeVal.toString().replace(/^\//, "") : null;
        if (objType === "Filespec") {
          const name = decodeTextOrStream(obj.get(PDFName.of("UF")) ?? obj.get(PDFName.of("F")));
          let byteLength = 0;
          let sha256: string | null = null;
          try {
            const efVal = obj.get(PDFName.of("EF"));
            if (efVal) {
              const efDict = doc.context.lookup(efVal, PDFDict);
              const streamRef = efDict.get(PDFName.of("UF")) ?? efDict.get(PDFName.of("F"));
              if (streamRef) {
                const stream = doc.context.lookup(streamRef, PDFStream);
                if (stream instanceof PDFRawStream) {
                  const decoded = decodePDFRawStream(stream).decode();
                  const fileBytes = typeof decoded === "string" ? new TextEncoder().encode(decoded) : (decoded as Uint8Array);
                  byteLength = fileBytes.byteLength;
                  sha256 = await sha256HexOfBytes(fileBytes);
                }
              }
            }
          } catch {
            // this file specification's embedded stream could not be read — still record the name if one was found
          }
          embeddedFiles.push({ name, byteLength, sha256 });
        }
      }
    } catch (err: any) {
      errors.push(`Hidden-action / embedded-file scan could not complete: ${err?.message ?? String(err)}`);
    }
  }

  const { fields: hiddenActionFields, raw: hiddenActionRaw } = interpretPdfHiddenActions({
    checked: !isEncrypted,
    hasOpenAction,
    javascriptActions,
    launchActionCount,
    submitFormActionCount,
    importDataActionCount,
    embeddedFiles,
    incrementalUpdateCount,
  });

  const infoFields = isEncrypted
    ? [
        {
          id: "pdf.encrypted",
          label: "Encryption",
          value: "Encrypted",
          status: "present" as const,
          origin: "PDF trailer /Encrypt",
          note:
            "This PDF is encrypted. String values in the Info dictionary are not decrypted by " +
            "this tool and were deliberately not read, to avoid rendering ciphertext as though " +
            "it were real metadata.",
          severity: "notable" as const,
        },
      ]
    : interpretPdfInfoDict(entries, { isEncrypted, pageCount, signatureFieldCount });

  const timestamps = [...(isEncrypted ? [] : interpretPdfDates(entries)), ...signatureTimestamps];

  const raw: { label: string; text: string }[] = [];
  let xmpFields: ProvenanceField[] = [];
  if (xmpXml) {
    raw.push({ label: "XMP packet", text: xmpXml });
    xmpFields = xmpFieldsFrom(parseXmpPacket(xmpXml));
  }
  raw.push(...hiddenActionRaw);

  return {
    kind: "pdf",
    container,
    fields: [...infoFields, ...xmpFields, ...signatureFields, ...hiddenActionFields],
    timestamps,
    raw,
    errors,
    cannotDetermine: cannotDetermineFor("pdf"),
    method:
      "PDF Info dictionary and embedded XMP packet, read via pdf-lib (updateMetadata: false, so " +
      "pdf-lib's own writer identity is never substituted for the file's real Producer/ModDate) " +
      "plus this project's own PDF-date and XMP parsers. Signature fields (/AcroForm /Sig) are " +
      "verified as CMS/PKCS#7 detached signatures over the file's own /ByteRange bytes, checking " +
      "self-consistency against the embedded certificate only — not a chain of trust. Hidden actions " +
      "(/OpenAction, /JavaScript, /Launch, /SubmitForm, /ImportData) and embedded files are found by " +
      "enumerating every indirect object in the document, not just ones reachable from the page tree — " +
      "skipped for encrypted PDFs, since decoding would return ciphertext, not real content. Incremental " +
      "update count is a raw byte scan for \"%%EOF\", independent of encryption.",
    extractedAt,
    signatureCertificates,
  };
}

// ─── Word (OOXML) / ODF ────────────────────────────────────────────────────

const MAX_OOXML_BYTES = 100 * 1024 * 1024;
const OOXML_WANTED_ENTRIES = new Set([
  "[Content_Types].xml",
  "docProps/core.xml",
  "docProps/app.xml",
  "docProps/custom.xml",
  "meta.xml",
  "mimetype",
]);

/**
 * Relationship-part paths worth inflating for the remote-template-injection
 * check below. The relevant part's name differs per Office app type (Word
 * vs. Excel vs. PowerPoint), and the app type itself is only known AFTER
 * `classifyZipEntries` runs on the full entry list — which happens after
 * fflate's filter has already decided what to inflate. Matching all four
 * suffixes up front is simpler and cheaper than a second unzip pass.
 */
const OOXML_RELS_SUFFIXES = ["_rels/document.xml.rels", "_rels/workbook.xml.rels", "_rels/presentation.xml.rels", "_rels/settings.xml.rels"];

export async function readOfficeProvenance(
  file: Blob,
  container: ContainerIdentity,
  extractedAt: string,
): Promise<FileProvenanceReport> {
  if (file.size > MAX_OOXML_BYTES) {
    return unsupportedReport(container, extractedAt, [
      `This file is ${(file.size / (1024 * 1024)).toFixed(0)}MB, over the ` +
        `${MAX_OOXML_BYTES / (1024 * 1024)}MB limit for in-browser zip extraction. It was not opened.`,
    ]);
  }

  const { unzipSync } = await import("fflate");
  const bytes = new Uint8Array(await file.arrayBuffer());

  // fflate's filter callback runs once per zip entry BEFORE deciding whether
  // to inflate it, with the entry's name always available — a free full
  // listing this file already relied on for classifyZipEntries below, and
  // which the vbaProject.bin check reuses rather than a second unzip pass.
  const allEntryNames: string[] = [];
  let unzipped: Record<string, Uint8Array>;
  try {
    // The filter inflates ONLY the matched entries — a multi-MB word/document.xml
    // never gets decompressed, keeping this fast regardless of file content size.
    unzipped = unzipSync(bytes, {
      filter: (f) => {
        allEntryNames.push(f.name);
        return OOXML_WANTED_ENTRIES.has(f.name) || OOXML_RELS_SUFFIXES.some((suffix) => f.name.endsWith(suffix));
      },
    });
  } catch (err: any) {
    return unsupportedReport(container, extractedAt, [
      `This zip-based file could not be opened: ${err?.message ?? String(err)}`,
    ]);
  }

  const decode = (name: string): string | null =>
    unzipped[name] ? new TextDecoder("utf-8", { fatal: false }).decode(unzipped[name]) : null;
  const classification = classifyZipEntries(allEntryNames);

  const hasVbaProject = allEntryNames.some((n) => n.endsWith("vbaProject.bin"));
  const relationships = OOXML_RELS_SUFFIXES.flatMap((suffix) => {
    const relsName = allEntryNames.find((n) => n.endsWith(suffix));
    const relsXml = relsName ? decode(relsName) : null;
    return relsXml ? parseRelationshipsXml(relsXml) : [];
  });
  const macroFields = interpretOoxmlMacrosAndTemplates(hasVbaProject, relationships);

  if (classification === "odf") {
    const metaXml = decode("meta.xml");
    if (!metaXml) {
      return {
        kind: "odf",
        container,
        fields: [],
        timestamps: [],
        raw: [],
        errors: ["This ODF file's meta.xml entry could not be found."],
        cannotDetermine: cannotDetermineFor("odf"),
        method: "ODF meta.xml, read via fflate.",
        extractedAt,
      };
    }
    return {
      kind: "odf",
      container,
      fields: interpretOdfMeta(parseOdfMeta(metaXml)),
      timestamps: [],
      raw: [{ label: "meta.xml", text: metaXml }],
      errors: [],
      cannotDetermine: cannotDetermineFor("odf"),
      method: "ODF meta.xml, read via fflate + this project's own XML scanner (no DOMParser, which is unavailable server-side and deliberately not used client-side either — see file-provenance.ts).",
      extractedAt,
    };
  }

  if (classification === "ooxml") {
    const coreXml = decode("docProps/core.xml");
    const appXml = decode("docProps/app.xml");
    const customXml = decode("docProps/custom.xml");
    if (!coreXml) {
      return {
        kind: "ooxml",
        container,
        fields: macroFields,
        timestamps: [],
        raw: [],
        errors: ["This OOXML file's docProps/core.xml entry could not be found."],
        cannotDetermine: cannotDetermineFor("ooxml"),
        method: "OOXML docProps, read via fflate.",
        extractedAt,
      };
    }
    const core = parseOoxmlCoreProps(coreXml);
    const app = appXml ? parseOoxmlAppProps(appXml) : null;
    const custom = customXml ? parseOoxmlCustomProps(customXml) : [];
    const raw: { label: string; text: string }[] = [{ label: "docProps/core.xml", text: coreXml }];
    if (appXml) raw.push({ label: "docProps/app.xml", text: appXml });
    if (customXml) raw.push({ label: "docProps/custom.xml", text: customXml });

    return {
      kind: "ooxml",
      container,
      fields: [...interpretOfficeDocument(core, app, custom), ...macroFields],
      timestamps: [],
      raw,
      errors: appXml
        ? []
        : ["This file has no docProps/app.xml — common for files exported from Google Docs, which never write it."],
      cannotDetermine: cannotDetermineFor("ooxml"),
      method:
        "OOXML docProps/core.xml, app.xml and custom.xml, read via fflate (only these entries are " +
        "ever inflated) + this project's own XML scanner. VBA macro presence is checked from the zip's " +
        "own entry-name listing (no macro source is decompiled). Remote-template/external-relationship " +
        "references are checked by inflating and parsing whichever _rels part(s) this app type carries.",
      extractedAt,
    };
  }

  return unsupportedReport(container, extractedAt, [
    "This zip-based file is neither a recognisable OOXML (.docx/.xlsx/.pptx) nor ODF " +
      "(.odt/.ods/.odp) document — no [Content_Types].xml/docProps or mimetype entry was found. " +
      "It may be a different zip-based format, or a password-protected OOXML file (which stores " +
      "its content encrypted inside an OLE2 wrapper and would have sniffed differently).",
  ]);
}

// ─── Video containers (ISO-BMFF / mp4, mov) ────────────────────────────────

const MAX_MOOV_BYTES = 32 * 1024 * 1024;
/** How much of the head/tail to scan looking for ftyp/moov before giving up. */
const SCAN_CHUNK_BYTES = 16 * 1024 * 1024;

function findFtypBrand(bytes: Uint8Array, boxes: ReturnType<typeof parseIsoBmffBoxes>): string | null {
  const ftyp = boxes.find((b) => b.type === "ftyp");
  if (!ftyp) return null;
  return new TextDecoder("ascii", { fatal: false }).decode(
    bytes.slice(ftyp.start + ftyp.headerSize, ftyp.start + ftyp.headerSize + 4),
  );
}

export async function readVideoContainerProvenance(
  file: Blob,
  container: ContainerIdentity,
  extractedAt: string,
): Promise<FileProvenanceReport> {
  const errors: string[] = [];
  let moovTruncated = false;

  async function scanFor(offset: number, length: number): Promise<{ bytes: Uint8Array; ftypBrand: string | null; moovBytes: Uint8Array | null }> {
    const bytes = new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
    const boxes = parseIsoBmffBoxes(bytes, 0, bytes.length);
    const ftypBrand = findFtypBrand(bytes, boxes);
    const moov = boxes.find((b) => b.type === "moov");
    if (!moov) return { bytes, ftypBrand, moovBytes: null };
    let moovBytes = bytes.slice(moov.start, moov.start + moov.size);
    if (moovBytes.length > MAX_MOOV_BYTES) {
      moovTruncated = true;
      moovBytes = moovBytes.slice(0, MAX_MOOV_BYTES);
    }
    return { bytes, ftypBrand, moovBytes };
  }

  // moov is often near the front (faststart) but can sit at the end of a
  // non-faststart file — try the head first via Blob.slice (no whole-file
  // read), then the tail if it wasn't there.
  let result = await scanFor(0, Math.min(SCAN_CHUNK_BYTES, file.size));
  if (!result.moovBytes && file.size > SCAN_CHUNK_BYTES) {
    const tailStart = Math.max(0, file.size - SCAN_CHUNK_BYTES);
    const tail = await scanFor(tailStart, file.size - tailStart);
    if (tail.moovBytes) result = tail;
  }

  let mvhd = null;
  let ilst: Record<string, string> = {};
  const handlerTypes: string[] = [];
  const codecs: string[] = [];

  if (result.moovBytes) {
    const moovBytes = result.moovBytes;
    const moovBoxes = parseIsoBmffBoxes(moovBytes, 0, moovBytes.length);

    const mvhdBox = moovBoxes.find((b) => b.type === "mvhd");
    if (mvhdBox) mvhd = parseMvhd(moovBytes.slice(mvhdBox.start + mvhdBox.headerSize, mvhdBox.start + mvhdBox.size));

    const udta = moovBoxes.find((b) => b.type === "udta");
    if (udta) {
      const udtaBoxes = parseIsoBmffBoxes(moovBytes, udta.start + udta.headerSize, udta.start + udta.size);
      const meta = udtaBoxes.find((b) => b.type === "meta");
      if (meta) {
        // "meta" is a FullBox (version+flags before its children) in the
        // common case, but some writers omit that header — try both.
        let metaBoxes = parseIsoBmffBoxes(moovBytes, meta.start + meta.headerSize + 4, meta.start + meta.size);
        let ilstBox = metaBoxes.find((b) => b.type === "ilst");
        if (!ilstBox) {
          metaBoxes = parseIsoBmffBoxes(moovBytes, meta.start + meta.headerSize, meta.start + meta.size);
          ilstBox = metaBoxes.find((b) => b.type === "ilst");
        }
        if (ilstBox) ilst = parseIlstTags(moovBytes.slice(ilstBox.start + ilstBox.headerSize, ilstBox.start + ilstBox.size));
      }
    }

    for (const trak of moovBoxes.filter((b) => b.type === "trak")) {
      const trakBoxes = parseIsoBmffBoxes(moovBytes, trak.start + trak.headerSize, trak.start + trak.size);
      const mdia = trakBoxes.find((b) => b.type === "mdia");
      if (!mdia) continue;
      const mdiaBoxes = parseIsoBmffBoxes(moovBytes, mdia.start + mdia.headerSize, mdia.start + mdia.size);
      const hdlr = mdiaBoxes.find((b) => b.type === "hdlr");
      if (hdlr) {
        // hdlr: version(1)+flags(3)+pre_defined(4)+handler_type(4)
        const handlerType = new TextDecoder("ascii", { fatal: false }).decode(
          moovBytes.slice(hdlr.start + hdlr.headerSize + 8, hdlr.start + hdlr.headerSize + 12),
        );
        if (handlerType.trim()) handlerTypes.push(handlerType);
      }
      const minf = mdiaBoxes.find((b) => b.type === "minf");
      if (!minf) continue;
      const stbl = parseIsoBmffBoxes(moovBytes, minf.start + minf.headerSize, minf.start + minf.size).find((b) => b.type === "stbl");
      if (!stbl) continue;
      const stsd = parseIsoBmffBoxes(moovBytes, stbl.start + stbl.headerSize, stbl.start + stbl.size).find((b) => b.type === "stsd");
      if (!stsd) continue;
      // stsd: version(1)+flags(3)+entry_count(4), then sample entries whose own box TYPE is the codec 4CC.
      const sampleEntries = parseIsoBmffBoxes(moovBytes, stsd.start + stsd.headerSize + 8, stsd.start + stsd.size);
      for (const entry of sampleEntries) codecs.push(entry.type);
    }
  } else {
    errors.push(
      "No moov box was found in the scanned portion of this file — its container structure could " +
        "not be read. The file may be truncated, or its metadata may sit outside the head/tail " +
        `chunks this tool scans (${SCAN_CHUNK_BYTES / (1024 * 1024)}MB each).`,
    );
  }

  // A real bug lived here, found live (2026-08-25): revoking the blob URL
  // from an independent setTimeout raced the <video> element's own in-flight
  // load — if metadata loading took anywhere near the timeout, the URL got
  // revoked while the element was still fetching it, producing a real
  // net::ERR_FILE_NOT_FOUND on the blob URL in the browser console. The fix
  // is to make revocation single-shot and to actively abort the element's
  // fetch (src = "", then load()) BEFORE revoking, closing the race window
  // instead of hoping the timeout never fires mid-load.
  const decoderDurationSeconds = await new Promise<number | null>((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    const url = URL.createObjectURL(file);
    let settled = false;

    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      video.onloadedmetadata = null;
      video.onerror = null;
      video.src = ""; // abort any in-flight fetch before revoking, not after
      video.load();
      URL.revokeObjectURL(url);
      resolve(value);
    };

    const timeout = setTimeout(() => finish(null), 8000);
    video.onloadedmetadata = () => finish(Number.isFinite(video.duration) ? video.duration : null);
    video.onerror = () => finish(null);
    video.src = url;
  });

  return {
    kind: "video",
    container,
    fields: interpretVideoContainer({
      ftypBrand: result.ftypBrand,
      mvhd,
      ilst,
      handlerTypes,
      codecs,
      decoderDurationSeconds,
      moovTruncated,
    }),
    timestamps: [],
    raw: [],
    errors,
    cannotDetermine: cannotDetermineFor("video"),
    method:
      "ISO-BMFF box walk (moov/mvhd, moov/udta/meta/ilst, moov/trak/mdia) over the file's own " +
      "bytes via Blob.slice — never the whole file in memory — plus this browser's own decoder " +
      "for duration.",
    extractedAt,
  };
}

// ─── RIFF / AVI / WAVE ──────────────────────────────────────────────────────

/** RIFF metadata (the LIST/INFO chunk) sits near the front for virtually every real-world AVI/WAV file — scanning this much of the head is comfortably enough while still avoiding loading a large file fully into memory. */
const RIFF_SCAN_BYTES = 16 * 1024 * 1024;

/** Handles both RIFF forms this project recognises: "AVI " (video) and "WAVE" (audio) — same chunk format, same LIST/INFO metadata convention, differing only in the resulting report's `kind`. */
export async function readRiffProvenance(file: Blob, container: ContainerIdentity, extractedAt: string): Promise<FileProvenanceReport> {
  const bytes = new Uint8Array(await file.slice(0, Math.min(RIFF_SCAN_BYTES, file.size)).arrayBuffer());
  const riff = parseRiffContainer(bytes);
  const kind = riff?.formType === "WAVE" ? "audio" : "video";
  const formLabel = kind === "audio" ? "WAV" : "AVI";
  const errors: string[] = [];
  if (riff && Object.keys(riff.tags).length === 0 && file.size > RIFF_SCAN_BYTES) {
    errors.push(
      `No LIST/INFO metadata chunk was found within the first ${RIFF_SCAN_BYTES / (1024 * 1024)}MB scanned. ` +
        `Real ${formLabel} files almost always carry it near the start, but this file is larger than the scanned region, so a genuine INFO chunk further in would have been missed.`,
    );
  }
  return {
    kind,
    container,
    fields: interpretRiffContainer(riff),
    timestamps: [],
    raw: [],
    errors,
    cannotDetermine: cannotDetermineFor(kind),
    method: `RIFF chunk walk over the first ${(bytes.length / (1024 * 1024)).toFixed(1)}MB of the file, looking for a top-level LIST/INFO chunk.`,
    extractedAt,
  };
}

// ─── WebP ───────────────────────────────────────────────────────────────────

const MAX_WEBP_BYTES = 100 * 1024 * 1024;

export async function readWebpProvenance(file: Blob, container: ContainerIdentity, extractedAt: string): Promise<FileProvenanceReport> {
  if (file.size > MAX_WEBP_BYTES) {
    return unsupportedReport(container, extractedAt, [
      `This file is ${(file.size / (1024 * 1024)).toFixed(0)}MB, over the ${MAX_WEBP_BYTES / (1024 * 1024)}MB limit for in-browser WebP parsing. It was not opened.`,
    ]);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const errors: string[] = [];
  const fields: ProvenanceField[] = [];

  const exifChunk = findRiffChunkBytes(bytes, "EXIF");
  if (exifChunk) {
    // The WebP spec allows (but does not require) an "Exif\0\0" preamble
    // before the real TIFF-structured EXIF data, mirroring JPEG's APP1
    // segment — stripped here so exifr always receives a bare TIFF blob,
    // the same shape it expects from a raw .tif file.
    const hasPreamble = exifChunk.length > 6 && new TextDecoder("ascii").decode(exifChunk.slice(0, 4)) === "Exif";
    const tiffBytes = hasPreamble ? exifChunk.slice(6) : exifChunk;
    try {
      const exif = await readExif(new Blob([tiffBytes as BufferSource]));
      for (const f of exif.findings) {
        fields.push({
          id: `exif.${f.id}`,
          label: f.label,
          value: f.value === "absent" ? null : f.value,
          status: f.value === "absent" ? "absent" : "present",
          origin: "EXIF chunk (exifr)",
          note: f.note,
          severity: f.severity,
        });
      }
    } catch (err: any) {
      errors.push(`This file's EXIF chunk could not be parsed: ${err?.message ?? String(err)}`);
    }
  }

  const xmpChunk = findRiffChunkBytes(bytes, "XMP ");
  let raw: { label: string; text: string }[] = [];
  if (xmpChunk) {
    const xmpXml = new TextDecoder("utf-8", { fatal: false }).decode(xmpChunk);
    raw = [{ label: "XMP packet", text: xmpXml }];
    fields.push(...xmpFieldsFrom(parseXmpPacket(xmpXml)));
  }

  if (!exifChunk && !xmpChunk) {
    fields.push({
      id: "webp.metadata",
      label: "Embedded metadata",
      value: null,
      status: "absent",
      origin: "WebP EXIF/XMP chunks",
      note: "This WebP file carries neither an EXIF nor an XMP chunk — very common, since many WebP encoders strip both by default.",
      severity: "info",
    });
  }

  return {
    kind: "image",
    container,
    fields,
    timestamps: [],
    raw,
    errors,
    cannotDetermine: cannotDetermineFor("image"),
    method: "RIFF chunk walk for WebP's top-level EXIF/XMP chunks, then this project's existing EXIF (exifr) and XMP parsers on their contents.",
    extractedAt,
  };
}

// ─── GIF ────────────────────────────────────────────────────────────────────

const MAX_GIF_BYTES = 100 * 1024 * 1024;

export async function readGifProvenance(file: Blob, container: ContainerIdentity, extractedAt: string): Promise<FileProvenanceReport> {
  if (file.size > MAX_GIF_BYTES) {
    return unsupportedReport(container, extractedAt, [
      `This file is ${(file.size / (1024 * 1024)).toFixed(0)}MB, over the ${MAX_GIF_BYTES / (1024 * 1024)}MB limit for in-browser GIF parsing. It was not opened.`,
    ]);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const gif = parseGifBlocks(bytes);
  return {
    kind: "image",
    container,
    fields: interpretGifInfo(gif),
    timestamps: [],
    raw: [],
    errors: gif ? [] : ["This file's GIF header could not be read."],
    cannotDetermine: cannotDetermineFor("image"),
    method: "GIF block-stream walk (Comment and Application Extensions) — see this project's own GIF parser for what is and is not decoded.",
    extractedAt,
  };
}

// ─── MP3 / ID3 ──────────────────────────────────────────────────────────────

const MAX_MP3_SCAN_BYTES = 16 * 1024 * 1024; // ID3v2 sits at the start — no need to load a large audio file fully into memory

export async function readMp3Provenance(file: Blob, container: ContainerIdentity, extractedAt: string): Promise<FileProvenanceReport> {
  const head = new Uint8Array(await file.slice(0, Math.min(MAX_MP3_SCAN_BYTES, file.size)).arrayBuffer());
  const v2 = parseId3v2Tags(head);

  let v1: ReturnType<typeof parseId3v1Tag> = null;
  const errors: string[] = [];
  if (file.size >= 128) {
    try {
      const tail = new Uint8Array(await file.slice(file.size - 128, file.size).arrayBuffer());
      v1 = parseId3v1Tag(tail);
    } catch (err: any) {
      errors.push(`This file's trailing ID3v1 tag could not be read: ${err?.message ?? String(err)}`);
    }
  }

  if (!v2 && !v1) {
    errors.push("Neither an ID3v2 header nor a trailing ID3v1 tag was found in this file.");
  }

  return {
    kind: "audio",
    container,
    fields: interpretId3Tags(v2, v1),
    timestamps: [],
    raw: [],
    errors,
    cannotDetermine: cannotDetermineFor("audio"),
    method: "ID3v2 header walk (version-aware frame-size decoding) over the file's start, plus a trailing 128-byte ID3v1 tag read as a fallback.",
    extractedAt,
  };
}

// ─── EBML / WebM / MKV (Matroska) ──────────────────────────────────────────

/** Segment/Info is one of the first elements a real Matroska/WebM muxer writes, right after the EBML header — this scan window is comfortably enough without loading a large video fully into memory. */
const EBML_SCAN_BYTES = 16 * 1024 * 1024;

export async function readEbmlProvenance(file: Blob, container: ContainerIdentity, extractedAt: string): Promise<FileProvenanceReport> {
  const bytes = new Uint8Array(await file.slice(0, Math.min(EBML_SCAN_BYTES, file.size)).arrayBuffer());
  const ebml = parseEbmlContainer(bytes);
  const errors: string[] = [];
  if (!ebml) {
    errors.push(
      `No Segment/Info element was found within the first ${EBML_SCAN_BYTES / (1024 * 1024)}MB scanned. ` +
        "Real Matroska/WebM files almost always write it near the start; its absence here may mean this file's Segment uses an unusually large preceding element, or the file is otherwise unusual.",
    );
  }
  return {
    kind: "video",
    container,
    fields: interpretEbmlContainer(ebml),
    timestamps: [],
    raw: [],
    errors,
    cannotDetermine: cannotDetermineFor("video"),
    method: `EBML element walk over the first ${(bytes.length / (1024 * 1024)).toFixed(1)}MB of the file, looking for Segment/Info (MuxingApp, WritingApp, Title, DateUTC).`,
    extractedAt,
  };
}

// ─── OLE2 / CFBF (legacy .doc/.xls/.ppt) ───────────────────────────────────

const MAX_CFBF_BYTES = 100 * 1024 * 1024;
/** Real presence of this stream inside an OLE2 wrapper is exactly what distinguishes a password-protected OOXML file (MS-OFFCRYPTO) from a genuine legacy binary document — both sniff as "ole2" from magic bytes alone. */
const OFFCRYPTO_STREAM_NAME = "EncryptedPackage";

export async function readCfbfProvenance(file: Blob, container: ContainerIdentity, extractedAt: string): Promise<FileProvenanceReport> {
  if (file.size > MAX_CFBF_BYTES) {
    return unsupportedReport(container, extractedAt, [
      `This file is ${(file.size / (1024 * 1024)).toFixed(0)}MB, over the ${MAX_CFBF_BYTES / (1024 * 1024)}MB limit for in-browser CFBF parsing. It was not opened.`,
    ]);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!parseCfbfHeader(bytes)) {
    return unsupportedReport(container, extractedAt, [
      "This file's OLE2 signature matched, but its header could not be read as a well-formed Compound File.",
    ]);
  }

  const encryptedPackage = readCfbfStream(bytes, OFFCRYPTO_STREAM_NAME);
  if (encryptedPackage) {
    return {
      kind: "unsupported",
      container,
      fields: [],
      timestamps: [],
      raw: [],
      errors: [],
      cannotDetermine: [
        "This is a password-protected OOXML file (MS-OFFCRYPTO): its real .docx/.xlsx/.pptx content is stored encrypted inside this OLE2 wrapper, under an \"EncryptedPackage\" stream. Decrypting it needs the document's own password, which this tool does not have and does not ask for.",
      ],
      method: "OLE2/CFBF stream walk found an \"EncryptedPackage\" stream, identifying this as password-protected OOXML rather than a legacy binary document.",
      extractedAt,
    };
  }

  const summaryBytes = readCfbfStream(bytes, "\x05SummaryInformation");
  const docSummaryBytes = readCfbfStream(bytes, "\x05DocumentSummaryInformation");
  const errors: string[] = [];
  if (!summaryBytes && !docSummaryBytes) {
    errors.push("Neither \\x05SummaryInformation nor \\x05DocumentSummaryInformation streams were found in this file.");
  }

  const summary = summaryBytes ? parseOlepsPropertySet(summaryBytes) : null;
  const docSummary = docSummaryBytes ? parseOlepsPropertySet(docSummaryBytes) : null;
  if (summaryBytes && !summary) errors.push("The \\x05SummaryInformation stream was found but could not be parsed as a valid property set.");
  if (docSummaryBytes && !docSummary) errors.push("The \\x05DocumentSummaryInformation stream was found but could not be parsed as a valid property set.");

  const { fields, timestamps } = interpretCfbfDocument({ summary, docSummary });

  return {
    kind: "ooxml", // reuses the same disclosure/cannotDetermine text as OOXML — same class of self-reported, editable metadata, just an older binary container
    container,
    fields,
    timestamps,
    raw: [],
    errors,
    cannotDetermine: [
      OOXML_ABSENCE_NOTE,
      "Whether this document has been edited since these properties were last written — revision/track-changes history is not read.",
      "Whether a VBA macro project is present or what it contains.",
    ],
    method:
      "OLE2/CFBF sector-chain walk (following the FAT and, for small streams, the mini-FAT) to " +
      "\\x05SummaryInformation and \\x05DocumentSummaryInformation, then MS-OLEPS property-set " +
      "parsing of their contents.",
    extractedAt,
  };
}

// ─── Images — reuses Module 4's existing EXIF/C2PA extraction verbatim ────

export async function readImageProvenance(
  file: Blob,
  container: ContainerIdentity,
  extractedAt: string,
): Promise<FileProvenanceReport> {
  const errors: string[] = [];
  const fields: ProvenanceField[] = [];

  try {
    const exif = await readExif(file);
    for (const f of exif.findings) {
      fields.push({
        id: `exif.${f.id}`,
        label: f.label,
        value: f.value === "absent" ? null : f.value,
        status: f.value === "absent" ? "absent" : "present",
        origin: "EXIF/TIFF/XMP (exifr)",
        note: f.note,
        severity: f.severity,
      });
    }
  } catch (err: any) {
    errors.push(`EXIF could not be read: ${err?.message ?? String(err)}`);
  }

  try {
    const c2pa = await readC2pa(file);
    fields.push({
      id: "c2pa.status",
      label: "Content Credentials (C2PA)",
      value: c2pa.status === "absent" ? null : c2pa.status,
      status: c2pa.status === "absent" ? "absent" : "present",
      origin: "C2PA manifest (contentauth WASM)",
      note: c2pa.summary,
      severity: c2pa.status === "valid" || c2pa.status === "invalid" ? "notable" : "info",
    });
  } catch (err: any) {
    errors.push(`Content Credentials could not be read: ${err?.message ?? String(err)}`);
  }

  // Only JPEG and PNG have a well-defined end marker this tool knows how to
  // walk (see parseJpegTrailer/parsePngTrailer's own doc comments) — GIF,
  // WebP and other sniffed kinds are silently skipped rather than guessed at.
  if (container.kind === "image-jpeg" || container.kind === "image-png") {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const info = container.kind === "image-jpeg" ? parseJpegTrailer(bytes) : parsePngTrailer(bytes);
      const trailingHead = info && info.trailingByteCount > 0 ? bytes.slice(info.endOffset, info.endOffset + SNIFF_HEAD_BYTES) : null;
      fields.push(interpretTrailingData(container.kind === "image-jpeg" ? "JPEG" : "PNG", info, trailingHead));
    } catch (err: any) {
      errors.push(`Trailing-data check could not complete: ${err?.message ?? String(err)}`);
    }
  }

  return {
    kind: "image",
    container,
    fields,
    timestamps: [],
    raw: [],
    errors,
    cannotDetermine: cannotDetermineFor("image"),
    method:
      "Reuses Module 4's existing EXIF (exifr) and C2PA (contentauth WASM) extraction verbatim, plus a byte-level " +
      "walk to the image's real end marker (JPEG EOI / PNG IEND) to detect data appended past it. For the full " +
      "analysis — including pHash near-duplicate matching against the collected corpus — continue in Image Intelligence.",
    extractedAt,
  };
}

export { assessFileProvenance };
