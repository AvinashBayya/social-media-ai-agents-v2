import { describe, expect, test } from "bun:test";
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
  parseIso6709,
  parseIsoBmffBoxes,
  parseMvhd,
  parseOdfMeta,
  parseOoxmlAppProps,
  parseOoxmlCoreProps,
  parseOoxmlCustomProps,
  parsePdfDate,
  parseXmpPacket,
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

  test("signature fields are counted, and validity is explicitly NOT claimed", () => {
    const fields = interpretPdfInfoDict({}, { isEncrypted: false, pageCount: null, signatureFieldCount: 2 });
    const sig = fields.find((f) => f.id === "pdf.signatures")!;
    expect(sig.value).toBe("2");
    expect(sig.note.toLowerCase()).toContain("not evidence");
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
    for (const kind of ["pdf", "ooxml", "odf", "video", "image", "unsupported"] as const) {
      expect(cannotDetermineFor(kind).length).toBeGreaterThan(0);
    }
  });
});
