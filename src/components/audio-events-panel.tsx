import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Ear, AlertTriangle, Loader2, ShieldAlert, Info } from "lucide-react";
import { extractAudioAsWav } from "@/utils/audio-extract-client";
import {
  aiServiceClassifyAudio,
  AiServiceUnavailableError,
  type AiAudioEvent,
  type AiAudioEventsResult,
} from "@/utils/ai-service-client";
import {
  groupAudioEvents,
  describeCoverage,
  shouldShowClosestMatches,
  AUDIO_EVENT_GAPS,
  AUDIO_EVENT_CANNOT_DETERMINE,
} from "@/utils/audio-events";
import { NotImplementedPanel } from "@/components/not-implemented";

const fmtSec = (s: number) => `${s.toFixed(2)}s`;

function EventRow({ event, hazard }: { event: AiAudioEvent; hazard: boolean }) {
  return (
    <div
      className={`rounded border p-2.5 ${
        hazard ? "border-console-red/40 bg-console-red/5" : "border-console-border bg-console-deep/60"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        {hazard && <ShieldAlert className="size-3 shrink-0 text-console-red" />}
        <span className="text-[11px] font-semibold text-console-text">{event.className}</span>
        <span className="font-mono text-[9px] text-console-muted">
          {fmtSec(event.startTime)}–{fmtSec(event.endTime)}
        </span>
        <span className="ml-auto font-mono text-[9px] text-console-muted">
          model score {event.maxScore.toFixed(2)} (mean {event.meanScore.toFixed(2)})
        </span>
      </div>
      <p className="mt-1 text-[9px] text-console-label">
        {event.framesAboveThreshold}/{event.framesTotal} windows above the reporting threshold
      </p>
      {hazard && (
        <p className="mt-1 flex items-start gap-1 text-[9px] leading-relaxed text-console-red">
          <Info className="mt-px size-2.5 shrink-0" />
          Confirm by listening at this timestamp — this is a candidate label, not a verified
          finding. Impulsive real-world sounds (door slams, fireworks, clipping) are a documented
          confuser for this class.
        </p>
      )}
    </div>
  );
}

interface AudioEventsPanelProps {
  file: File | null;
}

/**
 * Module 4 — semantic sound-event classification (YAMNet, via ai-service).
 * The one action anywhere on /videos that sends audio off the browser —
 * gated behind its own explicit, unchecked-by-default consent control,
 * the same pattern as the Sarvam transcription card above it.
 *
 * Ships as a listening index, not a findings list: YAMNet's own published
 * balanced mAP on the AudioSet eval set is 0.306, genuinely modest, and
 * every choice below (scores labelled "model score" never "confidence",
 * hazard classes carrying a "confirm by listening" marker, real coverage
 * numbers even when nothing is reported) exists because of that number,
 * not despite it.
 */
export function AudioEventsPanel({ file }: AudioEventsPanelProps) {
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<AiAudioEventsResult | null>(null);

  useEffect(() => {
    setResult(null);
    setError("");
  }, [file]);

  const run = async () => {
    if (!file || !consent) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const wav = await extractAudioAsWav(file);
      const classified = await aiServiceClassifyAudio(wav);
      setResult(classified);
    } catch (err: any) {
      setError(
        err instanceof AiServiceUnavailableError ? err.message : (err?.message ?? String(err)),
      );
    } finally {
      setBusy(false);
    }
  };

  const grouped = result ? groupAudioEvents(result) : null;

  return (
    <Card className="bg-console-surface border-console-border">
      <CardContent className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Ear className="size-3.5 text-console-purple" />
          <h3 className="text-xs font-bold uppercase text-console-text">
            Sound-event classification (YAMNet)
          </h3>
        </div>
        <p className="mt-1.5 text-[10px] leading-relaxed text-console-muted">
          Unlike everything else on this page, this sends the audio to ai-service — a separate
          local backend, over the network — to classify it against 521 real AudioSet sound
          categories (bell, siren, crying, alarm, speech, and more). Scores are the model's own
          uncalibrated per-class outputs, shown as "model score," never as a confidence value.
        </p>

        <label className="mt-2.5 flex items-start gap-2 rounded border border-console-border bg-console-deep/60 p-2">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            className="mt-0.5 size-3 shrink-0 accent-console-purple"
          />
          <span className="text-[10px] leading-relaxed text-console-muted">
            I consent to sending this video&apos;s audio to ai-service for sound-event
            classification.
          </span>
        </label>

        <Button
          size="sm"
          variant="outline"
          disabled={!file || !consent || busy}
          onClick={run}
          className="mt-2 h-7 gap-1 text-[10px]"
        >
          {busy ? <Loader2 className="size-3 animate-spin" /> : <Ear className="size-3" />}
          Classify sounds
        </Button>

        {error && (
          <div className="mt-2 flex items-start gap-2 rounded border border-console-red/30 bg-console-red/5 p-2">
            <AlertTriangle className="size-3.5 shrink-0 text-console-red" />
            <span className="text-[10px] leading-relaxed text-console-red">{error}</span>
          </div>
        )}

        {result && grouped && (
          <div className="mt-3">
            <p className="text-[10px] leading-relaxed text-console-muted">{describeCoverage(result)}</p>

            {grouped.hazards.length > 0 && (
              <>
                <h4 className="mt-2.5 flex items-center gap-1.5 text-[10px] font-bold uppercase text-console-red">
                  <ShieldAlert className="size-3" />
                  Hazard-class candidates ({grouped.hazards.length}) — confirm by listening
                </h4>
                <div className="mt-1.5 space-y-1.5">
                  {grouped.hazards.map((e, i) => (
                    <EventRow key={i} event={e} hazard />
                  ))}
                </div>
              </>
            )}

            <h4 className="mt-2.5 text-[10px] font-bold uppercase text-console-text">
              Other detected classes ({grouped.other.length})
            </h4>
            {grouped.other.length === 0 ? (
              <p className="mt-1.5 text-[11px] text-console-label">
                Nothing else cleared the reporting threshold in this clip.
              </p>
            ) : (
              <div className="mt-1.5 space-y-1.5">
                {grouped.other.map((e, i) => (
                  <EventRow key={i} event={e} hazard={false} />
                ))}
              </div>
            )}

            {shouldShowClosestMatches(result) && (
              <div className="mt-2.5 rounded border border-console-border bg-console-deep/60 p-2.5">
                <div className="text-[10px] font-bold uppercase tracking-wider text-console-muted">
                  Closest matches — none reached the reporting threshold
                </div>
                <p className="mt-1 text-[10px] leading-relaxed text-console-label">
                  Not a finding — the model's own real top candidates for this clip, shown so
                  "nothing detected" isn't confused with "nothing was analysed."
                </p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {result.closestBelowThreshold.map((c, i) => (
                    <Badge
                      key={i}
                      variant="outline"
                      className="border-console-label/40 bg-console-label/5 font-mono text-[9px] font-normal text-console-muted"
                    >
                      {c.className} {c.maxScore.toFixed(2)}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-3 rounded border border-console-label/30 bg-console-deep/60 p-2.5">
              <div className="text-[10px] font-bold uppercase tracking-wider text-console-muted">
                What this system could NOT determine about this audio
              </div>
              <ul className="mt-1 list-disc space-y-1 pl-4 text-[10px] leading-relaxed text-console-muted">
                {AUDIO_EVENT_CANNOT_DETERMINE.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>

            <p className="mt-2 text-[10px] italic text-console-label">
              {result.provenance.model} · {result.provenance.version}. This is a listening index,
              not a verdict — every class here is falsifiable in one second by listening at the
              timestamp.
            </p>

            <div className="mt-3">
              <NotImplementedPanel
                gaps={AUDIO_EVENT_GAPS}
                title="Sound-event classification — not implemented"
                description="What real YAMNet classification of this audio cannot do — stated explicitly rather than implied by silence."
              />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
