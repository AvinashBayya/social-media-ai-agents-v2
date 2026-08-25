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
  interpretOdfMeta,
  interpretOfficeDocument,
  interpretPdfDates,
  interpretPdfInfoDict,
  interpretVideoContainer,
  parseIlstTags,
  parseIsoBmffBoxes,
  parseMvhd,
  parseOdfMeta,
  parseOoxmlAppProps,
  parseOoxmlCoreProps,
  parseOoxmlCustomProps,
  parseXmpPacket,
  sniffContainer,
  type ContainerIdentity,
  type FileProvenanceReport,
  type ProvenanceField,
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
  ".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp,.jpg,.jpeg,.png,.mp4,.mov,.m4v,.webm,.mkv,.avi," +
  "application/pdf,image/jpeg,image/png,video/mp4,video/quicktime,video/webm,video/x-matroska,video/x-msvideo";

/** How many header bytes to sniff. Comfortably covers every magic-byte check in sniffContainer. */
const SNIFF_HEAD_BYTES = 64;

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
        return unsupportedReport(container, extractedAt, [
          "Detected as an OLE2 Compound File — either a legacy binary Office document " +
            "(.doc/.xls/.ppt) or a password-protected OOXML file (which stores its content " +
            "encrypted inside an OLE2 wrapper). Neither is parsed by this tool; a CFBF parser " +
            "would be needed for the former, and the password for the latter.",
        ]);
      case "image-jpeg":
      case "image-png":
        return await readImageProvenance(file, container, extractedAt);
      case "iso-bmff":
        return await readVideoContainerProvenance(file, container, extractedAt);
      case "ebml":
        return unsupportedReport(container, extractedAt, [
          "Detected as EBML (WebM/MKV) — container metadata parsing for this format is not " +
            "implemented. See the Not Implemented list.",
        ]);
      case "riff-avi":
        return unsupportedReport(container, extractedAt, [
          "Detected as RIFF/AVI — container metadata parsing for this format is not implemented. " +
            "See the Not Implemented list.",
        ]);
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

// ─── PDF ─────────────────────────────────────────────────────────────────

export async function readPdfProvenance(
  file: Blob,
  container: ContainerIdentity,
  extractedAt: string,
): Promise<FileProvenanceReport> {
  const { PDFDocument, PDFDict, PDFName, PDFArray, PDFStream, PDFRawStream, decodePDFRawStream } = await import("pdf-lib");
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
          if (ft?.toString() === "/Sig") signatureFieldCount += 1;
        }
      }
    }
  } catch {
    // An unusual /AcroForm shape just means signature fields can't be counted — not fatal.
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

  const timestamps = isEncrypted ? [] : interpretPdfDates(entries);

  const raw: { label: string; text: string }[] = [];
  let xmpFields: ProvenanceField[] = [];
  if (xmpXml) {
    raw.push({ label: "XMP packet", text: xmpXml });
    xmpFields = xmpFieldsFrom(parseXmpPacket(xmpXml));
  }

  return {
    kind: "pdf",
    container,
    fields: [...infoFields, ...xmpFields],
    timestamps,
    raw,
    errors,
    cannotDetermine: cannotDetermineFor("pdf"),
    method:
      "PDF Info dictionary and embedded XMP packet, read via pdf-lib (updateMetadata: false, so " +
      "pdf-lib's own writer identity is never substituted for the file's real Producer/ModDate) " +
      "plus this project's own PDF-date and XMP parsers.",
    extractedAt,
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

  let unzipped: Record<string, Uint8Array>;
  try {
    // The filter inflates ONLY the matched entries — a multi-MB word/document.xml
    // never gets decompressed, keeping this fast regardless of file content size.
    unzipped = unzipSync(bytes, { filter: (f) => OOXML_WANTED_ENTRIES.has(f.name) });
  } catch (err: any) {
    return unsupportedReport(container, extractedAt, [
      `This zip-based file could not be opened: ${err?.message ?? String(err)}`,
    ]);
  }

  const decode = (name: string): string | null =>
    unzipped[name] ? new TextDecoder("utf-8", { fatal: false }).decode(unzipped[name]) : null;
  const classification = classifyZipEntries(Object.keys(unzipped));

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
        fields: [],
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
      fields: interpretOfficeDocument(core, app, custom),
      timestamps: [],
      raw,
      errors: appXml
        ? []
        : ["This file has no docProps/app.xml — common for files exported from Google Docs, which never write it."],
      cannotDetermine: cannotDetermineFor("ooxml"),
      method:
        "OOXML docProps/core.xml, app.xml and custom.xml, read via fflate (only these entries are " +
        "ever inflated) + this project's own XML scanner.",
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

  const decoderDurationSeconds = await new Promise<number | null>((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    const url = URL.createObjectURL(file);
    const cleanup = () => URL.revokeObjectURL(url);
    const timeout = setTimeout(() => {
      cleanup();
      resolve(null);
    }, 8000);
    video.onloadedmetadata = () => {
      clearTimeout(timeout);
      const d = Number.isFinite(video.duration) ? video.duration : null;
      cleanup();
      resolve(d);
    };
    video.onerror = () => {
      clearTimeout(timeout);
      cleanup();
      resolve(null);
    };
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

  return {
    kind: "image",
    container,
    fields,
    timestamps: [],
    raw: [],
    errors,
    cannotDetermine: cannotDetermineFor("image"),
    method:
      "Reuses Module 4's existing EXIF (exifr) and C2PA (contentauth WASM) extraction verbatim. " +
      "For the full analysis — including pHash near-duplicate matching against the collected " +
      "corpus — continue in Image Intelligence.",
    extractedAt,
  };
}

export { assessFileProvenance };
