import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { AppShell, PageHeader } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Upload,
  Loader2,
  AlertTriangle,
  Film,
  Scissors,
  Type,
  Fingerprint,
  Info,
  Youtube,
  Search,
  Mic,
} from "lucide-react";
import {
  findNearDuplicates,
  OCR_LANGUAGES,
  OCR_LOW_CONFIDENCE,
  type DuplicateReport,
  type HashedImage,
  type OcrReport,
} from "@/utils/imaging";
import {
  extractFrameBlob,
  extractKeyframes,
  loadImageCorpus,
  rememberImage,
  runOcr,
  MediaError,
  OCR_ASSET_PROVENANCE,
  type KeyframeResult,
} from "@/utils/imaging-client";
import { extractAudioAsWav } from "@/utils/audio-extract-client";
import { AudioSpectrumPanel } from "@/components/audio-spectrum-panel";
import { AudioEventsPanel } from "@/components/audio-events-panel";
import {
  aiServiceOcrVlm,
  AiServiceUnavailableError,
  type AiOcrVlmResult,
} from "@/utils/ai-service-client";
import { NotImplementedPanel } from "@/components/not-implemented";
import { AiAnalysisPanel } from "@/components/ai-analysis-panel";
import { getActiveTarget } from "@/utils/active-target";
import { serverSearchYoutubeVideos, type YoutubeSearchResult } from "@/utils/youtube-collector";
import {
  startAudioTranscription,
  pollAudioTranscription,
  TRANSCRIPTION_PROVENANCE,
  type StartTranscriptionResult,
  type TranscriptionResult,
} from "@/utils/transcription";

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
 * Audio transcription is real (Sarvam saaras:v3) but is the one action on this
 * page that sends the file off the machine — see TRANSCRIPTION_PROVENANCE and
 * the explicit consent control before the button. Voice-clone/anti-spoofing
 * detection remains not implemented — see the panel for why.
 */

export const Route = createFileRoute("/videos")({
  head: () => ({ meta: [{ title: "Video Intelligence — Sentinel AI" }] }),
  component: Page,
});

const CARD = "bg-console-surface border-console-border";
const DEFAULT_LANGS = ["eng"];
/** Frame budget. 60 keyframes at 2s covers two minutes; beyond that the tab suffers. */
const MAX_FRAMES = 60;

const fmtTime = (s: number) =>
  `${Math.floor(s / 60)
    .toString()
    .padStart(2, "0")}:${Math.floor(s % 60)
    .toString()
    .padStart(2, "0")}`;

function Page() {
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [result, setResult] = useState<KeyframeResult | null>(null);
  const [videoFile, setVideoFile] = useState<File | null>(null);
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

  // Florence-2 OCR (ai-service) — a sibling of Tesseract above, for the
  // case Tesseract structurally struggles with: legible text sharing the
  // frame with a busy photo, which describes most video frames by
  // definition. See ai-service-client.ts's aiServiceOcrVlm doc comment.
  const [ocrVlm, setOcrVlm] = useState<Record<number, AiOcrVlmResult>>({});
  const [ocrVlmError, setOcrVlmError] = useState("");
  const [ocrVlmLoading, setOcrVlmLoading] = useState(false);

  // ── Audio transcription (Sarvam) — one of two actions on this page that
  // send the file off the machine (the other is sound-event classification,
  // via AudioEventsPanel below), so both require explicit consent (unchecked
  // by default) before their button is even enabled. `jobId` is only set for
  // the batch (long-clip) path; the polling effect below drives it.
  const [transcribeConsent, setTranscribeConsent] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptionResult | null>(null);
  const [transcribeStatus, setTranscribeStatus] = useState<string | null>(null);
  const [transcribeError, setTranscribeError] = useState("");
  const [transcribeJobId, setTranscribeJobId] = useState<string | null>(null);

  // Audio spectral analysis (audio-spectrum-panel.tsx) — fully local, no
  // consent needed. Its findings are threaded into the AI panel below as
  // extra measured context, the same way the transcript already is.
  const [audioFindingLines, setAudioFindingLines] = useState<string[]>([]);

  // AiAnalysisPanel needs real bytes, not a data URL — resolved once per
  // selected frame rather than on every render.
  const [selectedBlob, setSelectedBlob] = useState<Blob | null>(null);

  // Empty on both server and first client render — getActiveTarget() reads
  // localStorage, unavailable during SSR. The mount+listener effect below
  // sets the real value client-side and keeps it in sync with the top-nav
  // search bar, matching the pattern used on every other route that shares
  // this global target.
  const [target, setTarget] = useState("");
  const [relatedVideos, setRelatedVideos] = useState<YoutubeSearchResult[]>([]);
  const [relatedLoading, setRelatedLoading] = useState(false);
  const [relatedError, setRelatedError] = useState<string | null>(null);

  useEffect(() => {
    const initial = getActiveTarget();
    setTarget(initial);

    const handleTargetChange = (e: any) => {
      if (e.detail) setTarget(e.detail);
    };
    window.addEventListener("sentinel_target_changed", handleTargetChange);
    return () => window.removeEventListener("sentinel_target_changed", handleTargetChange);
  }, []);

  useEffect(() => {
    // Skip the empty placeholder — the mount-sync effect above fills in the
    // real target a moment later, which re-triggers this effect via [target].
    if (!target) return;
    let cancelled = false;
    (async () => {
      setRelatedLoading(true);
      setRelatedError(null);
      try {
        const res = await serverSearchYoutubeVideos({ data: { query: target } });
        if (cancelled) return;
        setRelatedVideos(res.results);
        setRelatedError(res.error);
      } catch (err: any) {
        if (!cancelled) {
          setRelatedVideos([]);
          setRelatedError(err?.message ?? String(err));
        }
      } finally {
        if (!cancelled) setRelatedLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target]);

  useEffect(() => setCorpus(loadImageCorpus()), []);

  const analyse = async (file: File) => {
    setError("");
    setResult(null);
    setMatches({});
    setOcr({});
    setOcrVlm({});
    setOcrVlmError("");
    setSelected(null);
    setName(file.name);
    setVideoFile(file);
    setBusy("Decoding video");
    setTranscript(null);
    setTranscribeStatus(null);
    setTranscribeError("");
    setTranscribeJobId(null);

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
      setError(
        err instanceof MediaError ? `[${err.stage}] ${err.message}` : (err?.message ?? String(err)),
      );
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const ocrFrame = async (index: number) => {
    if (!result || !videoFile) return;
    const frame = result.frames[index];
    setBusy("Running OCR");
    setOcrError("");
    try {
      // Full-quality re-extraction, not the thumbnail's 0.6-quality JPEG —
      // see extractFrameBlob's comment. That thumbnail is fine to look at
      // but its compression artifacts silently defeated OCR on real text.
      const blob = await extractFrameBlob(videoFile, frame.time);
      const report = await runOcr(blob, langs);
      setOcr((prev) => ({ ...prev, [index]: report }));
    } catch (err: any) {
      setOcrError(err?.message ?? String(err));
    } finally {
      setBusy(null);
    }
  };

  const ocrFrameVlm = async (index: number) => {
    if (!result || !videoFile) return;
    setOcrVlmLoading(true);
    setOcrVlmError("");
    try {
      const blob = await extractFrameBlob(videoFile, result.frames[index].time);
      const vlmResult = await aiServiceOcrVlm(blob);
      setOcrVlm((prev) => ({ ...prev, [index]: vlmResult }));
    } catch (err: any) {
      setOcrVlmError(
        err instanceof AiServiceUnavailableError ? err.message : (err?.message ?? String(err)),
      );
    } finally {
      setOcrVlmLoading(false);
    }
  };

  const startTranscribe = async () => {
    if (!videoFile || !transcribeConsent) return;
    setTranscript(null);
    setTranscribeError("");
    setTranscribeJobId(null);
    setTranscribeStatus("Extracting audio in this browser…");
    try {
      // Sending the raw video container straight to Sarvam looked like it
      // worked (the type-check accepted it) but silently failed to decode —
      // see audio-extract-client.ts's file doc comment. Demux/decode here,
      // in-browser, and send real WAV bytes instead.
      const wav = await extractAudioAsWav(videoFile);
      const wavFile = new File([wav], `${name.replace(/\.[^.]+$/, "")}.wav`, { type: "audio/wav" });

      setTranscribeStatus("Sending audio to Sarvam…");
      const form = new FormData();
      form.append("file", wavFile);
      form.append("durationSeconds", String(result?.duration ?? ""));
      const outcome: StartTranscriptionResult = await startAudioTranscription({ data: form });
      if (outcome.mode === "sync") {
        setTranscript(outcome.result);
        setTranscribeStatus(null);
      } else {
        setTranscribeJobId(outcome.jobId);
        setTranscribeStatus("Transcribing (longer clip — this can take a while)…");
      }
    } catch (err: any) {
      setTranscribeError(
        err instanceof MediaError ? `[${err.stage}] ${err.message}` : (err?.message ?? String(err)),
      );
      setTranscribeStatus(null);
    }
  };

  // Batch jobs are polled from the client, not held open on the server —
  // see transcription.ts's file doc comment for why a long-running job
  // can't be awaited inside one request.
  useEffect(() => {
    if (!transcribeJobId) return;
    let cancelled = false;
    let attempts = 0;
    const MAX_ATTEMPTS = 300; // ~20 minutes at 4s intervals

    const poll = async () => {
      attempts += 1;
      try {
        const outcome = await pollAudioTranscription({ data: { jobId: transcribeJobId } });
        if (cancelled) return;
        if (!outcome.done) {
          setTranscribeStatus(`Sarvam job state: ${outcome.jobState}…`);
          if (attempts >= MAX_ATTEMPTS) {
            setTranscribeError(
              `Still processing after ~20 minutes (job ${transcribeJobId}, state ${outcome.jobState}). ` +
                "It may still finish — this page just stopped waiting.",
            );
            setTranscribeJobId(null);
            setTranscribeStatus(null);
            return;
          }
          timer = setTimeout(poll, 4000);
          return;
        }
        if ("error" in outcome) {
          setTranscribeError(outcome.error);
        } else {
          setTranscript(outcome.result);
        }
        setTranscribeJobId(null);
        setTranscribeStatus(null);
      } catch (err: any) {
        if (cancelled) return;
        setTranscribeError(err?.message ?? String(err));
        setTranscribeJobId(null);
        setTranscribeStatus(null);
      }
    };

    let timer = setTimeout(poll, 2000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [transcribeJobId]);

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

  useEffect(() => {
    const time = selected !== null ? result?.frames[selected]?.time : undefined;
    if (time === undefined || !videoFile) {
      setSelectedBlob(null);
      return;
    }
    let cancelled = false;
    setSelectedBlob(null); // clear the previous frame's blob while the new one decodes
    (async () => {
      try {
        // Full-quality re-extraction — see extractFrameBlob's comment. Using
        // the thumbnail dataUrl here fed the AI panel the same degraded
        // 0.6-quality JPEG that broke OCR on legible text.
        const blob = await extractFrameBlob(videoFile, time);
        if (!cancelled) setSelectedBlob(blob);
      } catch {
        if (!cancelled) setSelectedBlob(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected, result, videoFile]);

  const cutIndexes = new Set(result?.scenes.cuts.map((c) => c.index) ?? []);

  return (
    <AppShell>
      <PageHeader
        title="Video Intelligence"
        description="In-browser keyframe extraction, scene-cut detection, perceptual matching and audio spectral analysis. No GPU, no server for those — the file is never uploaded. Audio transcription and sound-event classification are opt-in exceptions that do send audio to a server."
      />

      <Card className={`${CARD} mb-4`}>
        <CardContent className="p-4">
          <div className="flex items-center gap-1.5">
            <Youtube className="size-3.5 text-console-red" />
            <span className="text-xs font-bold uppercase text-console-text">
              Related YouTube Videos
            </span>
            {target && (
              <span className="font-mono text-[10px] text-console-label">for "{target}"</span>
            )}
            {relatedLoading && <Loader2 className="ml-1 size-3 animate-spin text-console-label" />}
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-console-label">
            Found via YouTube's own search endpoint (the same one youtube.com's search page calls
            internally) — keyless, no API key involved. Analyze hands the real video off to YouTube
            Video Intelligence for metadata, captions and download; this page's own keyframe
            pipeline only runs on an uploaded file.
          </p>

          {!target ? (
            <p className="mt-3 text-[11px] text-console-label">
              Set a target with the search bar above to find related videos.
            </p>
          ) : relatedError ? (
            <div className="mt-3 flex items-start gap-2 rounded border border-console-red/30 bg-console-red/5 p-2">
              <AlertTriangle className="size-3.5 shrink-0 text-console-red" />
              <span className="font-mono text-[10px] leading-relaxed text-console-red">
                {relatedError}
              </span>
            </div>
          ) : !relatedLoading && relatedVideos.length === 0 ? (
            <p className="mt-3 text-[11px] text-console-label">
              No YouTube videos found for "{target}".
            </p>
          ) : (
            <div className="mt-3 space-y-1.5">
              {relatedVideos.map((v, i) => (
                <div
                  key={`${v.videoId}-${i}`}
                  className="flex items-center gap-2 rounded border border-console-border bg-console-deep/60 p-2"
                >
                  <Search className="size-3 shrink-0 text-console-label" />
                  <div className="min-w-0 flex-1">
                    <a
                      href={v.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block truncate text-[11px] text-console-text hover:underline"
                    >
                      {v.title}
                    </a>
                    <span className="font-mono text-[9px] text-console-label">
                      {v.channel ?? "unknown channel"}
                      {v.publishedTimeText ? ` · ${v.publishedTimeText}` : ""}
                      {v.duration ? ` · ${v.duration}` : ""}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => navigate({ to: "/youtube", search: { url: v.url } as never })}
                    className="h-6 shrink-0 gap-1 px-2 text-[9px]"
                    title="Send this video to YouTube Video Intelligence for metadata, captions and download"
                  >
                    <Youtube className="size-3" />
                    Analyze
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className={`${CARD} mb-4`}>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-end gap-2">
            <Button
              size="sm"
              onClick={() => fileRef.current?.click()}
              disabled={busy !== null}
              className="h-8 gap-1.5"
            >
              {busy ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Upload className="size-3.5" />
              )}
              {busy ?? "Upload video"}
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="video/*"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) analyse(f);
              }}
              className="hidden"
            />

            <div>
              <label className="text-[10px] uppercase tracking-wider text-console-label">
                Sample interval (s)
              </label>
              <Input
                type="number"
                min={0.5}
                max={30}
                step={0.5}
                value={interval}
                onChange={(e) => setIntervalSeconds(Math.max(0.5, Number(e.target.value) || 2))}
                className="mt-1 h-8 w-24 border-console-border bg-console-deep text-[11px] text-console-text"
              />
            </div>

            {progress && (
              <span className="font-mono text-[10px] text-console-muted">
                frame {progress.done}/{progress.total}
              </span>
            )}
            <span className="ml-auto text-[10px] text-console-label">
              {corpus.length} image(s) in the matching corpus
            </span>
          </div>

          <p className="mt-2 flex items-start gap-1.5 text-[10px] leading-relaxed text-console-label">
            <Info className="mt-px size-3 shrink-0" />
            Frames are sampled at a fixed interval, so a scene cut is located to within one interval
            rather than to the exact frame. Sampling stops at {MAX_FRAMES} frames.
          </p>

          {error && (
            <div className="mt-3 flex items-start gap-2 rounded border border-console-red/30 bg-console-red/5 p-2">
              <AlertTriangle className="size-3.5 shrink-0 text-console-red" />
              <span className="font-mono text-[10px] leading-relaxed text-console-red">{error}</span>
            </div>
          )}
        </CardContent>
      </Card>

      {!result ? (
        <div className="grid gap-4 lg:grid-cols-[1fr_400px]">
          <Card className={CARD}>
            <CardContent className="p-10 text-center">
              <Film className="mx-auto size-8 text-console-border" />
              <p className="mt-3 text-sm text-console-muted">No video loaded.</p>
              <p className="mx-auto mt-1 max-w-md text-[11px] leading-relaxed text-console-label">
                Upload a file to extract keyframes. Decoding, hashing, OCR and audio spectral
                analysis all run in this tab — nothing is sent to a server. Audio transcription
                and sound-event classification are the two exceptions, both explicit and opt-in —
                see below once a video is loaded.
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
                  <Film className="size-3.5 text-console-blue" />
                  <span className="truncate text-xs font-bold uppercase text-console-text">{name}</span>
                  <span className="ml-auto font-mono text-[10px] text-console-muted">
                    {fmtTime(result.duration)} · {result.frames.length} keyframes @ {interval}s
                  </span>
                </div>

                {result.truncated && (
                  <p className="mt-1.5 text-[10px] text-console-amber">
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
                          ? "border-console-blue"
                          : cutIndexes.has(i)
                            ? "border-console-amber/60"
                            : "border-console-border"
                      }`}
                    >
                      {f.dataUrl && (
                        <img
                          src={f.dataUrl}
                          alt={`frame at ${fmtTime(f.time)}`}
                          className="h-16 w-full object-cover"
                        />
                      )}
                      <div className="flex items-center gap-1 px-1 py-0.5 font-mono text-[9px] text-console-muted">
                        {fmtTime(f.time)}
                        {cutIndexes.has(i) && <Scissors className="size-2.5 text-console-amber" />}
                        {matches[i] && <Fingerprint className="size-2.5 text-console-purple" />}
                      </div>
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card className={CARD}>
              <CardContent className="p-4">
                <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase text-console-text">
                  <Scissors className="size-3.5 text-console-amber" />
                  Scene cuts
                </h3>
                {result.scenes.cuts.length === 0 ? (
                  <p className="mt-2 text-[11px] text-console-label">
                    No cut exceeded the threshold between sampled frames. With a {interval}s
                    interval, cuts shorter than that can fall entirely between samples.
                  </p>
                ) : (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {result.scenes.cuts.map((c) => (
                      <Badge
                        key={c.index}
                        variant="outline"
                        className="cursor-pointer border-console-amber/40 bg-console-amber/10 font-mono text-[10px] font-normal text-console-amber"
                        onClick={() => setSelected(c.index)}
                      >
                        {fmtTime(c.time)} · Δ{c.distanceFromPrevious}
                      </Badge>
                    ))}
                  </div>
                )}
                <p className="mt-2 text-[10px] leading-relaxed text-console-label">
                  {result.scenes.method}
                  {result.scenes.meanDistance !== null &&
                    ` Mean consecutive-frame distance ${result.scenes.meanDistance.toFixed(1)}.`}
                </p>
              </CardContent>
            </Card>

            <Card className={CARD}>
              <CardContent className="p-4">
                <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase text-console-text">
                  <Mic className="size-3.5 text-[#22D3EE]" />
                  Audio transcription (Sarvam)
                </h3>
                <p className="mt-1.5 text-[10px] leading-relaxed text-console-muted">
                  {TRANSCRIPTION_PROVENANCE.disclosure}
                </p>

                <label className="mt-2.5 flex items-start gap-2 rounded border border-console-border bg-console-deep/60 p-2">
                  <input
                    type="checkbox"
                    checked={transcribeConsent}
                    onChange={(e) => setTranscribeConsent(e.target.checked)}
                    className="mt-0.5 size-3 shrink-0 accent-[#22D3EE]"
                  />
                  <span className="text-[10px] leading-relaxed text-console-muted">
                    I consent to sending this video&apos;s audio to Sarvam for transcription.
                  </span>
                </label>

                <Button
                  size="sm"
                  variant="outline"
                  disabled={!transcribeConsent || transcribeStatus !== null}
                  onClick={startTranscribe}
                  className="mt-2 h-7 gap-1 text-[10px]"
                >
                  {transcribeStatus !== null ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Mic className="size-3" />
                  )}
                  Transcribe audio
                </Button>

                {transcribeStatus && (
                  <p className="mt-2 flex items-center gap-1.5 text-[10px] text-console-muted">
                    <Loader2 className="size-3 animate-spin text-[#22D3EE]" />
                    {transcribeStatus}
                  </p>
                )}

                {transcribeError && (
                  <div className="mt-2 flex items-start gap-2 rounded border border-console-red/30 bg-console-red/5 p-2">
                    <AlertTriangle className="size-3.5 shrink-0 text-console-red" />
                    <span className="text-[10px] leading-relaxed text-console-red">
                      {transcribeError}
                    </span>
                  </div>
                )}

                {transcript && (
                  <div className="mt-2 space-y-1.5">
                    {!transcript.transcript.trim() ? (
                      <p className="text-[11px] text-console-label">
                        Sarvam returned an empty transcript — no speech was recognised in this
                        audio.
                      </p>
                    ) : (
                      <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded border border-console-border bg-console-deep p-2 text-[11px] text-console-text">
                        {transcript.transcript}
                      </pre>
                    )}
                    <div className="font-mono text-[10px] text-console-muted">
                      {transcript.mode} ·{" "}
                      {transcript.languageCode
                        ? `language ${transcript.languageCode}${
                            transcript.languageProbability !== null
                              ? ` (${(transcript.languageProbability * 100).toFixed(0)}% confidence)`
                              : ""
                          }`
                        : "language not reported"}
                    </div>
                  </div>
                )}

                <p className="mt-2 text-[10px] leading-relaxed text-console-label">
                  {TRANSCRIPTION_PROVENANCE.model}
                </p>
              </CardContent>
            </Card>

            <AudioSpectrumPanel file={videoFile} onFindings={setAudioFindingLines} />

            <AudioEventsPanel file={videoFile} />

            {Object.keys(matches).length > 0 && (
              <Card className="border-console-purple/40 bg-console-surface">
                <CardContent className="p-4">
                  <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase text-console-text">
                    <Fingerprint className="size-3.5 text-console-purple" />
                    Keyframes matching previously seen images
                  </h3>
                  <p className="mt-1 text-[10px] leading-relaxed text-console-muted">
                    A video reusing a still that already appeared elsewhere is a recontextualisation
                    signal. It is a fact about where the image has been seen, not a claim about
                    intent.
                  </p>
                  <div className="mt-2 space-y-1.5">
                    {Object.entries(matches).map(([idx, report]) => (
                      <div
                        key={idx}
                        className="rounded border border-console-border bg-console-deep/60 p-2"
                      >
                        <button
                          onClick={() => setSelected(Number(idx))}
                          className="font-mono text-[10px] text-console-blue hover:underline"
                        >
                          frame {fmtTime(result.frames[Number(idx)].time)}
                        </button>
                        <p className="mt-0.5 text-[10px] leading-relaxed text-console-muted">
                          {report.summary}
                        </p>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {selected !== null && (
              <>
              <Card className={CARD}>
                <CardContent className="p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-bold uppercase text-console-text">
                      Frame at {fmtTime(result.frames[selected].time)}
                    </span>
                    <span className="ml-auto font-mono text-[10px] text-console-muted">
                      pHash {result.frames[selected].hash}
                    </span>
                  </div>

                  {result.frames[selected].dataUrl && (
                    <img
                      src={result.frames[selected].dataUrl}
                      alt={`keyframe at ${fmtTime(result.frames[selected].time)}`}
                      className="mt-2 max-h-72 w-full rounded bg-console-deep object-contain"
                    />
                  )}

                  <div className="mt-2 flex flex-wrap gap-1">
                    {OCR_LANGUAGES.map((l) => {
                      const on = langs.includes(l.code);
                      return (
                        <button
                          key={l.code}
                          onClick={() =>
                            setLangs((prev) =>
                              prev.includes(l.code)
                                ? prev.filter((c) => c !== l.code)
                                : [...prev, l.code],
                            )
                          }
                          title={l.accuracyNote}
                          className={`rounded border px-1.5 py-0.5 text-[10px] ${
                            on
                              ? "border-console-cyan/50 bg-console-cyan/10 text-console-cyan"
                              : "border-console-border bg-console-deep text-console-label"
                          }`}
                        >
                          {l.label}
                        </button>
                      );
                    })}
                  </div>

                  <div className="mt-2 flex gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy !== null || langs.length === 0}
                      onClick={() => ocrFrame(selected)}
                      className="h-7 gap-1 text-[10px]"
                    >
                      {busy === "Running OCR" ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <Type className="size-3" />
                      )}
                      OCR this frame
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => addFrameToCorpus(selected)}
                      className="h-7 gap-1 text-[10px]"
                    >
                      <Fingerprint className="size-3" />
                      Add to corpus
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={ocrVlmLoading}
                      onClick={() => ocrFrameVlm(selected)}
                      className="h-7 gap-1 text-[10px]"
                      title="Tesseract above struggles when text shares the frame with a busy photo — verified live: confidence ~33, no real words, on a real composition of that kind. Florence-2 is a different tool for that case."
                    >
                      {ocrVlmLoading ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <Type className="size-3" />
                      )}
                      Try Florence-2 OCR
                    </Button>
                  </div>

                  {/* Same disclosure as the image route — one string, rendered verbatim. */}
                  <p className="mt-2 text-[10px] leading-relaxed text-console-label">
                    {OCR_ASSET_PROVENANCE.disclosure}
                  </p>

                  {ocrError && (
                    <div className="mt-2 flex items-start gap-2 rounded border border-console-red/30 bg-console-red/5 p-2">
                      <AlertTriangle className="size-3.5 shrink-0 text-console-red" />
                      <span className="text-[10px] leading-relaxed text-console-red">{ocrError}</span>
                    </div>
                  )}

                  {ocr[selected] && (
                    <div className="mt-2 space-y-1.5">
                      {/* Gated on text, not words.length — see images.tsx. */}
                      {!ocr[selected].text.trim() ? (
                        <p className="text-[11px] text-console-label">
                          No text recognised in this frame with the selected languages.
                        </p>
                      ) : (
                        <>
                          <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded border border-console-border bg-console-deep p-2 text-[11px] text-console-text">
                            {ocr[selected].text}
                          </pre>
                          <div className="font-mono text-[10px] text-console-muted">
                            mean confidence {ocr[selected].meanConfidence?.toFixed(1) ?? "—"} ·{" "}
                            {ocr[selected].lowConfidenceCount} word(s) below {OCR_LOW_CONFIDENCE}
                          </div>
                        </>
                      )}
                      {ocr[selected].accuracyNotes.map((n, i) => (
                        <p key={i} className="text-[10px] leading-relaxed text-console-amber">
                          {n}
                        </p>
                      ))}
                    </div>
                  )}

                  {ocrVlmError && (
                    <div className="mt-2 flex items-start gap-2 rounded border border-console-red/30 bg-console-red/5 p-2">
                      <AlertTriangle className="size-3.5 shrink-0 text-console-red" />
                      <span className="text-[10px] leading-relaxed text-console-red">
                        {ocrVlmError}
                      </span>
                    </div>
                  )}

                  {ocrVlm[selected] && (
                    <div className="mt-2 space-y-1.5">
                      {!ocrVlm[selected].text.trim() ? (
                        <p className="text-[11px] text-console-label">
                          Florence-2 found no text in this frame either.
                        </p>
                      ) : (
                        <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded border border-console-border bg-console-deep p-2 text-[11px] text-console-text">
                          {ocrVlm[selected].text}
                        </pre>
                      )}
                      <div className="font-mono text-[10px] text-console-muted">
                        {ocrVlm[selected].provenance.model} · sent to ai-service over the network,
                        unlike Tesseract above
                      </div>
                    </div>
                  )}

                  {matches[selected] && (
                    <p className="mt-2 rounded border border-console-purple/30 bg-console-purple/5 p-2 text-[10px] leading-relaxed text-console-muted">
                      {matches[selected].summary}
                    </p>
                  )}
                </CardContent>
              </Card>

              <AiAnalysisPanel
                image={selectedBlob}
                imageName={`${name} @ ${fmtTime(result.frames[selected].time)}`}
                resetKey={`${name}-${selected}`}
                reportType="Video Frame Intelligence"
                reportContextLines={[
                  `Video: ${name}. Frame at ${fmtTime(result.frames[selected].time)} of ${fmtTime(result.duration)} total duration.`,
                  cutIndexes.has(selected)
                    ? "This frame is a detected scene cut."
                    : "This frame is not a detected scene cut.",
                  `Perceptual hash: ${result.frames[selected].hash}`,
                  ...(matches[selected] ? [`Near-duplicate match: ${matches[selected].summary}`] : []),
                  ...(ocr[selected]?.text.trim()
                    ? [
                        `OCR text (${ocr[selected].languages.join("+")}): ${ocr[selected].text.trim().slice(0, 1500)}`,
                      ]
                    : []),
                  ...(ocrVlm[selected]?.text.trim()
                    ? [`Florence-2 OCR text: ${ocrVlm[selected].text.trim().slice(0, 1500)}`]
                    : []),
                  ...(transcript?.transcript.trim()
                    ? [
                        `Audio transcript (Sarvam, ${transcript.mode}${transcript.languageCode ? `, ${transcript.languageCode}` : ""}): ${transcript.transcript.trim().slice(0, 3000)}`,
                      ]
                    : []),
                  ...audioFindingLines,
                ]}
                bytesUnavailableNote="Preparing frame bytes — try again in a moment."
              />
              </>
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
