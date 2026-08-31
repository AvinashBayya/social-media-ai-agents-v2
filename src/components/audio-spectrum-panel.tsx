import { useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AudioLines, AlertTriangle, Loader2, Activity, Info, MessageSquareText, Fingerprint, Trash2 } from "lucide-react";
import { MediaError } from "@/utils/imaging-client";
import { analyseAudioFrequencies, MAX_AUDIO_ANALYSIS_SECONDS } from "@/utils/audio-extract-client";
import {
  detectAcousticEvents,
  describeSpectralAnalysis,
  summariseForAnalyst,
  extractFingerprint,
  compareFingerprints,
  FREQUENCY_BANDS,
  AUDIO_SPECTRAL_GAPS,
  MIN_ANALYSIS_HZ,
  MAX_ANALYSIS_HZ,
  type SpectralAnalysis,
  type AcousticEvent,
  type SpectralFindingsSummary,
  type AnalystAudioSummary,
  type SpectralFrame,
  type AudioFingerprint,
  type FingerprintMatch,
} from "@/utils/audio-frequency";
import {
  getAudioReferences,
  saveAudioReference,
  deleteAudioReference,
  type StoredAudioReference,
} from "@/utils/audio-fingerprint-store";
import { NotImplementedPanel } from "@/components/not-implemented";

const fmtSec = (s: number) => `${s.toFixed(2)}s`;

/** Waterfall colour ramp: near-black (floor) -> green -> amber (peak). Fixed, not theme-linked — a spectrogram is conventionally read on a dark ground regardless of page theme. */
function dbToColor(db: number, floor: number, ceiling: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, (db - floor) / (ceiling - floor)));
  // 3-stop lerp: [5,8,16] -> [16,150,110] -> [250,204,21]
  if (t < 0.5) {
    const u = t / 0.5;
    return [5 + u * (16 - 5), 8 + u * (150 - 8), 16 + u * (110 - 16)];
  }
  const u = (t - 0.5) / 0.5;
  return [16 + u * (250 - 16), 150 + u * (204 - 150), 110 + u * (21 - 110)];
}

function Spectrogram({ analysis }: { analysis: SpectralAnalysis }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { spectrogram } = analysis;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = spectrogram.columns;
    canvas.height = spectrogram.rows;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(spectrogram.columns, spectrogram.rows);
    for (let r = 0; r < spectrogram.rows; r += 1) {
      // Row 0 is the lowest frequency (rowHz[0]) — flip so low sits at the
      // BOTTOM of the canvas, matching every conventional spectrogram.
      const destRow = spectrogram.rows - 1 - r;
      for (let c = 0; c < spectrogram.columns; c += 1) {
        const db = spectrogram.db[r * spectrogram.columns + c];
        const [red, green, blue] = dbToColor(db, spectrogram.dbFloor, spectrogram.dbCeiling);
        const idx = (destRow * spectrogram.columns + c) * 4;
        img.data[idx] = red;
        img.data[idx + 1] = green;
        img.data[idx + 2] = blue;
        img.data[idx + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [spectrogram]);

  // Hz ticks evenly spaced in LOG space — matches rowHz's own construction,
  // so flexbox's even pixel spacing lines up exactly with real row position.
  const hzTicks = useMemo(() => {
    const rows = spectrogram.rowHz;
    const logMin = Math.log(rows[0]);
    const logMax = Math.log(rows[rows.length - 1]);
    const n = 6;
    return Array.from({ length: n }, (_, i) => Math.exp(logMin + ((logMax - logMin) * i) / (n - 1))).reverse();
  }, [spectrogram]);

  return (
    <div className="mt-2">
      <div className="flex items-stretch gap-1.5">
        <div className="flex h-40 shrink-0 flex-col justify-between py-0.5 text-right font-mono text-[8px] text-console-label">
          {hzTicks.map((hz, i) => (
            <span key={i}>{hz >= 1000 ? `${(hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 1)}k` : Math.round(hz)}</span>
          ))}
        </div>
        <canvas
          ref={canvasRef}
          className="h-40 flex-1 rounded border border-console-border bg-black"
          style={{ imageRendering: "auto" }}
        />
      </div>
      <div className="mt-0.5 flex justify-between pl-8 font-mono text-[8px] text-console-label">
        <span>0:00</span>
        <span>{fmtSec(analysis.durationSeconds)}</span>
      </div>
      {spectrogram.interpolatedBelowHz > spectrogram.rowHz[0] && (
        <p className="mt-1 text-[9px] leading-relaxed text-console-label">
          Rows below {Math.round(spectrogram.interpolatedBelowHz)}Hz are interpolated between FFT
          bins, not independently resolved.
        </p>
      )}
    </div>
  );
}

function BandBars({ analysis }: { analysis: SpectralAnalysis }) {
  const stats = useMemo(
    () =>
      FREQUENCY_BANDS.map((band, i) => {
        const vals = analysis.frames
          .map((f) => f.bandFraction[i])
          .filter((v): v is number => v !== null);
        const mean = vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
        return { band, mean, measuredFrames: vals.length };
      }),
    [analysis],
  );

  return (
    <div className="mt-2 space-y-1">
      {stats.map(({ band, mean, measuredFrames }) => (
        <div key={band.id} className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-[9px] text-console-label">{band.label}</span>
          <div className="h-2.5 flex-1 overflow-hidden rounded bg-console-deep">
            {mean !== null ? (
              <div className="h-full bg-console-green" style={{ width: `${Math.min(100, mean * 100)}%` }} />
            ) : (
              <div className="h-full w-full bg-[repeating-linear-gradient(45deg,transparent,transparent_3px,var(--console-border)_3px,var(--console-border)_6px)]" />
            )}
          </div>
          <span className="w-20 shrink-0 text-right font-mono text-[9px] text-console-muted">
            {mean !== null ? `${(mean * 100).toFixed(0)}% mean` : "not measured"}
          </span>
          {band.partiallyCovered && (
            <span title="Band extends outside the analysed range.">
              <Info className="size-2.5 shrink-0 text-console-label" />
            </span>
          )}
        </div>
      ))}
      <p className="pt-0.5 text-[9px] leading-relaxed text-console-label">
        Mean share of total spectral power per band, across windows carrying a measurable signal
        (silent/noise-like windows excluded, never averaged in as zero).
      </p>
    </div>
  );
}

function LoudestWindow({ frame }: { frame: SpectralFrame }) {
  return (
    <div className="mt-2 rounded border border-console-border bg-console-deep/60 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-semibold text-console-text">
          Loudest measured window — {fmtSec(frame.time)}
        </span>
        <span className="ml-auto font-mono text-[9px] text-console-muted">{frame.rmsDbfs.toFixed(1)} dBFS RMS</span>
      </div>
      <dl className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] leading-relaxed">
        <div>
          <dt className="inline font-semibold text-console-muted">Dominant partial: </dt>
          <dd className="inline text-console-muted">
            {frame.dominant ? `${frame.dominant.hz.toFixed(1)}Hz (${frame.dominant.magnitudeDb.toFixed(1)}dB)` : "none above the peak floor"}
          </dd>
        </div>
        <div>
          <dt className="inline font-semibold text-console-muted">Fundamental (HPS): </dt>
          <dd className="inline text-console-muted">
            {frame.fundamentalHz !== null && frame.fundamentalConfidence !== null
              ? `${frame.fundamentalHz.toFixed(1)}Hz (confidence ${frame.fundamentalConfidence.toFixed(2)})`
              : "not resolvable in this window"}
          </dd>
        </div>
        <div>
          <dt className="inline font-semibold text-console-muted">Harmonic ratio: </dt>
          <dd className="inline text-console-muted">
            {frame.harmonicRatio !== null
              ? `${frame.harmonicRatio.toFixed(2)} (${frame.harmonicRatio > 0.6 ? "harmonic-like — voice/music/tone" : "inharmonic-like — struck/resonant source"})`
              : "no fundamental to measure against"}
          </dd>
        </div>
        <div>
          <dt className="inline font-semibold text-console-muted">Partial ratios: </dt>
          <dd className="inline text-console-muted">
            {frame.partialRatios.length > 0 ? frame.partialRatios.map((r) => r.toFixed(2)).join(", ") + "× fundamental" : "none matched"}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function EventsList({ events }: { events: AcousticEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="mt-2 text-[11px] text-console-label">
        No impulsive onset was detected above the flux threshold in this recording.
      </p>
    );
  }
  return (
    <div className="mt-2 space-y-1.5">
      {events.map((e, i) => (
        <div key={i} className="rounded border border-console-border bg-console-deep/60 p-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <Activity className="size-3 shrink-0 text-console-amber" />
            <span className="font-mono text-[10px] font-semibold text-console-text">
              {fmtSec(e.onsetTime)} (±{e.onsetUncertaintySeconds.toFixed(2)}s)
            </span>
            <span className="ml-auto font-mono text-[9px] text-console-muted">{e.peakDbfs.toFixed(1)} dBFS peak</span>
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-console-muted">{e.descriptor}</p>
          <div className="mt-1 font-mono text-[9px] text-console-label">
            {e.decayToMinus60Seconds !== null && e.decayFitR2 !== null
              ? `decay to -60dB in ~${e.decayToMinus60Seconds.toFixed(2)}s (R²=${e.decayFitR2.toFixed(2)})`
              : e.decayFitR2 !== null
                ? `decay fit R²=${e.decayFitR2.toFixed(2)} — below the 0.80 threshold, not reported as a time`
                : "insufficient data to fit a decay curve"}
            {e.partialDriftCentsPerSecond !== null &&
              ` · partial drift ${e.partialDriftCentsPerSecond.toFixed(0)} cents/s`}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The plain-English front door to the technical detail below. Every
 * sentence here is generated in summariseForAnalyst from the same measured
 * values the technical sections show — this is a friendlier restatement,
 * never a second, looser analysis.
 */
function PlainSummary({ summary }: { summary: AnalystAudioSummary }) {
  return (
    <div className="mt-3 rounded border border-console-green/30 bg-console-green/5 p-3">
      <div className="flex items-center gap-1.5">
        <MessageSquareText className="size-3.5 shrink-0 text-console-green" />
        <span className="text-[10px] font-bold uppercase tracking-wider text-console-green">
          In plain language
        </span>
      </div>
      <p className="mt-1.5 text-[13px] font-semibold leading-relaxed text-console-text">{summary.headline}</p>
      <ul className="mt-2 list-disc space-y-1 pl-4 text-[11px] leading-relaxed text-console-text">
        {summary.bullets.map((b, i) => (
          <li key={i}>{b}</li>
        ))}
      </ul>
    </div>
  );
}

function FindingsSummary({ summary }: { summary: SpectralFindingsSummary }) {
  return (
    <div className="mt-3">
      <p className="text-[11px] leading-relaxed text-console-text">{summary.summary}</p>
      <div className="mt-2 space-y-1.5">
        {summary.findings.map((f, i) => (
          <div key={i} className="rounded border border-console-amber/30 bg-console-amber/5 p-2">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold text-console-text">{f.label}</span>
              <Badge variant="outline" className="ml-auto shrink-0 border-console-border text-[9px] font-normal text-console-muted">
                {f.strength}
              </Badge>
            </div>
            <p className="mt-0.5 text-[10px] leading-relaxed text-console-muted">{f.detail}</p>
          </div>
        ))}
      </div>
      <div className="mt-3 rounded border border-console-label/30 bg-console-deep/60 p-2.5">
        <div className="text-[10px] font-bold uppercase tracking-wider text-console-muted">
          What this system could NOT determine about this audio
        </div>
        <ul className="mt-1 list-disc space-y-1 pl-4 text-[10px] leading-relaxed text-console-muted">
          {summary.cannotDetermine.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

interface ReferenceMatchingProps {
  fingerprint: AudioFingerprint | null;
  references: StoredAudioReference[];
  sourceLabel: string;
  onSave: (name: string) => void;
  onDelete: (id: string) => void;
}

/**
 * Answers "does this sound resemble one I've heard before" against
 * references the analyst has actually saved — never "what is this sound"
 * from nothing. See extractFingerprint/compareFingerprints in
 * audio-frequency.ts for the real, measured basis of every score here.
 */
function ReferenceMatching({ fingerprint, references, sourceLabel, onSave, onDelete }: ReferenceMatchingProps) {
  const [nameInput, setNameInput] = useState("");

  const matches = useMemo(() => {
    if (!fingerprint) return [];
    return references
      .map((ref) => ({ ref, match: compareFingerprints(fingerprint, ref.fingerprint) }))
      .sort((a, b) => b.match.overallSimilarity - a.match.overallSimilarity);
  }, [fingerprint, references]);

  return (
    <div className="mt-3">
      <h4 className="flex items-center gap-1.5 text-[10px] font-bold uppercase text-console-text">
        <Fingerprint className="size-3 text-console-purple" />
        Reference matching
      </h4>
      <p className="mt-1 text-[10px] leading-relaxed text-console-muted">
        Matches only against clips you've saved as references below — never identifies a sound
        from nothing. A high score is real, measured similarity worth reviewing, not a confirmed
        identity.
      </p>

      {!fingerprint ? (
        <p className="mt-1.5 text-[11px] text-console-label">
          No measurable partial structure in this clip to fingerprint (silence or noise-like
          throughout).
        </p>
      ) : (
        <>
          <div className="mt-2 flex gap-1.5">
            <Input
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              placeholder="Name this reference (e.g. Big Ben strike)"
              className="h-7 flex-1 border-console-border bg-console-deep text-[11px] text-console-text"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!nameInput.trim()}
              onClick={() => {
                onSave(nameInput.trim());
                setNameInput("");
              }}
              className="h-7 shrink-0 gap-1 text-[10px]"
            >
              <Fingerprint className="size-3" />
              Save as reference
            </Button>
          </div>

          {references.length === 0 ? (
            <p className="mt-2 text-[11px] text-console-label">
              No saved references yet — save this clip's fingerprint above, or analyse a known
              clip first and save that one, then come back and compare others against it.
            </p>
          ) : (
            <div className="mt-2 space-y-1.5">
              {matches.map(({ ref, match }) => (
                <div key={ref.id} className="rounded border border-console-border bg-console-deep/60 p-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] font-semibold text-console-text">{ref.name}</span>
                    <span className="font-mono text-[10px] text-console-muted">
                      {(match.overallSimilarity * 100).toFixed(0)}% similarity
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onDelete(ref.id)}
                      className="ml-auto h-6 gap-1 px-1.5 text-[9px] text-console-red hover:text-console-red"
                      title="Delete this reference"
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[9px] text-console-label">
                    <span>
                      partials{" "}
                      {match.partialRatioSimilarity !== null
                        ? `${(match.partialRatioSimilarity * 100).toFixed(0)}%`
                        : "not comparable"}
                    </span>
                    <span>
                      harmonicity{" "}
                      {match.harmonicRatioSimilarity !== null
                        ? `${(match.harmonicRatioSimilarity * 100).toFixed(0)}%`
                        : "not comparable"}
                    </span>
                    <span>
                      spectral shape{" "}
                      {match.spectralShapeSimilarity !== null
                        ? `${(match.spectralShapeSimilarity * 100).toFixed(0)}%`
                        : "not comparable"}
                    </span>
                  </div>
                  {ref.sourceLabel && (
                    <p className="mt-0.5 text-[9px] text-console-label">
                      saved from {ref.sourceLabel} · {new Date(ref.savedAt).toLocaleString()}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

interface AudioSpectrumPanelProps {
  file: File | null;
  /** Fired with a flat list of measured facts whenever a fresh analysis completes, or [] when it's cleared — lets the parent thread them into AiAnalysisPanel's reportContextLines. */
  onFindings?: (lines: string[]) => void;
}

/**
 * Module 4 — real spectral/frequency analysis of a video's audio track.
 * Pure computation lives in audio-frequency.ts; this is the DOM half:
 * decode, run, render. See that file's header for the scientific-honesty
 * position this whole panel is built around — no source identification,
 * ever, only measured spectral characteristics.
 */
export function AudioSpectrumPanel({ file, onFindings }: AudioSpectrumPanelProps) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState("");
  const [analysis, setAnalysis] = useState<SpectralAnalysis | null>(null);
  const [events, setEvents] = useState<AcousticEvent[]>([]);
  const [summary, setSummary] = useState<SpectralFindingsSummary | null>(null);
  const [references, setReferences] = useState<StoredAudioReference[]>([]);

  // Loaded once on mount — getAudioReferences() reads localStorage, empty
  // on the server and on first client render, same SSR-safe pattern every
  // other localStorage-backed panel in this app already follows.
  useEffect(() => {
    setReferences(getAudioReferences());
  }, []);

  // A new video invalidates any prior analysis — never show stale numbers
  // against a different file.
  useEffect(() => {
    setAnalysis(null);
    setEvents([]);
    setSummary(null);
    setError("");
    onFindings?.([]);
    // onFindings intentionally excluded — callers should pass a stable
    // callback; re-running this on every render would clear state constantly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  const run = async () => {
    if (!file) return;
    setBusy(true);
    setError("");
    setProgress(null);
    try {
      const result = await analyseAudioFrequencies(file, {}, (done, total) => setProgress({ done, total }));
      const detected = detectAcousticEvents(result);
      const found = describeSpectralAnalysis(result, detected);
      setAnalysis(result);
      setEvents(detected);
      setSummary(found);
      onFindings?.([
        `Audio spectral analysis: ${result.durationSeconds.toFixed(1)}s analysed, ${result.frames.length} windows, ` +
          `${(result.coverage * 100).toFixed(0)}% coverage${result.truncated ? " (sampling truncated)" : ""}.`,
        found.summary,
        ...found.findings.map((f) => `${f.label}: ${f.detail}`),
      ]);
    } catch (err: any) {
      setError(err instanceof MediaError ? `[${err.stage}] ${err.message}` : (err?.message ?? String(err)));
      setAnalysis(null);
      setEvents([]);
      setSummary(null);
      onFindings?.([]);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const loudest = useMemo(() => {
    if (!analysis) return null;
    let best: SpectralFrame | null = null;
    for (const f of analysis.frames) {
      if (f.status === "measured" && (best === null || f.rmsDbfs > best.rmsDbfs)) best = f;
    }
    return best;
  }, [analysis]);

  const plainSummary = useMemo(
    () => (analysis ? summariseForAnalyst(analysis, events) : null),
    [analysis, events],
  );

  const fingerprint = useMemo(
    () => (analysis ? extractFingerprint(analysis, events) : null),
    [analysis, events],
  );

  const saveReference = (name: string) => {
    if (!fingerprint) return;
    setReferences(
      saveAudioReference(
        references,
        { name, fingerprint, sourceLabel: file?.name ?? "" },
        new Date().toISOString(),
      ),
    );
  };

  const removeReference = (id: string) => {
    setReferences(deleteAudioReference(references, id));
  };

  return (
    <Card className="bg-console-surface border-console-border">
      <CardContent className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <AudioLines className="size-3.5 text-console-green" />
          <h3 className="text-xs font-bold uppercase text-console-text">Audio spectral analysis</h3>
          <Button
            size="sm"
            variant="outline"
            disabled={!file || busy}
            onClick={run}
            className="ml-auto h-7 gap-1 text-[10px]"
          >
            {busy ? <Loader2 className="size-3 animate-spin" /> : <AudioLines className="size-3" />}
            {analysis ? "Re-run analysis" : "Run spectral analysis"}
          </Button>
        </div>
        <p className="mt-1.5 text-[10px] leading-relaxed text-console-muted">
          A real FFT over the decoded audio track — spectrogram, per-window dominant frequency,
          named frequency bands, harmonicity and onset/decay events. Runs entirely in this browser;
          nothing is uploaded. Files over {Math.round(MAX_AUDIO_ANALYSIS_SECONDS / 60)} minutes of
          audio are refused rather than left to freeze the tab.
        </p>

        {progress && (
          <p className="mt-1.5 font-mono text-[10px] text-console-label">
            window {progress.done}/{progress.total}
          </p>
        )}

        {error && (
          <div className="mt-2 flex items-start gap-2 rounded border border-console-red/30 bg-console-red/5 p-2">
            <AlertTriangle className="size-3.5 shrink-0 text-console-red" />
            <span className="text-[10px] leading-relaxed text-console-red">{error}</span>
          </div>
        )}

        {analysis && (
          <>
            {plainSummary && <PlainSummary summary={plainSummary} />}

            <h4 className="mt-3 text-[10px] font-bold uppercase tracking-wider text-console-label">
              Technical detail
            </h4>
            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-[9px] text-console-muted">
              <span>bin spacing {analysis.binSpacingHz.toFixed(1)}Hz</span>
              <span>real resolution ~{analysis.effectiveResolutionHz.toFixed(1)}Hz (2× bin spacing)</span>
              <span>
                range {MIN_ANALYSIS_HZ}–{MAX_ANALYSIS_HZ}Hz
              </span>
              <span>{analysis.frames.length} windows</span>
              {analysis.truncated && <span className="text-console-amber">sampling truncated</span>}
            </div>

            <Spectrogram analysis={analysis} />
            <BandBars analysis={analysis} />
            {loudest && <LoudestWindow frame={loudest} />}

            <h4 className="mt-3 flex items-center gap-1.5 text-[10px] font-bold uppercase text-console-text">
              <Activity className="size-3 text-console-amber" />
              Acoustic events ({events.length})
            </h4>
            <EventsList events={events} />

            {summary && <FindingsSummary summary={summary} />}

            <ReferenceMatching
              fingerprint={fingerprint}
              references={references}
              sourceLabel={file?.name ?? ""}
              onSave={saveReference}
              onDelete={removeReference}
            />

            <div className="mt-3">
              <NotImplementedPanel
                gaps={AUDIO_SPECTRAL_GAPS}
                title="Audio spectral analysis — not implemented"
                description="What real, measured spectral analysis of this audio cannot do — stated explicitly rather than implied by silence."
              />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
