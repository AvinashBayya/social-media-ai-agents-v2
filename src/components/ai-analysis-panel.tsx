import { useEffect, useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertTriangle,
  Loader2,
  Scan,
  ScanFace,
  FileText,
  FileOutput,
  Wifi,
  WifiOff,
  Plus,
  X,
  ChevronDown,
  ChevronRight,
  Crop,
  Save,
} from "lucide-react";
import {
  aiServiceDescribe,
  aiServiceDetect,
  aiServiceFaces,
  aiServiceHealth,
  AI_SERVICE_PROVENANCE,
  type AiDetection,
  type AiFace,
  type AiFaceReference,
  type AiServiceHealth,
} from "@/utils/ai-service-client";
import { cropImageRegion } from "@/utils/imaging-client";
import { sha256OfFile } from "@/utils/evidence";
import { buildDetectionEvidenceRecord, getEvidence, appendEvidence } from "@/utils/evidence-store";
import { llmReport } from "@/utils/llm";
import { MarkdownReport } from "@/components/markdown-report";
import { toast } from "sonner";

const CARD = "bg-console-surface border-console-border";

/** A saved evidence record's `previewUrl` must survive a page reload — an object URL (URL.createObjectURL) does not, since it is revoked with the tab session, but a data URL persists in localStorage like the rest of the record. */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Could not read the cropped image."));
    reader.readAsDataURL(blob);
  });
}

function Section({
  icon,
  title,
  subtitle,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <Card className={CARD}>
      <CardContent className="p-4">
        <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 text-left">
          {open ? (
            <ChevronDown className="size-3.5 shrink-0 text-console-label" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-console-label" />
          )}
          {icon}
          <span className="text-xs font-bold uppercase text-console-text">{title}</span>
          {subtitle && <span className="ml-auto text-[10px] text-console-label">{subtitle}</span>}
        </button>
        {open && <div className="mt-3">{children}</div>}
      </CardContent>
    </Card>
  );
}

/**
 * Local-model analysis (Grounding DINO detection, Florence-2 description,
 * InsightFace faces) plus report generation — the same feature originally
 * built for /images, extracted so /videos can offer it per selected
 * keyframe without duplicating ~250 lines of state and handlers.
 *
 * Callers own everything upstream of "here is an image": EXIF/C2PA/OCR/
 * whatever else is specific to their page is passed in as
 * `reportContextLines` and prepended to this panel's own detect/describe/
 * faces findings when composing the report. This panel never fabricates —
 * a missing capability or an ai-service outage is reported as exactly
 * that, never silently skipped.
 *
 * State resets whenever `resetKey` changes (images.tsx: the analysed
 * image's name/hash; videos.tsx: the selected frame's timestamp) — a
 * detection made on the previous image/frame must not linger once a new
 * one is in view.
 */
export function AiAnalysisPanel({
  image,
  imageName,
  resetKey,
  reportType = "Image Intelligence",
  reportContextLines = [],
  bytesUnavailableNote,
}: {
  image: Blob | null;
  imageName: string;
  resetKey: string;
  reportType?: string;
  reportContextLines?: string[];
  bytesUnavailableNote?: string;
}) {
  const faceRefInputRef = useRef<HTMLInputElement | null>(null);

  const [aiHealth, setAiHealth] = useState<AiServiceHealth | null>(null);
  const [aiHealthError, setAiHealthError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const [detectPrompts, setDetectPrompts] = useState("a vehicle license plate, a weapon, a rifle, a military vehicle");
  const [detections, setDetections] = useState<AiDetection[] | null>(null);
  const [detectError, setDetectError] = useState("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [crop, setCrop] = useState<{ index: number; url: string; blob: Blob } | null>(null);
  const [cropBusy, setCropBusy] = useState<number | null>(null);
  const [cropError, setCropError] = useState("");
  const [savingCrop, setSavingCrop] = useState(false);
  const [description, setDescription] = useState<string | null>(null);
  const [describeError, setDescribeError] = useState("");
  const [faceRefs, setFaceRefs] = useState<AiFaceReference[]>([]);
  const [faceRefDraftLabel, setFaceRefDraftLabel] = useState("");
  const [faces, setFaces] = useState<AiFace[] | null>(null);
  const [facesError, setFacesError] = useState("");
  const [report, setReport] = useState<{ text: string; model: string; provider: string } | null>(
    null,
  );
  const [reportError, setReportError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const h = await aiServiceHealth();
        if (!cancelled) {
          setAiHealth(h);
          setAiHealthError("");
        }
      } catch (err: any) {
        if (!cancelled) {
          setAiHealth(null);
          setAiHealthError(err?.message ?? String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setDetections(null);
    setDetectError("");
    setDescription(null);
    setDescribeError("");
    setFaces(null);
    setFacesError("");
    setFaceRefs([]);
    setReport(null);
    setReportError("");
    setNaturalSize(null);
    setCropError("");
    setCrop(null);
  }, [resetKey]);

  // Kept as an object URL for the bounding-box overlay `<img>` below — separate
  // from `image` itself, which stays the raw Blob every ai-service call sends.
  useEffect(() => {
    if (!image) {
      setImageUrl(null);
      return;
    }
    const url = URL.createObjectURL(image);
    setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);

  useEffect(() => {
    if (!crop) return;
    return () => URL.revokeObjectURL(crop.url);
  }, [crop]);

  const runDetect = async () => {
    if (!image) return;
    const prompts = detectPrompts
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    if (prompts.length === 0) return;
    setBusy("Running object detection");
    setDetectError("");
    setDetections(null);
    setCrop(null);
    setCropError("");
    try {
      const res = await aiServiceDetect(image, prompts);
      setDetections(res.detections);
    } catch (err: any) {
      setDetectError(err?.message ?? String(err));
    } finally {
      setBusy(null);
    }
  };

  /**
   * Crops directly from `image` — the exact Blob `runDetect` sent to
   * ai-service — never a separately-loaded copy, since the detection's box
   * coordinates are only meaningful relative to whatever bytes ai-service
   * actually received (see cropImageRegion's own doc comment).
   */
  const openCrop = async (index: number) => {
    if (!image || !detections) return;
    setCropError("");
    setCropBusy(index);
    try {
      const blob = await cropImageRegion(image, detections[index].box);
      const url = URL.createObjectURL(blob);
      setCrop({ index, url, blob });
    } catch (err: any) {
      setCropError(err?.message ?? String(err));
    } finally {
      setCropBusy(null);
    }
  };

  const saveCropToVault = async () => {
    if (!crop || !detections) return;
    const detection = detections[crop.index];
    setSavingCrop(true);
    try {
      const hash = await sha256OfFile(crop.blob).catch(() => null);
      const previewDataUrl = await blobToDataUrl(crop.blob);
      const record = buildDetectionEvidenceRecord({
        label: detection.label,
        score: detection.score,
        sourceName: imageName,
        reportType,
        previewDataUrl,
        hash,
        existing: getEvidence(),
      });
      appendEvidence(record);
      toast.success(`Saved to Evidence Vault as ${record.id}.`);
      setCrop(null);
    } catch (err: any) {
      toast.error(`Could not save to Evidence Vault: ${err?.message ?? String(err)}`);
    } finally {
      setSavingCrop(false);
    }
  };

  const runDescribe = async () => {
    if (!image) return;
    setBusy("Describing image");
    setDescribeError("");
    setDescription(null);
    try {
      const res = await aiServiceDescribe(image);
      setDescription(res.description);
    } catch (err: any) {
      setDescribeError(err?.message ?? String(err));
    } finally {
      setBusy(null);
    }
  };

  const addFaceRef = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const id = faceRefDraftLabel.trim() || `reference-${faceRefs.length + 1}`;
    setFaceRefs((prev) => [...prev, { id, file }]);
    setFaceRefDraftLabel("");
  };

  const removeFaceRef = (id: string) => {
    setFaceRefs((prev) => prev.filter((r) => r.id !== id));
  };

  const runFaces = async () => {
    if (!image) return;
    setBusy(faceRefs.length ? "Detecting & matching faces" : "Detecting faces");
    setFacesError("");
    setFaces(null);
    try {
      const res = await aiServiceFaces(image, faceRefs);
      setFaces(res.faces);
    } catch (err: any) {
      setFacesError(err?.message ?? String(err));
    } finally {
      setBusy(null);
    }
  };

  const generateReport = async () => {
    setBusy("Generating report");
    setReportError("");
    setReport(null);
    try {
      const lines: string[] = [...reportContextLines];
      if (description) lines.push(`AI-generated image description (Florence-2): ${description}`);
      if (detections?.length) {
        lines.push(
          `Object detection candidates (Grounding DINO, unverified — review before treating as ` +
            `a confirmed finding): ` +
            detections.map((d) => `${d.label} (${(d.score * 100).toFixed(0)}%)`).join(", "),
        );
      }
      if (faces?.length) {
        const matched = faces.filter((f) => f.matchId);
        lines.push(
          `Face detection: ${faces.length} face(s) found.` +
            (matched.length
              ? ` Matched against operator-supplied reference(s): ` +
                matched
                  .map(
                    (f) =>
                      `${f.matchId}` +
                      (f.matchScore !== null ? ` (${(f.matchScore * 100).toFixed(0)}%)` : ""),
                  )
                  .join(", ")
              : " No reference set supplied, or no match cleared the similarity threshold."),
        );
      }

      const res = await llmReport({
        data: { type: reportType, target: imageName, data: lines.join("\n") },
      });
      setReport({ text: res.text, model: res.model, provider: res.provider });
    } catch (err: any) {
      setReportError(err?.message ?? String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Card className={CARD}>
        <CardContent className="p-4">
          <div className="flex items-center gap-1.5">
            {aiHealth ? (
              <Wifi className="size-3.5 text-console-green" />
            ) : (
              <WifiOff className="size-3.5 text-console-red" />
            )}
            <span className="text-xs font-bold uppercase text-console-text">Local AI Analysis</span>
          </div>
          <p className="mt-1.5 text-[10px] leading-relaxed text-console-label">
            {AI_SERVICE_PROVENANCE.disclosure}
          </p>
          <p className="mt-1 text-[10px] leading-relaxed text-console-label">
            {AI_SERVICE_PROVENANCE.models}
          </p>

          {aiHealthError && (
            <div className="mt-2 flex items-start gap-2 rounded border border-console-red/30 bg-console-red/5 p-2">
              <AlertTriangle className="size-3.5 shrink-0 text-console-red" />
              <span className="text-[10px] leading-relaxed text-console-red">
                <span className="font-bold">ai-service unavailable.</span> {aiHealthError}
              </span>
            </div>
          )}

          {aiHealth && (
            <div className="mt-2 font-mono text-[9px] leading-relaxed text-console-label">
              device: {aiHealth.device}
              {Object.entries(aiHealth.models)
                .filter(([k]) => ["grounding_dino", "florence2", "insightface"].includes(k))
                .map(([k, v]) => ` · ${k}: ${v}`)
                .join("")}
            </div>
          )}

          {aiHealth && !image && (
            <p className="mt-2 text-[10px] leading-relaxed text-console-amber">
              {bytesUnavailableNote ?? "Image bytes are unavailable for this item."}
            </p>
          )}
        </CardContent>
      </Card>

      {aiHealth && image && (
        <>
          <Section
            icon={<Scan className="size-3.5 text-console-blue" />}
            title="Object detection"
            subtitle={detections ? `${detections.length} candidate(s)` : "not run"}
          >
            <Input
              value={detectPrompts}
              onChange={(e) => setDetectPrompts(e.target.value)}
              placeholder="comma-separated: a vehicle license plate, a weapon, a rifle"
              className="h-7 border-console-border bg-console-deep text-[10px] text-console-text"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null || !detectPrompts.trim()}
              onClick={runDetect}
              className="mt-2 h-7 gap-1 text-[10px]"
            >
              {busy === "Running object detection" ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Scan className="size-3" />
              )}
              Run detection
            </Button>

            {detectError && (
              <div className="mt-2 flex items-start gap-2 rounded border border-console-red/30 bg-console-red/5 p-2">
                <AlertTriangle className="size-3.5 shrink-0 text-console-red" />
                <span className="text-[10px] leading-relaxed text-console-red">{detectError}</span>
              </div>
            )}

            {detections && (
              <div className="mt-2 space-y-1">
                {detections.length === 0 ? (
                  <p className="text-[11px] text-console-label">
                    No candidates cleared the confidence threshold for these prompts.
                  </p>
                ) : (
                  <>
                    {imageUrl && (
                      <div
                        className="relative w-full overflow-hidden rounded border border-console-border bg-console-deep"
                        style={naturalSize ? { aspectRatio: `${naturalSize.width} / ${naturalSize.height}` } : undefined}
                      >
                        <img
                          src={imageUrl}
                          alt=""
                          className="block h-full w-full object-contain"
                          onLoad={(e) =>
                            setNaturalSize({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })
                          }
                        />
                        {naturalSize &&
                          detections.map((d, i) => {
                            const [x0, y0, x1, y1] = d.box;
                            return (
                              <div
                                key={i}
                                title={`${d.label} (${(d.score * 100).toFixed(0)}%)`}
                                className="absolute border-2 border-console-blue shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
                                style={{
                                  left: `${(x0 / naturalSize.width) * 100}%`,
                                  top: `${(y0 / naturalSize.height) * 100}%`,
                                  width: `${((x1 - x0) / naturalSize.width) * 100}%`,
                                  height: `${((y1 - y0) / naturalSize.height) * 100}%`,
                                }}
                              >
                                <span className="absolute -top-4 left-0 whitespace-nowrap rounded-sm bg-console-blue px-1 text-[9px] font-bold text-console-deep">
                                  {d.label}
                                </span>
                              </div>
                            );
                          })}
                      </div>
                    )}

                    {detections.map((d, i) => (
                      <div
                        key={i}
                        className="flex items-center justify-between rounded border border-console-border bg-console-deep/60 px-2 py-1"
                      >
                        <span className="text-[11px] text-console-text">{d.label}</span>
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[10px] text-console-muted">{(d.score * 100).toFixed(0)}%</span>
                          <button
                            onClick={() => openCrop(i)}
                            disabled={cropBusy !== null}
                            title="View this region enlarged, and optionally save it"
                            className="text-console-label hover:text-console-blue disabled:opacity-50"
                          >
                            {cropBusy === i ? <Loader2 className="size-3.5 animate-spin" /> : <Crop className="size-3.5" />}
                          </button>
                        </div>
                      </div>
                    ))}
                  </>
                )}
                {cropError && (
                  <div className="mt-1 flex items-start gap-2 rounded border border-console-red/30 bg-console-red/5 p-2">
                    <AlertTriangle className="size-3.5 shrink-0 text-console-red" />
                    <span className="text-[10px] leading-relaxed text-console-red">{cropError}</span>
                  </div>
                )}
                <p className="mt-1 text-[10px] leading-relaxed text-console-amber">
                  Unverified candidates for analyst review, not confirmed findings — Grounding DINO
                  does not reliably return "nothing found" for an absent object and can report a
                  confident best-guess match instead.
                </p>
              </div>
            )}
          </Section>

          <Dialog open={crop !== null} onOpenChange={(open) => !open && setCrop(null)}>
            <DialogContent className="max-w-lg bg-console-surface border-console-border">
              {crop && detections && (
                <>
                  <DialogHeader>
                    <DialogTitle className="text-xs text-console-text">
                      {detections[crop.index].label} — {(detections[crop.index].score * 100).toFixed(0)}%
                    </DialogTitle>
                  </DialogHeader>
                  <img src={crop.url} alt={detections[crop.index].label} className="max-h-[60vh] w-full rounded border border-console-border object-contain" />
                  <p className="text-[10px] leading-relaxed text-console-amber">
                    Unverified candidate for analyst review — not a confirmed finding.
                  </p>
                  <DialogFooter>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={savingCrop}
                      onClick={saveCropToVault}
                      className="h-7 gap-1 text-[10px]"
                    >
                      {savingCrop ? <Loader2 className="size-3 animate-spin" /> : <Save className="size-3" />}
                      Save to Evidence Vault
                    </Button>
                  </DialogFooter>
                </>
              )}
            </DialogContent>
          </Dialog>

          <Section
            icon={<FileText className="size-3.5 text-console-purple" />}
            title="Image description"
            subtitle={description ? "generated" : "not run"}
          >
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={runDescribe}
              className="h-7 gap-1 text-[10px]"
            >
              {busy === "Describing image" ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <FileText className="size-3" />
              )}
              Describe image
            </Button>

            {describeError && (
              <div className="mt-2 flex items-start gap-2 rounded border border-console-red/30 bg-console-red/5 p-2">
                <AlertTriangle className="size-3.5 shrink-0 text-console-red" />
                <span className="text-[10px] leading-relaxed text-console-red">{describeError}</span>
              </div>
            )}

            {description && (
              <p className="mt-2 text-[11px] leading-relaxed text-console-text">{description}</p>
            )}
          </Section>

          <Section
            icon={<ScanFace className="size-3.5 text-console-cyan" />}
            title="Face detection & matching"
            subtitle={faces ? `${faces.length} face(s)` : "not run"}
          >
            <p className="text-[10px] leading-relaxed text-console-label">
              Matching, if any reference photos are added below, checks only against those photos
              for this one request. Nothing is stored, no watchlist is consulted and no open-web
              face search is performed.
            </p>

            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Input
                value={faceRefDraftLabel}
                onChange={(e) => setFaceRefDraftLabel(e.target.value)}
                placeholder="label for next reference photo (optional)"
                className="h-7 min-w-[160px] flex-1 border-console-border bg-console-deep text-[10px] text-console-text"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => faceRefInputRef.current?.click()}
                className="h-7 gap-1 text-[10px]"
              >
                <Plus className="size-3" />
                Add reference photo
              </Button>
              <input
                ref={faceRefInputRef}
                type="file"
                accept="image/*"
                onChange={addFaceRef}
                className="hidden"
              />
            </div>

            {faceRefs.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {faceRefs.map((r) => (
                  <Badge
                    key={r.id}
                    className="gap-1 border-console-cyan/30 bg-console-cyan/10 text-[10px] font-normal text-console-cyan"
                  >
                    {r.id}
                    <button onClick={() => removeFaceRef(r.id)} title="Remove">
                      <X className="size-2.5" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}

            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={runFaces}
              className="mt-2 h-7 gap-1 text-[10px]"
            >
              {busy === "Detecting faces" || busy === "Detecting & matching faces" ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <ScanFace className="size-3" />
              )}
              {faceRefs.length ? "Detect & match faces" : "Detect faces"}
            </Button>

            {facesError && (
              <div className="mt-2 flex items-start gap-2 rounded border border-console-red/30 bg-console-red/5 p-2">
                <AlertTriangle className="size-3.5 shrink-0 text-console-red" />
                <span className="text-[10px] leading-relaxed text-console-red">{facesError}</span>
              </div>
            )}

            {faces && (
              <div className="mt-2 space-y-1">
                {faces.length === 0 ? (
                  <p className="text-[11px] text-console-label">No faces detected.</p>
                ) : (
                  faces.map((f, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between rounded border border-console-border bg-console-deep/60 px-2 py-1"
                    >
                      <span className="text-[11px] text-console-text">Face {i + 1}</span>
                      <span className="font-mono text-[10px] text-console-muted">
                        {f.matchId
                          ? `matched: ${f.matchId}` +
                            (f.matchScore !== null ? ` (${(f.matchScore * 100).toFixed(0)}%)` : "")
                          : faceRefs.length
                            ? "no match"
                            : "detection only"}
                      </span>
                    </div>
                  ))
                )}
              </div>
            )}
          </Section>

          <Card className={CARD}>
            <CardContent className="p-4">
              <div className="flex items-center gap-1.5">
                <FileOutput className="size-3.5 text-console-green" />
                <span className="text-xs font-bold uppercase text-console-text">Generate report</span>
              </div>
              <p className="mt-1.5 text-[10px] leading-relaxed text-console-label">
                Synthesizes only what has actually been collected — the context passed into this
                panel plus any detection/description/faces run above. Sections with nothing
                collected are stated as such, never invented.
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={generateReport}
                className="mt-2 h-7 gap-1 text-[10px]"
              >
                {busy === "Generating report" ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <FileOutput className="size-3" />
                )}
                Generate report
              </Button>

              {reportError && (
                <div className="mt-2 flex items-start gap-2 rounded border border-console-red/30 bg-console-red/5 p-2">
                  <AlertTriangle className="size-3.5 shrink-0 text-console-red" />
                  <span className="text-[10px] leading-relaxed text-console-red">
                    <span className="font-bold">AI unavailable.</span> {reportError}
                  </span>
                </div>
              )}

              {report && (
                <div className="mt-2">
                  <div className="max-h-96 overflow-auto rounded border border-console-border bg-console-deep p-2.5">
                    <MarkdownReport text={report.text} />
                  </div>
                  <p className="mt-1.5 font-mono text-[9px] text-console-label">
                    {report.model} via {report.provider}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}
