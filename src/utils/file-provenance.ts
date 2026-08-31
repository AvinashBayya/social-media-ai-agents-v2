/**
 * File provenance forensics — pure layer, for PDF / Word (OOXML) / ODF / video
 * containers (PS-18 §6.4, extending Module 4's existing image forensics).
 *
 * SAME PHILOSOPHY AS imaging.ts: provenance over classification. Nothing here
 * is cryptographically verified the way a C2PA signature is — every field is
 * self-reported by the application that wrote the file and is editable with
 * ordinary, freely available tools. That is stated on every report, not left
 * to a footnote.
 *
 * ABSENCE VS UNREADABLE. Every field carries a `status`: "present" (a real
 * value was found), "absent" (the file genuinely does not carry this field —
 * rendered as literal "not embedded", never blank), or "unreadable" (an
 * attempt to read it failed — rendered with the real cause). Confusing these
 * two would be exactly the fabrication class CLAUDE.md forbids: a failed read
 * is NOT the same finding as a field that was never populated.
 *
 * NO INVENTED PRECISION. A date-only value (e.g. a PDF "D:20240302" with no
 * time component) is never rendered as though it recorded a specific second,
 * and a timestamp with no recorded UTC offset is never silently assigned one
 * — mirrors `readExifCaptureTime`'s contract in imaging.ts for the identical
 * problem with EXIF capture times.
 *
 * This file is PURE: no DOM, no network, no dynamic imports, no `new Date()`
 * calls of its own (callers thread `extractedAt` in, matching this project's
 * "now lives at the edge" convention elsewhere — e.g. `buildSocialContext`'s
 * `now` parameter — so every function here stays deterministic and directly
 * testable under `bun test`, which has no DOM/Date shims). Browser-only work
 * — pdf-lib, fflate, `<video>` decoding — lives in file-provenance-client.ts,
 * which imports this and never the reverse.
 */

import type { Gap } from "./imaging";

// ─── Shared field/report shapes ────────────────────────────────────────────

export type FieldStatus = "present" | "absent" | "unreadable";

export interface ProvenanceField {
  id: string;
  label: string;
  value: string | null;
  status: FieldStatus;
  /** Exactly where this value came from, so an analyst can verify it themselves. */
  origin: string;
  /** What this observation does and does not support. */
  note: string;
  severity: "info" | "notable";
}

export type TimestampPrecision = "year" | "month" | "day" | "minute" | "second" | null;

export interface ProvenanceTimestamp {
  id: string;
  label: string;
  /** The value exactly as recorded in the file. */
  raw: string;
  /** Normalised wall-clock reading, e.g. "2024-03-01 10:30:00". Never Z-suffixed. */
  local: string | null;
  /** UTC offset the file recorded, e.g. "+05:30". Null when none was recorded. */
  offset: string | null;
  /** Absolute instant, ISO 8601 — ONLY when an offset was actually recorded. */
  absolute: string | null;
  /** How much of the value was actually present — never finer than what was recorded. */
  precision: TimestampPrecision;
  note: string;
}

export type ContainerKind =
  | "pdf"
  | "zip-unknown"
  | "ole2"
  | "image-jpeg"
  | "image-png"
  | "iso-bmff"
  | "iso-bmff-heif"
  | "ebml"
  | "riff-avi"
  | "riff-wave"
  | "riff-webp"
  | "gif"
  | "mp3"
  | "unknown";

export interface ContainerIdentity {
  kind: ContainerKind;
  declaredType: string;
  fileName: string;
  extension: string | null;
  /** True when the magic bytes disagree with what the extension/declared type implies. */
  mismatch: boolean;
  mismatchNote: string | null;
}

export type FileProvenanceKind = "pdf" | "ooxml" | "odf" | "image" | "video" | "audio" | "unsupported";

/**
 * One PDF signature's leaf/issuer certificate DER bytes, carried forward
 * from `readPdfProvenance`'s internal `verifyDetachedCms` result so the UI
 * can offer the opt-in Signature Revocation Check (pdf-revocation-client.ts)
 * without re-parsing the PDF or its CMS structure a second time. Present
 * only when BOTH certificates were actually resolved (a "valid" signature
 * with a known issuer) — never guessed or partially populated.
 */
export interface PdfSignatureCertificatePair {
  /** Matches the index used in the signature's own field ids/labels (`pdf.signature.{n}...`), so the UI can associate a revocation-check action with the right signature block. */
  signatureIndex: number;
  leafDer: Uint8Array;
  issuerDer: Uint8Array;
}

export interface FileProvenanceReport {
  kind: FileProvenanceKind;
  container: ContainerIdentity;
  fields: ProvenanceField[];
  timestamps: ProvenanceTimestamp[];
  /** View-only raw dumps (XMP packet, core.xml, ...) — never persisted, see evidence-store.ts. */
  raw: { label: string; text: string }[];
  /** Hard read failures — distinct from a field's own "unreadable" status. */
  errors: string[];
  cannotDetermine: string[];
  method: string;
  extractedAt: string;
  /** PDF only. One entry per signature whose leaf AND issuer certificate were both resolved — see PdfSignatureCertificatePair. */
  signatureCertificates?: PdfSignatureCertificatePair[];
}

function fieldFor(
  id: string,
  label: string,
  value: string | null,
  origin: string,
  note: string,
  severity: "info" | "notable" = "info",
): ProvenanceField {
  return { id, label, value: value ?? null, status: value ? "present" : "absent", origin, note, severity };
}

function unreadableField(id: string, label: string, origin: string, reason: string): ProvenanceField {
  return {
    id,
    label,
    value: null,
    status: "unreadable",
    origin,
    note: `Could not be read: ${reason}`,
    severity: "info",
  };
}

// ─── XML entity decoding + a small hand-written scanner ────────────────────
//
// No DOMParser here — confirmed unavailable under `bun test`, and jsdom is
// deliberately kept server-only elsewhere in this codebase
// (identity-websearch.ts). XMP/OOXML/ODF are all simple enough that a
// regex-based scanner is sufficient and stays testable without a DOM.

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&"); // must run last, or a literal "&amp;lt;" would double-decode
}

/** Match either `<prefix:local>text</prefix:local>` or a bare `<local>text</local>`. */
function extractSimpleTag(xml: string, prefixes: string[], localName: string): string | null {
  for (const p of prefixes) {
    const tag = p ? `${p}:${localName}` : localName;
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`);
    const m = re.exec(xml);
    if (m) {
      const text = m[1].trim();
      return text ? decodeXmlEntities(text) : null;
    }
  }
  return null;
}

// ─── PDF date parsing ───────────────────────────────────────────────────────
//
// PDF spec date string: D:YYYYMMDDHHmmSSOHH'mm' — every component after YYYY
// is optional (a legal truncation, not a malformed value), and the offset
// (O) is '+', '-' or 'Z'. Getting this wrong two ways is easy: treating a
// date-only value as midnight-UTC invents both a time and a timezone that
// were never in the file, and assuming a missing "D:" prefix makes a date
// unparseable rejects real files (some writers omit it).

const PDF_DATE_RE =
  /^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:([Z+-])(\d{2})?'?(\d{2})?'?)?$/;

export function parsePdfDate(id: string, label: string, origin: string, raw: string): ProvenanceTimestamp {
  const trimmed = raw.trim();
  const m = PDF_DATE_RE.exec(trimmed);
  if (!m) {
    return {
      id,
      label,
      raw: trimmed,
      local: null,
      offset: null,
      absolute: null,
      precision: null,
      note:
        "This date could not be parsed as a PDF date string (expected D:YYYYMMDDHHmmSS with an " +
        "optional ±HH'mm' offset). Shown exactly as recorded rather than guessed at.",
    };
  }

  const [, y, mo, d, h, mi, s, tzSign, tzH, tzM] = m;
  let precision: TimestampPrecision = "year";
  if (mo) precision = "month";
  if (mo && d) precision = "day";
  if (mo && d && h && mi) precision = "minute";
  if (mo && d && h && mi && s) precision = "second";

  const local =
    `${y}-${mo ?? "01"}-${d ?? "01"} ${h ?? "00"}:${mi ?? "00"}:${s ?? "00"}`;

  let offset: string | null = null;
  if (tzSign === "Z") offset = "+00:00";
  else if (tzSign === "+" || tzSign === "-") offset = `${tzSign}${tzH ?? "00"}:${tzM ?? "00"}`;

  let absolute: string | null = null;
  if (offset) {
    const dt = new Date(`${local.replace(" ", "T")}${offset}`);
    absolute = Number.isFinite(dt.getTime()) ? dt.toISOString() : null;
  }

  const note = offset
    ? "The file records a UTC offset, so this is an absolute instant."
    : precision === "year" || precision === "month" || precision === "day"
      ? `Only ${precision}-level precision was recorded — the time-of-day shown is a placeholder for ` +
        `display and was not in the file.`
      : "No UTC offset was recorded. This is a wall-clock reading with no known timezone and must " +
        "not be compared against an event time without establishing which zone it was written in.";

  return { id, label, raw: trimmed, local, offset, absolute, precision, note };
}

// ─── XMP packet parsing (shared by PDF and video) ──────────────────────────

const XMP_NAMESPACES: Record<string, string> = {
  xmp: "http://ns.adobe.com/xap/1.0/",
  xap: "http://ns.adobe.com/xap/1.0/", // Adobe binds the XAP namespace to both prefixes depending on vintage
  dc: "http://purl.org/dc/elements/1.1/",
  pdf: "http://ns.adobe.com/pdf/1.3/",
  xmpMM: "http://ns.adobe.com/xap/1.0/mm/",
  stEvt: "http://ns.adobe.com/xap/1.0/sType/ResourceEvent#",
};

export interface XmpHistoryEvent {
  action: string;
  softwareAgent: string | null;
  when: string | null;
}

export interface XmpProperties {
  values: Record<string, string | string[] | null>;
  documentId: string | null;
  originalDocumentId: string | null;
  history: XmpHistoryEvent[];
}

function extractLiValues(inner: string): string[] | null {
  if (!/<rdf:(Alt|Seq|Bag)/.test(inner)) return null;
  const liRe = /<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/g;
  const out: string[] = [];
  let lm: RegExpExecArray | null;
  while ((lm = liRe.exec(inner))) out.push(decodeXmlEntities(lm[1].trim()));
  return out;
}

/**
 * Parse an XMP packet. Handles the three real-world complications a naive
 * `<xmp:CreatorTool>` regex gets wrong: namespace prefixes are not fixed
 * (scanned from the doc's own xmlns declarations, falling back to the
 * conventional binding), properties may appear as attributes rather than
 * elements, and multi-value properties are wrapped in rdf:Alt/Seq/Bag.
 */
export function parseXmpPacket(xml: string): XmpProperties {
  const prefixToUri: Record<string, string> = {};
  const nsDeclRe = /xmlns:([a-zA-Z0-9_]+)\s*=\s*"([^"]*)"/g;
  let nm: RegExpExecArray | null;
  while ((nm = nsDeclRe.exec(xml))) prefixToUri[nm[1]] = nm[2];

  function prefixesForUri(uri: string): string[] {
    const found = Object.entries(prefixToUri)
      .filter(([, u]) => u === uri)
      .map(([p]) => p);
    if (found.length) return found;
    return Object.entries(XMP_NAMESPACES)
      .filter(([, u]) => u === uri)
      .map(([p]) => p);
  }

  function findProperty(uri: string, localName: string): string | string[] | null {
    for (const prefix of prefixesForUri(uri)) {
      const elRe = new RegExp(`<${prefix}:${localName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${prefix}:${localName}>`);
      const elMatch = elRe.exec(xml);
      if (elMatch) {
        const liValues = extractLiValues(elMatch[1]);
        if (liValues) return liValues.length === 1 ? liValues[0] : liValues;
        const text = elMatch[1].trim();
        return text ? decodeXmlEntities(text) : null;
      }
      const attrRe = new RegExp(`\\b${prefix}:${localName}\\s*=\\s*"([^"]*)"`);
      const attrMatch = attrRe.exec(xml);
      if (attrMatch) return decodeXmlEntities(attrMatch[1]);
    }
    return null;
  }

  const fieldDefs: [string, string, string][] = [
    ["xmp:CreatorTool", XMP_NAMESPACES.xmp, "CreatorTool"],
    ["xmp:CreateDate", XMP_NAMESPACES.xmp, "CreateDate"],
    ["xmp:ModifyDate", XMP_NAMESPACES.xmp, "ModifyDate"],
    ["xmp:MetadataDate", XMP_NAMESPACES.xmp, "MetadataDate"],
    ["dc:creator", XMP_NAMESPACES.dc, "creator"],
    ["dc:title", XMP_NAMESPACES.dc, "title"],
    ["pdf:Producer", XMP_NAMESPACES.pdf, "Producer"],
    ["xmpMM:DocumentID", XMP_NAMESPACES.xmpMM, "DocumentID"],
    ["xmpMM:OriginalDocumentID", XMP_NAMESPACES.xmpMM, "OriginalDocumentID"],
  ];
  const values: Record<string, string | string[] | null> = {};
  for (const [key, uri, local] of fieldDefs) values[key] = findProperty(uri, local);

  const documentId = typeof values["xmpMM:DocumentID"] === "string" ? (values["xmpMM:DocumentID"] as string) : null;
  const originalDocumentId =
    typeof values["xmpMM:OriginalDocumentID"] === "string" ? (values["xmpMM:OriginalDocumentID"] as string) : null;

  const history: XmpHistoryEvent[] = [];
  const historyBlock = /<xmpMM:History>([\s\S]*?)<\/xmpMM:History>/.exec(xml);
  if (historyBlock) {
    // rdf:li entries here are commonly self-closing with stEvt:* as
    // attributes (the real form Adobe tools write), but the element form
    // with nested <stEvt:action>text</stEvt:action> children also occurs —
    // handle both. The optional trailing group only fires for a genuine
    // open/close pair; for a self-closing `<rdf:li .../>` it stays empty
    // rather than reaching forward into a later, unrelated li's content.
    const eventRe = /<rdf:li\b([^>]*?)(\/)?>(?:([\s\S]*?)<\/rdf:li>)?/g;
    let em: RegExpExecArray | null;
    while ((em = eventRe.exec(historyBlock[1]))) {
      const attrs = em[1] ?? "";
      const inner = em[2] ? "" : (em[3] ?? "");
      const block = `${attrs} ${inner}`;
      const action =
        /stEvt:action\s*=\s*"([^"]*)"/.exec(block)?.[1] ??
        /<stEvt:action>([^<]*)<\/stEvt:action>/.exec(block)?.[1] ??
        "unspecified";
      const agent =
        /stEvt:softwareAgent\s*=\s*"([^"]*)"/.exec(block)?.[1] ??
        /<stEvt:softwareAgent>([^<]*)<\/stEvt:softwareAgent>/.exec(block)?.[1] ??
        null;
      const when =
        /stEvt:when\s*=\s*"([^"]*)"/.exec(block)?.[1] ??
        /<stEvt:when>([^<]*)<\/stEvt:when>/.exec(block)?.[1] ??
        null;
      history.push({
        action: decodeXmlEntities(action),
        softwareAgent: agent ? decodeXmlEntities(agent) : null,
        when,
      });
    }
  }

  return { values, documentId, originalDocumentId, history };
}

// ─── PDF Info dictionary interpretation ────────────────────────────────────

const PDF_STANDARD_KEYS = ["Title", "Author", "Subject", "Keywords", "Creator", "Producer", "Trapped"];

export interface PdfInterpretContext {
  isEncrypted: boolean;
  pageCount: number | null;
  signatureFieldCount: number;
}

export function interpretPdfInfoDict(entries: Record<string, string>, ctx: PdfInterpretContext): ProvenanceField[] {
  const fields: ProvenanceField[] = [];
  const get = (k: string) => (entries[k]?.trim() ? entries[k].trim() : null);

  fields.push(
    fieldFor(
      "pdf.author",
      "Author",
      get("Author"),
      "PDF Info dictionary /Author",
      "The document author as recorded by the authoring application. Self-reported and editable " +
        "— treat as a claim, not a verified identity.",
      "notable",
    ),
  );
  fields.push(
    fieldFor(
      "pdf.creator",
      "Creator (authoring application)",
      get("Creator"),
      "PDF Info dictionary /Creator",
      'The application that authored the SOURCE document (e.g. "Microsoft Word", "LaTeX with ' +
        'hyperref"), not the tool that wrote these PDF bytes — that is Producer, below.',
    ),
  );
  fields.push(
    fieldFor(
      "pdf.producer",
      "Producer (PDF-writing library)",
      get("Producer"),
      "PDF Info dictionary /Producer",
      'The library that wrote the PDF file itself (e.g. "Skia/PDF m120" means printed from ' +
        'Chrome, "Acrobat Distiller" or "Ghostscript" means processed through those tools). ' +
        "Different from Creator above, and the more reliable signal for how the PDF bytes " +
        "themselves were produced.",
      "notable",
    ),
  );
  fields.push(fieldFor("pdf.title", "Title", get("Title"), "PDF Info dictionary /Title", "Document title metadata."));
  fields.push(
    fieldFor("pdf.subject", "Subject", get("Subject"), "PDF Info dictionary /Subject", "Document subject metadata."),
  );
  fields.push(
    fieldFor(
      "pdf.keywords",
      "Keywords",
      get("Keywords"),
      "PDF Info dictionary /Keywords",
      "Keyword metadata as entered by the authoring application.",
    ),
  );

  const extraKeys = Object.keys(entries).filter(
    (k) => !PDF_STANDARD_KEYS.includes(k) && k !== "CreationDate" && k !== "ModDate",
  );
  for (const key of extraKeys.sort()) {
    fields.push({
      id: `pdf.extra.${key}`,
      label: `Additional entry: /${key}`,
      value: entries[key],
      status: "present",
      origin: `PDF Info dictionary /${key}`,
      note:
        "A non-standard Info dictionary entry. Some authoring tools record extra organisational " +
        'or workflow metadata here — Microsoft Word, for example, writes /Company.',
      severity: "notable",
    });
  }

  if (ctx.isEncrypted) {
    fields.push({
      id: "pdf.encrypted",
      label: "Encryption",
      value: "Encrypted",
      status: "present",
      origin: "PDF trailer /Encrypt",
      note:
        "This PDF is encrypted. String values in the Info dictionary are not decrypted by this " +
        "tool, so any values shown above may be ciphertext rather than real metadata — treat " +
        "them as unreliable until confirmed against a password-aware reader.",
      severity: "notable",
    });
  }

  if (ctx.signatureFieldCount > 0) {
    fields.push({
      id: "pdf.signatures",
      label: "Digital signature fields",
      value: String(ctx.signatureFieldCount),
      status: "present",
      origin: "PDF /AcroForm /Fields with /FT /Sig",
      note:
        `This PDF contains ${ctx.signatureFieldCount} digital signature field(s). Signed fields ` +
        "(with a /V value) are cryptographically checked below — see each \"Signature N — " +
        "cryptographic validity\" field. An unsigned placeholder field carries no such check, " +
        "since there is nothing yet to verify.",
      severity: "notable",
    });
  }

  return fields;
}

export function interpretPdfDates(entries: Record<string, string>): ProvenanceTimestamp[] {
  const out: ProvenanceTimestamp[] = [];
  if (entries.CreationDate?.trim()) {
    out.push(parsePdfDate("pdf.created", "Created", "PDF Info dictionary /CreationDate", entries.CreationDate));
  }
  if (entries.ModDate?.trim()) {
    out.push(parsePdfDate("pdf.modified", "Modified", "PDF Info dictionary /ModDate", entries.ModDate));
  }
  return out;
}

// ─── PDF hidden actions / embedded files ───────────────────────────────────
//
// pdf-lib's object model is the only PDF access point this codebase has (see
// this file's own header) — walking `/OpenAction`, `/AA`, the `/Names`
// JavaScript/EmbeddedFiles trees and every indirect object for an action
// dictionary all require pdf-lib's `PDFDict`/`PDFName`/`enumerateIndirectObjects`,
// so that walk lives in file-provenance-client.ts. This section only turns
// the PLAIN DATA that walk extracts into fields — same split as everywhere
// else in this file (`interpretPdfInfoDict` takes a plain Record, not a
// pdf-lib object).
//
// What this deliberately does NOT do: determine what an extracted JavaScript
// action actually DOES when run (no JS interpreter/sandbox here — the source
// is surfaced verbatim for a human to read, never executed), and no VBA
// decompilation for the OOXML macro check below. Both are named explicitly
// in FILE_PROVENANCE_NOT_IMPLEMENTED.

export interface PdfEmbeddedFileInfo {
  /** The file specification's declared name (/F or /UF), or null if the dictionary omitted one. */
  name: string | null;
  byteLength: number;
  /** SHA-256 of the embedded stream's raw bytes, for the analyst to independently match/search — null if hashing failed. */
  sha256: string | null;
}

export interface PdfHiddenActionsSummary {
  /** False only for an encrypted PDF, where action dictionaries and streams are not decrypted by this tool and the object graph is deliberately not walked — never claim "checked, none found" over ciphertext. */
  checked: boolean;
  hasOpenAction: boolean;
  /** Extracted /JS source strings, one per JavaScript action found anywhere in the document (catalog /OpenAction, /AA, or the /Names/JavaScript tree). */
  javascriptActions: string[];
  launchActionCount: number;
  submitFormActionCount: number;
  importDataActionCount: number;
  embeddedFiles: PdfEmbeddedFileInfo[];
  /** Count of raw "%%EOF" markers in the file's bytes — more than one means incremental updates exist; earlier revisions can remain physically present even after content is deleted in the current view. Measured by a raw byte scan independent of encryption, so this one field stays meaningful even when `checked` is false. */
  incrementalUpdateCount: number;
}

/** Raw byte scan for PDF's `%%EOF` end-of-update marker — deliberately independent of pdf-lib's object model, since pdf-lib resolves to the LATEST revision and has no reason to expose how many revisions preceded it. */
export function countPdfEofMarkers(bytes: Uint8Array): number {
  const marker = [0x25, 0x25, 0x45, 0x4f, 0x46]; // "%%EOF"
  let count = 0;
  for (let i = 0; i + marker.length <= bytes.length; i += 1) {
    if (bytesEqual(bytes, i, marker)) count += 1;
  }
  return count;
}

export function interpretPdfHiddenActions(summary: PdfHiddenActionsSummary): { fields: ProvenanceField[]; raw: { label: string; text: string }[] } {
  const fields: ProvenanceField[] = [];
  const raw: { label: string; text: string }[] = [];

  if (!summary.checked) {
    fields.push({
      id: "pdf.hiddenActions",
      label: "Hidden actions / embedded files",
      value: "Not checked",
      status: "unreadable",
      origin: "Document object graph (skipped for encrypted PDFs)",
      note:
        "This PDF is encrypted — action dictionaries and embedded file streams are not decrypted by this tool, " +
        "so /OpenAction, JavaScript, launch, form-submission and embedded-file detection were not attempted " +
        "rather than risk reporting ciphertext as though it were real content.",
      severity: "notable",
    });
    fields.push(incrementalUpdatesField(summary.incrementalUpdateCount));
    return { fields, raw };
  }

  fields.push({
    id: "pdf.openAction",
    label: "Auto-run action on open",
    value: summary.hasOpenAction ? "This PDF declares an /OpenAction that runs automatically when the file is opened." : null,
    status: summary.hasOpenAction ? "present" : "absent",
    origin: "Document Catalog /OpenAction entry",
    note: summary.hasOpenAction
      ? "The most consequential of these checks: unlike the other actions below, this one requires no click — a compliant reader runs it on open. See the JavaScript/launch/form-action fields for what it actually does, if determinable."
      : "Checked: the document catalog carries no /OpenAction entry.",
    severity: summary.hasOpenAction ? "notable" : "info",
  });

  fields.push({
    id: "pdf.javascript",
    label: "Embedded JavaScript",
    value: summary.javascriptActions.length ? `${summary.javascriptActions.length} JavaScript action(s) found` : null,
    status: summary.javascriptActions.length ? "present" : "absent",
    origin: "Action dictionaries with /S /JavaScript, found anywhere in the document's object graph",
    note: summary.javascriptActions.length
      ? "Source extracted verbatim below, not executed or evaluated by this tool — read it directly to determine intent."
      : "Checked: no /S /JavaScript action dictionary found anywhere in the document.",
    severity: summary.javascriptActions.length ? "notable" : "info",
  });
  summary.javascriptActions.forEach((source, i) => {
    raw.push({ label: `PDF JavaScript action ${i + 1}`, text: source });
  });

  fields.push({
    id: "pdf.launchAction",
    label: "Launch action (runs an external program/file)",
    value: summary.launchActionCount > 0 ? `${summary.launchActionCount} /Launch action(s) found` : null,
    status: summary.launchActionCount > 0 ? "present" : "absent",
    origin: "Action dictionaries with /S /Launch, found anywhere in the document's object graph",
    note: summary.launchActionCount > 0
      ? "A /Launch action tells a compliant reader to open an external file or program — one of the highest-risk PDF action types."
      : "Checked: no /S /Launch action dictionary found anywhere in the document.",
    severity: summary.launchActionCount > 0 ? "notable" : "info",
  });

  const formActionCount = summary.submitFormActionCount + summary.importDataActionCount;
  fields.push({
    id: "pdf.formDataActions",
    label: "Form submit/import actions",
    value: formActionCount > 0
      ? `${summary.submitFormActionCount} /SubmitForm, ${summary.importDataActionCount} /ImportData action(s) found`
      : null,
    status: formActionCount > 0 ? "present" : "absent",
    origin: "Action dictionaries with /S /SubmitForm or /S /ImportData, found anywhere in the document's object graph",
    note: formActionCount > 0
      ? "/SubmitForm can send form field data to a URL without an explicit save/export step — this reports its presence, not the destination's trustworthiness."
      : "Checked: no /S /SubmitForm or /S /ImportData action dictionary found anywhere in the document.",
    severity: formActionCount > 0 ? "notable" : "info",
  });

  fields.push({
    id: "pdf.embeddedFiles",
    label: "Embedded files",
    value: summary.embeddedFiles.length
      ? summary.embeddedFiles.map((f) => `${f.name ?? "(unnamed)"} (${f.byteLength} bytes)`).join(", ")
      : null,
    status: summary.embeddedFiles.length ? "present" : "absent",
    origin: "File specification dictionaries reachable via /Names/EmbeddedFiles or an annotation's /FS entry",
    note: summary.embeddedFiles.length
      ? "A PDF can carry an arbitrary attached file that never renders on any page and is only visible in a reader's " +
        "attachments panel. SHA-256 hashes are given so an analyst can independently search for or compare the " +
        "attached content without re-extracting it from this file."
      : "Checked: no embedded file attachments found.",
    severity: summary.embeddedFiles.length ? "notable" : "info",
  });

  fields.push(incrementalUpdatesField(summary.incrementalUpdateCount));

  return { fields, raw };
}

function incrementalUpdatesField(incrementalUpdateCount: number): ProvenanceField {
  return {
    id: "pdf.incrementalUpdates",
    label: "Incremental updates (revision markers)",
    value: `${incrementalUpdateCount} "%%EOF" marker(s) found in the file`,
    status: "present",
    origin: "Raw byte scan for the PDF end-of-update marker, independent of encryption or which revision pdf-lib resolves to",
    note: incrementalUpdateCount > 1
      ? "More than one \"%%EOF\" marker means this file has been incrementally updated at least once. PDF's " +
        "incremental-update model can leave earlier content — including text or objects since deleted from the " +
        "visible document — physically present in the file's bytes, recoverable by anyone who reads the whole " +
        "file rather than just its latest revision. This tool reports the count only, not the earlier revisions' content."
      : "A single \"%%EOF\" marker is the normal case — this file was written once, with no incremental updates layered on top.",
    severity: incrementalUpdateCount > 1 ? "notable" : "info",
  };
}

// ─── OOXML (.docx/.xlsx/.pptx) and ODF (.odt/.ods/.odp) ────────────────────

export interface OoxmlCoreProps {
  title: string | null;
  subject: string | null;
  creator: string | null;
  keywords: string | null;
  description: string | null;
  lastModifiedBy: string | null;
  revision: string | null;
  created: string | null;
  modified: string | null;
  lastPrinted: string | null;
  category: string | null;
  contentStatus: string | null;
}

export function parseOoxmlCoreProps(xml: string): OoxmlCoreProps {
  return {
    title: extractSimpleTag(xml, ["dc"], "title"),
    subject: extractSimpleTag(xml, ["dc"], "subject"),
    creator: extractSimpleTag(xml, ["dc"], "creator"),
    keywords: extractSimpleTag(xml, ["cp"], "keywords"),
    description: extractSimpleTag(xml, ["dc"], "description"),
    lastModifiedBy: extractSimpleTag(xml, ["cp"], "lastModifiedBy"),
    revision: extractSimpleTag(xml, ["cp"], "revision"),
    created: extractSimpleTag(xml, ["dcterms"], "created"),
    modified: extractSimpleTag(xml, ["dcterms"], "modified"),
    lastPrinted: extractSimpleTag(xml, ["cp"], "lastPrinted"),
    category: extractSimpleTag(xml, ["cp"], "category"),
    contentStatus: extractSimpleTag(xml, ["cp"], "contentStatus"),
  };
}

export interface OoxmlAppProps {
  application: string | null;
  appVersion: string | null;
  company: string | null;
  manager: string | null;
  template: string | null;
  totalTime: string | null;
  pages: string | null;
  words: string | null;
  characters: string | null;
}

export function parseOoxmlAppProps(xml: string): OoxmlAppProps {
  return {
    application: extractSimpleTag(xml, [""], "Application"),
    appVersion: extractSimpleTag(xml, [""], "AppVersion"),
    company: extractSimpleTag(xml, [""], "Company"),
    manager: extractSimpleTag(xml, [""], "Manager"),
    template: extractSimpleTag(xml, [""], "Template"),
    totalTime: extractSimpleTag(xml, [""], "TotalTime"),
    pages: extractSimpleTag(xml, [""], "Pages"),
    words: extractSimpleTag(xml, [""], "Words"),
    characters: extractSimpleTag(xml, [""], "Characters"),
  };
}

export function parseOoxmlCustomProps(xml: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  const propRe = /<property[^>]*\bname="([^"]*)"[^>]*>([\s\S]*?)<\/property>/g;
  let m: RegExpExecArray | null;
  while ((m = propRe.exec(xml))) {
    const name = decodeXmlEntities(m[1]);
    const valMatch = /<vt:\w+>([\s\S]*?)<\/vt:\w+>/.exec(m[2]);
    const value = valMatch ? decodeXmlEntities(valMatch[1].trim()) : m[2].trim();
    if (name && value) out.push({ name, value });
  }
  return out;
}

export interface OdfMeta {
  initialCreator: string | null;
  creator: string | null;
  generator: string | null;
  editingCycles: string | null;
  editingDuration: string | null;
  date: string | null;
  creationDate: string | null;
}

export function parseOdfMeta(xml: string): OdfMeta {
  return {
    initialCreator: extractSimpleTag(xml, ["meta"], "initial-creator"),
    creator: extractSimpleTag(xml, ["dc"], "creator"),
    generator: extractSimpleTag(xml, ["meta"], "generator"),
    editingCycles: extractSimpleTag(xml, ["meta"], "editing-cycles"),
    editingDuration: extractSimpleTag(xml, ["meta"], "editing-duration"),
    date: extractSimpleTag(xml, ["dc"], "date"),
    creationDate: extractSimpleTag(xml, ["meta"], "creation-date"),
  };
}

export const OOXML_ABSENCE_NOTE =
  "dc:creator and similar fields are the Office/OS user display name configured on the machine " +
  "that wrote the file. They are not verified identities, they are editable with any zip tool, " +
  "and organisations routinely blank them before release — Google Docs exports omit app.xml " +
  "entirely, and Word's Document Inspector can blank dc:creator. Absence is not concealment.";

export function interpretOfficeDocument(
  core: OoxmlCoreProps,
  app: OoxmlAppProps | null,
  custom: { name: string; value: string }[],
): ProvenanceField[] {
  const fields: ProvenanceField[] = [];

  fields.push(fieldFor("ooxml.creator", "Author (dc:creator)", core.creator, "docProps/core.xml dc:creator", OOXML_ABSENCE_NOTE, "notable"));

  const differs = Boolean(core.lastModifiedBy && core.creator && core.lastModifiedBy !== core.creator);
  fields.push(
    fieldFor(
      "ooxml.lastModifiedBy",
      "Last modified by",
      core.lastModifiedBy,
      "docProps/core.xml cp:lastModifiedBy",
      differs
        ? "This differs from the original author above — the file passed through a second identity " +
          "since it was created."
        : "The Office/OS display name of whoever last saved this file.",
      differs ? "notable" : "info",
    ),
  );
  fields.push(fieldFor("ooxml.title", "Title", core.title, "docProps/core.xml dc:title", "Document title metadata."));
  fields.push(fieldFor("ooxml.subject", "Subject", core.subject, "docProps/core.xml dc:subject", "Document subject metadata."));
  fields.push(
    fieldFor(
      "ooxml.created",
      "Created",
      core.created,
      "docProps/core.xml dcterms:created",
      "W3CDTF timestamp, virtually always UTC — genuinely absolute, unlike EXIF/PDF wall-clock times.",
    ),
  );
  fields.push(
    fieldFor(
      "ooxml.modified",
      "Modified",
      core.modified,
      "docProps/core.xml dcterms:modified",
      "W3CDTF timestamp, virtually always UTC.",
    ),
  );
  fields.push(fieldFor("ooxml.revision", "Revision number", core.revision, "docProps/core.xml cp:revision", "Internal save-count counter."));
  fields.push(fieldFor("ooxml.category", "Category", core.category, "docProps/core.xml cp:category", "Document category metadata."));
  fields.push(
    fieldFor(
      "ooxml.contentStatus",
      "Content status",
      core.contentStatus,
      "docProps/core.xml cp:contentStatus",
      "e.g. \"Draft\" or \"Final\" — set by the author, not verified.",
    ),
  );

  if (app) {
    fields.push(
      fieldFor(
        "ooxml.application",
        "Authoring application",
        app.application ? `${app.application}${app.appVersion ? ` (${app.appVersion})` : ""}` : null,
        "docProps/app.xml Application",
        "The application that saved this file.",
      ),
    );
    fields.push(
      fieldFor(
        "ooxml.company",
        "Company",
        app.company,
        "docProps/app.xml Company",
        "An organisational fingerprint, when populated by the authoring application's own settings.",
        "notable",
      ),
    );
    fields.push(
      fieldFor(
        "ooxml.template",
        "Template",
        app.template,
        "docProps/app.xml Template",
        "A custom template name (e.g. a .dotm) can be an organisational fingerprint.",
        "notable",
      ),
    );
    fields.push(
      fieldFor(
        "ooxml.totalTime",
        "Cumulative editing time (minutes)",
        app.totalTime,
        "docProps/app.xml TotalTime",
        "Total minutes the document was open for editing across all sessions, self-reported by the application.",
      ),
    );
  }

  for (const c of custom) {
    fields.push({
      id: `ooxml.custom.${c.name}`,
      label: `Custom property: ${c.name}`,
      value: c.value,
      status: "present",
      origin: "docProps/custom.xml",
      note:
        "An analyst- or organisation-defined custom document property — this is sometimes where " +
        "classification markings or workflow flags live.",
      severity: "notable",
    });
  }

  return fields;
}

// ─── OOXML macros and remote-template references ───────────────────────────

export interface OoxmlRelationship {
  type: string;
  target: string;
  /** "External" when the relationship points outside the package (per OOXML's Target Mode); null (the spec default) means an ordinary internal package part. */
  targetMode: string | null;
}

/** Parses a `.rels` part's flat `<Relationship Id=".." Type=".." Target=".." TargetMode=".."/>` elements — a simple, well-known, non-nested XML shape that a targeted attribute regex handles cleanly, unlike the deeper document/XMP XML elsewhere in this file. */
export function parseRelationshipsXml(xml: string): OoxmlRelationship[] {
  const out: OoxmlRelationship[] = [];
  const elementRe = /<Relationship\b([^>]*)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = elementRe.exec(xml))) {
    const attrs = m[1];
    const type = /\bType="([^"]*)"/.exec(attrs)?.[1];
    const target = /\bTarget="([^"]*)"/.exec(attrs)?.[1];
    const targetMode = /\bTargetMode="([^"]*)"/.exec(attrs)?.[1] ?? null;
    if (type && target) out.push({ type: decodeXmlEntities(type), target: decodeXmlEntities(target), targetMode });
  }
  return out;
}

/** Relationship Type suffixes that are ordinary, extremely common hyperlinks — not a remote-content vector, and excluded from the flagged list below so a normal in-text link doesn't drown every real finding in noise. */
const BENIGN_EXTERNAL_RELATIONSHIP_SUFFIXES = ["/hyperlink"];

export function interpretOoxmlMacrosAndTemplates(hasVbaProject: boolean, relationships: OoxmlRelationship[]): ProvenanceField[] {
  const fields: ProvenanceField[] = [];

  fields.push({
    id: "ooxml.vbaMacro",
    label: "VBA macro project",
    value: hasVbaProject
      ? "This document contains a vbaProject.bin — a macro-enabled document regardless of what its file extension claims."
      : null,
    status: hasVbaProject ? "present" : "absent",
    origin: "Presence of a vbaProject.bin entry in the file's zip archive",
    note: hasVbaProject
      ? "Detected from the zip entry's presence alone — this tool does not decompile or read the macro's actual VBA source, only that one exists."
      : "Checked: no vbaProject.bin entry found in this file's zip archive.",
    severity: hasVbaProject ? "notable" : "info",
  });

  const external = relationships.filter(
    (r) => r.targetMode === "External" && !BENIGN_EXTERNAL_RELATIONSHIP_SUFFIXES.some((suffix) => r.type.endsWith(suffix)),
  );
  fields.push({
    id: "ooxml.externalReferences",
    label: "External document/template references",
    value: external.length ? external.map((r) => `${r.type.split("/").pop()} → ${r.target}`).join("; ") : null,
    status: external.length ? "present" : "absent",
    origin: 'TargetMode="External" relationships in the document\'s _rels parts (ordinary hyperlinks excluded)',
    note: external.length
      ? "A relationship of this kind (e.g. an attached template or external OLE object) can cause the document to " +
        "fetch content from an external location when opened — a known remote-template-injection vector. Ordinary " +
        "in-text hyperlinks are excluded from this list since nearly every real document has some."
      : "Checked: no non-hyperlink external relationships found (attached templates, external OLE objects, etc).",
    severity: external.length ? "notable" : "info",
  });

  return fields;
}

export function interpretOdfMeta(meta: OdfMeta): ProvenanceField[] {
  const fields: ProvenanceField[] = [];
  fields.push(fieldFor("odf.initialCreator", "Original author", meta.initialCreator, "meta.xml meta:initial-creator", OOXML_ABSENCE_NOTE, "notable"));
  const differs = Boolean(meta.creator && meta.initialCreator && meta.creator !== meta.initialCreator);
  fields.push(
    fieldFor(
      "odf.creator",
      "Last modified by",
      meta.creator,
      "meta.xml dc:creator",
      differs
        ? "This differs from the original author above — the file passed through a second identity."
        : "The user display name of whoever last saved this file.",
      differs ? "notable" : "info",
    ),
  );
  fields.push(
    fieldFor(
      "odf.generator",
      "Generator",
      meta.generator,
      "meta.xml meta:generator",
      "The application and version that wrote this file (e.g. \"LibreOffice/7.4.5.2\").",
    ),
  );
  fields.push(fieldFor("odf.creationDate", "Created", meta.creationDate, "meta.xml meta:creation-date", "Genuinely absolute (UTC) timestamp."));
  fields.push(fieldFor("odf.date", "Last modified", meta.date, "meta.xml dc:date", "Genuinely absolute (UTC) timestamp."));
  fields.push(
    fieldFor(
      "odf.editingCycles",
      "Editing cycles",
      meta.editingCycles,
      "meta.xml meta:editing-cycles",
      "Number of times the document was saved.",
    ),
  );
  fields.push(
    fieldFor(
      "odf.editingDuration",
      "Cumulative editing duration",
      meta.editingDuration,
      "meta.xml meta:editing-duration",
      "Total time the document was open for editing, self-reported by the application.",
    ),
  );
  return fields;
}

// ─── OLE2 / Compound File Binary Format (legacy .doc/.xls/.ppt) parsing ────
//
// CFBF (Microsoft's own published MS-CFB spec) is a real filesystem-in-a-
// file: fixed-size sectors, a File Allocation Table chaining a stream's
// sectors together — the same "follow a linked list of block indices" idea
// as a real filesystem's FAT — a directory stream of fixed 128-byte
// entries, and, for streams under a cutoff size (typically 4096 bytes,
// which \x05SummaryInformation/\x05DocumentSummaryInformation almost always
// are in practice), a SEPARATE mini-FAT/mini-stream system using 64-byte
// "mini sectors" instead of regular ones. Both paths are implemented below
// — skipping the mini-stream path would silently fail to find these
// streams in the overwhelming majority of real files, since they are
// almost always small enough to live there rather than in regular sectors.
//
// The metadata itself lives in a further nested format inside those
// streams: MS-OLEPS ("Property Set"), a real, separately-specified binary
// layout — this is the same kind of two-layer nesting this project already
// handles for XMP-inside-PDF and Content_Types-XML-inside-a-zip.

const CFBF_HEADER_SIZE = 512;
const CFBF_FREESECT = 0xffffffff;
const CFBF_ENDOFCHAIN = 0xfffffffe;

function readU32LE2(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

export interface CfbfHeader {
  sectorSize: number;
  miniSectorSize: number;
  numFatSectors: number;
  firstDirSector: number;
  miniStreamCutoff: number;
  firstMiniFatSector: number;
  numMiniFatSectors: number;
  firstDifatSector: number;
  numDifatSectors: number;
}

/** Reads the fixed 512-byte CFBF header. Returns null if the buffer is too short to contain one — the magic-byte signature itself is already checked by sniffContainer before this is called. */
export function parseCfbfHeader(bytes: Uint8Array): CfbfHeader | null {
  if (bytes.length < CFBF_HEADER_SIZE) return null;
  const sectorShift = bytes[30] | (bytes[31] << 8);
  const miniSectorShift = bytes[32] | (bytes[33] << 8);
  if (sectorShift < 1 || sectorShift > 20 || miniSectorShift < 1 || miniSectorShift > 20) return null; // implausible, likely not a real CFBF file
  return {
    sectorSize: 1 << sectorShift,
    miniSectorSize: 1 << miniSectorShift,
    numFatSectors: readU32LE2(bytes, 44),
    firstDirSector: readU32LE2(bytes, 48),
    miniStreamCutoff: readU32LE2(bytes, 56),
    firstMiniFatSector: readU32LE2(bytes, 60),
    numMiniFatSectors: readU32LE2(bytes, 64),
    firstDifatSector: readU32LE2(bytes, 68),
    numDifatSectors: readU32LE2(bytes, 72),
  };
}

function readCfbfSector(bytes: Uint8Array, sector: number, sectorSize: number): Uint8Array | null {
  const off = CFBF_HEADER_SIZE + sector * sectorSize;
  if (sector < 0 || off + sectorSize > bytes.length) return null;
  return bytes.subarray(off, off + sectorSize);
}

/** Builds the full FAT (sector index -> next-sector-or-special-value) from the header-embedded DIFAT entries (the first 109, at fixed offset 76) plus any chained DIFAT sectors for larger files. */
function buildCfbfFat(bytes: Uint8Array, header: CfbfHeader): number[] | null {
  const entriesPerSector = header.sectorSize / 4;
  const fatSectorNumbers: number[] = [];
  for (let i = 0; i < 109 && fatSectorNumbers.length < header.numFatSectors; i += 1) {
    const v = readU32LE2(bytes, 76 + i * 4);
    if (v === CFBF_FREESECT) break;
    fatSectorNumbers.push(v);
  }
  let difatSector = header.firstDifatSector;
  let guard = 0;
  while (difatSector !== CFBF_ENDOFCHAIN && difatSector !== CFBF_FREESECT && guard <= header.numDifatSectors) {
    const sec = readCfbfSector(bytes, difatSector, header.sectorSize);
    if (!sec) break;
    const entriesInThisSector = entriesPerSector - 1; // the last 4 bytes of a DIFAT sector point to the next one
    for (let i = 0; i < entriesInThisSector && fatSectorNumbers.length < header.numFatSectors; i += 1) {
      const v = readU32LE2(sec, i * 4);
      if (v === CFBF_FREESECT) break;
      fatSectorNumbers.push(v);
    }
    difatSector = readU32LE2(sec, entriesInThisSector * 4);
    guard += 1;
  }

  const fat: number[] = [];
  for (const fatSec of fatSectorNumbers) {
    const sec = readCfbfSector(bytes, fatSec, header.sectorSize);
    if (!sec) return null;
    for (let i = 0; i < entriesPerSector; i += 1) fat.push(readU32LE2(sec, i * 4));
  }
  return fat;
}

/** Follows a chain from `startSector` until ENDOFCHAIN/FREESECT, concatenating whole sectors — used for the directory stream, whose total length is not declared anywhere and must be inferred from the chain itself. */
function readCfbfChainUntilEnd(bytes: Uint8Array, fat: number[], startSector: number, sectorSize: number): Uint8Array | null {
  const chunks: Uint8Array[] = [];
  let sector = startSector;
  let guard = 0;
  while (sector !== CFBF_ENDOFCHAIN && sector !== CFBF_FREESECT && guard <= fat.length) {
    const sec = readCfbfSector(bytes, sector, sectorSize);
    if (!sec) break;
    chunks.push(sec);
    sector = fat[sector];
    guard += 1;
  }
  if (chunks.length === 0) return null;
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

/** Follows a chain for exactly `streamSize` declared bytes (a real data stream, unlike the directory stream above). Returns null on a short/broken chain rather than a silently truncated result. */
function readCfbfStreamBySize(bytes: Uint8Array, fat: number[], startSector: number, streamSize: number, sectorSize: number): Uint8Array | null {
  if (streamSize === 0) return new Uint8Array(0);
  const out = new Uint8Array(streamSize);
  let sector = startSector;
  let written = 0;
  let guard = 0;
  while (sector !== CFBF_ENDOFCHAIN && written < streamSize && guard <= fat.length) {
    const sec = readCfbfSector(bytes, sector, sectorSize);
    if (!sec) return null;
    const take = Math.min(sectorSize, streamSize - written);
    out.set(sec.subarray(0, take), written);
    written += take;
    sector = fat[sector];
    guard += 1;
  }
  return written === streamSize ? out : null;
}

export interface CfbfDirEntry {
  name: string;
  /** 0 = unused, 1 = storage, 2 = stream, 5 = root storage. */
  objectType: number;
  startSector: number;
  streamSize: number;
}

function decodeCfbfEntryName(bytes: Uint8Array, nameLenBytes: number): string {
  // nameLenBytes counts the UTF-16 null terminator too; a 0 or 1 length means an empty/unused name.
  const charCount = Math.max(0, Math.floor(nameLenBytes / 2) - 1);
  let s = "";
  for (let i = 0; i < charCount; i += 1) s += String.fromCharCode(bytes[i * 2] | (bytes[i * 2 + 1] << 8));
  return s;
}

function parseCfbfDirEntries(dirBytes: Uint8Array): CfbfDirEntry[] {
  const entries: CfbfDirEntry[] = [];
  for (let off = 0; off + 128 <= dirBytes.length; off += 128) {
    const objectType = dirBytes[off + 66];
    if (objectType === 0) continue;
    const nameLenBytes = dirBytes[off + 64] | (dirBytes[off + 65] << 8);
    entries.push({
      name: decodeCfbfEntryName(dirBytes.subarray(off, off + 64), nameLenBytes),
      objectType,
      startSector: readU32LE2(dirBytes, off + 116),
      streamSize: readU32LE2(dirBytes, off + 120), // the high 4 bytes (v4-only, off+124) are not read — real SummaryInformation/DocumentSummaryInformation streams are always well under 4GB
    });
  }
  return entries;
}

function buildCfbfMiniFat(bytes: Uint8Array, fat: number[], header: CfbfHeader): number[] | null {
  if (header.firstMiniFatSector === CFBF_ENDOFCHAIN || header.numMiniFatSectors === 0) return [];
  const raw = readCfbfChainUntilEnd(bytes, fat, header.firstMiniFatSector, header.sectorSize);
  if (!raw) return null;
  const entries: number[] = [];
  for (let i = 0; i + 4 <= raw.length; i += 4) entries.push(readU32LE2(raw, i));
  return entries;
}

function readCfbfMiniStreamData(miniStreamBytes: Uint8Array, miniFat: number[], startMiniSector: number, streamSize: number, miniSectorSize: number): Uint8Array | null {
  if (streamSize === 0) return new Uint8Array(0);
  const out = new Uint8Array(streamSize);
  let sector = startMiniSector;
  let written = 0;
  let guard = 0;
  while (sector !== CFBF_ENDOFCHAIN && written < streamSize && guard <= miniFat.length) {
    const off = sector * miniSectorSize;
    if (off + miniSectorSize > miniStreamBytes.length) return null;
    const take = Math.min(miniSectorSize, streamSize - written);
    out.set(miniStreamBytes.subarray(off, off + take), written);
    written += take;
    sector = miniFat[sector];
    guard += 1;
  }
  return written === streamSize ? out : null;
}

/**
 * Reads a named stream's raw bytes out of a CFBF file, transparently
 * choosing the regular-sector or mini-stream path per the stream's own
 * declared size vs the header's cutoff — the same choice a real CFBF reader
 * makes, not a simplification. Returns null if the file is not a well-
 * formed CFBF, or the named stream does not exist.
 */
export function readCfbfStream(bytes: Uint8Array, streamName: string): Uint8Array | null {
  const header = parseCfbfHeader(bytes);
  if (!header) return null;
  const fat = buildCfbfFat(bytes, header);
  if (!fat) return null;

  const dirBytes = readCfbfChainUntilEnd(bytes, fat, header.firstDirSector, header.sectorSize);
  if (!dirBytes) return null;
  const entries = parseCfbfDirEntries(dirBytes);

  const target = entries.find((e) => e.name === streamName && e.objectType === 2);
  if (!target) return null;

  if (target.streamSize >= header.miniStreamCutoff) {
    return readCfbfStreamBySize(bytes, fat, target.startSector, target.streamSize, header.sectorSize);
  }

  const root = entries.find((e) => e.objectType === 5);
  if (!root) return null;
  const miniStreamBytes = readCfbfStreamBySize(bytes, fat, root.startSector, root.streamSize, header.sectorSize);
  if (!miniStreamBytes) return null;
  const miniFat = buildCfbfMiniFat(bytes, fat, header);
  if (!miniFat) return null;
  return readCfbfMiniStreamData(miniStreamBytes, miniFat, target.startSector, target.streamSize, header.miniSectorSize);
}

// ─── MS-OLEPS ("Property Set") parsing — the format INSIDE \x05SummaryInformation / \x05DocumentSummaryInformation ───

const OLEPS_VT_I4 = 3;
const OLEPS_VT_BOOL = 11;
const OLEPS_VT_LPSTR = 30;
const OLEPS_VT_LPWSTR = 31;
const OLEPS_VT_FILETIME = 64;

/** Windows FILETIME: 100-nanosecond intervals since 1601-01-01T00:00:00Z — a FOURTH distinct epoch this module handles, after Unix (1970), QuickTime (1904, mvhd above) and Matroska (2001, EBML DateUTC above). */
const FILETIME_EPOCH_OFFSET_MS = -11644473600000;

function filetimeToUnixMs(low: number, high: number): number | null {
  // 0 in both halves means "not set" for these optional date properties —
  // never rendered as the literal 1601-01-01 epoch instant, the same trap
  // already guarded against for mvhd's 0-means-unset creation/mod times.
  if (low === 0 && high === 0) return null;
  const ticks = high * 4294967296 + low;
  return FILETIME_EPOCH_OFFSET_MS + ticks / 10000;
}

function decodeOlepsCodepageString(bytes: Uint8Array): string {
  // Real SummaryInformation strings are technically in the stream's own
  // declared codepage (PID_CODEPAGE, property 1 — not read here), not
  // always ASCII. A plain byte->charCode mapping is legible for real-world
  // Latin-script text (the overwhelming majority of cases) and produces
  // visible mojibake rather than a wrong-but-confident value for anything
  // else — a stated, honest limitation, not silently wrong output.
  let s = "";
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  return s.replace(/\0+$/, "");
}

type OlepsValue = string | number | boolean | null;

function readOlepsProperty(bytes: Uint8Array, offset: number): OlepsValue {
  if (offset + 4 > bytes.length) return null;
  const type = readU32LE2(bytes, offset);
  const dataOffset = offset + 4;
  switch (type) {
    case OLEPS_VT_LPSTR: {
      if (dataOffset + 4 > bytes.length) return null;
      const len = readU32LE2(bytes, dataOffset);
      if (dataOffset + 4 + len > bytes.length) return null;
      return decodeOlepsCodepageString(bytes.subarray(dataOffset + 4, dataOffset + 4 + len));
    }
    case OLEPS_VT_LPWSTR: {
      if (dataOffset + 4 > bytes.length) return null;
      const charLen = readU32LE2(bytes, dataOffset);
      let s = "";
      for (let i = 0; i < charLen; i += 1) {
        const p = dataOffset + 4 + i * 2;
        if (p + 2 > bytes.length) break;
        const code = bytes[p] | (bytes[p + 1] << 8);
        if (code === 0) break;
        s += String.fromCharCode(code);
      }
      return s;
    }
    case OLEPS_VT_FILETIME: {
      if (dataOffset + 8 > bytes.length) return null;
      return filetimeToUnixMs(readU32LE2(bytes, dataOffset), readU32LE2(bytes, dataOffset + 4));
    }
    case OLEPS_VT_I4:
      return dataOffset + 4 <= bytes.length ? readU32LE2(bytes, dataOffset) | 0 : null;
    case OLEPS_VT_BOOL:
      return dataOffset + 2 <= bytes.length ? (bytes[dataOffset] | (bytes[dataOffset + 1] << 8)) !== 0 : null;
    default:
      return null; // a real property type this module does not decode — never guessed at
  }
}

/** Parses ONE property set (SummaryInformation streams have exactly one; DocumentSummaryInformation can have a second, UserDefined set this module does not read). Returns a PID -> decoded-value map. */
export function parseOlepsPropertySet(bytes: Uint8Array): Map<number, OlepsValue> | null {
  if (bytes.length < 28) return null;
  const byteOrder = bytes[0] | (bytes[1] << 8);
  if (byteOrder !== 0xfffe) return null;
  const numPropertySets = readU32LE2(bytes, 24);
  if (numPropertySets < 1) return null;
  const offset0 = readU32LE2(bytes, 44);
  if (offset0 + 8 > bytes.length) return null;
  const numProperties = readU32LE2(bytes, offset0 + 4);

  const properties = new Map<number, OlepsValue>();
  for (let i = 0; i < numProperties; i += 1) {
    const entryOff = offset0 + 8 + i * 8;
    if (entryOff + 8 > bytes.length) break;
    const id = readU32LE2(bytes, entryOff);
    const propOffset = readU32LE2(bytes, entryOff + 4);
    properties.set(id, readOlepsProperty(bytes, offset0 + propOffset));
  }
  return properties;
}

// Well-known Property IDs, MS-OLEPS §2.15/2.16 — the same fields OOXML/ODF
// already report, under the older binary format's own PID numbering.
const SUMMARY_INFO_PID = {
  title: 2,
  subject: 3,
  author: 4,
  keywords: 5,
  comments: 6,
  template: 7,
  lastAuthor: 8,
  revisionNumber: 9,
  lastPrinted: 11,
  createDateTime: 12,
  lastSaveDateTime: 13,
  appName: 18,
};
const DOC_SUMMARY_INFO_PID = { category: 2, manager: 14, company: 15 };

export interface CfbfDocumentMeta {
  summary: Map<number, OlepsValue> | null;
  docSummary: Map<number, OlepsValue> | null;
}

export function interpretCfbfDocument(meta: CfbfDocumentMeta): { fields: ProvenanceField[]; timestamps: ProvenanceTimestamp[] } {
  const fields: ProvenanceField[] = [];
  const timestamps: ProvenanceTimestamp[] = [];
  const strOf = (m: Map<number, OlepsValue> | null, pid: number): string | null => {
    const v = m?.get(pid);
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };

  const author = strOf(meta.summary, SUMMARY_INFO_PID.author);
  const lastAuthor = strOf(meta.summary, SUMMARY_INFO_PID.lastAuthor);
  const authorDiffers = Boolean(author && lastAuthor && author !== lastAuthor);

  fields.push(fieldFor("cfbf.author", "Author", author, "\\x05SummaryInformation PID_AUTHOR", OOXML_ABSENCE_NOTE, "notable"));
  fields.push(
    fieldFor(
      "cfbf.lastAuthor",
      "Last saved by",
      lastAuthor,
      "\\x05SummaryInformation PID_LASTAUTHOR",
      authorDiffers
        ? "This differs from the original author above — the file passed through a second identity since it was created."
        : "The Office/OS display name of whoever last saved this file.",
      authorDiffers ? "notable" : "info",
    ),
  );
  fields.push(fieldFor("cfbf.title", "Title", strOf(meta.summary, SUMMARY_INFO_PID.title), "\\x05SummaryInformation PID_TITLE", "Document title metadata."));
  fields.push(fieldFor("cfbf.subject", "Subject", strOf(meta.summary, SUMMARY_INFO_PID.subject), "\\x05SummaryInformation PID_SUBJECT", "Document subject metadata."));
  fields.push(fieldFor("cfbf.keywords", "Keywords", strOf(meta.summary, SUMMARY_INFO_PID.keywords), "\\x05SummaryInformation PID_KEYWORDS", "Keyword metadata as entered by the authoring application."));
  fields.push(
    fieldFor(
      "cfbf.appName",
      "Authoring application",
      strOf(meta.summary, SUMMARY_INFO_PID.appName),
      "\\x05SummaryInformation PID_APPNAME",
      'The application that saved this file (e.g. "Microsoft Office Word").',
    ),
  );
  fields.push(fieldFor("cfbf.revisionNumber", "Revision number", strOf(meta.summary, SUMMARY_INFO_PID.revisionNumber), "\\x05SummaryInformation PID_REVNUMBER", "Internal save-count / revision identifier."));
  fields.push(
    fieldFor(
      "cfbf.company",
      "Company",
      strOf(meta.docSummary, DOC_SUMMARY_INFO_PID.company),
      "\\x05DocumentSummaryInformation PID_COMPANY",
      "An organisational fingerprint, when populated by the authoring application's own settings — the same field OOXML/ODF report under a different container format.",
      "notable",
    ),
  );
  fields.push(fieldFor("cfbf.manager", "Manager", strOf(meta.docSummary, DOC_SUMMARY_INFO_PID.manager), "\\x05DocumentSummaryInformation PID_MANAGER", "An organisational fingerprint, self-reported.", "notable"));

  for (const [pid, id, label, origin] of [
    [SUMMARY_INFO_PID.createDateTime, "cfbf.created", "Created", "\\x05SummaryInformation PID_CREATE_DTM"],
    [SUMMARY_INFO_PID.lastSaveDateTime, "cfbf.modified", "Modified", "\\x05SummaryInformation PID_LASTSAVE_DTM"],
  ] as [number, string, string, string][]) {
    const ms = meta.summary?.get(pid);
    if (typeof ms === "number") {
      const iso = new Date(ms).toISOString();
      timestamps.push({
        id,
        label,
        raw: iso,
        local: iso.replace("T", " ").replace("Z", ""),
        offset: "+00:00",
        absolute: iso,
        precision: "second",
        note: "FILETIME is genuinely UTC — a real absolute instant, unlike PDF's wall-clock CreationDate/ModDate.",
      });
    }
  }

  return { fields, timestamps };
}

// ─── Video container (ISO-BMFF / mp4, mov) parsing ─────────────────────────

export interface BoxHeader {
  type: string;
  /** Offset of the box's own header, within the buffer passed to parseIsoBmffBoxes. */
  start: number;
  headerSize: number;
  /** Total box size including its header. */
  size: number;
}

function readU32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}
function readU64(bytes: Uint8Array, offset: number): number {
  return readU32(bytes, offset) * 4294967296 + readU32(bytes, offset + 4);
}
function readU16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}
function readAscii(bytes: Uint8Array, offset: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i += 1) s += String.fromCharCode(bytes[offset + i]);
  return s;
}

/**
 * Walk top-level ISO-BMFF boxes in [offset, end). Two traps that silently
 * stop a naive walker mid-file: box size 0 means "extends to the end of
 * this buffer" (only meaningful for the outermost read), and size 1 means a
 * 64-bit `largesize` follows the 8-byte header (used for boxes over 4GB).
 */
export function parseIsoBmffBoxes(bytes: Uint8Array, offset = 0, end = bytes.length): BoxHeader[] {
  const boxes: BoxHeader[] = [];
  let pos = offset;
  while (pos + 8 <= end) {
    const size32 = readU32(bytes, pos);
    const type = readAscii(bytes, pos + 4, 4);
    let headerSize = 8;
    let size: number;
    if (size32 === 1) {
      if (pos + 16 > end) break;
      size = readU64(bytes, pos + 8);
      headerSize = 16;
    } else if (size32 === 0) {
      size = end - pos;
    } else {
      size = size32;
    }
    if (size < headerSize || pos + size > end + headerSize) break; // corrupt or truncated buffer
    boxes.push({ type, start: pos, headerSize, size });
    if (size === 0) break;
    pos += size;
  }
  return boxes;
}

/** Seconds between the QuickTime/ISO-BMFF epoch (1904-01-01) and Unix epoch. */
const QUICKTIME_EPOCH_OFFSET_SECONDS = 2082844800;

export interface MvhdInfo {
  /** Unix epoch milliseconds, or null when the file recorded 0 ("not set"). */
  creationTimeMs: number | null;
  modificationTimeMs: number | null;
  timescale: number;
  duration: number;
  version: number;
}

/**
 * Parse an mvhd box's payload (bytes starting right after the 8/16-byte box
 * header). The creation/modification time fields are seconds since
 * 1904-01-01 — NOT 1970 — and a raw value of 0 means "not set", never
 * 1904-01-01 itself. Getting the epoch wrong renders dates ~66 years off;
 * treating 0 as a real date would invent a capture time for a file that
 * never recorded one.
 */
export function parseMvhd(payload: Uint8Array): MvhdInfo | null {
  if (payload.length < 4) return null;
  const version = payload[0];
  let pos = 4; // skip version(1) + flags(3)
  let creationRaw: number;
  let modRaw: number;
  let timescale: number;
  let duration: number;
  if (version === 1) {
    if (payload.length < pos + 28) return null;
    creationRaw = readU64(payload, pos);
    pos += 8;
    modRaw = readU64(payload, pos);
    pos += 8;
    timescale = readU32(payload, pos);
    pos += 4;
    duration = readU64(payload, pos);
  } else {
    if (payload.length < pos + 16) return null;
    creationRaw = readU32(payload, pos);
    pos += 4;
    modRaw = readU32(payload, pos);
    pos += 4;
    timescale = readU32(payload, pos);
    pos += 4;
    duration = readU32(payload, pos);
  }
  return {
    creationTimeMs: creationRaw > 0 ? (creationRaw - QUICKTIME_EPOCH_OFFSET_SECONDS) * 1000 : null,
    modificationTimeMs: modRaw > 0 ? (modRaw - QUICKTIME_EPOCH_OFFSET_SECONDS) * 1000 : null,
    timescale,
    duration,
    version,
  };
}

/**
 * Parse iTunes-style `ilst` atoms (moov/udta/meta/ilst). Each child box is
 * named with a 4CC (often prefixed with the "©" byte) followed by a nested
 * "data" box: version(1)+flags(3)+reserved(4)+payload. Decoded as UTF-8 text
 * — sufficient for the string tags this module reads (©day/©nam/©mak/©mod/
 * ©swr/©too/©xyz); binary-typed atoms are skipped.
 */
export function parseIlstTags(bytes: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const boxes = parseIsoBmffBoxes(bytes, 0, bytes.length);
  for (const box of boxes) {
    const inner = parseIsoBmffBoxes(bytes, box.start + box.headerSize, box.start + box.size);
    const dataBox = inner.find((b) => b.type === "data");
    if (!dataBox) continue;
    const payloadStart = dataBox.start + dataBox.headerSize + 8; // + version/flags/reserved
    const payloadEnd = dataBox.start + dataBox.size;
    if (payloadStart >= payloadEnd) continue;
    try {
      const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(payloadStart, payloadEnd));
      const trimmed = text.replace(/\0+$/, "").trim();
      if (trimmed) out[box.type] = trimmed;
    } catch {
      // Not decodable as text (a binary-typed atom) — skip, don't fabricate a value.
    }
  }
  return out;
}

export interface Iso6709Location {
  latitude: number;
  longitude: number;
  altitude: number | null;
}

/** Parse an ISO-6709 location string, e.g. "+28.6139+077.2090/" (lat+lon[+alt]/). */
export function parseIso6709(value: string): Iso6709Location | null {
  const m = /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)(?:([+-]\d+(?:\.\d+)?))?\/?$/.exec(value.trim());
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lon = parseFloat(m[2]);
  const alt = m[3] !== undefined ? parseFloat(m[3]) : null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { latitude: lat, longitude: lon, altitude: alt !== null && Number.isFinite(alt) ? alt : null };
}

export interface VideoContainerInput {
  ftypBrand: string | null;
  mvhd: MvhdInfo | null;
  ilst: Record<string, string>;
  handlerTypes: string[];
  codecs: string[];
  decoderDurationSeconds: number | null;
  moovTruncated: boolean;
}

const HANDLER_LABELS: Record<string, string> = { vide: "video", soun: "audio", sbtl: "subtitle" };

export function interpretVideoContainer(input: VideoContainerInput): ProvenanceField[] {
  const fields: ProvenanceField[] = [];

  if (input.mvhd) {
    const creation =
      input.mvhd.creationTimeMs !== null ? new Date(input.mvhd.creationTimeMs).toISOString() : null;
    fields.push({
      id: "video.creation_time",
      label: "Container creation time",
      value: creation,
      status: creation ? "present" : "absent",
      origin: "moov/mvhd creation_time",
      note:
        "Recorded by the muxer when the file was written. The ISO-BMFF spec calls for UTC, but " +
        "many real-world muxers write local wall-clock time instead — treat this as a claim, " +
        "not a guaranteed UTC instant.",
      severity: "notable",
    });
    const mod =
      input.mvhd.modificationTimeMs !== null ? new Date(input.mvhd.modificationTimeMs).toISOString() : null;
    fields.push(
      fieldFor("video.modification_time", "Container modification time", mod, "moov/mvhd modification_time", "Same caveats as creation time above."),
    );
  } else {
    fields.push(unreadableField("video.mvhd", "Container creation/modification time", "moov/mvhd", "the mvhd box was not found or could not be parsed"));
  }

  fields.push(
    fieldFor(
      "video.brand",
      "Container major brand",
      input.ftypBrand,
      "ftyp major_brand",
      'Identifies the muxer family (e.g. "qt  " = QuickTime/Apple, "isom"/"mp42" = generic/FFmpeg-family MP4).',
    ),
  );

  const ilstMap: [string, string, string, "info" | "notable"][] = [
    ["©day", "video.ilst.day", "Creation date (device tag)", "info"],
    ["©nam", "video.ilst.name", "Title (device tag)", "info"],
    ["©mak", "video.ilst.make", "Device make", "notable"],
    ["©mod", "video.ilst.model", "Device model", "notable"],
    ["©swr", "video.ilst.software", "Software", "info"],
    ["©too", "video.ilst.tool", "Encoder", "notable"],
  ];
  for (const [tag, id, label, severity] of ilstMap) {
    fields.push(
      fieldFor(
        id,
        label,
        input.ilst[tag] ?? null,
        `moov/udta/meta/ilst ${tag}`,
        label === "Encoder"
          ? "The exact encoder build string (e.g. an FFmpeg version) can pin how, and roughly when, this file was produced."
          : "A metadata tag written by the device or application that produced this file.",
        severity,
      ),
    );
  }

  const gpsRaw = input.ilst["©xyz"] ?? null;
  if (gpsRaw) {
    const parsed = parseIso6709(gpsRaw);
    fields.push({
      id: "video.gps",
      label: "GPS location (device tag)",
      value: parsed ? `${parsed.latitude.toFixed(6)}, ${parsed.longitude.toFixed(6)}` : gpsRaw,
      status: "present",
      origin: "moov/udta/meta/ilst ©xyz (ISO-6709)",
      note:
        "Geotagged by the recording device — among the highest-value fields in video provenance. " +
        "The coordinate is written by the device and can be edited or stripped, so treat it as a " +
        "strong lead, not a fact.",
      severity: "notable",
    });
  } else {
    fields.push(fieldFor("video.gps", "GPS location (device tag)", null, "moov/udta/meta/ilst ©xyz", "No GPS tag was embedded in this file's container metadata."));
  }

  if (input.handlerTypes.length) {
    fields.push(
      fieldFor(
        "video.tracks",
        "Track types present",
        input.handlerTypes.map((h) => HANDLER_LABELS[h] ?? h).join(", "),
        "moov/trak/mdia/hdlr",
        "Which kinds of tracks this file contains.",
      ),
    );
  }
  if (input.codecs.length) {
    fields.push(
      fieldFor("video.codecs", "Codec(s)", input.codecs.join(", "), "moov/trak/mdia/minf/stbl/stsd", "Sample format(s) declared in the container."),
    );
  }

  if (input.decoderDurationSeconds !== null) {
    fields.push({
      id: "video.decoder_duration",
      label: "Duration (reported by this browser's decoder)",
      value: `${input.decoderDurationSeconds.toFixed(2)}s`,
      status: "present",
      origin: "HTMLMediaElement.duration",
      note:
        "A real measurement from decoding the file, not a container claim. Where this disagrees " +
        "with the container's own declared duration, that disagreement is itself worth noting.",
      severity: "info",
    });
  }

  if (input.moovTruncated) {
    fields.push({
      id: "video.moov_truncated",
      label: "Container metadata truncated",
      value: "yes",
      status: "present",
      origin: "moov box size check",
      note: "This file's moov box exceeded the read cap, so some container metadata may not have been read.",
      severity: "info",
    });
  }

  return fields;
}

// ─── RIFF / AVI container parsing ──────────────────────────────────────────
//
// RIFF (Microsoft's own published spec, also the container this project's
// own encodeWavPcm16 already writes for WAV) is a flat chunk format: a
// 4-byte FourCC id, a 4-byte LITTLE-endian size, then that many bytes of
// data, padded to an even byte boundary. LIST chunks nest further chunks
// inside a 4-byte list-type FourCC. AVI's INFO list carries the same kind
// of authorship metadata OOXML/ODF already report, under different tag
// names (INAM=title, IART=artist, ISFT=software, ...).

function readU32LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

export interface RiffChunk {
  id: string;
  dataStart: number;
  size: number;
}

/** Walk RIFF chunks in [offset, end), each padded to an even byte boundary. */
export function parseRiffChunks(bytes: Uint8Array, offset: number, end: number): RiffChunk[] {
  const chunks: RiffChunk[] = [];
  let pos = offset;
  while (pos + 8 <= end) {
    const id = readAscii(bytes, pos, 4);
    const size = readU32LE(bytes, pos + 4);
    const dataStart = pos + 8;
    if (size < 0 || dataStart + size > end) break; // corrupt or truncated buffer
    chunks.push({ id, dataStart, size });
    pos = dataStart + size + (size % 2); // odd-sized chunks are padded with one byte
  }
  return chunks;
}

export interface RiffInfo {
  formType: string | null;
  /** Raw FourCC -> decoded text, from the top-level LIST/INFO chunk. */
  tags: Record<string, string>;
}

/** Parses a RIFF file's outer header and its top-level LIST/INFO chunk, if present. Returns null if the buffer is not a RIFF file at all. */
export function parseRiffContainer(bytes: Uint8Array): RiffInfo | null {
  if (readAscii(bytes, 0, 4) !== "RIFF" || bytes.length < 12) return null;
  const declaredSize = readU32LE(bytes, 4);
  const formType = readAscii(bytes, 8, 4);
  // declaredSize excludes the 8-byte "RIFF"+size header itself; a real file
  // can still be truncated relative to what it claims, so clamp to what we
  // actually have rather than reading past the buffer.
  const end = Math.min(bytes.length, 8 + declaredSize);

  const tags: Record<string, string> = {};
  for (const chunk of parseRiffChunks(bytes, 12, end)) {
    if (chunk.id !== "LIST" || chunk.size < 4) continue;
    const listType = readAscii(bytes, chunk.dataStart, 4);
    if (listType !== "INFO") continue;
    for (const sub of parseRiffChunks(bytes, chunk.dataStart + 4, chunk.dataStart + chunk.size)) {
      const raw = bytes.slice(sub.dataStart, sub.dataStart + sub.size);
      const text = new TextDecoder("utf-8", { fatal: false }).decode(raw).replace(/\0+$/, "").trim();
      if (text) tags[sub.id] = text;
    }
  }
  return { formType, tags };
}

const RIFF_INFO_FIELDS: [string, string, string, "info" | "notable"][] = [
  ["INAM", "riff.title", "Title", "info"],
  ["IART", "riff.artist", "Artist", "info"],
  ["ICMT", "riff.comment", "Comment", "info"],
  ["ICRD", "riff.created", "Creation date (as recorded, not a parsed timestamp)", "notable"],
  ["ISFT", "riff.software", "Software", "notable"],
  ["IPRD", "riff.product", "Product", "info"],
  ["ICOP", "riff.copyright", "Copyright", "info"],
  ["IENG", "riff.engineer", "Engineer", "notable"],
  ["IKEY", "riff.keywords", "Keywords", "info"],
  ["IGNR", "riff.genre", "Genre", "info"],
];

export function interpretRiffContainer(riff: RiffInfo | null): ProvenanceField[] {
  if (!riff) return [];
  const fields: ProvenanceField[] = [];
  fields.push(
    fieldFor(
      "riff.formType",
      "Container form type",
      riff.formType,
      "RIFF header form type",
      'Identifies the RIFF variant (e.g. "AVI " for Audio Video Interleave, "WAVE" for audio).',
    ),
  );
  for (const [tag, id, label, severity] of RIFF_INFO_FIELDS) {
    fields.push(
      fieldFor(
        id,
        label,
        riff.tags[tag] ?? null,
        `RIFF LIST/INFO ${tag}`,
        label === "Software"
          ? "The application that wrote this file — a real fingerprint for how it was produced, editable like every other field here."
          : "A metadata tag from the file's own LIST/INFO chunk, self-reported by the writing application.",
        severity,
      ),
    );
  }
  return fields;
}

/**
 * Finds a top-level RIFF chunk's raw bytes by FourCC — e.g. WebP's own
 * top-level "EXIF" and "XMP " chunks (WEBP form type), distinct from AVI/
 * WAVE's LIST/INFO sub-chunks above. Returns null if the buffer isn't a real
 * RIFF file or the chunk is absent.
 */
export function findRiffChunkBytes(bytes: Uint8Array, chunkId: string): Uint8Array | null {
  if (readAscii(bytes, 0, 4) !== "RIFF" || bytes.length < 12) return null;
  const declaredSize = readU32LE(bytes, 4);
  const end = Math.min(bytes.length, 8 + declaredSize);
  for (const chunk of parseRiffChunks(bytes, 12, end)) {
    if (chunk.id === chunkId) return bytes.slice(chunk.dataStart, chunk.dataStart + chunk.size);
  }
  return null;
}

// ─── EBML / WebM / MKV (Matroska) container parsing ────────────────────────
//
// EBML (the container Matroska and WebM are built on) is self-describing:
// every element is an ID (a variable-length integer that KEEPS its own
// length-marker bits, unlike its size) followed by a size (a variable-
// length integer with the marker bits STRIPPED), followed by that many
// bytes of payload — which for a "master" element is itself a sequence of
// child elements. Segment/Info carries the same kind of authorship fields
// OOXML/RIFF already report (MuxingApp/WritingApp), plus DateUTC — a THIRD
// distinct epoch this module now handles (nanoseconds since 2001-01-01,
// after Unix 1970 elsewhere in this file and QuickTime's 1904 in mvhd
// above), stored as a signed 64-bit integer wide enough that reading it as
// a plain JS number would silently lose precision — handled with BigInt.

/** Reads an EBML variable-length integer. `keepMarker`: IDs keep the length-marker bit(s) as part of their value (per spec); sizes have them stripped. Returns null on a reserved/invalid leading byte or a truncated buffer. */
function readEbmlVint(
  bytes: Uint8Array,
  offset: number,
  keepMarker: boolean,
): { value: number; length: number; isUnknown: boolean } | null {
  if (offset >= bytes.length) return null;
  const first = bytes[offset];
  if (first === 0) return null; // reserved: implies a length > 8, not a real element
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && (first & mask) === 0) {
    mask >>= 1;
    length += 1;
  }
  if (length > 8 || offset + length > bytes.length) return null;

  // "Unknown size" is encoded as every data bit set to 1 (spec-legal,
  // common in streamed/live-muxed files) — the caller decides how to
  // bound an element with this size, never treated as a literal huge number.
  let allOnes = true;
  const valueMask = mask - 1;
  if ((first & valueMask) !== valueMask) allOnes = false;
  for (let i = 1; i < length && allOnes; i += 1) if (bytes[offset + i] !== 0xff) allOnes = false;

  let value = keepMarker ? first : first & valueMask;
  for (let i = 1; i < length; i += 1) value = value * 256 + bytes[offset + i];
  return { value, length, isUnknown: allOnes };
}

export interface EbmlElement {
  id: number;
  dataStart: number;
  dataSize: number;
}

/** Walk EBML elements in [offset, end). An "unknown size" master element (common in streamed Matroska) is bounded to `end` rather than treated as a literal all-1s number. */
export function parseEbmlElements(bytes: Uint8Array, offset: number, end: number): EbmlElement[] {
  const elements: EbmlElement[] = [];
  let pos = offset;
  while (pos < end) {
    const idRes = readEbmlVint(bytes, pos, true);
    if (!idRes) break;
    const sizeRes = readEbmlVint(bytes, pos + idRes.length, false);
    if (!sizeRes) break;
    const dataStart = pos + idRes.length + sizeRes.length;
    const dataSize = sizeRes.isUnknown ? end - dataStart : sizeRes.value;
    if (dataSize < 0 || dataStart + dataSize > end) break; // corrupt or truncated buffer
    elements.push({ id: idRes.value, dataStart, dataSize });
    if (dataSize === 0 && sizeRes.isUnknown) break; // avoid a zero-progress loop on a degenerate buffer
    pos = dataStart + dataSize;
  }
  return elements;
}

const EBML_ID_SEGMENT = 0x18538067;
const EBML_ID_INFO = 0x1549a966;
const EBML_ID_MUXING_APP = 0x4d80;
const EBML_ID_WRITING_APP = 0x5741;
const EBML_ID_DATE_UTC = 0x4461;
const EBML_ID_TITLE = 0x7ba9;

/** Milliseconds from the Unix epoch to the Matroska DateUTC epoch (2001-01-01T00:00:00Z). */
const MATROSKA_EPOCH_OFFSET_MS = Date.UTC(2001, 0, 1);

function readI64BE(bytes: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 0; i < 8; i += 1) value = (value << 8n) | BigInt(bytes[offset + i]);
  if (value >= 1n << 63n) value -= 1n << 64n; // two's-complement: fold the unsigned bit pattern back to signed
  return value;
}

function decodeEbmlUtf8(bytes: Uint8Array, el: EbmlElement): string | null {
  const text = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.slice(el.dataStart, el.dataStart + el.dataSize))
    .replace(/\0+$/, "")
    .trim();
  return text || null;
}

export interface EbmlInfo {
  muxingApp: string | null;
  writingApp: string | null;
  title: string | null;
  /** Unix epoch milliseconds — already converted from the file's own 2001-epoch nanosecond value. Null when DateUTC was not recorded or was malformed. */
  dateUtcMs: number | null;
}

/** Parses only as far as Segment -> Info, which is where the fields this module reports actually live — never walks the (potentially huge) rest of the Segment. Returns null if this is not a recognisable EBML file, or if it has no Segment/Info at all (a real, valid absence — e.g. a fragment). */
export function parseEbmlContainer(bytes: Uint8Array): EbmlInfo | null {
  const top = parseEbmlElements(bytes, 0, bytes.length);
  const segment = top.find((e) => e.id === EBML_ID_SEGMENT);
  if (!segment) return null;

  const segmentEnd = Math.min(bytes.length, segment.dataStart + segment.dataSize);
  const segmentChildren = parseEbmlElements(bytes, segment.dataStart, segmentEnd);
  const info = segmentChildren.find((e) => e.id === EBML_ID_INFO);
  if (!info) return { muxingApp: null, writingApp: null, title: null, dateUtcMs: null };

  const infoChildren = parseEbmlElements(bytes, info.dataStart, info.dataStart + info.dataSize);
  let muxingApp: string | null = null;
  let writingApp: string | null = null;
  let title: string | null = null;
  let dateUtcMs: number | null = null;
  for (const child of infoChildren) {
    if (child.id === EBML_ID_MUXING_APP) muxingApp = decodeEbmlUtf8(bytes, child);
    else if (child.id === EBML_ID_WRITING_APP) writingApp = decodeEbmlUtf8(bytes, child);
    else if (child.id === EBML_ID_TITLE) title = decodeEbmlUtf8(bytes, child);
    else if (child.id === EBML_ID_DATE_UTC && child.dataSize === 8) {
      const ns = readI64BE(bytes, child.dataStart);
      dateUtcMs = MATROSKA_EPOCH_OFFSET_MS + Number(ns / 1_000_000n);
    }
  }
  return { muxingApp, writingApp, title, dateUtcMs };
}

export function interpretEbmlContainer(ebml: EbmlInfo | null): ProvenanceField[] {
  if (!ebml) return [];
  const fields: ProvenanceField[] = [];
  fields.push(
    fieldFor(
      "ebml.writingApp",
      "Writing application",
      ebml.writingApp,
      "Segment/Info WritingApp",
      "The application that wrote this specific file (e.g. a version string identifying the exact encoder build).",
      "notable",
    ),
  );
  fields.push(
    fieldFor(
      "ebml.muxingApp",
      "Muxing library",
      ebml.muxingApp,
      "Segment/Info MuxingApp",
      "The library that packaged the audio/video streams into this container — often distinct from the writing application above.",
      "notable",
    ),
  );
  fields.push(fieldFor("ebml.title", "Title", ebml.title, "Segment/Info Title", "Container-level title metadata."));
  fields.push({
    id: "ebml.dateUtc",
    label: "Container date (DateUTC)",
    value: ebml.dateUtcMs !== null ? new Date(ebml.dateUtcMs).toISOString() : null,
    status: ebml.dateUtcMs !== null ? "present" : "absent",
    origin: "Segment/Info DateUTC",
    note:
      "Recorded by the muxer when the file was written, genuinely UTC per the Matroska spec (unlike ISO-BMFF's mvhd, which many real muxers write in local time despite the spec calling for UTC) — but still self-reported, not verified.",
    severity: "notable",
  });
  return fields;
}

// ─── GIF (GIF87a/GIF89a) container parsing ─────────────────────────────────
//
// GIF (per the official CompuServe GIF89a spec) is a stream of blocks after
// a fixed 13-byte header+Logical Screen Descriptor (+ an optional Global
// Color Table): Extension blocks (Graphic Control 0xF9, Comment 0xFE, Plain
// Text 0x01, Application 0xFF) and Image Descriptor blocks (0x2C), until a
// Trailer (0x3B). Real metadata lives in Comment Extensions (free text,
// possibly repeated) and the Application Extension's 11-byte identifier+auth
// code (e.g. "NETSCAPE2.0" for the looping extension, or another tool's own
// stamp). **Not extracted here, a stated scope limit**: XMP-in-GIF (Adobe's
// convention, identifier "XMP Data"+auth "XMP") stores its payload as raw
// bytes terminated by a 258-byte magic trailer instead of GIF's normal
// length-prefixed sub-blocks — a genuinely different, easy-to-get-subtly-wrong
// parsing rule bolted onto the format after the fact, deliberately not
// hand-rolled here rather than risk a fragile trailer-matching bug; the
// Application Extension's raw identifier is still reported, so an XMP-in-GIF
// file is still visible as "written by a tool declaring XMP Data", just not
// XMP-parsed.

export interface GifInfo {
  comments: string[];
  applications: string[];
}

/** Walks a GIF's block stream. Stops cleanly (never throws, never reads out of bounds) on any structural surprise — a corrupt/truncated file yields whatever was found before the surprise, not a crash. */
export function parseGifBlocks(bytes: Uint8Array): GifInfo | null {
  const header = readAscii(bytes, 0, Math.min(6, bytes.length));
  if (header !== "GIF87a" && header !== "GIF89a") return null;
  if (bytes.length < 13) return { comments: [], applications: [] };

  const packed = bytes[10];
  let pos = 13;
  if (packed & 0x80) pos += 3 * (2 ** ((packed & 0x07) + 1)); // Global Color Table

  const comments: string[] = [];
  const applications: string[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: false });

  /** Consumes GIF's standard length-prefixed sub-block sequence (each: 1 size byte N, then N data bytes), ending at the 0x00 terminator. Returns the position just past the terminator, or null if the buffer runs out first. */
  function skipSubBlocks(p: number, collect?: number[]): number | null {
    while (p < bytes.length) {
      const size = bytes[p];
      if (size === 0) return p + 1;
      if (p + 1 + size > bytes.length) return null; // truncated
      if (collect) for (let i = 0; i < size; i += 1) collect.push(bytes[p + 1 + i]);
      p += 1 + size;
    }
    return null;
  }

  while (pos < bytes.length) {
    const marker = bytes[pos];
    if (marker === 0x3b) break; // Trailer
    if (marker === 0x21) {
      // Extension Introducer
      if (pos + 1 >= bytes.length) break;
      const label = bytes[pos + 1];
      if (label === 0xf9) {
        // Graphic Control Extension — fixed size, always declares 4 data bytes
        if (pos + 2 >= bytes.length) break;
        const blockSize = bytes[pos + 2];
        const next = pos + 3 + blockSize + 1;
        if (next > bytes.length) break;
        pos = next;
      } else if (label === 0xfe) {
        // Comment Extension
        const raw: number[] = [];
        const next = skipSubBlocks(pos + 2, raw);
        if (next === null) break;
        const text = decoder.decode(new Uint8Array(raw)).trim();
        if (text) comments.push(text);
        pos = next;
      } else if (label === 0x01) {
        // Plain Text Extension — 13 fixed bytes (block size + geometry/color fields) then sub-blocks
        if (pos + 2 >= bytes.length) break;
        const blockSize = bytes[pos + 2];
        const subBlocksStart = pos + 3 + blockSize;
        const next = skipSubBlocks(subBlocksStart);
        if (next === null) break;
        pos = next;
      } else if (label === 0xff) {
        // Application Extension
        if (pos + 2 >= bytes.length) break;
        const blockSize = bytes[pos + 2]; // conventionally 11 (8-byte identifier + 3-byte auth code)
        if (pos + 3 + blockSize > bytes.length) break;
        const appHeader = decoder.decode(bytes.slice(pos + 3, pos + 3 + blockSize)).trim();
        if (appHeader) applications.push(appHeader);
        const next = skipSubBlocks(pos + 3 + blockSize);
        if (next === null) break;
        pos = next;
      } else {
        // An extension label this parser does not specifically know — GIF's
        // own spec guarantees every extension still uses the standard
        // sub-block sequence, so it can still be skipped safely.
        const next = skipSubBlocks(pos + 2);
        if (next === null) break;
        pos = next;
      }
    } else if (marker === 0x2c) {
      // Image Descriptor: separator(1) + left/top/width/height(2 each) + packed(1)
      if (pos + 9 >= bytes.length) break;
      const imgPacked = bytes[pos + 9];
      let p = pos + 10;
      if (imgPacked & 0x80) p += 3 * (2 ** ((imgPacked & 0x07) + 1)); // Local Color Table
      p += 1; // LZW minimum code size
      const next = skipSubBlocks(p);
      if (next === null) break;
      pos = next;
    } else {
      break; // not a recognised block marker — stop rather than guess
    }
  }

  return { comments, applications };
}

export function interpretGifInfo(gif: GifInfo | null): ProvenanceField[] {
  if (!gif) return [];
  const fields: ProvenanceField[] = [];
  fields.push({
    id: "gif.comment",
    label: "Comment",
    value: gif.comments.length ? gif.comments.join(" / ") : null,
    status: gif.comments.length ? "present" : "absent",
    origin: "GIF Comment Extension block(s)",
    note: "Free text embedded by whatever tool last saved this file — self-reported, not verified.",
    severity: gif.comments.length ? "notable" : "info",
  });
  fields.push({
    id: "gif.application",
    label: "Application extension",
    value: gif.applications.length ? gif.applications.join(", ") : null,
    status: gif.applications.length ? "present" : "absent",
    origin: "GIF Application Extension block(s)",
    note:
      "The 11-byte identifier+authentication code a tool stamps into the file — e.g. \"NETSCAPE2.0\" marks the " +
      "standard looping extension; other values name whatever software last wrote this file. XMP packets " +
      "embedded here (identifier \"XMP Data\") are not decoded — see this module's own header comment.",
    severity: "notable",
  });
  return fields;
}

// ─── Hidden / appended data detection (JPEG, PNG) ──────────────────────────
//
// A file whose container format has a well-defined end marker (JPEG's EOI,
// PNG's IEND chunk) can have arbitrary bytes appended after that marker
// without breaking the image — every viewer stops reading at the marker, so
// the appended bytes are invisible to a casual look and only found by
// walking the format's real structure to its documented end, the same
// "actually parse it, don't just sniff the head" discipline `sniffContainer`
// already applies to the FRONT of a file, applied here to what comes after
// its end. This is a real, well-known steganography/exfiltration technique
// (a ZIP or archive appended after a JPEG's EOI opens directly in most
// archive tools that scan backward from EOF for a central directory) — not
// hypothetical, and cheap to check for.
//
// Deliberately NOT attempted: pixel-level LSB steganography (needs a full
// pixel decode and has no honest way to distinguish "steganography" from
// "this photo has grain" without a reference), and interpreting *what* any
// found trailing data means beyond identifying its own magic bytes via
// `sniffContainerKind` — this reports a fact (N bytes after the real end,
// looking like format X), never a verdict about intent.

export interface TrailingDataInfo {
  /** Byte offset immediately after the format's real end marker. */
  endOffset: number;
  /** How many bytes exist past that marker. */
  trailingByteCount: number;
}

/**
 * Walks a JPEG's marker segments to find the REAL end-of-image marker,
 * distinct from any 0xFFD9-looking byte pair inside entropy-coded scan data.
 * Two traps a naive byte scan for `FF D9` gets wrong: byte-stuffing (a literal
 * 0xFF inside compressed data is always followed by a 0x00 pad byte, per the
 * JPEG spec, so `FF 00` must be skipped as one unit, not read as two) and
 * restart markers (0xFFD0–0xFFD7 are valid, expected byte pairs inside scan
 * data between restart intervals, not the image end). Returns null for a
 * non-JPEG buffer or one truncated before a real EOI is ever found — never a
 * guessed offset.
 */
export function parseJpegTrailer(bytes: Uint8Array): TrailingDataInfo | null {
  if (!bytesEqual(bytes, 0, [0xff, 0xd8])) return null; // SOI
  let pos = 2;
  while (pos + 1 < bytes.length) {
    if (bytes[pos] !== 0xff) return null; // not a marker where one was expected — malformed, don't guess
    const marker = bytes[pos + 1];
    if (marker === 0xd9) return { endOffset: pos + 2, trailingByteCount: bytes.length - (pos + 2) }; // EOI
    if (marker === 0xd8) {
      pos += 2; // stray SOI, no length field
      continue;
    }
    if (marker === 0xda) {
      // Start of Scan: a variable-length header (length-prefixed, as usual),
      // then raw entropy-coded data with NO length field — must be walked
      // byte-by-byte to its own end (the next real marker) rather than
      // skipped via a length this segment doesn't carry.
      if (pos + 3 >= bytes.length) break;
      const headerLen = readU16BE(bytes, pos + 2);
      let p = pos + 2 + headerLen;
      while (p + 1 < bytes.length) {
        if (bytes[p] === 0xff) {
          const next = bytes[p + 1];
          if (next === 0x00) {
            p += 2; // byte-stuffed literal 0xFF in scan data
            continue;
          }
          if (next >= 0xd0 && next <= 0xd7) {
            p += 2; // restart marker, still inside scan data
            continue;
          }
          // Any other marker ends this scan — resume the normal marker walk from here.
          break;
        }
        p += 1;
      }
      pos = p;
      continue;
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      pos += 2; // bare restart marker outside scan data — no length field
      continue;
    }
    // Every other marker is length-prefixed, and the length INCLUDES the two length bytes themselves.
    if (pos + 3 >= bytes.length) break;
    const segmentLen = readU16BE(bytes, pos + 2);
    pos += 2 + segmentLen;
  }
  return null; // ran out of buffer before a real EOI — truncated, not "no trailing data"
}

/**
 * Walks a PNG's chunk sequence (4-byte length + 4-byte type + data + 4-byte
 * CRC, per the PNG spec) to the mandatory IEND chunk. Unlike JPEG, PNG has no
 * embedded-entropy-data ambiguity — every chunk's length is authoritative —
 * so this is a straightforward walk, but still a real walk rather than a
 * fixed-offset guess, since chunk order/count before IEND is not fixed.
 */
export function parsePngTrailer(bytes: Uint8Array): TrailingDataInfo | null {
  if (!bytesEqual(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return null;
  let pos = 8;
  while (pos + 8 <= bytes.length) {
    const dataLen = readU32BE(bytes, pos);
    const type = readAscii(bytes, pos + 4, 4);
    const chunkEnd = pos + 8 + dataLen + 4; // length + type + data + CRC
    if (chunkEnd > bytes.length) break; // truncated mid-chunk
    if (type === "IEND") return { endOffset: chunkEnd, trailingByteCount: bytes.length - chunkEnd };
    pos = chunkEnd;
  }
  return null; // ran out of buffer before IEND — truncated, not "no trailing data"
}

/**
 * Turns a raw trailing-byte count into a field, identifying what the
 * trailing bytes themselves look like (via the same magic-byte table
 * `sniffContainer` uses for a whole file) so "appended data" becomes
 * "appended data that looks like a ZIP archive" wherever that's determinable
 * — still never a guess at INTENT, only at format.
 */
export function interpretTrailingData(formatLabel: string, info: TrailingDataInfo | null, trailingHead: Uint8Array | null): ProvenanceField {
  if (!info) {
    return {
      id: "container.trailingData",
      label: "Data after the image's end marker",
      value: null,
      status: "unreadable",
      origin: `Walking the file's ${formatLabel} structure to its documented end marker`,
      note: "This file's structure could not be walked to a real end marker — it may be truncated or malformed, which is itself worth noting for a redistributed file, but no trailing-byte count could be measured.",
      severity: "notable",
    };
  }
  if (info.trailingByteCount === 0) {
    return {
      id: "container.trailingData",
      label: "Data after the image's end marker",
      value: null,
      status: "absent",
      origin: `Walking the file's ${formatLabel} structure to its documented end marker`,
      note: "Checked: nothing follows the file's real end marker.",
      severity: "info",
    };
  }
  const identified = trailingHead ? sniffContainerKind(trailingHead) : "unknown";
  const identifiedNote = identified !== "unknown" ? ` The appended bytes' own magic-byte signature looks like: ${identified}.` : " The appended bytes match no known file signature this tool checks for.";
  return {
    id: "container.trailingData",
    label: "Data after the image's end marker",
    value: `${info.trailingByteCount} byte(s) appended after the real ${formatLabel} end marker`,
    status: "present",
    origin: `Walking the file's ${formatLabel} structure to its documented end marker`,
    note:
      "Every standard viewer stops reading at the format's end marker, so appended bytes are invisible to a normal " +
      "open — a known technique for smuggling a second file (commonly a ZIP archive) inside an image file." +
      identifiedNote +
      " This reports the fact of appended data, not what it means — confirm by extracting and inspecting it directly.",
    severity: "notable",
  };
}

// ─── MP3 / ID3 tag parsing ──────────────────────────────────────────────────
//
// ID3v2 (per id3.org's published spec) sits at the very start of the file:
// "ID3" + version(2 bytes: major, revision) + flags(1) + size(4, SYNCSAFE —
// each byte only uses its low 7 bits, matching MP3's own bitstream framing
// so a naive frame-sync scanner never mistakes tag data for audio). Frames
// follow: a 4-character ID (e.g. TIT2=title, TPE1=artist, TALB=album,
// TCON=genre, COMM=comment, TSSE=encoder software — a real "what tool made
// this file" signal) + a size field whose own encoding is VERSION-DEPENDENT
// — syncsafe in v2.4, but a PLAIN big-endian 32-bit integer in v2.3, a real,
// easy-to-get-wrong trap this parser branches on explicitly — + flags(2) +
// that many bytes of frame data. Text frames are prefixed with a 1-byte
// encoding marker (0=Latin-1, 1=UTF-16 with BOM, 2=UTF-16BE, 3=UTF-8).
//
// ID3v1 (a much older, simpler, fixed-size 128-byte tag at the very END of
// the file, starting "TAG") is parsed as a fallback for files with no ID3v2
// header — common on older or minimally-tagged files.

function readSyncsafeU32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] & 0x7f) << 21) | ((bytes[offset + 1] & 0x7f) << 14) | ((bytes[offset + 2] & 0x7f) << 7) | (bytes[offset + 3] & 0x7f);
}
function readU32BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function decodeId3Text(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  const encodingByte = bytes[0];
  const body = bytes.subarray(1);
  let text: string;
  if (encodingByte === 1 || encodingByte === 2) {
    // UTF-16 (with or without a leading BOM) — TextDecoder("utf-16le") only
    // handles the common little-endian case, which covers the vast majority
    // of real-world ID3v2 UTF-16 frames.
    text = new TextDecoder("utf-16le", { fatal: false }).decode(body);
  } else if (encodingByte === 3) {
    text = new TextDecoder("utf-8", { fatal: false }).decode(body);
  } else {
    text = new TextDecoder("iso-8859-1", { fatal: false }).decode(body); // Latin-1 (encoding byte 0)
  }
  // eslint-disable-next-line no-control-regex
  return text.replace(/\0+$/, "").trim();
}

export interface Id3v2Tags {
  version: string;
  frames: Record<string, string>;
}

export function parseId3v2Tags(bytes: Uint8Array): Id3v2Tags | null {
  if (readAscii(bytes, 0, 3) !== "ID3" || bytes.length < 10) return null;
  const majorVersion = bytes[3];
  const revision = bytes[4];
  const flags = bytes[5];
  const tagSize = readSyncsafeU32(bytes, 6);
  const tagEnd = Math.min(bytes.length, 10 + tagSize);

  let pos = 10;
  if (flags & 0x40) {
    // Extended header present — its own size field is syncsafe from v2.4
    // onward; v2.3's extended header size is a plain 32-bit integer, but its
    // presence is rare enough in practice that skipping it defensively (stop
    // rather than misparse) is the honest choice over guessing the encoding.
    if (majorVersion >= 4) {
      const extSize = readSyncsafeU32(bytes, pos);
      pos += extSize;
    } else {
      return { version: `2.${majorVersion}.${revision}`, frames: {} };
    }
  }

  const frames: Record<string, string> = {};
  while (pos + 10 <= tagEnd) {
    const frameId = readAscii(bytes, pos, 4);
    if (!/^[A-Z0-9]{4}$/.test(frameId)) break; // padding or corruption — stop cleanly
    const frameSize = majorVersion >= 4 ? readSyncsafeU32(bytes, pos + 4) : readU32BE(bytes, pos + 4);
    const frameDataStart = pos + 10;
    if (frameSize < 0 || frameDataStart + frameSize > tagEnd) break;
    const frameBytes = bytes.slice(frameDataStart, frameDataStart + frameSize);
    if (frameId.startsWith("T") || frameId === "COMM") {
      const text = frameId === "COMM" && frameBytes.length > 4 ? decodeId3Text(frameBytes.subarray(4)) : decodeId3Text(frameBytes); // COMM: encoding(1)+language(3)+short-description+text — the description is skipped, only the real comment text is kept
      if (text) frames[frameId] = text;
    }
    pos = frameDataStart + frameSize;
  }

  return { version: `2.${majorVersion}.${revision}`, frames };
}

const ID3V1_GENRES = [
  "Blues", "Classic Rock", "Country", "Dance", "Disco", "Funk", "Grunge", "Hip-Hop", "Jazz", "Metal", "New Age",
  "Oldies", "Other", "Pop", "R&B", "Rap", "Reggae", "Rock", "Techno", "Industrial", "Alternative", "Ska",
];

export interface Id3v1Tag {
  title: string | null;
  artist: string | null;
  album: string | null;
  year: string | null;
  comment: string | null;
  genre: string | null;
}

/** Reads the fixed 128-byte ID3v1 tag from the LAST 128 bytes of a file, if present. Caller passes just that tail slice. */
export function parseId3v1Tag(tail128: Uint8Array): Id3v1Tag | null {
  if (tail128.length !== 128 || readAscii(tail128, 0, 3) !== "TAG") return null;
  const latin1 = (offset: number, length: number): string | null => {
    const raw = new TextDecoder("iso-8859-1", { fatal: false }).decode(tail128.slice(offset, offset + length));
    const trimmed = raw.replace(/\0+$/, "").trim();
    return trimmed || null;
  };
  const genreIndex = tail128[127];
  return {
    title: latin1(3, 30),
    artist: latin1(33, 30),
    album: latin1(63, 30),
    year: latin1(93, 4),
    comment: latin1(97, 30),
    genre: genreIndex < ID3V1_GENRES.length ? ID3V1_GENRES[genreIndex] : null,
  };
}

const ID3V2_FRAME_FIELDS: [string, string, string, "info" | "notable"][] = [
  ["TIT2", "id3.title", "Title", "info"],
  ["TPE1", "id3.artist", "Artist", "info"],
  ["TALB", "id3.album", "Album", "info"],
  ["TCON", "id3.genre", "Genre", "info"],
  ["TYER", "id3.year", "Year", "info"],
  ["TDRC", "id3.recordingDate", "Recording date (as recorded, not a parsed timestamp)", "notable"],
  ["COMM", "id3.comment", "Comment", "info"],
  ["TENC", "id3.encodedBy", "Encoded by", "notable"],
  ["TSSE", "id3.softwareSettings", "Software / encoder settings", "notable"],
  ["TCOP", "id3.copyright", "Copyright", "info"],
  ["TPUB", "id3.publisher", "Publisher", "info"],
];

export function interpretId3Tags(v2: Id3v2Tags | null, v1: Id3v1Tag | null): ProvenanceField[] {
  const fields: ProvenanceField[] = [];
  fields.push(
    fieldFor(
      "id3.version",
      "ID3 tag version",
      v2 ? `ID3v${v2.version}` : v1 ? "ID3v1" : null,
      "File header",
      "The tagging format used — ID3v2 (near the start of the file) carries far more fields than the older, fixed-size ID3v1 (the last 128 bytes).",
      "info",
    ),
  );
  for (const [frameId, id, label, severity] of ID3V2_FRAME_FIELDS) {
    const value = v2?.frames[frameId] ?? null;
    fields.push(
      fieldFor(
        id,
        label,
        value,
        `ID3v2 ${frameId} frame`,
        label === "Software / encoder settings" || label === "Encoded by"
          ? "The application that wrote this file — a real fingerprint for how it was produced, editable like every other field here."
          : "A tag frame self-reported by the tagging application — editable with any ID3 editor.",
        severity,
      ),
    );
  }
  if (!v2 && v1) {
    // No ID3v2 tag — fall back to reporting whatever ID3v1 carries (a strict subset).
    fields.push(fieldFor("id3v1.title", "Title (ID3v1)", v1.title, "ID3v1 tag", "Self-reported, from the older fixed-size tag.", "info"));
    fields.push(fieldFor("id3v1.artist", "Artist (ID3v1)", v1.artist, "ID3v1 tag", "Self-reported, from the older fixed-size tag.", "info"));
    fields.push(fieldFor("id3v1.album", "Album (ID3v1)", v1.album, "ID3v1 tag", "Self-reported, from the older fixed-size tag.", "info"));
    fields.push(fieldFor("id3v1.year", "Year (ID3v1)", v1.year, "ID3v1 tag", "Self-reported, from the older fixed-size tag.", "info"));
    fields.push(fieldFor("id3v1.comment", "Comment (ID3v1)", v1.comment, "ID3v1 tag", "Self-reported, from the older fixed-size tag.", "info"));
    fields.push(fieldFor("id3v1.genre", "Genre (ID3v1)", v1.genre, "ID3v1 tag genre index", "A fixed 3-digit numeric code mapped to a name from the original 1990s ID3v1 genre list — not a free-text field.", "info"));
  }
  return fields;
}

// ─── Container sniffing ─────────────────────────────────────────────────────

function bytesEqual(bytes: Uint8Array, offset: number, expected: number[]): boolean {
  if (bytes.length < offset + expected.length) return false;
  for (let i = 0; i < expected.length; i += 1) if (bytes[offset + i] !== expected[i]) return false;
  return true;
}

const CONTAINER_EXTENSIONS: Record<string, ContainerKind[]> = {
  pdf: ["pdf"],
  docx: ["zip-unknown"],
  xlsx: ["zip-unknown"],
  pptx: ["zip-unknown"],
  odt: ["zip-unknown"],
  ods: ["zip-unknown"],
  odp: ["zip-unknown"],
  doc: ["ole2"],
  xls: ["ole2"],
  ppt: ["ole2"],
  jpg: ["image-jpeg"],
  jpeg: ["image-jpeg"],
  png: ["image-png"],
  gif: ["gif"],
  webp: ["riff-webp"],
  heic: ["iso-bmff-heif"],
  heif: ["iso-bmff-heif"],
  heics: ["iso-bmff-heif"],
  avif: ["iso-bmff-heif"],
  avifs: ["iso-bmff-heif"],
  mp4: ["iso-bmff"],
  mov: ["iso-bmff"],
  m4v: ["iso-bmff"],
  webm: ["ebml"],
  mkv: ["ebml"],
  avi: ["riff-avi"],
  wav: ["riff-wave"],
  wave: ["riff-wave"],
  mp3: ["mp3"],
};

/** ISO-BMFF major/compatible brands that mark a still-image (HEIF/AVIF) file rather than a video — see ISO/IEC 23008-12 and the AVIF spec. */
const HEIF_FTYP_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs", "mif1", "msf1", "avif", "avis"]);

/**
 * The pure magic-byte→kind identification core of `sniffContainer` below,
 * extracted so it can ALSO identify what a chunk of TRAILING data appended
 * after a file's real end actually is (see `interpretTrailingData`) — the
 * same signature table, reused, rather than a second copy that could drift.
 */
function sniffContainerKind(head: Uint8Array): ContainerKind {
  if (bytesEqual(head, 0, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "pdf"; // %PDF-
  if (
    bytesEqual(head, 0, [0x50, 0x4b, 0x03, 0x04]) ||
    bytesEqual(head, 0, [0x50, 0x4b, 0x05, 0x06]) ||
    bytesEqual(head, 0, [0x50, 0x4b, 0x07, 0x08])
  )
    return "zip-unknown"; // OOXML vs ODF resolved by classifyZipEntries once the zip is opened
  if (bytesEqual(head, 0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "ole2";
  if (bytesEqual(head, 0, [0xff, 0xd8, 0xff])) return "image-jpeg";
  if (bytesEqual(head, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image-png";
  if (bytesEqual(head, 0, [0x47, 0x49, 0x46, 0x38]) && (bytesEqual(head, 4, [0x37, 0x61]) || bytesEqual(head, 4, [0x39, 0x61])))
    return "gif"; // "GIF87a" or "GIF89a"
  if (bytesEqual(head, 0, [0x49, 0x44, 0x33])) return "mp3"; // "ID3" — ID3v2 header; a bare/ID3v1-only MP3 has no head-byte signature to sniff
  if (readAscii(head, 4, Math.min(4, Math.max(0, head.length - 4))) === "ftyp") {
    const majorBrand = readAscii(head, 8, Math.min(4, Math.max(0, head.length - 8)));
    return HEIF_FTYP_BRANDS.has(majorBrand) ? "iso-bmff-heif" : "iso-bmff";
  }
  if (bytesEqual(head, 0, [0x1a, 0x45, 0xdf, 0xa3])) return "ebml";
  if (readAscii(head, 0, Math.min(4, head.length)) === "RIFF") {
    const formType = readAscii(head, 8, Math.min(4, Math.max(0, head.length - 8)));
    if (formType === "AVI ") return "riff-avi";
    if (formType === "WAVE") return "riff-wave";
    if (formType === "WEBP") return "riff-webp";
  }
  return "unknown";
}

/** Identify a file's real container from its magic bytes — never trust the extension alone. */
export function sniffContainer(head: Uint8Array, fileName: string, declaredType: string): ContainerIdentity {
  const extMatch = /\.([a-z0-9]+)$/i.exec(fileName);
  const extension = extMatch ? extMatch[1].toLowerCase() : null;
  const kind = sniffContainerKind(head);

  const expected = extension ? CONTAINER_EXTENSIONS[extension] : undefined;
  const mismatch = Boolean(expected && !expected.includes(kind));
  const mismatchNote = mismatch
    ? `This file's actual content (detected as "${kind}") does not match what its ".${extension}" ` +
      "extension implies. This could mean a renamed file, a misidentified upload, or a genuine " +
      "container-format inconsistency — worth confirming before treating it as that file type."
    : null;

  return { kind, declaredType, fileName, extension, mismatch, mismatchNote };
}

/** ODF always has an uncompressed "mimetype" entry first; OOXML always has [Content_Types].xml. */
export function classifyZipEntries(entryNames: string[]): "ooxml" | "odf" | "zip-unknown" {
  if (entryNames.includes("mimetype")) return "odf";
  if (entryNames.some((n) => n === "[Content_Types].xml" || n.startsWith("docProps/"))) return "ooxml";
  return "zip-unknown";
}

// ─── Shared honesty surface ─────────────────────────────────────────────────

export const PDF_ABSENCE_NOTE =
  "Nothing in a PDF's metadata is cryptographically verified. Every field here is self-reported " +
  "by the writing application and is editable with ordinary, freely available tools. Treat all " +
  "of it as a claim about the file's history, never as proof of it.";

export const VIDEO_CONTAINER_ABSENCE_NOTE =
  "Video container metadata (creation time, device tags, GPS) is written by the recording " +
  "device or muxer and is not verified. It is commonly stripped or rewritten when a video is " +
  "transcoded or re-uploaded to a platform.";

export function cannotDetermineFor(kind: FileProvenanceKind): string[] {
  switch (kind) {
    case "pdf":
      return [
        PDF_ABSENCE_NOTE,
        "Revocation status of any signing certificate — chain-of-trust checks that a certificate resolves to a " +
          "root in the bundled Mozilla CA store, but a \"trusted\" chain does not by itself mean the certificate " +
          "wasn't later revoked. A real OCSP/CRL check is available as a separate, explicit opt-in action per " +
          "signature (see the Signature Revocation Check) — not run automatically, since it is the one exception " +
          "to this feature's fully local design. The trust store itself is a dated snapshot (2026-08-13), not a live registry.",
        "Signatures using SubFilters other than adbe.pkcs7.detached/ETSI.CAdES.detached, or ECDSA/DSA rather than " +
          "RSA — reported as \"not verified\", never guessed. The bundled trust store itself is RSA-only for the " +
          "same reason: 80 of the real Mozilla bundle's 121 root CAs parse (the rest are genuine ECDSA/Ed25519 " +
          "roots this tool's crypto layer does not read) — a chain through one of the other 41 reports " +
          "\"not checked\", never a guess either way.",
        "The exact software version behind an unrecognised Producer string.",
        "What an extracted JavaScript action actually DOES when run — its source is surfaced verbatim for a " +
          "human to read, never executed or evaluated by this tool.",
        "The content of earlier revisions in a file with more than one \"%%EOF\" marker — the count is reported, not the bytes.",
      ];
    case "ooxml":
      return [
        OOXML_ABSENCE_NOTE,
        "Whether this file has been edited since docProps was last written — revision/track-changes history is not read.",
        "The actual VBA source inside a detected vbaProject.bin — its presence is reported, not decompiled or read.",
      ];
    case "odf":
      return [OOXML_ABSENCE_NOTE, "Full edit history beyond the editing-cycles counter."];
    case "video":
      return [
        VIDEO_CONTAINER_ABSENCE_NOTE,
        "The video's spoken audio content — handled separately by Video Intelligence's transcription feature, not this report.",
      ];
    case "image":
      return [
        "EXIF/XMP fields are self-reported by the capturing device and editable. See the Image Intelligence provenance report for the full assessment.",
        "XMP embedded in a GIF (identifier \"XMP Data\") — GIF Comment/Application Extension text is read, but " +
          "this special, differently-encoded XMP convention is not decoded; see this module's own GIF section.",
        "Pixel-level steganography (LSB or other in-content encoding) — no full pixel decode is performed, and " +
          "there is no honest way to distinguish encoded data from ordinary image noise/grain without a reference. " +
          "Only appended bytes AFTER the image's real end marker (JPEG EOI / PNG IEND) are checked.",
      ];
    case "audio":
      return [
        "Tags (ID3, RIFF INFO) are self-reported by the encoding/tagging software and freely editable with " +
          "ordinary tools — never verified.",
        "The audio content itself — no waveform, spectral or speech analysis is performed here. See Video " +
          "Intelligence's audio spectral analysis and sound-event classification for that.",
        "An MP3 with neither an ID3v2 header nor a trailing ID3v1 tag — real but genuinely untagged files " +
          "exist, and are reported as having no readable tag, not as a read failure.",
      ];
    case "unsupported":
      return ["This container type is not parsed by this tool — see the report's errors for exactly why."];
  }
}

export interface FileProvenanceAssessment {
  findings: { label: string; detail: string; strength: "observed" | "absent" }[];
  cannotDetermine: string[];
  summary: string;
}

/**
 * Summarise a report. Mirrors imaging.ts's assessProvenance: an ordered list
 * of findings plus an explicit cannotDetermine[], and deliberately NO score
 * — a single number here would be read as an authenticity rating this data
 * cannot support.
 */
export function assessFileProvenance(report: FileProvenanceReport): FileProvenanceAssessment {
  const findings: FileProvenanceAssessment["findings"] = [];
  const notable = report.fields.filter((f) => f.severity === "notable" && f.status === "present");
  for (const f of notable) findings.push({ label: f.label, detail: `${f.value}. ${f.note}`, strength: "observed" });

  for (const e of report.errors) findings.push({ label: "Read error", detail: e, strength: "absent" });

  if (notable.length === 0 && report.errors.length === 0) {
    findings.push({
      label: "No notable metadata recovered",
      detail: "This file's embedded metadata carried nothing beyond common or absent fields.",
      strength: "absent",
    });
  }

  const cannotDetermine = report.cannotDetermine.length ? report.cannotDetermine : cannotDetermineFor(report.kind);
  const observed = findings.filter((f) => f.strength === "observed").length;
  const summary =
    observed > 0
      ? `${observed} notable metadata finding(s) recovered from this file. None of it is ` +
        "cryptographically verified — see below for what it can and cannot establish."
      : "No notable embedded metadata was recovered from this file. This is an absence of " +
        "information, not evidence about the file's origin.";

  return { findings, cannotDetermine, summary };
}

// ─── What is explicitly NOT implemented ────────────────────────────────────

export const FILE_PROVENANCE_NOT_IMPLEMENTED: Gap[] = [
  {
    capability: "Automatic, always-on PDF signature revocation checking (CRL/OCSP)",
    requires: "A live network call per signature to a certificate revocation endpoint — a real exception to " +
      "this feature's otherwise fully local, nothing-ever-leaves-the-browser-tab design, so it runs only when " +
      "an analyst explicitly opts in per signature, never automatically alongside the other, fully local checks.",
    limitation:
      "OCSP and CRL revocation checking ARE implemented and real when explicitly run (see the Signature " +
      "Revocation Check action) — a real OCSP request is built and verified against the issuing certificate " +
      "authority's own key, and a CRL is fetched and checked for the certificate's serial number. Two honest " +
      "limits: very large CRLs (tens of thousands of revoked-certificate entries, common among major commercial " +
      "CAs) fail to parse — a confirmed, real limitation of the ASN.1 library used here, reported as \"could not " +
      "be parsed\" rather than a false \"not revoked\"; and the network request itself reveals to the " +
      "certificate authority (and, as a proxying hop, to this application's own server) which certificate is " +
      "being checked. Chain-of-trust against a bundled Mozilla root-CA store still runs automatically and " +
      "locally for every signature, unaffected by any of this.",
  },
  {
    capability: "PDF JavaScript / VBA macro behavior analysis",
    requires: "A real JavaScript interpreter (for PDF actions) or VBA decompiler+sandbox (for Office macros), " +
      "run against genuinely hostile input — a correctness-critical, security-sensitive component this feature " +
      "does not attempt to build or vendor.",
    limitation:
      "Hidden PDF actions (/OpenAction, /JavaScript, /Launch, /SubmitForm, /ImportData) and Office VBA macro " +
      "projects (vbaProject.bin) ARE detected, and PDF JavaScript source is extracted and shown verbatim for a " +
      "human to read. Neither is executed, decompiled, or scored — this tool reports presence and (for PDF JS) " +
      "source text only, never a verdict about what the code does when run.",
  },
  {
    capability: "Pixel-level image steganography (LSB / in-content encoding) detection",
    requires: "A full pixel decode plus a reference-free statistical model that can separate encoded data from " +
      "ordinary sensor noise, compression artefacts and image grain — no such honest distinction exists without a " +
      "known-clean reference image, the same reference-corpus requirement pHash near-duplicate matching already " +
      "has and cannot bypass here either.",
    limitation:
      "Only bytes appended AFTER a JPEG's real end-of-image marker or a PNG's IEND chunk are detected — a real, " +
      "well-known technique (a second file, e.g. a ZIP archive, appended past the format's own end) that every " +
      "standard viewer ignores. Data encoded into the pixel values themselves is not attempted and would not be found.",
  },
];
