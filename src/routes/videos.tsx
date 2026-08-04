import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { AppShell, PageHeader } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Upload, Loader2, AlertTriangle, Film, Scissors, Type, Fingerprint, Info,
} from "lucide-react";
import {
  findNearDuplicates, OCR_LANGUAGES, OCR_LOW_CONFIDENCE,
  type DuplicateReport, type HashedImage, type OcrReport,
} from "@/utils/imaging";
import {
  dataUrlToBlob, extractKeyframes, loadImageCorpus, rememberImage, runOcr,
  MediaError, type KeyframeResult,
} from "@/utils/imaging-client";
import { NotImplementedPanel } from "@/components/not-implemented";

/**
 * Video Intelligence — Module 4 (PS-18 §6.4).
 *
 * The previous version of this page was invented in full: five scenes with
 * captions and timestamps, a five-line "audio transcript" of a press briefing
 * that never happened, an object table reading "Faces 4 · 92%", a rolling
 * sentiment chart, and a "Deepfake analysis 14%" panel captioned "facial
 * artifact and audio-sync analysis suggest authentic capture". No video was ever
 * decoded, and no such analysis existed.
 *
 * This replaces it with what actually runs with no GPU and no server: the
 * browser decodes the file, keyframes are painted to a canvas at a fixed
 * interval, each is perceptually hashed, scene cuts come from the distance
 * between consecutive hashes, and every frame is matched against the image
 * corpus. A video reusing a known still is a strong recontextualisation signal
 * and needs no model at all.
 *
 * Audio transcription is NOT implemented — see the panel for why.
 */

export const Route = createFileRoute("/videos")({
  head: () => ({ meta: [{ title: "Video Intelligence — Sentinel AI" }] }),
  component: Page,
});

const CARD = "bg-[#111827] border-[#263548]";
const DEFAULT_LANGS = ["eng"];
/** Frame budget. 60 keyframes at 2s covers two minutes; beyond that the tab suffers. */
const MAX_FRAMES = 60;

const fmtTime = (s: number) =>
  `${Math.floor(s / 60).toString().padStart(2, "0")}:${Math.floor(s % 60).toString().padStart(2, "0")}`;

function Page() {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [result, setResult] = useState<KeyframeResult | null>(null);
  const [name, setName] = useState("");
  const [interval, setIntervalSeconds] = useState(2);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState("");

  const [corpus, setCorpus] = useState<HashedImage[]>([]);
  const [matches, setMatches] = useState<Record<number, DuplicateReport>>({});
  const [selected, setSelected] = useState<number | null>(null);

  const [langs, setLangs] = useState<string[]>(DEFAULT_LANGS);
  const [ocr, setOcr] = useState<Record<number, OcrReport>>({});
  const [ocrError, setOcrError] = useState("");

  useEffect(() => setCorpus(loadImageCorpus()), []);

  const analyse = async (file: File) => {
    setError("");
    setResult(null);
    setMatches({});
    setOcr({});
    setSelected(null);
    setName(file.name);
    setBusy("Decoding video");

    try {
      const stored = loadImageCorpus();
      const res = await extractKeyframes(file, interval, MAX_FRAMES, (done, total) => {
        setProgress({ done, total });
        setBusy("Extracting keyframes");
      });

      // Each keyframe is matched against the image corpus. A video that reuses a
      // still already seen in an article is the recontextualisation case this
      // module exists to catch.
      const found: Record<number, DuplicateReport> = {};
      res.frames.forEach((f, i) => {
        const report = findNearDuplicates({ hash: f.hash, id: `${file.name}#${i}` }, stored);
        if (report.matches.length > 0) found[i] = report;
      });
      setMatches(found);
      setResult(res);
    } catch (err: any) {
      setError(err instanceof MediaError ? `[${err.stage}] ${err.message}` : (err?.message ?? String(err)));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const ocrFrame = async (index: number) => {
    if (!result) return;
    const frame = result.frames[index];
    if (!frame.dataUrl) return;
    setBusy("Running OCR");
    setOcrError("");
    try {
      const blob = await dataUrlToBlob(frame.dataUrl);
      const report = await runOcr(blob, langs);
      setOcr((prev) => ({ ...prev, [index]: report }));
    } catch (err: any) {
      setOcrError(err?.message ?? String(err));
    } finally {
      setBusy(null);
    }
  };

  const addFrameToCorpus = (index: number) => {
    if (!result) return;
    const frame = result.frames[index];
    const next = rememberImage({
      id: `${name}#${fmtTime(frame.time)}`,
      hash: frame.hash,
      source: "video keyframe",
      url: "",
      seenAt: new Date().toISOString(),
      context: `Keyframe at ${fmtTime(frame.time)} of ${name}`,
    });
    setCorpus(next);
  };

  const cutIndexes = new Set(result?.scenes.cuts.map((c) => c.index) ?? []);

  return (
    <AppShell>
      <PageHeader
        title="Video Intelligence"
        description="In-browser keyframe extraction, scene-cut detection and perceptual matching. No GPU, no server — the file is never uploaded."
      />

      <Card className={`${CARD} mb-4`}>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-end gap-2">
            <Button size="sm" onClick={() => fileRef.current?.click()} disabled={busy !== null} className="h-8 gap-1.5">
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
              {busy ?? "Upload video"}
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="video/*"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) analyse(f); }}
              className="hidden"
            />

            <div>
              <label className="text-[10px] uppercase tracking-wider text-[#64748B]">
                Sample interval (s)
              </label>
              <Input
                type="number" min={0.5} max={30} step={0.5}
                value={interval}
                onChange={(e) => setIntervalSeconds(Math.max(0.5, Number(e.target.value) || 2))}
                className="mt-1 h-8 w-24 border-[#263548] bg-[#0B1220] text-[11px] text-white"
              />
            </div>

            {progress && (
              <span className="font-mono text-[10px] text-[#94A3B8]">
                frame {progress.done}/{progress.total}
              </span>
            )}
            <span className="ml-auto text-[10px] text-[#64748B]">
              {corpus.length} image(s) in the matching corpus
            </span>
          </div>

          <p className="mt-2 flex items-start gap-1.5 text-[10px] leading-relaxed text-[#64748B]">
            <Info className="mt-px size-3 shrink-0" />
            Frames are sampled at a fixed interval, so a scene cut is located to within one
            interval rather than to the exact frame. Sampling stops at {MAX_FRAMES} frames.
          </p>

          {error && (
            <div className="mt-3 flex items-start gap-2 rounded border border-[#EF4444]/30 bg-[#EF4444]/5 p-2">
              <AlertTriangle className="size-3.5 shrink-0 text-[#EF4444]" />
              <span className="font-mono text-[10px] leading-relaxed text-[#EF4444]">{error}</span>
            </div>
          )}
        </CardContent>
      </Card>

      {!result ? (
        <div className="grid gap-4 lg:grid-cols-[1fr_400px]">
          <Card className={CARD}>
            <CardContent className="p-10 text-center">
              <Film className="mx-auto size-8 text-[#263548]" />
              <p className="mt-3 text-sm text-[#94A3B8]">No video loaded.</p>
              <p className="mx-auto mt-1 max-w-md text-[11px] leading-relaxed text-[#64748B]">
                Upload a file to extract keyframes. Decoding, hashing and OCR all run in this
                tab — nothing is sent to a server, and there is no server-side media pipeline
                to send it to.
              </p>
            </CardContent>
          </Card>
          <NotImplementedPanel />
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_400px]">
          <div className="space-y-4">
            <Card className={CARD}>
              <CardContent className="p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Film className="size-3.5 text-[#3B82F6]" />
                  <span className="truncate text-xs font-bold uppercase text-white">{name}</span>
                  <span className="ml-auto font-mono text-[10px] text-[#94A3B8]">
                    {fmtTime(result.duration)} · {result.frames.length} keyframes @ {interval}s
                  </span>
                </div>

                {result.truncated && (
                  <p className="mt-1.5 text-[10px] text-[#F59E0B]">
                    Sampling stopped at {MAX_FRAMES} frames — the remainder of the video was not
                    analysed. Raise the interval to cover the whole duration.
                  </p>
                )}

                <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-6">
                  {result.frames.map((f, i) => (
                    <button
                      key={i}
                      onClick={() => setSelected(selected === i ? null : i)}
                      className={`overflow-hidden rounded border text-left ${
                        selected === i
                          ? "border-[#3B82F6]"
                          : cutIndexes.has(i)
                            ? "border-[#F59E0B]/60"
                            : "border-[#263548]"
                      }`}
                    >
                      {f.dataUrl && (
                        <img src={f.dataUrl} alt={`frame at ${fmtTime(f.time)}`} className="h-16 w-full object-cover" />
                      )}
                      <div className="flex items-center gap-1 px-1 py-0.5 font-mono text-[9px] text-[#94A3B8]">
                        {fmtTime(f.time)}
                        {cutIndexes.has(i) && <Scissors className="size-2.5 text-[#F59E0B]" />}
                        {matches[i] && <Fingerprint className="size-2.5 text-[#8B5CF6]" />}
                      </div>
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card className={CARD}>
              <CardContent className="p-4">
                <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase text-white">
                  <Scissors className="size-3.5 text-[#F59E0B]" />
                  Scene cuts
                </h3>
                {result.scenes.cuts.length === 0 ? (
                  <p className="mt-2 text-[11px] text-[#64748B]">
                    No cut exceeded the threshold between sampled frames. With a {interval}s
                    interval, cuts shorter than that can fall entirely between samples.
                  </p>
                ) : (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {result.scenes.cuts.map((c) => (
                      <Badge
                        key={c.index}
                        variant="outline"
                        className="cursor-pointer border-[#F59E0B]/40 bg-[#F59E0B]/10 font-mono text-[10px] font-normal text-[#F59E0B]"
                        onClick={() => setSelected(c.index)}
                      >
                        {fmtTime(c.time)} · Δ{c.distanceFromPrevious}
                      </Badge>
                    ))}
                  </div>
                )}
                <p className="mt-2 text-[10px] leading-relaxed text-[#64748B]">
                  {result.scenes.method}
                  {result.scenes.meanDistance !== null &&
                    ` Mean consecutive-frame distance ${result.scenes.meanDistance.toFixed(1)}.`}
                </p>
              </CardContent>
            </Card>

            {Object.keys(matches).length > 0 && (
              <Card className="border-[#8B5CF6]/40 bg-[#111827]">
                <CardContent className="p-4">
                  <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase text-white">
                    <Fingerprint className="size-3.5 text-[#8B5CF6]" />
                    Keyframes matching previously seen images
                  </h3>
                  <p className="mt-1 text-[10px] leading-relaxed text-[#94A3B8]">
                    A video reusing a still that already appeared elsewhere is a
                    recontextualisation signal. It is a fact about where the image has been
                    seen, not a claim about intent.
                  </p>
                  <div className="mt-2 space-y-1.5">
                    {Object.entries(matches).map(([idx, report]) => (
                      <div key={idx} className="rounded border border-[#263548] bg-[#0B1220]/60 p-2">
                        <button
                          onClick={() => setSelected(Number(idx))}
                          className="font-mono text-[10px] text-[#3B82F6] hover:underline"
                        >
                          frame {fmtTime(result.frames[Number(idx)].time)}
                        </button>
                        <p className="mt-0.5 text-[10px] leading-relaxed text-[#94A3B8]">
                          {report.summary}
                        </p>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {selected !== null && (
              <Card className={CARD}>
                <CardContent className="p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-bold uppercase text-white">
                      Frame at {fmtTime(result.frames[selected].time)}
                    </span>
                    <span className="ml-auto font-mono text-[10px] text-[#94A3B8]">
                      pHash {result.frames[selected].hash}
                    </span>
                  </div>

                  {result.frames[selected].dataUrl && (
                    <img
                      src={result.frames[selected].dataUrl}
                      alt={`keyframe at ${fmtTime(result.frames[selected].time)}`}
                      className="mt-2 max-h-72 w-full rounded bg-[#0B1220] object-contain"
                    />
                  )}

                  <div className="mt-2 flex flex-wrap gap-1">
                    {OCR_LANGUAGES.slice(0, 8).map((l) => {
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

                  <div className="mt-2 flex gap-1.5">
                    <Button
                      size="sm" variant="outline"
                      disabled={busy !== null || langs.length === 0}
                      onClick={() => ocrFrame(selected)}
                      className="h-7 gap-1 text-[10px]"
                    >
                      {busy === "Running OCR" ? <Loader2 className="size-3 animate-spin" /> : <Type className="size-3" />}
                      OCR this frame
                    </Button>
                    <Button
                      size="sm" variant="outline"
                      onClick={() => addFrameToCorpus(selected)}
                      className="h-7 gap-1 text-[10px]"
                    >
                      <Fingerprint className="size-3" />
                      Add to corpus
                    </Button>
                  </div>

                  {ocrError && (
                    <div className="mt-2 flex items-start gap-2 rounded border border-[#EF4444]/30 bg-[#EF4444]/5 p-2">
                      <AlertTriangle className="size-3.5 shrink-0 text-[#EF4444]" />
                      <span className="text-[10px] leading-relaxed text-[#EF4444]">{ocrError}</span>
                    </div>
                  )}

                  {ocr[selected] && (
                    <div className="mt-2 space-y-1.5">
                      {ocr[selected].words.length === 0 ? (
                        <p className="text-[11px] text-[#64748B]">
                          No text recognised in this frame with the selected languages.
                        </p>
                      ) : (
                        <>
                          <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded border border-[#263548] bg-[#0B1220] p-2 text-[11px] text-[#F3F4F6]">
                            {ocr[selected].text}
                          </pre>
                          <div className="font-mono text-[10px] text-[#94A3B8]">
                            mean confidence{" "}
                            {ocr[selected].meanConfidence?.toFixed(1) ?? "—"} ·{" "}
                            {ocr[selected].lowConfidenceCount} word(s) below {OCR_LOW_CONFIDENCE}
                          </div>
                        </>
                      )}
                      {ocr[selected].accuracyNotes.map((n, i) => (
                        <p key={i} className="text-[10px] leading-relaxed text-[#F59E0B]">{n}</p>
                      ))}
                    </div>
                  )}

                  {matches[selected] && (
                    <p className="mt-2 rounded border border-[#8B5CF6]/30 bg-[#8B5CF6]/5 p-2 text-[10px] leading-relaxed text-[#94A3B8]">
                      {matches[selected].summary}
                    </p>
                  )}
                </CardContent>
              </Card>
            )}
          </div>

          <div className="space-y-4">
            <NotImplementedPanel />
          </div>
        </div>
      )}
    </AppShell>
  );
}
