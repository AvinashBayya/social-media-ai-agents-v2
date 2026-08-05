import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppShell, PageHeader } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Upload, Loader2, AlertTriangle, ShieldCheck, ShieldAlert, ShieldQuestion,
  Camera, MapPin, Type, Copy, Fingerprint, ChevronDown, ChevronRight, Info, Tags,
} from "lucide-react";
import {
  assessProvenance, findNearDuplicates,
  C2PA_ABSENCE_NOTE, OCR_LANGUAGES, OCR_LOW_CONFIDENCE,
  type C2paReport, type DuplicateReport, type ExifReport, type HashedImage, type OcrReport,
} from "@/utils/imaging";
import {
  decodeImage, loadImageCorpus, readC2pa, readExif, rememberImage, runOcr,
  MediaError,
} from "@/utils/imaging-client";
import { hashRgba } from "@/utils/imaging";
import { ExifMap } from "@/components/exif-map";
import { NotImplementedPanel } from "@/components/not-implemented";
import { PinButton } from "@/components/pin-button";
import { aiExtractEntities, type AnalysisEntity } from "@/utils/analysis-llm";

/**
 * Image Intelligence — Module 4 analysis workbench (PS-18 §6.4).
 *
 * The previous version of this page was invented end to end: twelve gradient
 * rectangles with captions like "Convoy near restricted checkpoint", a fixed
 * EXIF line reading "Canon EOS · f/2.8 · ISO 400", a GPS fix at Damascus with a
 * "±180m" precision, an Arabic OCR string, a watchlist face match at 71%, and a
 * "Deepfake probability 8%" bar. No image was ever read.
 *
 * This is the replacement: real bytes, real parsers, and an explicit statement
 * of what cannot be determined. All processing is in-browser — the uploaded file
 * never leaves the machine, which for a defence tool is worth stating plainly.
 */

export const Route = createFileRoute("/images")({
  head: () => ({ meta: [{ title: "Image Intelligence — Sentinel AI" }] }),
  component: Page,
});

const CARD = "bg-[#111827] border-[#263548]";

/** Default OCR selection: English plus Hindi covers most Indian-language signage. */
const DEFAULT_LANGS = ["eng", "hin"];

interface Analysis {
  name: string;
  previewUrl: string;
  hash: string;
  width: number;
  height: number;
  sizeBytes: number | null;
  exif: ExifReport | null;
  exifError: string | null;
  c2pa: C2paReport | null;
  duplicates: DuplicateReport | null;
}

function Section({
  icon, title, subtitle, children, defaultOpen = true,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Card className={CARD}>
      <CardContent className="p-4">
        <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 text-left">
          {open ? (
            <ChevronDown className="size-3.5 shrink-0 text-[#64748B]" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-[#64748B]" />
          )}
          {icon}
          <span className="text-xs font-bold uppercase text-white">{title}</span>
          {subtitle && <span className="ml-auto text-[10px] text-[#64748B]">{subtitle}</span>}
        </button>
        {open && <div className="mt-3">{children}</div>}
      </CardContent>
    </Card>
  );
}

function Page() {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [urlDraft, setUrlDraft] = useState("");
  const [corpus, setCorpus] = useState<HashedImage[]>([]);

  const [langs, setLangs] = useState<string[]>(DEFAULT_LANGS);
  const [ocr, setOcr] = useState<OcrReport | null>(null);
  const [ocrError, setOcrError] = useState("");
  const [ocrProgress, setOcrProgress] = useState<{ status: string; progress: number } | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [entities, setEntities] = useState<AnalysisEntity[] | null>(null);
  const [entityError, setEntityError] = useState("");

  useEffect(() => setCorpus(loadImageCorpus()), []);

  useEffect(() => {
    return () => {
      if (analysis?.previewUrl.startsWith("blob:")) URL.revokeObjectURL(analysis.previewUrl);
    };
  }, [analysis?.previewUrl]);

  const analyse = useCallback(async (source: File | Blob | string, name: string) => {
    setError("");
    setOcr(null);
    setOcrError("");
    setEntities(null);
    setEntityError("");
    setAnalysis(null);
    setBusy("Decoding image");

    try {
      const { data, width, height } = await decodeImage(source);
      const hash = hashRgba(data, width, height);

      setBusy("Reading EXIF");
      let exif: ExifReport | null = null;
      let exifError: string | null = null;
      try {
        if (typeof source !== "string") {
          exif = await readExif(source);
        } else {
          // Fetch the original bytes so EXIF can be read from a URL too. This
          // used to skip the attempt entirely and hand the assessment
          // interpretExif(null), which renders as "No EXIF metadata" — reporting
          // "we never looked" as "there is nothing there", the exact confusion
          // the rest of this module is built to avoid. A CORS refusal is now
          // surfaced as a failed read, and exif stays null so no absence is
          // claimed.
          const res = await fetch(source, { mode: "cors" });
          if (!res.ok) throw new Error(`HTTP ${res.status} fetching the image bytes.`);
          exif = await readExif(await res.blob());
        }
      } catch (err: any) {
        // A parse or fetch failure is reported as a failure, never converted
        // into "no metadata" — those are different findings.
        exif = null;
        exifError =
          typeof source === "string"
            ? `EXIF could not be read from this URL: ${err?.message ?? String(err)}. ` +
              `Cross-origin images are usually blocked by CORS. Download the file and upload ` +
              `it directly. NOTE: this is a failed read, not an absence of metadata — nothing ` +
              `is being claimed about this image either way.`
            : (err?.message ?? String(err));
      }

      setBusy("Verifying Content Credentials");
      const c2pa = await readC2pa(source);

      setBusy("Matching against corpus");
      const stored = loadImageCorpus();
      const seenAt = exif?.captureTime ?? new Date().toISOString();
      const duplicates = findNearDuplicates({ hash, seenAt, id: name }, stored);

      const next = rememberImage({
        id: name,
        hash,
        source: typeof source === "string" ? new URL(source).hostname : "uploaded",
        url: typeof source === "string" ? source : "",
        seenAt,
        context: name,
        // Carried into the Module 5 map. Omitted entirely when there is no fix —
        // spreading `gps: undefined` would still create the key.
        ...(exif?.gps ? { gps: exif.gps } : {}),
        ...(exif?.camera.model
          ? { camera: [exif.camera.make, exif.camera.model].filter(Boolean).join(" ") }
          : {}),
      });
      setCorpus(next);

      setAnalysis({
        name,
        previewUrl: typeof source === "string" ? source : URL.createObjectURL(source),
        hash,
        width,
        height,
        sizeBytes: source instanceof Blob ? source.size : null,
        exif,
        exifError,
        c2pa,
        duplicates,
      });
    } catch (err: any) {
      setError(err instanceof MediaError ? `[${err.stage}] ${err.message}` : (err?.message ?? String(err)));
    } finally {
      setBusy(null);
    }
  }, []);

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) analyse(file, file.name);
  };

  const doOcr = async () => {
    if (!analysis) return;
    setBusy("Running OCR");
    setOcrError("");
    setOcr(null);
    setEntities(null);
    setEntityError("");
    try {
      const report = await runOcr(analysis.previewUrl, langs, setOcrProgress);
      setOcr(report);
    } catch (err: any) {
      setOcrError(err?.message ?? String(err));
    } finally {
      setBusy(null);
      setOcrProgress(null);
    }
  };

  /**
   * OCR text into Module 2's entity extractor. The recognised text becomes an
   * Article, so exactly the same extractor runs over it as over a news feed —
   * no separate image-specific path to drift out of sync.
   */
  const runEntities = async () => {
    if (!ocr?.text.trim() || !analysis) return;
    setBusy("Extracting entities");
    setEntityError("");
    try {
      const res: any = await aiExtractEntities({
        data: {
          article: {
            id: `ocr:${analysis.hash}`,
            title: ocr.text.slice(0, 160),
            source: `OCR (${ocr.languages.join("+")}) of ${analysis.name}`,
            url: "",
            pubDate: analysis.exif?.captureTime ?? "",
            body: ocr.text,
          },
        },
      });
      setEntities(res.entities ?? []);
    } catch (err: any) {
      setEntityError(err?.message ?? String(err));
    } finally {
      setBusy(null);
    }
  };

  const provenance = analysis
    ? assessProvenance({ exif: analysis.exif, c2pa: analysis.c2pa, duplicates: analysis.duplicates })
    : null;

  const statusIcon = (s: C2paReport["status"] | undefined) =>
    s === "valid" ? <ShieldCheck className="size-3.5 text-[#10B981]" />
    : s === "invalid" ? <ShieldAlert className="size-3.5 text-[#EF4444]" />
    : <ShieldQuestion className="size-3.5 text-[#64748B]" />;

  return (
    <AppShell>
      <PageHeader
        title="Image Intelligence"
        description="Provenance-first image forensics. C2PA verification, EXIF, OCR and perceptual matching — all in this browser; the file is never uploaded."
      />

      <Card className={`${CARD} mb-4`}>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-end gap-2">
            <Button size="sm" onClick={() => fileRef.current?.click()} disabled={busy !== null} className="h-8 gap-1.5">
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
              {busy ?? "Upload image"}
            </Button>
            <input ref={fileRef} type="file" accept="image/*" onChange={onFile} className="hidden" />

            <div className="min-w-[220px] flex-1">
              <Input
                value={urlDraft}
                onChange={(e) => setUrlDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && urlDraft.trim() && analyse(urlDraft.trim(), urlDraft.trim())}
                placeholder="…or paste an image URL"
                className="h-8 border-[#263548] bg-[#0B1220] text-[11px] text-white"
              />
            </div>
            <Button
              size="sm" variant="outline"
              disabled={busy !== null || !urlDraft.trim()}
              onClick={() => analyse(urlDraft.trim(), urlDraft.trim())}
              className="h-8"
            >
              Analyse URL
            </Button>
            <span className="text-[10px] text-[#64748B]">
              {corpus.length} image(s) hashed in this browser
            </span>
          </div>

          <p className="mt-2 flex items-start gap-1.5 text-[10px] leading-relaxed text-[#64748B]">
            <Info className="mt-px size-3 shrink-0" />
            Provenance beats classification. A C2PA signature either verifies or it does not —
            no threshold, no false positives. A deepfake score is a guess, so this system does
            not produce one; see "Not implemented" below for exactly what that means.
          </p>

          {error && (
            <div className="mt-3 flex items-start gap-2 rounded border border-[#EF4444]/30 bg-[#EF4444]/5 p-2">
              <AlertTriangle className="size-3.5 shrink-0 text-[#EF4444]" />
              <span className="font-mono text-[10px] leading-relaxed text-[#EF4444]">{error}</span>
            </div>
          )}
        </CardContent>
      </Card>

      {!analysis ? (
        <div className="grid gap-4 lg:grid-cols-[1fr_400px]">
          <Card className={CARD}>
            <CardContent className="p-10 text-center">
              <Camera className="mx-auto size-8 text-[#263548]" />
              <p className="mt-3 text-sm text-[#94A3B8]">No image loaded.</p>
              <p className="mx-auto mt-1 max-w-md text-[11px] leading-relaxed text-[#64748B]">
                Upload a file or paste a URL. Nothing is analysed until you do, and nothing is
                sent anywhere — EXIF parsing, C2PA verification, OCR and hashing all run as
                WebAssembly in this tab.
              </p>
            </CardContent>
          </Card>
          <NotImplementedPanel />
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_400px]">
          <div className="space-y-4">
            {/* ── Preview ─────────────────────────────────────────────────── */}
            <Card className={CARD}>
              <CardContent className="p-0">
                <img
                  src={analysis.previewUrl}
                  alt={analysis.name}
                  className="max-h-[420px] w-full rounded-t-lg bg-[#0B1220] object-contain"
                />
                <div className="flex flex-wrap items-center gap-2 border-t border-[#263548] p-3 font-mono text-[10px] text-[#94A3B8]">
                  <span className="truncate font-semibold text-white">{analysis.name}</span>
                  <span>{analysis.width}×{analysis.height}</span>
                  {analysis.sizeBytes !== null && (
                    <span>{(analysis.sizeBytes / 1024).toFixed(0)} KB</span>
                  )}
                  <span className="ml-auto flex items-center gap-1">
                    <Fingerprint className="size-3" />
                    pHash {analysis.hash}
                    <button
                      onClick={() => navigator.clipboard?.writeText(analysis.hash)}
                      className="text-[#3B82F6] hover:underline"
                      title="Copy hash"
                    >
                      <Copy className="size-3" />
                    </button>
                    <PinButton
                      payload={{
                        kind: "image",
                        title: analysis.name,
                        source: analysis.exif?.camera.model
                          ? [analysis.exif.camera.make, analysis.exif.camera.model].filter(Boolean).join(" ")
                          : "uploaded image",
                        url: typeof analysis.previewUrl === "string" && analysis.previewUrl.startsWith("http")
                          ? analysis.previewUrl
                          : "",
                        publishedAt: analysis.exif?.captureTime ?? "",
                        // The forensic findings ARE the evidence — a filename on
                        // its own tells a case nothing.
                        excerpt: [
                          `pHash ${analysis.hash} (${analysis.width}x${analysis.height})`,
                          analysis.c2pa ? `C2PA: ${analysis.c2pa.summary}` : "",
                          analysis.exif
                            ? analysis.exif.findings.map((f) => `${f.label}: ${f.value}`).join("; ")
                            : "EXIF was not read for this item.",
                          analysis.duplicates?.matches.length
                            ? analysis.duplicates.summary
                            : "",
                        ].filter(Boolean).join("\n"),
                        credibility: null,
                        credibilityRationale:
                          "Forensic findings from the image itself. C2PA results are " +
                          "cryptographically verified; EXIF is self-reported by the writing " +
                          "device and editable. No deepfake assessment is made.",
                        data: {
                          hash: analysis.hash,
                          gps: analysis.exif?.gps ?? null,
                          c2paStatus: analysis.c2pa?.status ?? null,
                        },
                      }}
                    />
                  </span>
                </div>
              </CardContent>
            </Card>

            {/* ── Provenance assessment ───────────────────────────────────── */}
            {provenance && (
              <Card className="border-[#3B82F6]/30 bg-[#111827]">
                <CardContent className="p-4">
                  <h3 className="text-xs font-bold uppercase text-white">Provenance assessment</h3>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-[#F3F4F6]">
                    {provenance.summary}
                  </p>

                  <div className="mt-3 space-y-1.5">
                    {provenance.findings.map((f, i) => (
                      <div
                        key={i}
                        className={`rounded border p-2 ${
                          f.strength === "verified"
                            ? "border-[#10B981]/40 bg-[#10B981]/5"
                            : f.strength === "observed"
                              ? "border-[#F59E0B]/30 bg-[#F59E0B]/5"
                              : "border-[#263548] bg-[#0B1220]/60"
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] font-semibold text-white">{f.label}</span>
                          <Badge
                            variant="outline"
                            className="ml-auto shrink-0 border-[#263548] text-[9px] font-normal text-[#94A3B8]"
                          >
                            {f.strength}
                          </Badge>
                        </div>
                        <p className="mt-0.5 text-[10px] leading-relaxed text-[#94A3B8]">{f.detail}</p>
                      </div>
                    ))}
                  </div>

                  <div className="mt-3 rounded border border-[#64748B]/30 bg-[#0B1220]/60 p-2.5">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-[#94A3B8]">
                      What this system could NOT determine about this file
                    </div>
                    <ul className="mt-1 list-disc space-y-1 pl-4 text-[10px] leading-relaxed text-[#94A3B8]">
                      {provenance.cannotDetermine.map((c, i) => <li key={i}>{c}</li>)}
                    </ul>
                  </div>

                  <p className="mt-2 text-[10px] italic text-[#64748B]">
                    This is a summary of findings, not a verdict. There is deliberately no
                    authenticity score — any single number here would be read as one, and we
                    have no basis for it.
                  </p>
                </CardContent>
              </Card>
            )}

            {/* ── C2PA ────────────────────────────────────────────────────── */}
            <Section
              icon={statusIcon(analysis.c2pa?.status)}
              title="Content Credentials (C2PA)"
              subtitle={analysis.c2pa?.status ?? "—"}
            >
              {analysis.c2pa && (
                <>
                  <p className="text-[11px] leading-relaxed text-[#F3F4F6]">{analysis.c2pa.summary}</p>

                  {analysis.c2pa.aiGenerated && (
                    <div className="mt-2 rounded border border-[#8B5CF6]/40 bg-[#8B5CF6]/10 p-2">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-[#8B5CF6]">
                        Declared AI-generated — high confidence
                      </div>
                      <p className="mt-0.5 text-[10px] leading-relaxed text-[#94A3B8]">
                        {analysis.c2pa.aiEvidence} This is the only high-confidence AI finding
                        this system produces, because it is declared by the producing tool and
                        cryptographically signed rather than inferred from the pixels.
                      </p>
                    </div>
                  )}

                  {analysis.c2pa.validationIssues.length > 0 && (
                    <ul className="mt-2 list-disc space-y-0.5 pl-4 text-[10px] text-[#EF4444]">
                      {analysis.c2pa.validationIssues.map((v, i) => <li key={i}>{v}</li>)}
                    </ul>
                  )}

                  {analysis.c2pa.actions.length > 0 && (
                    <div className="mt-2">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-[#94A3B8]">
                        Signed provenance chain
                      </div>
                      <ol className="mt-1 space-y-1">
                        {analysis.c2pa.actions.map((a, i) => (
                          <li key={i} className="rounded border border-[#263548] bg-[#0B1220]/60 p-1.5 text-[10px]">
                            <span className="font-mono text-white">{a.action}</span>
                            {a.agent && <span className="text-[#94A3B8]"> · {a.agent}</span>}
                            {a.when && <span className="text-[#64748B]"> · {a.when}</span>}
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}

                  {(analysis.c2pa.signedBy || analysis.c2pa.generator) && (
                    <dl className="mt-2 space-y-0.5 font-mono text-[10px]">
                      {analysis.c2pa.signedBy && (
                        <div className="flex justify-between">
                          <dt className="text-[#64748B]">Signing authority</dt>
                          <dd className="text-white">{analysis.c2pa.signedBy}</dd>
                        </div>
                      )}
                      {analysis.c2pa.generator && (
                        <div className="flex justify-between">
                          <dt className="text-[#64748B]">Claim generator</dt>
                          <dd className="text-white">{analysis.c2pa.generator}</dd>
                        </div>
                      )}
                      {analysis.c2pa.signedAt && (
                        <div className="flex justify-between">
                          <dt className="text-[#64748B]">Signed at</dt>
                          <dd className="text-white">{analysis.c2pa.signedAt}</dd>
                        </div>
                      )}
                    </dl>
                  )}

                  <p className="mt-2 text-[10px] leading-relaxed text-[#64748B]">
                    {analysis.c2pa.status === "absent" ? C2PA_ABSENCE_NOTE : analysis.c2pa.method}
                  </p>
                </>
              )}
            </Section>

            {/* ── EXIF ────────────────────────────────────────────────────── */}
            <Section
              icon={<Camera className="size-3.5 text-[#3B82F6]" />}
              title="EXIF metadata"
              subtitle={analysis.exif?.present ? "present" : "absent"}
            >
              {analysis.exifError && (
                <div className="mb-2 flex items-start gap-2 rounded border border-[#F59E0B]/30 bg-[#F59E0B]/5 p-2">
                  <AlertTriangle className="size-3.5 shrink-0 text-[#F59E0B]" />
                  <span className="text-[10px] leading-relaxed text-[#F59E0B]">{analysis.exifError}</span>
                </div>
              )}

              {analysis.exif && (
                <>
                  <div className="space-y-1.5">
                    {analysis.exif.findings.map((f) => (
                      <div
                        key={f.id}
                        className={`rounded border p-2 ${
                          f.severity === "notable"
                            ? "border-[#F59E0B]/30 bg-[#F59E0B]/5"
                            : "border-[#263548] bg-[#0B1220]/60"
                        }`}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[11px] font-semibold text-white">{f.label}</span>
                          <span className="font-mono text-[10px] text-[#94A3B8]">{f.value}</span>
                        </div>
                        <p className="mt-0.5 text-[10px] leading-relaxed text-[#94A3B8]">{f.note}</p>
                      </div>
                    ))}
                  </div>

                  {analysis.exif.present && (
                    <>
                      <button
                        onClick={() => setShowRaw(!showRaw)}
                        className="mt-2 text-[10px] text-[#3B82F6] hover:underline"
                      >
                        {showRaw ? "Hide" : "Show"} full metadata dump (
                        {Object.keys(analysis.exif.raw).length} tags)
                      </button>
                      {showRaw && (
                        <pre className="mt-1.5 max-h-64 overflow-auto rounded border border-[#263548] bg-[#0B1220] p-2 font-mono text-[9px] leading-relaxed text-[#94A3B8]">
                          {JSON.stringify(analysis.exif.raw, null, 2)}
                        </pre>
                      )}
                    </>
                  )}

                  <p className="mt-2 text-[10px] leading-relaxed text-[#64748B]">{analysis.exif.method}</p>
                </>
              )}
            </Section>

            {/* ── GPS ─────────────────────────────────────────────────────── */}
            {analysis.exif?.gps && (
              <Section
                icon={<MapPin className="size-3.5 text-[#10B981]" />}
                title="GPS fix from EXIF"
                subtitle="geotagged"
              >
                <ExifMap gps={analysis.exif.gps} label={analysis.name} />
                <p className="mt-2 text-[10px] leading-relaxed text-[#64748B]">
                  Written by the capturing device. Among the highest-value signals in image
                  OSINT because it places the camera — and forgeable with ordinary tools, so
                  treat it as a strong lead rather than a fact.
                </p>
              </Section>
            )}

            {/* ── OCR ─────────────────────────────────────────────────────── */}
            <Section
              icon={<Type className="size-3.5 text-[#06B6D4]" />}
              title="Text recognition (OCR)"
              subtitle={ocr ? `${ocr.words.length} words` : "not run"}
            >
              <div className="flex flex-wrap gap-1">
                {OCR_LANGUAGES.map((l) => {
                  const on = langs.includes(l.code);
                  return (
                    <button
                      key={l.code}
                      onClick={() =>
                        setLangs((prev) =>
                          prev.includes(l.code) ? prev.filter((c) => c !== l.code) : [...prev, l.code],
                        )
                      }
                      title={l.accuracyNote}
                      className={`rounded border px-1.5 py-0.5 text-[10px] ${
                        on
                          ? "border-[#06B6D4]/50 bg-[#06B6D4]/10 text-[#06B6D4]"
                          : "border-[#263548] bg-[#0B1220] text-[#64748B]"
                      }`}
                    >
                      {l.label}
                    </button>
                  );
                })}
              </div>

              <div className="mt-2 flex items-center gap-2">
                <Button size="sm" variant="outline" disabled={busy !== null || langs.length === 0} onClick={doOcr} className="h-7 gap-1 text-[10px]">
                  {busy === "Running OCR" ? <Loader2 className="size-3 animate-spin" /> : <Type className="size-3" />}
                  Run OCR
                </Button>
                {ocrProgress && (
                  <span className="font-mono text-[10px] text-[#94A3B8]">
                    {ocrProgress.status} {Math.round(ocrProgress.progress * 100)}%
                  </span>
                )}
              </div>

              {ocrError && (
                <div className="mt-2 flex items-start gap-2 rounded border border-[#EF4444]/30 bg-[#EF4444]/5 p-2">
                  <AlertTriangle className="size-3.5 shrink-0 text-[#EF4444]" />
                  <span className="text-[10px] leading-relaxed text-[#EF4444]">{ocrError}</span>
                </div>
              )}

              {ocr && (
                <div className="mt-2 space-y-2">
                  {ocr.words.length === 0 ? (
                    <p className="text-[11px] text-[#64748B]">
                      Tesseract found no text in this image with the selected languages. That is
                      an absence of recognised text, not a finding that the image contains none.
                    </p>
                  ) : (
                    <>
                      <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded border border-[#263548] bg-[#0B1220] p-2 text-[11px] leading-relaxed text-[#F3F4F6]">
                        {ocr.text}
                      </pre>
                      <div className="flex flex-wrap gap-1">
                        {ocr.words.map((w, i) => (
                          <span
                            key={i}
                            className={`rounded border px-1 py-0.5 font-mono text-[10px] ${
                              w.confidence < OCR_LOW_CONFIDENCE
                                ? "border-[#EF4444]/40 bg-[#EF4444]/5 text-[#EF4444]"
                                : "border-[#263548] bg-[#0B1220] text-[#94A3B8]"
                            }`}
                            title={`Tesseract confidence ${w.confidence.toFixed(1)}`}
                          >
                            {w.text}
                            <span className="ml-1 opacity-60">{w.confidence.toFixed(0)}</span>
                          </span>
                        ))}
                      </div>
                      <div className="font-mono text-[10px] text-[#94A3B8]">
                        mean confidence{" "}
                        {ocr.meanConfidence === null ? "—" : ocr.meanConfidence.toFixed(1)} ·{" "}
                        {ocr.lowConfidenceCount} word(s) below {OCR_LOW_CONFIDENCE}
                      </div>
                    </>
                  )}

                  <p className="text-[10px] leading-relaxed text-[#64748B]">{ocr.method}</p>
                  {ocr.accuracyNotes.map((n, i) => (
                    <p key={i} className="text-[10px] leading-relaxed text-[#F59E0B]">{n}</p>
                  ))}

                  {/* ── OCR text into Module 2's entity extraction ────────── */}
                  {ocr.text.trim() && (
                    <div className="border-t border-[#263548] pt-2">
                      <Button
                        size="sm" variant="outline"
                        disabled={busy !== null || entities !== null}
                        onClick={runEntities}
                        className="h-7 gap-1 text-[10px]"
                      >
                        {busy === "Extracting entities" ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <Tags className="size-3" />
                        )}
                        Extract entities from this text
                      </Button>
                      <p className="mt-1 text-[10px] leading-relaxed text-[#64748B]">
                        Runs Module 2's extractor over the recognised text. Note it inherits OCR's
                        errors: a mis-recognised name is extracted as a mis-spelled entity, and
                        the model has no way to know the text came from an image.
                      </p>

                      {entityError && (
                        <div className="mt-2 flex items-start gap-2 rounded border border-[#EF4444]/30 bg-[#EF4444]/5 p-2">
                          <AlertTriangle className="size-3.5 shrink-0 text-[#EF4444]" />
                          <span className="text-[10px] leading-relaxed text-[#EF4444]">
                            <span className="font-bold">AI unavailable.</span> {entityError}
                          </span>
                        </div>
                      )}

                      {entities && entities.length === 0 && (
                        <p className="mt-1.5 text-[10px] text-[#64748B]">
                          The model found no named entities in the recognised text.
                        </p>
                      )}

                      {entities && entities.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {entities.map((e, i) => (
                            <Badge
                              key={`${e.entity}-${i}`}
                              className="border-[#8B5CF6]/30 bg-[#8B5CF6]/10 text-[10px] font-normal text-[#8B5CF6]"
                              title={`${e.type} · model-reported confidence ${e.confidence}`}
                            >
                              {e.entity}
                              <span className="ml-1 opacity-60">{e.confidence.toFixed(2)}</span>
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </Section>

            {/* ── Near-duplicates ─────────────────────────────────────────── */}
            <Section
              icon={<Fingerprint className="size-3.5 text-[#8B5CF6]" />}
              title="Near-duplicate matches"
              subtitle={`${analysis.duplicates?.matches.length ?? 0} match(es)`}
            >
              {analysis.duplicates && (
                <>
                  <p className="text-[11px] leading-relaxed text-[#F3F4F6]">
                    {analysis.duplicates.summary}
                  </p>
                  {analysis.duplicates.matches.length > 0 && (
                    <div className="mt-2 space-y-1.5">
                      {analysis.duplicates.matches.map((m) => (
                        <div key={m.image.id} className="rounded border border-[#263548] bg-[#0B1220]/60 p-2">
                          <div className="flex flex-wrap items-center gap-2 text-[10px]">
                            <span className="font-mono text-white">{m.image.source}</span>
                            {m.identical && (
                              <Badge className="border-[#EF4444]/40 bg-[#EF4444]/10 text-[9px] font-normal text-[#EF4444]">
                                same image
                              </Badge>
                            )}
                            <span className="ml-auto font-mono text-[#94A3B8]">
                              distance {m.distance}/64
                              {m.daysEarlier !== null && m.daysEarlier > 0 &&
                                ` · ${m.daysEarlier.toFixed(0)}d earlier`}
                            </span>
                          </div>
                          {m.image.context && (
                            <p className="mt-0.5 text-[10px] text-[#94A3B8]">{m.image.context}</p>
                          )}
                          {m.image.url && (
                            <a
                              href={m.image.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[10px] text-[#3B82F6] hover:underline"
                            >
                              {m.image.url.slice(0, 80)}
                            </a>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  <p className="mt-2 text-[10px] leading-relaxed text-[#64748B]">
                    {analysis.duplicates.method} Corpus is {corpus.length} image(s) hashed in this
                    browser; matching is against what has been analysed here, not the open web.
                  </p>
                </>
              )}
            </Section>
          </div>

          <div className="space-y-4">
            <NotImplementedPanel />
          </div>
        </div>
      )}
    </AppShell>
  );
}
