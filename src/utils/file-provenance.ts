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
  | "ebml"
  | "riff-avi"
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

export type FileProvenanceKind = "pdf" | "ooxml" | "odf" | "image" | "video" | "unsupported";

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
        `This PDF contains ${ctx.signatureFieldCount} digital signature field(s). Signature ` +
        "validation is not implemented here — the presence of a signature field is not evidence " +
        "that the signature is valid.",
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
  mp4: ["iso-bmff"],
  mov: ["iso-bmff"],
  m4v: ["iso-bmff"],
  webm: ["ebml"],
  mkv: ["ebml"],
  avi: ["riff-avi"],
};

/** Identify a file's real container from its magic bytes — never trust the extension alone. */
export function sniffContainer(head: Uint8Array, fileName: string, declaredType: string): ContainerIdentity {
  const extMatch = /\.([a-z0-9]+)$/i.exec(fileName);
  const extension = extMatch ? extMatch[1].toLowerCase() : null;

  let kind: ContainerKind = "unknown";
  if (bytesEqual(head, 0, [0x25, 0x50, 0x44, 0x46, 0x2d])) kind = "pdf"; // %PDF-
  else if (
    bytesEqual(head, 0, [0x50, 0x4b, 0x03, 0x04]) ||
    bytesEqual(head, 0, [0x50, 0x4b, 0x05, 0x06]) ||
    bytesEqual(head, 0, [0x50, 0x4b, 0x07, 0x08])
  )
    kind = "zip-unknown"; // OOXML vs ODF resolved by classifyZipEntries once the zip is opened
  else if (bytesEqual(head, 0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) kind = "ole2";
  else if (bytesEqual(head, 0, [0xff, 0xd8, 0xff])) kind = "image-jpeg";
  else if (bytesEqual(head, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) kind = "image-png";
  else if (readAscii(head, 4, Math.min(4, Math.max(0, head.length - 4))) === "ftyp") kind = "iso-bmff";
  else if (bytesEqual(head, 0, [0x1a, 0x45, 0xdf, 0xa3])) kind = "ebml";
  else if (readAscii(head, 0, Math.min(4, head.length)) === "RIFF" && readAscii(head, 8, Math.min(4, Math.max(0, head.length - 8))) === "AVI ")
    kind = "riff-avi";

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
        "Whether a digital signature, if present, is cryptographically valid — only signature-field presence is reported, not validity.",
        "The exact software version behind an unrecognised Producer string.",
      ];
    case "ooxml":
      return [
        OOXML_ABSENCE_NOTE,
        "Whether this file has been edited since docProps was last written — revision/track-changes history is not read.",
        "Legacy binary Office files (.doc/.xls/.ppt, OLE2 format) — a different container, not parsed here.",
      ];
    case "odf":
      return [OOXML_ABSENCE_NOTE, "Full edit history beyond the editing-cycles counter."];
    case "video":
      return [
        VIDEO_CONTAINER_ABSENCE_NOTE,
        "The video's spoken audio content — handled separately by Video Intelligence's transcription feature, not this report.",
        "WebM/MKV container internals (EBML tag parsing is not implemented — see the gap list).",
      ];
    case "image":
      return ["EXIF/XMP fields are self-reported by the capturing device and editable. See the Image Intelligence provenance report for the full assessment."];
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
    capability: "PDF digital signature validation",
    requires: "A CMS/PKCS#7 signature verifier and a certificate-chain trust store.",
    limitation:
      "Only signature-FIELD presence is reported (how many /FT /Sig fields exist). Whether any " +
      "signature actually validates against its certificate is not checked — do not read " +
      "\"N signature field(s)\" as \"N valid signatures\".",
  },
  {
    capability: "Legacy binary Office files (.doc/.xls/.ppt — OLE2/CFBF format)",
    requires: "A Compound File Binary Format (CFBF) parser, a different container from OOXML's zip-of-XML.",
    limitation: "These files are detected and named as OLE2, but their internal metadata streams are not read.",
  },
  {
    capability: "WebM/MKV (EBML) container metadata",
    requires: "An EBML element-tree parser for Segment/Info (MuxingApp, WritingApp, DateUTC).",
    limitation:
      "The container is identified as EBML/WebM/MKV, but its metadata is not extracted. DateUTC " +
      "in this format uses yet a third epoch (nanoseconds since 2001-01-01), distinct from both " +
      "Unix and the QuickTime epoch this module already handles for ISO-BMFF.",
  },
  {
    capability: "RIFF/AVI container metadata",
    requires: "A RIFF chunk walker for the INFO list chunk.",
    limitation: "The container is identified as RIFF/AVI, but its INFO chunk metadata is not extracted.",
  },
];
