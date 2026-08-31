/**
 * In-browser audio extraction for Video Intelligence's Sarvam transcription
 * feature (transcription.ts). Runs entirely client-side, no dependency
 * beyond the Web Audio API already available in every evergreen browser —
 * no ffmpeg.wasm.
 *
 * Why this exists: sending the raw uploaded video file (an MP4/MOV/WebM
 * CONTAINER, not a plain audio file) straight to Sarvam looked like it
 * worked — a synthetic sine-tone WAV mislabelled as `application/octet-
 * stream` was accepted and decoded correctly in testing — but a REAL
 * multi-track video container is a different thing entirely: Sarvam's job
 * completed with `state: "Success"` and an empty transcript on a real
 * English-speech video, which is a silent decode failure, not "no speech
 * found". `application/octet-stream` only tells Sarvam's TYPE CHECK to
 * back off; it does not make Sarvam able to demux an MP4 it was never
 * shown how to unwrap.
 *
 * The fix is to do the demuxing/decoding OURSELVES, using the browser's own
 * built-in media pipeline (the same decoder `<video>`/`<audio>` elements
 * use) via `AudioContext.decodeAudioData`, which handles arbitrary
 * container/codec combinations the browser can play — then re-encode the
 * decoded PCM as a plain WAV file, a format with no demuxing ambiguity at
 * all and always on Sarvam's accepted list. Downsampled to 16kHz mono on
 * the way out: Sarvam's own docs note their ASR is tuned for 16kHz, and it
 * shrinks the upload for the batch (long-clip) path.
 */

import { MediaError } from "./imaging-client";
import { ANALYSIS_SAMPLE_RATE, analyseSpectrum, type SpectralAnalysis, type SpectralAnalysisOptions } from "./audio-frequency";

const TARGET_SAMPLE_RATE = 16_000;

/**
 * 15 minutes. analyseSpectrum's own measured runtime is sub-second even at
 * this cap (the FFT itself is cheap — decodeAudioData is the real cost,
 * already true for the existing transcription feature), so a hard refusal
 * above this line is the real safety net rather than a Web Worker: an
 * explicit MediaError the analyst sees, never a silent multi-minute freeze.
 */
export const MAX_AUDIO_ANALYSIS_SECONDS = 900;

/**
 * Pure: Float32 PCM samples (one channel, [-1, 1] range) -> a standard
 * 16-bit PCM WAV file. No AudioContext involved, so this half is
 * unit-testable without a browser.
 */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Blob {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += bytesPerSample;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

export interface DecodedAudioSamples {
  /** Mono PCM, [-1, 1] range, at `sampleRate`. */
  samples: Float32Array;
  sampleRate: number;
  duration: number;
}

/**
 * Decodes the audio track out of an uploaded video/audio file and returns
 * real mono PCM at `targetSampleRate` — the shared decode step behind both
 * `extractAudioAsWav` (Sarvam transcription) and the spectral-analysis
 * feature (audio-frequency.ts), so a file is only ever decoded once per
 * call site rather than each feature re-decoding independently. Throws
 * MediaError (stage "decode-audio") if the browser cannot decode this file
 * at all — never falls back to returning the original, undemuxed bytes.
 */
export async function decodeAudioSamples(
  file: File,
  targetSampleRate: number = TARGET_SAMPLE_RATE,
): Promise<DecodedAudioSamples> {
  const AudioContextCtor: typeof AudioContext | undefined =
    (window as any).AudioContext ?? (window as any).webkitAudioContext;
  if (!AudioContextCtor) {
    throw new MediaError("Web Audio API is unavailable in this browser.", "decode-audio");
  }

  const arrayBuffer = await file.arrayBuffer();
  const decodeCtx = new AudioContextCtor();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuffer);
  } catch (err: any) {
    throw new MediaError(
      `Could not decode an audio track from ${file.name}: ${err?.message ?? String(err)}. ` +
        "The file may have no audio track, or use a codec this browser cannot decode.",
      "decode-audio",
    );
  } finally {
    await decodeCtx.close().catch(() => {});
  }

  if (decoded.duration <= 0) {
    throw new MediaError(`${file.name} decoded to zero-length audio.`, "decode-audio");
  }

  // OfflineAudioContext with numberOfChannels=1 downmixes stereo/multi-
  // channel sources to mono per the Web Audio API's standard mixing rules,
  // and rendering at targetSampleRate resamples in the same pass.
  const frameCount = Math.ceil(decoded.duration * targetSampleRate);
  const offlineCtx = new OfflineAudioContext(1, frameCount, targetSampleRate);
  const source = offlineCtx.createBufferSource();
  source.buffer = decoded;
  source.connect(offlineCtx.destination);
  source.start();

  let rendered: AudioBuffer;
  try {
    rendered = await offlineCtx.startRendering();
  } catch (err: any) {
    throw new MediaError(
      `Could not resample the decoded audio from ${file.name}: ${err?.message ?? String(err)}`,
      "decode-audio",
    );
  }

  return {
    samples: rendered.getChannelData(0),
    sampleRate: targetSampleRate,
    duration: rendered.duration,
  };
}

/**
 * Decodes the audio track out of an uploaded video/audio file and returns
 * it as a 16kHz mono WAV blob, ready to send to Sarvam. Thin wrapper over
 * `decodeAudioSamples` — kept as its own export since it's the one that
 * carries the historical doc comment below explaining why this exists at
 * all (see the module header).
 */
export async function extractAudioAsWav(
  file: File,
  targetSampleRate: number = TARGET_SAMPLE_RATE,
): Promise<Blob> {
  const { samples, sampleRate } = await decodeAudioSamples(file, targetSampleRate);
  return encodeWavPcm16(samples, sampleRate);
}

/**
 * Decode + full spectral analysis in one call — the entry point
 * audio-spectrum-panel.tsx uses. `analyseSpectrum` itself is synchronous and
 * pure (see audio-frequency.ts); this async wrapper is the DOM-decode half,
 * and it's where a duration cap is enforced: a file whose decoded audio
 * exceeds MAX_AUDIO_ANALYSIS_SECONDS is refused outright (MediaError, stage
 * "duration-cap") rather than truncated or left to freeze the tab.
 *
 * Decodes at audio-frequency.ts's own ANALYSIS_SAMPLE_RATE (not
 * TARGET_SAMPLE_RATE above, which is a separate Sarvam-tuned constant that
 * happens to share the same value today) so the two stay explicitly tied
 * even if one is ever changed independently.
 */
export async function analyseAudioFrequencies(
  file: File,
  options: SpectralAnalysisOptions = {},
  onProgress?: (done: number, total: number) => void,
): Promise<SpectralAnalysis> {
  const { samples, sampleRate, duration } = await decodeAudioSamples(file, ANALYSIS_SAMPLE_RATE);

  if (duration > MAX_AUDIO_ANALYSIS_SECONDS) {
    throw new MediaError(
      `${file.name} decodes to ${Math.round(duration)}s of audio, over the ` +
        `${Math.round(MAX_AUDIO_ANALYSIS_SECONDS / 60)}-minute cap for spectral analysis. Trim the file and retry.`,
      "duration-cap",
    );
  }

  return analyseSpectrum(samples, sampleRate, options, onProgress);
}
