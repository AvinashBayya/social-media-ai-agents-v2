import { describe, expect, test } from "bun:test";
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
  parseCfbfHeader,
  parseEbmlContainer,
  parseEbmlElements,
  parseGifBlocks,
  parseId3v1Tag,
  parseId3v2Tags,
  parseIlstTags,
  parseIso6709,
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
  parseRiffChunks,
  parseRiffContainer,
  parseXmpPacket,
  readCfbfStream,
  sniffContainer,
  type FileProvenanceReport,
} from "../src/utils/file-provenance";

// ─── PDF date parsing ───────────────────────────────────────────────────────

describe("parsePdfDate", () => {
  test("full precision with a UTC offset yields an absolute instant", () => {
    const t = parsePdfDate("id", "label", "origin", "D:20240301103000+05'30'");
    expect(t.precision).toBe("second");
    expect(t.offset).toBe("+05:30");
    expect(t.local).toBe("2024-03-01 10:30:00");
    expect(t.absolute).toBe(new Date("2024-03-01T10:30:00+05:30").toISOString());
  });

  test("Z offset normalises to +00:00", () => {
    const t = parsePdfDate("id", "label", "origin", "D:20240301103000Z");
    expect(t.offset).toBe("+00:00");
    expect(t.absolute).not.toBeNull();
  });

  test("year-only value never invents a month, day or time", () => {
    const t = parsePdfDate("id", "label", "origin", "D:2024");
    expect(t.precision).toBe("year");
    expect(t.offset).toBeNull();
    expect(t.absolute).toBeNull();
    // The display placeholder must not be mistaken for a recorded value —
    // covered by the note text, not a separate field, so assert the note
    // actually says so.
    expect(t.note.toLowerCase()).toContain("year-level precision");
  });

  test("month-level truncation is reported as month precision, not day", () => {
    const t = parsePdfDate("id", "label", "origin", "D:202403");
    expect(t.precision).toBe("month");
    expect(t.absolute).toBeNull();
  });

  test("a full date with no time component is day precision, and invents no time or offset", () => {
    const t = parsePdfDate("id", "label", "origin", "D:20240302");
    expect(t.precision).toBe("day");
    expect(t.offset).toBeNull();
    expect(t.absolute).toBeNull();
    expect(t.note.toLowerCase()).toContain("day-level precision");
  });

  test("no offset recorded leaves absolute null and says so", () => {
    const t = parsePdfDate("id", "label", "origin", "D:20240301103000");
    expect(t.precision).toBe("second");
    expect(t.offset).toBeNull();
    expect(t.absolute).toBeNull();
    expect(t.note).toContain("No UTC offset was recorded");
  });

  test("a malformed date string is reported as unparseable, not silently dropped", () => {
    const t = parsePdfDate("id", "label", "origin", "not a date");
    expect(t.local).toBeNull();
    expect(t.offset).toBeNull();
    expect(t.absolute).toBeNull();
    expect(t.precision).toBeNull();
    expect(t.raw).toBe("not a date");
  });

  test("missing D: prefix is still accepted (some writers omit it)", () => {
    const t = parsePdfDate("id", "label", "origin", "20240301103000+0530");
    expect(t.precision).toBe("second");
    expect(t.offset).toBe("+05:30");
  });
});

// ─── PDF Info dictionary ────────────────────────────────────────────────────

describe("interpretPdfInfoDict", () => {
  test("standard fields present render as present with real values", () => {
    const fields = interpretPdfInfoDict(
      { Author: "Wg Cdr A. Sharma", Creator: "Microsoft Word", Producer: "Acrobat Distiller 23.0" },
      { isEncrypted: false, pageCount: 3, signatureFieldCount: 0 },
    );
    const author = fields.find((f) => f.id === "pdf.author")!;
    expect(author.status).toBe("present");
    expect(author.value).toBe("Wg Cdr A. Sharma");
    const producer = fields.find((f) => f.id === "pdf.producer")!;
    expect(producer.severity).toBe("notable");
  });

  test("missing standard fields render as absent, not blank", () => {
    const fields = interpretPdfInfoDict({}, { isEncrypted: false, pageCount: null, signatureFieldCount: 0 });
    const author = fields.find((f) => f.id === "pdf.author")!;
    expect(author.status).toBe("absent");
    expect(author.value).toBeNull();
  });

  test("non-standard keys (e.g. /Company) are surfaced as additional entries", () => {
    const fields = interpretPdfInfoDict(
      { Company: "HQ Western Air Command", SourceModified: "D:20240301100000" },
      { isEncrypted: false, pageCount: null, signatureFieldCount: 0 },
    );
    const extra = fields.filter((f) => f.id.startsWith("pdf.extra."));
    expect(extra.length).toBe(2);
    expect(extra.map((f) => f.value).sort()).toEqual(["D:20240301100000", "HQ Western Air Command"].sort());
  });

  test("encrypted PDFs get an explicit warning field", () => {
    const fields = interpretPdfInfoDict(
      { Author: "possibly ciphertext" },
      { isEncrypted: true, pageCount: null, signatureFieldCount: 0 },
    );
    const enc = fields.find((f) => f.id === "pdf.encrypted")!;
    expect(enc.value).toBe("Encrypted");
    expect(enc.note.toLowerCase()).toContain("ciphertext");
  });

  test("signature fields are counted, pointing to the real per-signature cryptographic check rather than claiming validity itself", () => {
    const fields = interpretPdfInfoDict({}, { isEncrypted: false, pageCount: null, signatureFieldCount: 2 });
    const sig = fields.find((f) => f.id === "pdf.signatures")!;
    expect(sig.value).toBe("2");
    // This function only counts fields — it never itself asserts a signature is valid; the real
    // cryptographic check is a separate, per-signature field built in file-provenance-client.ts.
    expect(sig.note.toLowerCase()).toContain("cryptographic validity");
  });
});

describe("interpretPdfDates", () => {
  test("returns a timestamp for each date field present", () => {
    const dates = interpretPdfDates({ CreationDate: "D:20240301103000+05'30'", ModDate: "D:20240302090000+05'30'" });
    expect(dates.map((d) => d.id).sort()).toEqual(["pdf.created", "pdf.modified"]);
  });

  test("returns nothing for fields that are absent", () => {
    expect(interpretPdfDates({})).toEqual([]);
  });
});

// ─── XMP ─────────────────────────────────────────────────────────────────

describe("parseXmpPacket", () => {
  test("reads element-form properties with the doc's own bound prefix", () => {
    const xml = `<x:xmpmeta xmlns:x="adobe:ns:meta/">
      <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
        <rdf:Description><xmp:CreatorTool>Adobe Illustrator 28.0</xmp:CreatorTool></rdf:Description>
      </rdf:RDF></x:xmpmeta>`;
    const result = parseXmpPacket(xml);
    expect(result.values["xmp:CreatorTool"]).toBe("Adobe Illustrator 28.0");
  });

  test("reads attribute-form properties too", () => {
    const xml = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
      <rdf:Description xmp:CreatorTool="Scribus 1.6.1"/></rdf:RDF>`;
    const result = parseXmpPacket(xml);
    expect(result.values["xmp:CreatorTool"]).toBe("Scribus 1.6.1");
  });

  test("handles a non-default prefix binding for the same namespace URI (xap: instead of xmp:)", () => {
    const xml = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:xap="http://ns.adobe.com/xap/1.0/">
      <rdf:Description><xap:CreatorTool>Old Adobe Tool</xap:CreatorTool></rdf:Description></rdf:RDF>`;
    const result = parseXmpPacket(xml);
    expect(result.values["xmp:CreatorTool"]).toBe("Old Adobe Tool");
  });

  test("unwraps rdf:Alt / rdf:li wrappers for multi-value properties", () => {
    const xml = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <rdf:Description><dc:title><rdf:Alt><rdf:li xml:lang="x-default">Operational Brief</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF>`;
    const result = parseXmpPacket(xml);
    expect(result.values["dc:title"]).toBe("Operational Brief");
  });

  test("decodes XML entities", () => {
    const xml = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <rdf:Description><dc:title>Ops &amp; Intel &lt;Draft&gt;</dc:title></rdf:Description></rdf:RDF>`;
    const result = parseXmpPacket(xml);
    expect(result.values["dc:title"]).toBe("Ops & Intel <Draft>");
  });

  test("extracts xmpMM:DocumentID and OriginalDocumentID separately", () => {
    const xml = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/">
      <rdf:Description xmpMM:DocumentID="xmp.did:abc123" xmpMM:OriginalDocumentID="xmp.did:orig456"/></rdf:RDF>`;
    const result = parseXmpPacket(xml);
    expect(result.documentId).toBe("xmp.did:abc123");
    expect(result.originalDocumentId).toBe("xmp.did:orig456");
  });

  test("parses xmpMM:History edit-chain entries", () => {
    const xml = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/" xmlns:stEvt="http://ns.adobe.com/xap/1.0/sType/ResourceEvent#">
      <rdf:Description><xmpMM:History><rdf:Seq>
        <rdf:li stEvt:action="saved" stEvt:softwareAgent="Adobe Acrobat 24.0" stEvt:when="2024-03-01T10:30:00Z"/>
      </rdf:Seq></xmpMM:History></rdf:Description></rdf:RDF>`;
    const result = parseXmpPacket(xml);
    expect(result.history.length).toBe(1);
    expect(result.history[0]).toEqual({ action: "saved", softwareAgent: "Adobe Acrobat 24.0", when: "2024-03-01T10:30:00Z" });
  });

  test("a property genuinely absent from the packet returns null, not an empty string", () => {
    const xml = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"></rdf:RDF>`;
    const result = parseXmpPacket(xml);
    expect(result.values["xmp:CreatorTool"]).toBeNull();
    expect(result.documentId).toBeNull();
  });
});

// ─── OOXML ───────────────────────────────────────────────────────────────

const CORE_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/">
  <dc:creator>Sqn Ldr R. Iyer</dc:creator>
  <cp:lastModifiedBy>Wg Cdr A. Sharma</cp:lastModifiedBy>
  <dc:title>Operational Summary</dc:title>
  <cp:revision>4</cp:revision>
  <dcterms:created xsi:type="dcterms:W3CDTF">2024-03-01T10:30:00Z</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">2024-03-02T09:00:00Z</dcterms:modified>
</cp:coreProperties>`;

const APP_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
  <Application>Microsoft Office Word</Application>
  <AppVersion>16.0300</AppVersion>
  <Company>HQ Western Air Command</Company>
  <TotalTime>145</TotalTime>
</Properties>`;

const CUSTOM_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="Classification"><vt:lpwstr>RESTRICTED</vt:lpwstr></property>
</Properties>`;

describe("OOXML parsing", () => {
  test("parseOoxmlCoreProps reads dc:/cp:/dcterms: fields", () => {
    const core = parseOoxmlCoreProps(CORE_XML);
    expect(core.creator).toBe("Sqn Ldr R. Iyer");
    expect(core.lastModifiedBy).toBe("Wg Cdr A. Sharma");
    expect(core.title).toBe("Operational Summary");
    expect(core.revision).toBe("4");
    expect(core.created).toBe("2024-03-01T10:30:00Z");
  });

  test("parseOoxmlAppProps reads unprefixed app.xml fields", () => {
    const app = parseOoxmlAppProps(APP_XML);
    expect(app.application).toBe("Microsoft Office Word");
    expect(app.company).toBe("HQ Western Air Command");
    expect(app.totalTime).toBe("145");
  });

  test("parseOoxmlCustomProps extracts name/value pairs, including classification markings", () => {
    const custom = parseOoxmlCustomProps(CUSTOM_XML);
    expect(custom).toEqual([{ name: "Classification", value: "RESTRICTED" }]);
  });

  test("missing core.xml fields render as absent, e.g. a Google-Docs export with no app.xml at all", () => {
    const core = parseOoxmlCoreProps(`<cp:coreProperties xmlns:cp="x" xmlns:dc="y"></cp:coreProperties>`);
    expect(core.creator).toBeNull();
    expect(core.lastModifiedBy).toBeNull();
  });

  test("interpretOfficeDocument flags lastModifiedBy as notable only when it differs from the original creator", () => {
    const core = parseOoxmlCoreProps(CORE_XML);
    const app = parseOoxmlAppProps(APP_XML);
    const custom = parseOoxmlCustomProps(CUSTOM_XML);
    const fields = interpretOfficeDocument(core, app, custom);
    const lmb = fields.find((f) => f.id === "ooxml.lastModifiedBy")!;
    expect(lmb.severity).toBe("notable");
    expect(lmb.note).toContain("differs from the original author");
  });

  test("interpretOfficeDocument does NOT flag lastModifiedBy as notable when it matches the creator", () => {
    const core = { ...parseOoxmlCoreProps(CORE_XML), lastModifiedBy: "Sqn Ldr R. Iyer" };
    const fields = interpretOfficeDocument(core, null, []);
    const lmb = fields.find((f) => f.id === "ooxml.lastModifiedBy")!;
    expect(lmb.severity).toBe("info");
  });

  test("custom properties surface as notable fields", () => {
    const core = parseOoxmlCoreProps(CORE_XML);
    const custom = parseOoxmlCustomProps(CUSTOM_XML);
    const fields = interpretOfficeDocument(core, null, custom);
    const cls = fields.find((f) => f.id === "ooxml.custom.Classification")!;
    expect(cls.value).toBe("RESTRICTED");
    expect(cls.severity).toBe("notable");
  });
});

// ─── ODF ─────────────────────────────────────────────────────────────────

const ODF_META_XML = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta xmlns:office="urn" xmlns:meta="urn:meta" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <office:meta>
    <meta:initial-creator>Sqn Ldr R. Iyer</meta:initial-creator>
    <dc:creator>Sqn Ldr R. Iyer</dc:creator>
    <meta:generator>LibreOffice/7.4.5.2</meta:generator>
    <meta:editing-cycles>7</meta:editing-cycles>
    <dc:date>2024-03-02T09:00:00Z</dc:date>
  </office:meta>
</office:document-meta>`;

describe("ODF parsing", () => {
  test("parseOdfMeta reads meta:/dc: fields", () => {
    const meta = parseOdfMeta(ODF_META_XML);
    expect(meta.initialCreator).toBe("Sqn Ldr R. Iyer");
    expect(meta.generator).toBe("LibreOffice/7.4.5.2");
    expect(meta.editingCycles).toBe("7");
  });

  test("interpretOdfMeta does not flag identical creator/initial-creator as notable", () => {
    const meta = parseOdfMeta(ODF_META_XML);
    const fields = interpretOdfMeta(meta);
    const creator = fields.find((f) => f.id === "odf.creator")!;
    expect(creator.severity).toBe("info");
  });
});

describe("classifyZipEntries", () => {
  test("identifies OOXML by [Content_Types].xml / docProps", () => {
    expect(classifyZipEntries(["[Content_Types].xml", "docProps/core.xml", "word/document.xml"])).toBe("ooxml");
  });
  test("identifies ODF by the uncompressed mimetype entry", () => {
    expect(classifyZipEntries(["mimetype", "content.xml", "meta.xml"])).toBe("odf");
  });
  test("an unrecognised zip is neither", () => {
    expect(classifyZipEntries(["readme.txt", "data.bin"])).toBe("zip-unknown");
  });
});

// ─── ISO-BMFF box walking ───────────────────────────────────────────────────

function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}
function ascii4(s: string): number[] {
  return [s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)];
}
function box(type: string, payload: number[]): number[] {
  return [...u32(8 + payload.length), ...ascii4(type), ...payload];
}

describe("parseIsoBmffBoxes", () => {
  test("walks a sequence of normal-sized boxes", () => {
    const bytes = new Uint8Array([...box("ftyp", [1, 2, 3, 4]), ...box("moov", [5, 6])]);
    const boxes = parseIsoBmffBoxes(bytes);
    expect(boxes.map((b) => b.type)).toEqual(["ftyp", "moov"]);
    expect(boxes[0].size).toBe(12);
    expect(boxes[1].start).toBe(12);
  });

  test("size 0 means the box extends to the end of the buffer", () => {
    const bytes = new Uint8Array([...u32(0), ...ascii4("mdat"), 1, 2, 3, 4, 5]);
    const boxes = parseIsoBmffBoxes(bytes);
    expect(boxes.length).toBe(1);
    expect(boxes[0].size).toBe(bytes.length);
  });

  test("size 1 reads a 64-bit largesize from the next 8 bytes", () => {
    const largesize = [0, 0, 0, 0, 0, 0, 0, 24]; // 24 as a 64-bit big-endian value
    const bytes = new Uint8Array([...u32(1), ...ascii4("mdat"), ...largesize, 1, 2, 3, 4, 5, 6, 7, 8]);
    const boxes = parseIsoBmffBoxes(bytes);
    expect(boxes.length).toBe(1);
    expect(boxes[0].headerSize).toBe(16);
    expect(boxes[0].size).toBe(24);
  });

  test("a truncated/corrupt buffer stops cleanly rather than reading out of bounds", () => {
    const bytes = new Uint8Array([...u32(999), ...ascii4("moov")]); // claims 999 bytes but buffer is only 8
    const boxes = parseIsoBmffBoxes(bytes);
    expect(boxes).toEqual([]);
  });
});

describe("parseMvhd", () => {
  test("version 0: converts real 1904-epoch seconds to the correct Unix instant", () => {
    // 2024-03-01T10:30:00Z is 3789995400 seconds after 1904-01-01, per the
    // QuickTime epoch offset of 2082844800 seconds.
    const creation = Math.floor(new Date("2024-03-01T10:30:00Z").getTime() / 1000) + 2082844800;
    const payload = new Uint8Array([0, 0, 0, 0, ...u32(creation), ...u32(creation), ...u32(600), ...u32(1200)]);
    const mvhd = parseMvhd(payload)!;
    expect(mvhd.version).toBe(0);
    expect(new Date(mvhd.creationTimeMs!).toISOString()).toBe("2024-03-01T10:30:00.000Z");
  });

  test("a raw value of 0 means 'not set' and must NOT render as 1904-01-01", () => {
    const payload = new Uint8Array([0, 0, 0, 0, ...u32(0), ...u32(0), ...u32(600), ...u32(1200)]);
    const mvhd = parseMvhd(payload)!;
    expect(mvhd.creationTimeMs).toBeNull();
    expect(mvhd.modificationTimeMs).toBeNull();
  });

  test("returns null for a payload too short to contain a valid mvhd body", () => {
    expect(parseMvhd(new Uint8Array([0, 0, 0]))).toBeNull();
  });
});

describe("parseIlstTags", () => {
  test("extracts a string tag from a data sub-box", () => {
    const text = "Lavf58.29.100";
    const textBytes = Array.from(new TextEncoder().encode(text));
    const dataBox = box("data", [0, 0, 0, 1, 0, 0, 0, 0, ...textBytes]); // type indicator(4)+locale(4)+text
    const tooBox = box("©too", dataBox);
    const bytes = new Uint8Array(tooBox);
    const tags = parseIlstTags(bytes);
    expect(tags["©too"]).toBe(text);
  });

  test("returns an empty object when no data sub-box is present", () => {
    const bytes = new Uint8Array(box("©nam", [1, 2, 3]));
    expect(parseIlstTags(bytes)).toEqual({});
  });
});

describe("parseIso6709", () => {
  test("parses latitude+longitude", () => {
    const loc = parseIso6709("+28.6139+077.2090/")!;
    expect(loc.latitude).toBeCloseTo(28.6139, 4);
    expect(loc.longitude).toBeCloseTo(77.209, 4);
    expect(loc.altitude).toBeNull();
  });

  test("parses an optional altitude component", () => {
    const loc = parseIso6709("+28.6139+077.2090+216.000/")!;
    expect(loc.altitude).toBeCloseTo(216, 1);
  });

  test("rejects out-of-range coordinates rather than accepting garbage", () => {
    expect(parseIso6709("+999.0+077.2090/")).toBeNull();
  });

  test("rejects an unparseable string", () => {
    expect(parseIso6709("not a location")).toBeNull();
  });
});

describe("interpretVideoContainer", () => {
  test("a full field set renders creation time, GPS, tracks and codecs", () => {
    const fields = interpretVideoContainer({
      ftypBrand: "qt  ",
      mvhd: { creationTimeMs: Date.parse("2024-03-01T10:30:00Z"), modificationTimeMs: null, timescale: 600, duration: 1200, version: 0 },
      ilst: { "©too": "Lavf58.29.100", "©xyz": "+28.6139+077.2090/" },
      handlerTypes: ["vide", "soun"],
      codecs: ["avc1", "mp4a"],
      decoderDurationSeconds: 12.5,
      moovTruncated: false,
    });
    expect(fields.find((f) => f.id === "video.creation_time")!.status).toBe("present");
    expect(fields.find((f) => f.id === "video.gps")!.value).toContain("28.6139");
    expect(fields.find((f) => f.id === "video.tracks")!.value).toBe("video, audio");
    expect(fields.find((f) => f.id === "video.decoder_duration")!.value).toBe("12.50s");
  });

  test("no mvhd at all is reported unreadable, not absent", () => {
    const fields = interpretVideoContainer({
      ftypBrand: null,
      mvhd: null,
      ilst: {},
      handlerTypes: [],
      codecs: [],
      decoderDurationSeconds: null,
      moovTruncated: false,
    });
    expect(fields.find((f) => f.id === "video.mvhd")!.status).toBe("unreadable");
  });

  test("moov truncation is surfaced as its own field", () => {
    const fields = interpretVideoContainer({
      ftypBrand: null,
      mvhd: null,
      ilst: {},
      handlerTypes: [],
      codecs: [],
      decoderDurationSeconds: null,
      moovTruncated: true,
    });
    expect(fields.find((f) => f.id === "video.moov_truncated")!.value).toBe("yes");
  });
});

// ─── Container sniffing ─────────────────────────────────────────────────────

describe("sniffContainer", () => {
  test("identifies a real PDF by magic bytes", () => {
    const head = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
    const id = sniffContainer(head, "report.pdf", "application/pdf");
    expect(id.kind).toBe("pdf");
    expect(id.mismatch).toBe(false);
  });

  test("identifies a zip signature (OOXML/ODF undetermined at this layer)", () => {
    const head = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    const id = sniffContainer(head, "report.docx", "application/vnd...");
    expect(id.kind).toBe("zip-unknown");
    expect(id.mismatch).toBe(false);
  });

  test("identifies OLE2 (legacy binary Office / encrypted OOXML)", () => {
    const head = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const id = sniffContainer(head, "old.doc", "application/msword");
    expect(id.kind).toBe("ole2");
  });

  test("identifies an ISO-BMFF (mp4/mov) file via the ftyp box", () => {
    const head = new Uint8Array([0, 0, 0, 0x20, ...ascii4("ftyp"), ...ascii4("isom")]);
    const id = sniffContainer(head, "clip.mp4", "video/mp4");
    expect(id.kind).toBe("iso-bmff");
  });

  test("flags a real mismatch — a PDF renamed to .jpg", () => {
    const head = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
    const id = sniffContainer(head, "photo.jpg", "image/jpeg");
    expect(id.mismatch).toBe(true);
    expect(id.mismatchNote).toContain("pdf");
  });

  test("no mismatch flagged when the extension has no strict expectation", () => {
    const head = new Uint8Array([0xff, 0xd8, 0xff]);
    const id = sniffContainer(head, "photo.jpg", "image/jpeg");
    expect(id.mismatch).toBe(false);
  });
});

// ─── Assessment / honesty surface ───────────────────────────────────────────

function baseReport(overrides: Partial<FileProvenanceReport> = {}): FileProvenanceReport {
  return {
    kind: "pdf",
    container: { kind: "pdf", declaredType: "application/pdf", fileName: "a.pdf", extension: "pdf", mismatch: false, mismatchNote: null },
    fields: [],
    timestamps: [],
    raw: [],
    errors: [],
    cannotDetermine: [],
    method: "test",
    extractedAt: "2024-03-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("assessFileProvenance", () => {
  test("surfaces notable present fields as observed findings", () => {
    const report = baseReport({
      fields: [
        { id: "a", label: "Author", value: "X", status: "present", origin: "o", note: "n", severity: "notable" },
        { id: "b", label: "Title", value: "Y", status: "present", origin: "o", note: "n", severity: "info" },
      ],
    });
    const a = assessFileProvenance(report);
    expect(a.findings.length).toBe(1);
    expect(a.findings[0].strength).toBe("observed");
  });

  test("errors become absent-strength findings, distinct from a normal absence", () => {
    const report = baseReport({ errors: ["The PDF structure could not be parsed."] });
    const a = assessFileProvenance(report);
    expect(a.findings.some((f) => f.label === "Read error")).toBe(true);
  });

  test("nothing notable and no errors reports an explicit absence, not an empty list", () => {
    const report = baseReport();
    const a = assessFileProvenance(report);
    expect(a.findings.length).toBe(1);
    expect(a.findings[0].strength).toBe("absent");
    expect(a.summary).toContain("No notable embedded metadata");
  });

  test("falls back to cannotDetermineFor(kind) when the report didn't set its own", () => {
    const report = baseReport({ kind: "ooxml", cannotDetermine: [] });
    const a = assessFileProvenance(report);
    expect(a.cannotDetermine).toEqual(cannotDetermineFor("ooxml"));
  });
});

describe("cannotDetermineFor", () => {
  test("every kind returns at least one real statement", () => {
    for (const kind of ["pdf", "ooxml", "odf", "video", "image", "audio", "unsupported"] as const) {
      expect(cannotDetermineFor(kind).length).toBeGreaterThan(0);
    }
  });
});

// ─── RIFF / AVI container parsing ───────────────────────────────────────────

function u32le(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}
function riffChunk(id: string, data: number[]): number[] {
  const padded = data.length % 2 === 1 ? [...data, 0] : data;
  return [...ascii4(id), ...u32le(data.length), ...padded];
}
function nullTerminated(s: string): number[] {
  return [...Array.from(new TextEncoder().encode(s)), 0];
}

describe("parseRiffChunks", () => {
  test("walks a sequence of chunks, honouring odd-size padding", () => {
    const bytes = new Uint8Array([...riffChunk("abcd", [1, 2, 3]), ...riffChunk("efgh", [4, 5])]);
    const chunks = parseRiffChunks(bytes, 0, bytes.length);
    expect(chunks.map((c) => c.id)).toEqual(["abcd", "efgh"]);
    expect(chunks[0].size).toBe(3);
    // "abcd": 8-byte header + 3 data bytes + 1 pad byte = 12 bytes before "efgh" starts.
    expect(chunks[1].dataStart).toBe(12 + 8);
  });

  test("a truncated/corrupt buffer stops cleanly rather than reading out of bounds", () => {
    const bytes = new Uint8Array([...ascii4("XXXX"), ...u32le(999)]); // claims 999 bytes, buffer far shorter
    expect(parseRiffChunks(bytes, 0, bytes.length)).toEqual([]);
  });
});

describe("parseRiffContainer", () => {
  test("extracts real INFO tags from a well-formed AVI file", () => {
    const infoContent = [
      ...ascii4("INFO"),
      ...riffChunk("ISFT", nullTerminated("Lavf60.3.100")),
      ...riffChunk("INAM", nullTerminated("Test clip")),
    ];
    const body = [...ascii4("AVI "), ...riffChunk("LIST", infoContent)];
    const bytes = new Uint8Array([...ascii4("RIFF"), ...u32le(body.length), ...body]);
    const riff = parseRiffContainer(bytes)!;
    expect(riff.formType).toBe("AVI ");
    expect(riff.tags.ISFT).toBe("Lavf60.3.100");
    expect(riff.tags.INAM).toBe("Test clip");
  });

  test("returns null for a non-RIFF buffer", () => {
    expect(parseRiffContainer(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toBeNull();
  });

  test("a file with no LIST/INFO chunk yields empty tags, not an error", () => {
    const body = [...ascii4("AVI "), ...riffChunk("hdrl", [1, 2, 3, 4])];
    const bytes = new Uint8Array([...ascii4("RIFF"), ...u32le(body.length), ...body]);
    expect(parseRiffContainer(bytes)!.tags).toEqual({});
  });
});

describe("interpretRiffContainer", () => {
  test("maps a known tag to a labelled, present field and an absent tag to a real absence", () => {
    const fields = interpretRiffContainer({ formType: "AVI ", tags: { ISFT: "Lavf60.3.100" } });
    const software = fields.find((f) => f.id === "riff.software")!;
    expect(software.value).toBe("Lavf60.3.100");
    expect(software.status).toBe("present");
    expect(software.severity).toBe("notable");
    const title = fields.find((f) => f.id === "riff.title")!;
    expect(title.status).toBe("absent");
  });

  test("null input yields no fields, not a crash", () => {
    expect(interpretRiffContainer(null)).toEqual([]);
  });
});

// ─── EBML / WebM / MKV (Matroska) container parsing ────────────────────────

const EBML_ID = {
  segment: [0x18, 0x53, 0x80, 0x67],
  info: [0x15, 0x49, 0xa9, 0x66],
  muxingApp: [0x4d, 0x80],
  writingApp: [0x57, 0x41],
  dateUtc: [0x44, 0x61],
  title: [0x7b, 0xa9],
};

/** Encodes `value` as a real EBML size VINT — smallest length that avoids the reserved all-1s ("unknown size") pattern, unless `forceLength` is given. */
function ebmlSize(value: number, forceLength?: number): number[] {
  let len = forceLength ?? 1;
  if (!forceLength) while (value >= 2 ** (7 * len) - 1) len += 1;
  const marker = 1 << (8 - len);
  const bytes = new Array(len).fill(0);
  let v = value;
  for (let i = len - 1; i >= 0; i -= 1) {
    bytes[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  bytes[0] |= marker;
  return bytes;
}
function ebmlElement(idBytes: number[], payload: number[]): number[] {
  return [...idBytes, ...ebmlSize(payload.length), ...payload];
}
function i64beBytes(value: bigint): number[] {
  let v = value < 0n ? value + (1n << 64n) : value; // two's-complement encode
  const bytes = new Array(8);
  for (let i = 7; i >= 0; i -= 1) {
    bytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return bytes;
}
function nsAfterMatroskaEpoch(iso: string): bigint {
  return BigInt(Date.parse(iso) - Date.UTC(2001, 0, 1)) * 1_000_000n;
}

describe("parseEbmlElements", () => {
  test("walks a nested element using real variable-length IDs and sizes", () => {
    const child = ebmlElement(EBML_ID.muxingApp, Array.from(new TextEncoder().encode("libwebm")));
    const parent = ebmlElement(EBML_ID.info, child);
    const els = parseEbmlElements(new Uint8Array(parent), 0, parent.length);
    expect(els.length).toBe(1);
    expect(els[0].id).toBe(0x1549a966);
  });

  test("an 'unknown size' element (all-1s size VINT) is bounded to the buffer end, never treated as a literal huge number", () => {
    const unknownSize = [0xff]; // 1-byte all-data-bits-set VINT = spec-legal "unknown size"
    const payload = [1, 2, 3, 4, 5];
    const bytes = new Uint8Array([...EBML_ID.segment, ...unknownSize, ...payload]);
    const els = parseEbmlElements(bytes, 0, bytes.length);
    expect(els.length).toBe(1);
    expect(els[0].dataSize).toBe(payload.length);
  });

  test("a truncated/corrupt buffer stops cleanly rather than reading out of bounds", () => {
    const bytes = new Uint8Array([...EBML_ID.info, ...ebmlSize(500)]); // claims 500 bytes, none present
    expect(parseEbmlElements(bytes, 0, bytes.length)).toEqual([]);
  });
});

describe("parseEbmlContainer", () => {
  test("extracts MuxingApp, WritingApp, Title and a real DateUTC from a real Segment/Info structure", () => {
    const infoChildren = [
      ...ebmlElement(EBML_ID.muxingApp, Array.from(new TextEncoder().encode("libwebm"))),
      ...ebmlElement(EBML_ID.writingApp, Array.from(new TextEncoder().encode("Lavf60.3.100"))),
      ...ebmlElement(EBML_ID.title, Array.from(new TextEncoder().encode("Test Video"))),
      ...ebmlElement(EBML_ID.dateUtc, i64beBytes(nsAfterMatroskaEpoch("2024-03-01T10:30:00.000Z"))),
    ];
    const segment = ebmlElement(EBML_ID.segment, ebmlElement(EBML_ID.info, infoChildren));
    const parsed = parseEbmlContainer(new Uint8Array(segment))!;
    expect(parsed.muxingApp).toBe("libwebm");
    expect(parsed.writingApp).toBe("Lavf60.3.100");
    expect(parsed.title).toBe("Test Video");
    expect(new Date(parsed.dateUtcMs!).toISOString()).toBe("2024-03-01T10:30:00.000Z");
  });

  test("returns null when there is no Segment element at all", () => {
    expect(parseEbmlContainer(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });

  test("a Segment with no Info returns real nulls, not a thrown error", () => {
    const segment = ebmlElement(EBML_ID.segment, [1, 2, 3]);
    const parsed = parseEbmlContainer(new Uint8Array(segment))!;
    expect(parsed.muxingApp).toBeNull();
    expect(parsed.dateUtcMs).toBeNull();
  });

  test("a DateUTC before the 2001 epoch (a negative signed value) is decoded correctly, proving real two's-complement handling", () => {
    const info = ebmlElement(EBML_ID.info, ebmlElement(EBML_ID.dateUtc, i64beBytes(nsAfterMatroskaEpoch("1999-06-15T00:00:00.000Z"))));
    const segment = ebmlElement(EBML_ID.segment, info);
    const parsed = parseEbmlContainer(new Uint8Array(segment))!;
    expect(new Date(parsed.dateUtcMs!).toISOString()).toBe("1999-06-15T00:00:00.000Z");
  });
});

describe("interpretEbmlContainer", () => {
  test("labels WritingApp as notable and states DateUTC's genuinely-UTC distinction from mvhd", () => {
    const fields = interpretEbmlContainer({
      muxingApp: "libwebm",
      writingApp: "Lavf60.3.100",
      title: null,
      dateUtcMs: Date.parse("2024-03-01T10:30:00Z"),
    });
    const writingApp = fields.find((f) => f.id === "ebml.writingApp")!;
    expect(writingApp.severity).toBe("notable");
    const dateField = fields.find((f) => f.id === "ebml.dateUtc")!;
    expect(dateField.note).toContain("genuinely UTC");
    expect(dateField.status).toBe("present");
  });

  test("a null DateUTC renders absent, never a fabricated epoch date", () => {
    const fields = interpretEbmlContainer({ muxingApp: null, writingApp: null, title: null, dateUtcMs: null });
    const dateField = fields.find((f) => f.id === "ebml.dateUtc")!;
    expect(dateField.status).toBe("absent");
    expect(dateField.value).toBeNull();
  });

  test("null input yields no fields, not a crash", () => {
    expect(interpretEbmlContainer(null)).toEqual([]);
  });
});

// ─── OLE2 / CFBF (legacy .doc/.xls/.ppt) + MS-OLEPS property sets ──────────

function cfbfU32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}
function cfbfU16(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff];
}
function padTo(bytes: number[], len: number): number[] {
  const out = bytes.slice(0, len);
  while (out.length < len) out.push(0);
  return out;
}
function lpstrValue(s: string): number[] {
  const strBytes = [...Array.from(new TextEncoder().encode(s)), 0]; // null-terminated
  return [...cfbfU32(30 /* VT_LPSTR */), ...cfbfU32(strBytes.length), ...strBytes];
}
function filetimeValue(iso: string): number[] {
  const ms = Date.parse(iso) - (-11644473600000); // ms since 1601-01-01
  const ticks = BigInt(ms) * 10000n;
  const low = Number(ticks & 0xffffffffn);
  const high = Number(ticks >> 32n);
  return [...cfbfU32(64 /* VT_FILETIME */), ...cfbfU32(low), ...cfbfU32(high)];
}
/** Builds a real, correctly-offset-tabled MS-OLEPS PropertySetStream — the same layout parseOlepsPropertySet expects, letting property values be tested in isolation from the CFBF sector/FAT machinery around them. */
function buildPropertySetStream(properties: { id: number; valueBytes: number[] }[]): number[] {
  const pairsSize = properties.length * 8;
  let cursor = 8 + pairsSize; // 4(size)+4(numProps)+pairs, before value bytes start
  const offsets: number[] = [];
  const valuesBytes: number[] = [];
  for (const p of properties) {
    offsets.push(cursor);
    valuesBytes.push(...p.valueBytes);
    cursor += p.valueBytes.length;
  }
  const pairs = properties.flatMap((p, i) => [...cfbfU32(p.id), ...cfbfU32(offsets[i])]);
  const propertySet = [...cfbfU32(cursor), ...cfbfU32(properties.length), ...pairs, ...valuesBytes];
  const offset0 = 48;
  const streamHeader = [
    ...cfbfU16(0xfffe),
    ...cfbfU16(0),
    ...cfbfU32(0),
    ...new Array(16).fill(0), // CLSID, unchecked by the parser
    ...cfbfU32(1), // NumPropertySets
    ...new Array(16).fill(0), // FMTID0, unchecked — streams are told apart by NAME, not FMTID
    ...cfbfU32(offset0),
  ];
  return [...streamHeader, ...propertySet];
}
function cfbfDirEntry(name: string, objectType: number, startSector: number, streamSize: number): number[] {
  const nameUtf16: number[] = [];
  for (const ch of name) nameUtf16.push(ch.charCodeAt(0) & 0xff, (ch.charCodeAt(0) >> 8) & 0xff);
  nameUtf16.push(0, 0);
  const entry = new Array(128).fill(0);
  const nameField = padTo(nameUtf16, 64);
  for (let i = 0; i < 64; i += 1) entry[i] = nameField[i];
  entry[64] = nameUtf16.length & 0xff;
  entry[65] = (nameUtf16.length >> 8) & 0xff;
  entry[66] = objectType;
  const startBytes = cfbfU32(startSector);
  for (let i = 0; i < 4; i += 1) entry[116 + i] = startBytes[i];
  const sizeBytes = cfbfU32(streamSize);
  for (let i = 0; i < 4; i += 1) entry[120 + i] = sizeBytes[i];
  return entry;
}
function cfbfHeaderBytes(opts: {
  numFatSectors: number;
  firstDirSector: number;
  miniStreamCutoff: number;
  firstMiniFatSector: number;
  numMiniFatSectors: number;
}): number[] {
  const header = new Array(512).fill(0);
  const sig = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  for (let i = 0; i < 8; i += 1) header[i] = sig[i];
  header[30] = 9; // sectorShift -> 512-byte sectors
  header[32] = 6; // miniSectorShift -> 64-byte mini sectors
  const setU32 = (off: number, v: number) => {
    const b = cfbfU32(v);
    for (let i = 0; i < 4; i += 1) header[off + i] = b[i];
  };
  setU32(44, opts.numFatSectors);
  setU32(48, opts.firstDirSector);
  setU32(56, opts.miniStreamCutoff);
  setU32(60, opts.firstMiniFatSector);
  setU32(64, opts.numMiniFatSectors);
  setU32(68, 0xfffffffe); // firstDifatSector: no chained DIFAT needed, one FAT sector fits in the header's 109 entries
  setU32(72, 0);
  setU32(76, 0); // DIFAT entry 0 -> FAT lives at regular sector 0
  for (let i = 1; i < 109; i += 1) setU32(76 + i * 4, 0xffffffff);
  return header;
}

describe("parseCfbfHeader", () => {
  test("reads real sector-size and FAT/directory locations", () => {
    const header = cfbfHeaderBytes({ numFatSectors: 1, firstDirSector: 1, miniStreamCutoff: 4096, firstMiniFatSector: 0xfffffffe, numMiniFatSectors: 0 });
    const parsed = parseCfbfHeader(new Uint8Array(header))!;
    expect(parsed.sectorSize).toBe(512);
    expect(parsed.miniSectorSize).toBe(64);
    expect(parsed.firstDirSector).toBe(1);
  });

  test("returns null for a buffer too short to hold a real header", () => {
    expect(parseCfbfHeader(new Uint8Array(100))).toBeNull();
  });
});

describe("parseOlepsPropertySet", () => {
  test("decodes LPSTR, FILETIME and I4 properties from real, correctly-offset-tabled bytes", () => {
    const stream = buildPropertySetStream([
      { id: 2, valueBytes: lpstrValue("Test Doc") }, // Title
      { id: 4, valueBytes: lpstrValue("Jane Doe") }, // Author
      { id: 12, valueBytes: filetimeValue("2024-03-01T10:30:00.000Z") }, // CreateDateTime
    ]);
    const props = parseOlepsPropertySet(new Uint8Array(stream))!;
    expect(props.get(2)).toBe("Test Doc");
    expect(props.get(4)).toBe("Jane Doe");
    expect(new Date(props.get(12) as number).toISOString()).toBe("2024-03-01T10:30:00.000Z");
  });

  test("a FILETIME of exactly 0 (both halves) is treated as 'not set', never rendered as 1601-01-01", () => {
    const stream = buildPropertySetStream([{ id: 12, valueBytes: [...cfbfU32(64), ...cfbfU32(0), ...cfbfU32(0)] }]);
    const props = parseOlepsPropertySet(new Uint8Array(stream))!;
    expect(props.get(12)).toBeNull();
  });

  test("returns null for a buffer with the wrong byte-order marker", () => {
    const stream = buildPropertySetStream([{ id: 2, valueBytes: lpstrValue("x") }]);
    stream[0] = 0x00; // corrupt the 0xFFFE marker
    expect(parseOlepsPropertySet(new Uint8Array(stream))).toBeNull();
  });
});

describe("readCfbfStream", () => {
  test("regular-sector path: reads a stream whose declared size is at or above the mini-stream cutoff", () => {
    const propSet = buildPropertySetStream([{ id: 2, valueBytes: lpstrValue("Test Doc") }]);
    const header = cfbfHeaderBytes({ numFatSectors: 1, firstDirSector: 1, miniStreamCutoff: 4, firstMiniFatSector: 0xfffffffe, numMiniFatSectors: 0 });

    const fat = new Array(128).fill(0xffffffff);
    fat[0] = 0xfffffffd; // FATSECT: sector 0 holds the FAT itself
    fat[1] = 0xfffffffe; // directory: one sector, ends there
    fat[2] = 0xfffffffe; // SummaryInformation data: one sector, ends there
    const fatSector = padTo(fat.flatMap(cfbfU32), 512);

    const dirSector = padTo(
      [...cfbfDirEntry("Root Entry", 5, 0xfffffffe, 0), ...cfbfDirEntry("\x05SummaryInformation", 2, 2, propSet.length)],
      512,
    );
    const dataSector = padTo(propSet, 512);

    const file = new Uint8Array([...header, ...fatSector, ...dirSector, ...dataSector]);
    const stream = readCfbfStream(file, "\x05SummaryInformation")!;
    expect(stream).not.toBeNull();
    expect(stream.length).toBe(propSet.length);
    const props = parseOlepsPropertySet(stream)!;
    expect(props.get(2)).toBe("Test Doc");
  });

  test("mini-stream path: reads a stream below the cutoff via the mini-FAT — the common real-world case, since SummaryInformation is almost always small", () => {
    const propSet = buildPropertySetStream([{ id: 4, valueBytes: lpstrValue("Jane Doe") }]);
    // 2 mini-sectors (64 bytes each) comfortably holds this small property set.
    const miniStreamLength = 128;
    expect(propSet.length).toBeLessThanOrEqual(miniStreamLength);

    const header = cfbfHeaderBytes({ numFatSectors: 1, firstDirSector: 1, miniStreamCutoff: 4096, firstMiniFatSector: 3, numMiniFatSectors: 1 });

    const fat = new Array(128).fill(0xffffffff);
    fat[0] = 0xfffffffd; // FAT sector
    fat[1] = 0xfffffffe; // directory
    fat[2] = 0xfffffffe; // root's mini-stream data (fits in one regular sector)
    fat[3] = 0xfffffffe; // the mini-FAT's own regular sector
    const fatSector = padTo(fat.flatMap(cfbfU32), 512);

    const dirSector = padTo(
      [
        ...cfbfDirEntry("Root Entry", 5, 2, miniStreamLength), // root's mini-stream lives at regular sector 2
        ...cfbfDirEntry("\x05SummaryInformation", 2, 0, propSet.length), // startSector 0 is now a MINI-sector index
      ],
      512,
    );

    const miniStreamDataSector = padTo(propSet, 512); // the mini-stream's bytes, spanning mini-sectors 0 and 1 within this one regular sector

    const miniFat = new Array(128).fill(0xffffffff);
    miniFat[0] = 1; // mini-sector 0 chains to mini-sector 1
    miniFat[1] = 0xfffffffe; // mini-sector 1 ends the chain
    const miniFatSector = padTo(miniFat.flatMap(cfbfU32), 512);

    const file = new Uint8Array([...header, ...fatSector, ...dirSector, ...miniStreamDataSector, ...miniFatSector]);
    const stream = readCfbfStream(file, "\x05SummaryInformation")!;
    expect(stream).not.toBeNull();
    expect(stream.length).toBe(propSet.length);
    const props = parseOlepsPropertySet(stream)!;
    expect(props.get(4)).toBe("Jane Doe");
  });

  test("returns null for a stream name that does not exist in the file", () => {
    const header = cfbfHeaderBytes({ numFatSectors: 1, firstDirSector: 1, miniStreamCutoff: 4096, firstMiniFatSector: 0xfffffffe, numMiniFatSectors: 0 });
    const fat = new Array(128).fill(0xffffffff);
    fat[0] = 0xfffffffd;
    fat[1] = 0xfffffffe;
    const fatSector = padTo(fat.flatMap(cfbfU32), 512);
    const dirSector = padTo([...cfbfDirEntry("Root Entry", 5, 0xfffffffe, 0)], 512);
    const file = new Uint8Array([...header, ...fatSector, ...dirSector]);
    expect(readCfbfStream(file, "\x05SummaryInformation")).toBeNull();
  });

  test("returns null for a buffer that is not a real CFBF file", () => {
    expect(readCfbfStream(new Uint8Array(600), "\x05SummaryInformation")).toBeNull();
  });
});

describe("interpretCfbfDocument", () => {
  test("flags a differing last-saved-by as notable, matching the OOXML/ODF convention", () => {
    const summary = new Map<number, string | number | boolean | null>([
      [4, "Original Author"],
      [8, "Someone Else"],
    ]);
    const { fields } = interpretCfbfDocument({ summary, docSummary: null });
    const lastSaved = fields.find((f) => f.id === "cfbf.lastAuthor")!;
    expect(lastSaved.severity).toBe("notable");
    expect(lastSaved.note).toContain("second identity");
  });

  test("converts a real FILETIME into a genuinely-UTC ProvenanceTimestamp", () => {
    const summary = new Map<number, string | number | boolean | null>([[12, Date.parse("2024-03-01T10:30:00.000Z")]]);
    const { timestamps } = interpretCfbfDocument({ summary, docSummary: null });
    const created = timestamps.find((t) => t.id === "cfbf.created")!;
    expect(created.absolute).toBe("2024-03-01T10:30:00.000Z");
    expect(created.offset).toBe("+00:00");
  });

  test("company (DocumentSummaryInformation) renders as a notable organisational fingerprint", () => {
    const docSummary = new Map<number, string | number | boolean | null>([[15, "Acme Corp"]]);
    const { fields } = interpretCfbfDocument({ summary: null, docSummary });
    const company = fields.find((f) => f.id === "cfbf.company")!;
    expect(company.value).toBe("Acme Corp");
    expect(company.severity).toBe("notable");
  });

  test("both maps null yields real absences throughout, not a crash", () => {
    const { fields, timestamps } = interpretCfbfDocument({ summary: null, docSummary: null });
    expect(fields.every((f) => f.status === "absent")).toBe(true);
    expect(timestamps).toEqual([]);
  });
});

// ─── RIFF top-level chunk finder (WebP EXIF/XMP) ────────────────────────────

describe("findRiffChunkBytes", () => {
  test("finds a real top-level chunk by FourCC, distinct from LIST/INFO sub-chunks", () => {
    const exifData = [1, 2, 3, 4, 5];
    const body = [...ascii4("WEBP"), ...riffChunk("VP8 ", [9, 9]), ...riffChunk("EXIF", exifData)];
    const bytes = new Uint8Array([...ascii4("RIFF"), ...u32le(body.length), ...body]);
    const found = findRiffChunkBytes(bytes, "EXIF")!;
    expect(Array.from(found)).toEqual(exifData);
  });

  test("returns null for a chunk that is not present", () => {
    const body = [...ascii4("WEBP"), ...riffChunk("VP8 ", [9, 9])];
    const bytes = new Uint8Array([...ascii4("RIFF"), ...u32le(body.length), ...body]);
    expect(findRiffChunkBytes(bytes, "XMP ")).toBeNull();
  });

  test("returns null for a non-RIFF buffer", () => {
    expect(findRiffChunkBytes(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), "EXIF")).toBeNull();
  });
});

// ─── GIF (GIF87a/GIF89a) container parsing ─────────────────────────────────

function gifHeader(version: "87a" | "89a" = "89a"): number[] {
  return [...Array.from(new TextEncoder().encode(`GIF${version}`))];
}
function gifLsd(hasGct = false): number[] {
  return [1, 0, 1, 0, hasGct ? 0x80 : 0x00, 0, 0]; // 1x1, no/yes GCT (size irrelevant here), bg index 0, aspect 0
}
function gifSubBlocks(data: number[]): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    const chunk = data.slice(i, i + 255);
    out.push(chunk.length, ...chunk);
    i += chunk.length;
  }
  out.push(0);
  return out;
}
function gifCommentExtension(text: string): number[] {
  return [0x21, 0xfe, ...gifSubBlocks(Array.from(new TextEncoder().encode(text)))];
}
function gifApplicationExtension(header11: string, subBlockData: number[] = [3, 1, 0, 0]): number[] {
  const headerBytes = Array.from(new TextEncoder().encode(header11));
  return [0x21, 0xff, headerBytes.length, ...headerBytes, ...gifSubBlocks(subBlockData)];
}
function gifImageDescriptor(): number[] {
  // separator + left/top/width/height(2 each) + packed(no LCT) + LZW min code size + one data sub-block + terminator
  return [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x00, 2, ...gifSubBlocks([0x00, 0x01])];
}

describe("parseGifBlocks", () => {
  test("extracts a real Comment Extension", () => {
    const bytes = new Uint8Array([...gifHeader(), ...gifLsd(), ...gifCommentExtension("Made with Sentinel AI"), 0x3b]);
    const gif = parseGifBlocks(bytes)!;
    expect(gif.comments).toEqual(["Made with Sentinel AI"]);
  });

  test("extracts a real Application Extension identifier+auth code (e.g. the standard looping extension)", () => {
    const bytes = new Uint8Array([...gifHeader(), ...gifLsd(), ...gifApplicationExtension("NETSCAPE2.0"), 0x3b]);
    const gif = parseGifBlocks(bytes)!;
    expect(gif.applications).toEqual(["NETSCAPE2.0"]);
  });

  test("walks past an Image Descriptor + real LZW image data correctly to reach a later Comment Extension", () => {
    const bytes = new Uint8Array([...gifHeader(), ...gifLsd(), ...gifImageDescriptor(), ...gifCommentExtension("after the image"), 0x3b]);
    const gif = parseGifBlocks(bytes)!;
    expect(gif.comments).toEqual(["after the image"]);
  });

  test("a file with no extensions yields empty comments/applications, not an error", () => {
    const bytes = new Uint8Array([...gifHeader(), ...gifLsd(), ...gifImageDescriptor(), 0x3b]);
    const gif = parseGifBlocks(bytes)!;
    expect(gif.comments).toEqual([]);
    expect(gif.applications).toEqual([]);
  });

  test("a truncated buffer mid-extension stops cleanly rather than reading out of bounds", () => {
    const full = new Uint8Array([...gifHeader(), ...gifLsd(), ...gifCommentExtension("this will be cut off"), 0x3b]);
    const truncated = full.slice(0, full.length - 10);
    expect(() => parseGifBlocks(truncated)).not.toThrow();
  });

  test("returns null for a non-GIF buffer", () => {
    expect(parseGifBlocks(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull();
  });
});

describe("interpretGifInfo", () => {
  test("maps comments and applications to labelled, notable fields", () => {
    const fields = interpretGifInfo({ comments: ["hello"], applications: ["NETSCAPE2.0"] });
    const comment = fields.find((f) => f.id === "gif.comment")!;
    expect(comment.value).toBe("hello");
    expect(comment.status).toBe("present");
    const app = fields.find((f) => f.id === "gif.application")!;
    expect(app.value).toBe("NETSCAPE2.0");
  });

  test("null input yields no fields, not a crash", () => {
    expect(interpretGifInfo(null)).toEqual([]);
  });
});

// ─── MP3 / ID3 tag parsing ──────────────────────────────────────────────────

function syncsafeBytes(value: number): number[] {
  return [(value >> 21) & 0x7f, (value >> 14) & 0x7f, (value >> 7) & 0x7f, value & 0x7f];
}
function u32beBytes(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}
function id3TextFrame(frameId: string, text: string, majorVersion: 3 | 4, encodingByte: 0 | 3 = 3): number[] {
  const textBytes = encodingByte === 3 ? Array.from(new TextEncoder().encode(text)) : Array.from(text).map((c) => c.charCodeAt(0));
  const data = [encodingByte, ...textBytes];
  const sizeBytes = majorVersion === 4 ? syncsafeBytes(data.length) : u32beBytes(data.length);
  return [...ascii4(frameId), ...sizeBytes, 0, 0, ...data];
}
function id3CommFrame(text: string, majorVersion: 3 | 4): number[] {
  // COMM: encoding(1) + language(3) + short-description(here: empty, just a null terminator) + text
  const textBytes = Array.from(new TextEncoder().encode(text));
  const data = [3 /* UTF-8 */, ...Array.from(new TextEncoder().encode("eng")), 0x00, ...textBytes];
  const sizeBytes = majorVersion === 4 ? syncsafeBytes(data.length) : u32beBytes(data.length);
  return [...ascii4("COMM"), ...sizeBytes, 0, 0, ...data];
}
function buildId3v2Tag(majorVersion: 3 | 4, frameBytesList: number[][]): number[] {
  const frames = frameBytesList.flat();
  return ["I".charCodeAt(0), "D".charCodeAt(0), "3".charCodeAt(0), majorVersion, 0, 0, ...syncsafeBytes(frames.length), ...frames];
}

describe("parseId3v2Tags", () => {
  test("ID3v2.3 (plain big-endian frame sizes) — a real, easy-to-get-wrong version difference from v2.4", () => {
    const bytes = new Uint8Array(buildId3v2Tag(3, [id3TextFrame("TIT2", "Test Title", 3), id3TextFrame("TPE1", "Test Artist", 3)]));
    const tags = parseId3v2Tags(bytes)!;
    expect(tags.version).toBe("2.3.0");
    expect(tags.frames.TIT2).toBe("Test Title");
    expect(tags.frames.TPE1).toBe("Test Artist");
  });

  test("ID3v2.4 (syncsafe frame sizes) parses correctly, distinctly from v2.3's plain sizes", () => {
    const bytes = new Uint8Array(buildId3v2Tag(4, [id3TextFrame("TIT2", "Synced Title", 4)]));
    const tags = parseId3v2Tags(bytes)!;
    expect(tags.version).toBe("2.4.0");
    expect(tags.frames.TIT2).toBe("Synced Title");
  });

  test("a COMM frame's language+description prefix is stripped, keeping only the real comment text", () => {
    const bytes = new Uint8Array(buildId3v2Tag(3, [id3CommFrame("A real comment", 3)]));
    const tags = parseId3v2Tags(bytes)!;
    expect(tags.frames.COMM).toBe("A real comment");
  });

  test("Latin-1 (encoding byte 0) and UTF-8 (encoding byte 3) text frames both decode correctly", () => {
    const bytes = new Uint8Array(buildId3v2Tag(3, [id3TextFrame("TALB", "Cafe", 3, 0), id3TextFrame("TCON", "Rock", 3, 3)]));
    const tags = parseId3v2Tags(bytes)!;
    expect(tags.frames.TALB).toBe("Cafe");
    expect(tags.frames.TCON).toBe("Rock");
  });

  test("returns null for a buffer with no ID3v2 header", () => {
    expect(parseId3v2Tags(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).toBeNull();
  });

  test("stops cleanly at corrupted/non-frame bytes rather than reading garbage as a frame", () => {
    const good = id3TextFrame("TIT2", "Real", 3);
    const bytes = new Uint8Array(buildId3v2Tag(3, [good, [0x00, 0x00, 0x00, 0x00, 1, 2, 3, 4, 5, 6]]));
    const tags = parseId3v2Tags(bytes)!;
    expect(tags.frames.TIT2).toBe("Real");
    expect(Object.keys(tags.frames).length).toBe(1);
  });
});

describe("parseId3v1Tag", () => {
  test("reads a real, fixed-layout 128-byte ID3v1 tag including the numeric genre index", () => {
    const tag = new Array(128).fill(0);
    const write = (offset: number, text: string) => Array.from(text).forEach((c, i) => (tag[offset + i] = c.charCodeAt(0)));
    write(0, "TAG");
    write(3, "V1 Title");
    write(33, "V1 Artist");
    write(63, "V1 Album");
    write(93, "1999");
    write(97, "V1 Comment");
    tag[127] = 17; // "Rock" in the standard ID3v1 genre list
    const parsed = parseId3v1Tag(new Uint8Array(tag))!;
    expect(parsed.title).toBe("V1 Title");
    expect(parsed.artist).toBe("V1 Artist");
    expect(parsed.album).toBe("V1 Album");
    expect(parsed.year).toBe("1999");
    expect(parsed.comment).toBe("V1 Comment");
    expect(parsed.genre).toBe("Rock");
  });

  test("returns null when the tail 128 bytes do not start with 'TAG'", () => {
    expect(parseId3v1Tag(new Uint8Array(128))).toBeNull();
  });

  test("returns null for a buffer that is not exactly 128 bytes", () => {
    expect(parseId3v1Tag(new Uint8Array(64))).toBeNull();
  });
});

describe("interpretId3Tags", () => {
  test("v2 frames take priority and render with real labels", () => {
    const fields = interpretId3Tags({ version: "2.3.0", frames: { TIT2: "My Title", TSSE: "LAME 3.100" } }, null);
    const title = fields.find((f) => f.id === "id3.title")!;
    expect(title.value).toBe("My Title");
    const software = fields.find((f) => f.id === "id3.softwareSettings")!;
    expect(software.value).toBe("LAME 3.100");
    expect(software.severity).toBe("notable");
  });

  test("falls back to ID3v1 fields when there is no ID3v2 tag at all", () => {
    const v1 = { title: "Old Title", artist: "Old Artist", album: null, year: null, comment: null, genre: "Rock" };
    const fields = interpretId3Tags(null, v1);
    const title = fields.find((f) => f.id === "id3v1.title")!;
    expect(title.value).toBe("Old Title");
    const version = fields.find((f) => f.id === "id3.version")!;
    expect(version.value).toBe("ID3v1");
  });

  test("neither tag present yields real absences, not a crash", () => {
    const fields = interpretId3Tags(null, null);
    expect(fields.every((f) => f.status === "absent")).toBe(true);
  });
});

// ─── Container sniffing — new formats ──────────────────────────────────────

describe("sniffContainer — new formats", () => {
  test("WAV sniffs as riff-wave, distinct from AVI's riff-avi", () => {
    const body = [...ascii4("WAVE"), ...riffChunk("fmt ", [1, 2, 3, 4])];
    const bytes = new Uint8Array([...ascii4("RIFF"), ...u32le(body.length), ...body]);
    expect(sniffContainer(bytes, "clip.wav", "audio/wav").kind).toBe("riff-wave");
  });

  test("WebP sniffs as riff-webp", () => {
    const body = [...ascii4("WEBP"), ...riffChunk("VP8 ", [1, 2])];
    const bytes = new Uint8Array([...ascii4("RIFF"), ...u32le(body.length), ...body]);
    expect(sniffContainer(bytes, "img.webp", "image/webp").kind).toBe("riff-webp");
  });

  test("GIF sniffs as gif", () => {
    const bytes = new Uint8Array([...gifHeader(), ...gifLsd(), 0x3b]);
    expect(sniffContainer(bytes, "anim.gif", "image/gif").kind).toBe("gif");
  });

  test("an ID3v2-tagged MP3 sniffs as mp3", () => {
    const bytes = new Uint8Array(buildId3v2Tag(3, [id3TextFrame("TIT2", "X", 3)]));
    expect(sniffContainer(bytes, "song.mp3", "audio/mpeg").kind).toBe("mp3");
  });

  test("a HEIC file (ftyp major brand 'heic') sniffs as iso-bmff-heif, distinct from mp4's iso-bmff", () => {
    const bytes = new Uint8Array([0, 0, 0, 24, ...ascii4("ftyp"), ...ascii4("heic"), 0, 0, 0, 0]);
    expect(sniffContainer(bytes, "photo.heic", "image/heic").kind).toBe("iso-bmff-heif");
  });

  test("an AVIF file (ftyp major brand 'avif') also sniffs as iso-bmff-heif", () => {
    const bytes = new Uint8Array([0, 0, 0, 24, ...ascii4("ftyp"), ...ascii4("avif"), 0, 0, 0, 0]);
    expect(sniffContainer(bytes, "photo.avif", "image/avif").kind).toBe("iso-bmff-heif");
  });

  test("an MP4 file (ftyp major brand 'isom') still sniffs as plain iso-bmff, not iso-bmff-heif", () => {
    const bytes = new Uint8Array([0, 0, 0, 24, ...ascii4("ftyp"), ...ascii4("isom"), 0, 0, 0, 0]);
    expect(sniffContainer(bytes, "clip.mp4", "video/mp4").kind).toBe("iso-bmff");
  });
});

// ─── Hidden / appended data detection (JPEG, PNG) ──────────────────────────

function jpegMarkerSegment(marker: number, data: number[]): number[] {
  const length = data.length + 2; // the length field counts itself
  return [0xff, marker, (length >> 8) & 0xff, length & 0xff, ...data];
}

/**
 * A structurally real, minimal JPEG: SOI, one APP0 segment, an SOS header
 * followed by real entropy-coded scan data (including a byte-stuffed 0xFF00
 * and a restart marker by default, both real traps a naive `FF D9` byte
 * scan gets wrong), then EOI.
 */
function buildMinimalJpeg(scanData: number[] = [0x11, 0x22, 0xff, 0x00, 0xff, 0xd0, 0x33]): number[] {
  return [
    0xff, 0xd8, // SOI
    ...jpegMarkerSegment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]), // APP0/JFIF
    0xff, 0xda, 0x00, 0x04, 0x00, 0x00, // SOS, 4-byte header (includes the 2 length bytes)
    ...scanData,
    0xff, 0xd9, // EOI
  ];
}

describe("parseJpegTrailer", () => {
  test("a real JPEG with nothing appended reports zero trailing bytes at the true EOI offset", () => {
    const bytes = buildMinimalJpeg();
    const info = parseJpegTrailer(new Uint8Array(bytes))!;
    expect(info.trailingByteCount).toBe(0);
    expect(info.endOffset).toBe(bytes.length);
  });

  test("bytes appended after EOI are counted, not swallowed into the scan", () => {
    const jpeg = buildMinimalJpeg();
    const appended = [0x50, 0x4b, 0x03, 0x04, 0xaa, 0xbb]; // looks like a ZIP local file header
    const bytes = new Uint8Array([...jpeg, ...appended]);
    const info = parseJpegTrailer(bytes)!;
    expect(info.endOffset).toBe(jpeg.length);
    expect(info.trailingByteCount).toBe(appended.length);
  });

  test("a byte-stuffed 0xFF00 inside scan data is not mistaken for a marker", () => {
    // The default scanData above already embeds 0xFF 0x00 — if the walker
    // mishandled stuffing it would either throw, misindex, or find the wrong
    // EOI offset. A correct walk still lands on the real trailing EOI.
    const bytes = buildMinimalJpeg();
    const info = parseJpegTrailer(new Uint8Array(bytes))!;
    expect(info.endOffset).toBe(bytes.length);
  });

  test("a restart marker (0xFFD0-0xFFD7) inside scan data is skipped, not read as EOI", () => {
    const bytes = buildMinimalJpeg([0x11, 0xff, 0xd3, 0x22]); // RST3 mid-scan
    const info = parseJpegTrailer(new Uint8Array(bytes))!;
    expect(info.endOffset).toBe(bytes.length);
    expect(info.trailingByteCount).toBe(0);
  });

  test("returns null for a non-JPEG buffer", () => {
    expect(parseJpegTrailer(new Uint8Array([1, 2, 3, 4, 5]))).toBeNull();
  });

  test("returns null (not a guessed offset) when the buffer is truncated before a real EOI", () => {
    const full = buildMinimalJpeg();
    const truncated = new Uint8Array(full.slice(0, full.length - 2)); // cut off the EOI itself
    expect(parseJpegTrailer(truncated)).toBeNull();
  });
});

function pngChunk(type: string, data: number[] = []): number[] {
  // parsePngTrailer only reads the length/type fields to skip a chunk — the CRC's actual value is never validated, so any 4 bytes stand in for it here.
  return [...u32beBytes(data.length), ...ascii4(type), ...data, 0xde, 0xad, 0xbe, 0xef];
}
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
function buildMinimalPng(extraChunks: number[][] = []): number[] {
  return [...PNG_SIGNATURE, ...pngChunk("IHDR", new Array(13).fill(0)), ...extraChunks.flat(), ...pngChunk("IEND")];
}

describe("parsePngTrailer", () => {
  test("a real PNG with nothing appended reports zero trailing bytes at the true IEND offset", () => {
    const bytes = buildMinimalPng();
    const info = parsePngTrailer(new Uint8Array(bytes))!;
    expect(info.trailingByteCount).toBe(0);
    expect(info.endOffset).toBe(bytes.length);
  });

  test("walks past an intermediate chunk (e.g. IDAT) correctly to reach IEND", () => {
    const bytes = buildMinimalPng([pngChunk("IDAT", [1, 2, 3, 4, 5])]);
    const info = parsePngTrailer(new Uint8Array(bytes))!;
    expect(info.endOffset).toBe(bytes.length);
  });

  test("bytes appended after IEND are counted", () => {
    const png = buildMinimalPng();
    const appended = [0x50, 0x4b, 0x03, 0x04, 0x01, 0x02, 0x03];
    const bytes = new Uint8Array([...png, ...appended]);
    const info = parsePngTrailer(bytes)!;
    expect(info.endOffset).toBe(png.length);
    expect(info.trailingByteCount).toBe(appended.length);
  });

  test("returns null for a non-PNG buffer", () => {
    expect(parsePngTrailer(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull();
  });

  test("returns null when the buffer is truncated before IEND", () => {
    const full = buildMinimalPng([pngChunk("IDAT", [1, 2, 3])]);
    const truncated = new Uint8Array(full.slice(0, full.length - 6));
    expect(parsePngTrailer(truncated)).toBeNull();
  });
});

describe("interpretTrailingData", () => {
  test("no trailing data yields a real absent measurement, not silence", () => {
    const field = interpretTrailingData("JPEG", { endOffset: 100, trailingByteCount: 0 }, null);
    expect(field.status).toBe("absent");
    expect(field.value).toBeNull();
  });

  test("trailing bytes matching a known signature are identified by kind", () => {
    const zipHead = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    const field = interpretTrailingData("PNG", { endOffset: 50, trailingByteCount: 8 }, zipHead);
    expect(field.status).toBe("present");
    expect(field.value).toContain("8 byte(s)");
    expect(field.note).toContain("zip-unknown");
  });

  test("trailing bytes matching no known signature are reported honestly as unidentified", () => {
    const junk = new Uint8Array([0x11, 0x22, 0x33, 0x44]);
    const field = interpretTrailingData("JPEG", { endOffset: 50, trailingByteCount: 4 }, junk);
    expect(field.status).toBe("present");
    expect(field.note).toContain("no known file signature");
  });

  test("a null parse result (truncated/malformed) is reported as unreadable, never zero", () => {
    const field = interpretTrailingData("JPEG", null, null);
    expect(field.status).toBe("unreadable");
    expect(field.value).toBeNull();
  });
});

// ─── PDF hidden actions / embedded files ───────────────────────────────────

describe("countPdfEofMarkers", () => {
  test("a single revision has exactly one %%EOF marker", () => {
    const bytes = new TextEncoder().encode("%PDF-1.7\n...\n%%EOF\n");
    expect(countPdfEofMarkers(bytes)).toBe(1);
  });

  test("an incrementally-updated file with two revisions has two %%EOF markers", () => {
    const bytes = new TextEncoder().encode("%PDF-1.7\n...\n%%EOF\n...more...\n%%EOF\n");
    expect(countPdfEofMarkers(bytes)).toBe(2);
  });

  test("a buffer with no %%EOF marker at all returns zero, not a guess", () => {
    const bytes = new TextEncoder().encode("not a pdf at all");
    expect(countPdfEofMarkers(bytes)).toBe(0);
  });
});

describe("interpretPdfHiddenActions", () => {
  test("checked:false (encrypted PDF) reports hidden actions as not checked, never a false negative", () => {
    const { fields } = interpretPdfHiddenActions({
      checked: false,
      hasOpenAction: false,
      javascriptActions: [],
      launchActionCount: 0,
      submitFormActionCount: 0,
      importDataActionCount: 0,
      embeddedFiles: [],
      incrementalUpdateCount: 1,
    });
    const hidden = fields.find((f) => f.id === "pdf.hiddenActions")!;
    expect(hidden.status).toBe("unreadable");
    expect(hidden.value).toBe("Not checked");
    // The %%EOF count is a raw byte scan independent of encryption — it must still be reported honestly.
    expect(fields.find((f) => f.id === "pdf.incrementalUpdates")!.value).toContain("1");
    expect(fields.some((f) => f.id === "pdf.openAction")).toBe(false);
  });

  test("a real /OpenAction is reported as notable, and no click required", () => {
    const { fields } = interpretPdfHiddenActions({
      checked: true,
      hasOpenAction: true,
      javascriptActions: [],
      launchActionCount: 0,
      submitFormActionCount: 0,
      importDataActionCount: 0,
      embeddedFiles: [],
      incrementalUpdateCount: 1,
    });
    const openAction = fields.find((f) => f.id === "pdf.openAction")!;
    expect(openAction.status).toBe("present");
    expect(openAction.severity).toBe("notable");
  });

  test("extracted JavaScript source is surfaced verbatim in raw[], never executed", () => {
    const { fields, raw } = interpretPdfHiddenActions({
      checked: true,
      hasOpenAction: false,
      javascriptActions: ["app.alert('hello');"],
      launchActionCount: 0,
      submitFormActionCount: 0,
      importDataActionCount: 0,
      embeddedFiles: [],
      incrementalUpdateCount: 1,
    });
    expect(fields.find((f) => f.id === "pdf.javascript")!.status).toBe("present");
    expect(raw).toEqual([{ label: "PDF JavaScript action 1", text: "app.alert('hello');" }]);
  });

  test("embedded files render name, byte length and are marked notable", () => {
    const { fields } = interpretPdfHiddenActions({
      checked: true,
      hasOpenAction: false,
      javascriptActions: [],
      launchActionCount: 0,
      submitFormActionCount: 0,
      importDataActionCount: 0,
      embeddedFiles: [{ name: "payload.exe", byteLength: 1024, sha256: "abc123" }],
      incrementalUpdateCount: 1,
    });
    const field = fields.find((f) => f.id === "pdf.embeddedFiles")!;
    expect(field.status).toBe("present");
    expect(field.value).toContain("payload.exe");
    expect(field.value).toContain("1024 bytes");
    expect(field.severity).toBe("notable");
  });

  test("more than one %%EOF marker is flagged notable as real incremental-update evidence", () => {
    const { fields } = interpretPdfHiddenActions({
      checked: true,
      hasOpenAction: false,
      javascriptActions: [],
      launchActionCount: 0,
      submitFormActionCount: 0,
      importDataActionCount: 0,
      embeddedFiles: [],
      incrementalUpdateCount: 3,
    });
    const field = fields.find((f) => f.id === "pdf.incrementalUpdates")!;
    expect(field.severity).toBe("notable");
    expect(field.value).toContain("3");
  });

  test("nothing hidden yields real, checked absences, not a blank report", () => {
    const { fields } = interpretPdfHiddenActions({
      checked: true,
      hasOpenAction: false,
      javascriptActions: [],
      launchActionCount: 0,
      submitFormActionCount: 0,
      importDataActionCount: 0,
      embeddedFiles: [],
      incrementalUpdateCount: 1,
    });
    expect(fields.find((f) => f.id === "pdf.openAction")!.status).toBe("absent");
    expect(fields.find((f) => f.id === "pdf.javascript")!.status).toBe("absent");
    expect(fields.find((f) => f.id === "pdf.launchAction")!.status).toBe("absent");
    expect(fields.find((f) => f.id === "pdf.formDataActions")!.status).toBe("absent");
    expect(fields.find((f) => f.id === "pdf.embeddedFiles")!.status).toBe("absent");
  });
});

// ─── OOXML macros and remote-template references ───────────────────────────

describe("parseRelationshipsXml", () => {
  test("extracts Type/Target/TargetMode from real .rels markup", () => {
    const xml =
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="http://evil.example/template.dotx" TargetMode="External"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      "</Relationships>";
    const rels = parseRelationshipsXml(xml);
    expect(rels).toHaveLength(3);
    expect(rels[0].type).toContain("attachedTemplate");
    expect(rels[0].targetMode).toBe("External");
    expect(rels[1].type).toContain("hyperlink");
    expect(rels[2].targetMode).toBeNull(); // no TargetMode attribute at all — an ordinary internal part
  });

  test("returns an empty list for markup with no Relationship elements", () => {
    expect(parseRelationshipsXml("<Relationships></Relationships>")).toEqual([]);
  });
});

describe("interpretOoxmlMacrosAndTemplates", () => {
  test("a vbaProject.bin presence is reported as a notable, un-decompiled fact", () => {
    const fields = interpretOoxmlMacrosAndTemplates(true, []);
    const field = fields.find((f) => f.id === "ooxml.vbaMacro")!;
    expect(field.status).toBe("present");
    expect(field.severity).toBe("notable");
  });

  test("no vbaProject.bin is a real, checked absence", () => {
    const fields = interpretOoxmlMacrosAndTemplates(false, []);
    expect(fields.find((f) => f.id === "ooxml.vbaMacro")!.status).toBe("absent");
  });

  test("an external attached-template relationship is flagged; an ordinary external hyperlink is not", () => {
    const fields = interpretOoxmlMacrosAndTemplates(false, [
      { type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate", target: "http://evil.example/x.dotx", targetMode: "External" },
      { type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink", target: "https://example.com", targetMode: "External" },
    ]);
    const field = fields.find((f) => f.id === "ooxml.externalReferences")!;
    expect(field.status).toBe("present");
    expect(field.value).toContain("evil.example");
    expect(field.value).not.toContain("example.com");
  });

  test("an internal (non-External) relationship of any type is never flagged", () => {
    const fields = interpretOoxmlMacrosAndTemplates(false, [
      { type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles", target: "styles.xml", targetMode: null },
    ]);
    expect(fields.find((f) => f.id === "ooxml.externalReferences")!.status).toBe("absent");
  });
});
