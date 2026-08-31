/**
 * Module 4 — audio spectral analysis, pure layer (video's audio track).
 *
 * SAME PHILOSOPHY AS imaging.ts: real, deterministic measurement over a
 * signal, never a guess. Every number here derives from a real FFT over
 * real decoded PCM — no model, no randomness, fully reproducible (the same
 * bytes always produce the same spectrum, unlike a live AnalyserNode poll).
 *
 * THE SCIENTIFIC-HONESTY POSITION THIS FILE IS BUILT AROUND: a struck bell
 * does not ring at one frequency. It radiates a partial series — classically
 * (Rayleigh's names) roughly 0.5/1.0/1.2/1.5/2.0x the prime, and the 1.2
 * "tierce" is a MINOR THIRD above the prime, not an integer multiple. That
 * inharmonicity is why a bell sounds clangorous rather than pitched like a
 * flute. So this module measures the real partials present, their energy,
 * and whether they are harmonic or not — and explicitly does NOT claim to
 * identify a specific real-world object (which cathedral's bell) from the
 * spectrum alone. That would need a reference recording to fingerprint
 * against, structurally identical to how findNearDuplicates (this same
 * module family, for images) needs a reference corpus and cannot identify
 * an object from first principles. See SPECTRAL_CANNOT_DETERMINE below.
 *
 * This file is PURE: no DOM, no network, no dynamic imports. Everything
 * here is directly testable under bun. Browser-only decode work lives in
 * audio-extract-client.ts, which produces the Float32Array PCM this file
 * consumes, and never the reverse.
 *
 * No Math.random(). No invented confidence values. Absence of a signal
 * (silence, or noise with no discernible tone) is reported as absence,
 * never as a measured zero — see the FrameStatus gate below.
 */

import type { Gap } from "./imaging";

// ─── Constants ──────────────────────────────────────────────────────────

/** Matches audio-extract-client.ts's own target — Sarvam-tuned, and what we analyse. */
export const ANALYSIS_SAMPLE_RATE = 16_000;

/**
 * 2048 samples at 16kHz = 128ms window. A real trade-off (the Gabor limit:
 * frequency resolution and time resolution cannot both improve at once),
 * not a default — see EFFECTIVE_RESOLUTION_HZ below for what this actually
 * buys in frequency terms, and the onset-detection hop for what it costs
 * in time terms. Exposed as a parameter so a caller can trade explicitly.
 */
export const FFT_SIZE = 2048;
export const BIN_COUNT = FFT_SIZE / 2 + 1;
/** sr/N. This is BIN SPACING, not resolution — see the note below. */
export const BIN_SPACING_HZ = ANALYSIS_SAMPLE_RATE / FFT_SIZE;
/**
 * The honest resolution number. A Hann window's main lobe is ~2 bins wide,
 * so two tones closer than this merge into one apparent peak — proven by a
 * unit test, not asserted. Never present BIN_SPACING_HZ as "the resolution"
 * anywhere in the UI; it understates the real limit by 2x.
 */
export const EFFECTIVE_RESOLUTION_HZ = 2 * BIN_SPACING_HZ;
export const WINDOW_SECONDS = FFT_SIZE / ANALYSIS_SAMPLE_RATE;

/** 50% overlap — the standard STFT choice, halves the time gap between frames. */
export const DEFAULT_HOP_SIZE = FFT_SIZE / 2;

/** A 128ms window sees fewer than 5 cycles below this — the practical low limit. */
export const MIN_ANALYSIS_HZ = 40;
/** 95% of Nyquist (8000Hz) — above this the resampler's anti-alias filter attenuates. */
export const MAX_ANALYSIS_HZ = 7600;

/** Below this RMS level, a frame is reported as silence, never a spurious "dominant" bin. */
export const SILENCE_FLOOR_DBFS = -60;
/** Above this spectral flatness (Wiener entropy), a frame is noise-like — peak-picking is not meaningful. */
export const NOISE_FLATNESS_THRESHOLD = 0.5;
/** A peak must be within this many dB of the frame's strongest peak to be kept. */
export const PEAK_FLOOR_DB = -40;
export const MAX_PEAKS_PER_FRAME = 8;

/** Caps analysis at ~21 minutes (50% overlap) so a long file stays bounded. Adaptive hop covers longer files at reduced coverage — see analyseSpectrum. */
export const MAX_FRAMES = 20_000;

export const SPECTROGRAM_COLUMNS = 512;
export const SPECTROGRAM_ROWS = 256;
export const SPECTROGRAM_MIN_HZ = 30;
export const SPECTROGRAM_MAX_HZ = 8000;
export const SPECTROGRAM_DB_FLOOR = -80;
export const SPECTROGRAM_DB_CEILING = 0;

/** Onset/decay detection tuning — see detectAcousticEvents. */
export const ONSET_MEDIAN_WINDOW_FRAMES = 32; // ~2s at 50% overlap
export const ONSET_REFRACTORY_FRAMES = 2;
export const DECAY_FIT_MIN_R2 = 0.8;
/** Decay is fit over this dB range relative to the event peak — the standard "avoid the noisy tail" range. */
export const DECAY_FIT_RANGE_DB: [number, number] = [-5, -25];

export interface FrequencyBand {
  id: string;
  label: string;
  minHz: number;
  maxHz: number;
  /** True when [minHz,maxHz] extends outside [MIN_ANALYSIS_HZ, MAX_ANALYSIS_HZ] — the band is not fully measurable. */
  partiallyCovered: boolean;
}

function makeBand(id: string, label: string, minHz: number, maxHz: number): FrequencyBand {
  return {
    id,
    label,
    minHz,
    maxHz,
    partiallyCovered: minHz < MIN_ANALYSIS_HZ || maxHz > MAX_ANALYSIS_HZ,
  };
}

/** Real, named audio-engineering bands — not arbitrary splits. Truncated at our 8kHz ceiling. */
export const FREQUENCY_BANDS: FrequencyBand[] = [
  makeBand("sub_bass", "Sub-bass", 20, 60),
  makeBand("bass", "Bass", 60, 250),
  makeBand("low_mid", "Low-mid", 250, 500),
  makeBand("mid", "Mid", 500, 2000),
  makeBand("upper_mid", "Upper-mid", 2000, 4000),
  makeBand("presence", "Presence", 4000, 6000),
  makeBand("brilliance", "Brilliance", 6000, 8000),
];

// ─── FFT core ───────────────────────────────────────────────────────────

/**
 * Iterative in-place radix-2 decimation-in-time FFT. `re`/`im` must be
 * power-of-two length and are overwritten with the transform. Hand-written
 * to match imaging.ts's own precedent of hand-writing its DCT rather than
 * adding a dependency for ~60 lines of textbook math.
 */
export function fftRadix2(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n !== im.length) throw new Error("fftRadix2: re/im length mismatch.");
  if (n === 0 || (n & (n - 1)) !== 0) {
    throw new Error(`fftRadix2 requires a power-of-two length, received ${n}.`);
  }

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const angleStep = (-2 * Math.PI) / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k += 1) {
        const angle = angleStep * k;
        const wr = Math.cos(angle);
        const wi = Math.sin(angle);
        const evenI = start + k;
        const oddI = start + k + half;
        const oddRe = re[oddI] * wr - im[oddI] * wi;
        const oddIm = re[oddI] * wi + im[oddI] * wr;
        re[oddI] = re[evenI] - oddRe;
        im[oddI] = im[evenI] - oddIm;
        re[evenI] += oddRe;
        im[evenI] += oddIm;
      }
    }
  }
}

const HANN_CACHE = new Map<number, Float64Array>();

/**
 * Periodic-form Hann window: w[n] = 0.5*(1 - cos(2*pi*n/N)) — the correct
 * form for STFT analysis (the symmetric (N-1) form is for FIR filter
 * design). Chosen over rectangular (leaks a weak partial into a strong
 * neighbour's sidelobe — would destroy the "find the weak bell partial"
 * deliverable) and over Hamming (lower near sidelobe, but only rolls off
 * at ~6dB/octave and stays near -40dB far out; Hann's 18dB/octave rolloff
 * wins for resolving something weak far from something strong).
 */
export function hannWindow(n: number): Float64Array {
  let w = HANN_CACHE.get(n);
  if (!w) {
    w = new Float64Array(n);
    for (let i = 0; i < n; i += 1) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
    HANN_CACHE.set(n, w);
  }
  return w;
}

/** Coherent gain of the window — used to normalise magnitudes so band levels are comparable across frames. */
function windowCoherentGain(window: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < window.length; i += 1) sum += window[i];
  return sum / window.length;
}

/**
 * Windows, FFTs and returns the magnitude spectrum (BIN_COUNT bins) of one
 * frame, normalised by the window's coherent gain so levels are comparable
 * frame to frame regardless of window choice.
 */
export function magnitudeSpectrum(frame: Float64Array, window: Float64Array): Float64Array {
  const n = frame.length;
  if (n !== window.length) throw new Error("magnitudeSpectrum: frame/window length mismatch.");

  // Remove DC offset before windowing — an unremoved offset biases bin 0
  // and leaks into neighbouring bins, the same reasoning imaging.ts's pHash
  // excludes the DC coefficient before its median.
  let mean = 0;
  for (let i = 0; i < n; i += 1) mean += frame[i];
  mean /= n;

  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i += 1) re[i] = (frame[i] - mean) * window[i];

  fftRadix2(re, im);

  const gain = windowCoherentGain(window) || 1;
  const mag = new Float64Array(n / 2 + 1);
  for (let k = 0; k < mag.length; k += 1) {
    mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / (n * gain);
  }
  return mag;
}

function magnitudeToDbfs(magnitude: number): number {
  return magnitude > 0 ? 20 * Math.log10(magnitude) : -Infinity;
}

// ─── Peak finding ───────────────────────────────────────────────────────

export interface SpectralPeak {
  hz: number;
  binIndex: number;
  magnitudeDb: number;
  /** Parabolic sub-bin refinement applied. False => trust only to +/-EFFECTIVE_RESOLUTION_HZ. */
  refined: boolean;
}

/**
 * Parabolic (quadratic) interpolation on log-magnitude around bin k, the
 * standard STFT peak-refinement formula. Valid ONLY for an isolated, stable
 * sinusoid — for a transient, noisy, or overlapping peak the refined value
 * is no more trustworthy than the raw bin centre, which is why callers
 * carry a `refined` flag rather than silently upgrading precision.
 */
export function refinePeakParabolic(mag: Float64Array, k: number): number {
  if (k <= 0 || k >= mag.length - 1) return 0;
  const toDb = (v: number) => (v > 0 ? Math.log(v) : -50);
  const alpha = toDb(mag[k - 1]);
  const beta = toDb(mag[k]);
  const gamma = toDb(mag[k + 1]);
  const denom = alpha - 2 * beta + gamma;
  if (Math.abs(denom) < 1e-12) return 0;
  const delta = 0.5 * ((alpha - gamma) / denom);
  return Math.max(-0.5, Math.min(0.5, delta));
}

/**
 * Local-maxima peak picking within [minHz,maxHz], kept above PEAK_FLOOR_DB
 * relative to the frame's own strongest peak. Returns [] for a frame with
 * no qualifying peak — callers gate on FrameStatus before trusting this at
 * all (see analyseSpectrum), since peak-picking always finds SOMETHING,
 * even in pure noise.
 */
export function findPeaks(
  mag: Float64Array,
  sampleRate: number,
  fftSize: number,
  minHz: number = MIN_ANALYSIS_HZ,
  maxHz: number = MAX_ANALYSIS_HZ,
  maxPeaks: number = MAX_PEAKS_PER_FRAME,
): SpectralPeak[] {
  const binHz = sampleRate / fftSize;
  const kMin = Math.max(1, Math.ceil(minHz / binHz));
  const kMax = Math.min(mag.length - 2, Math.floor(maxHz / binHz));

  let maxDb = -Infinity;
  for (let k = kMin; k <= kMax; k += 1) {
    const db = magnitudeToDbfs(mag[k]);
    if (db > maxDb) maxDb = db;
  }
  if (!Number.isFinite(maxDb)) return [];

  const floorDb = maxDb + PEAK_FLOOR_DB;
  const candidates: SpectralPeak[] = [];
  for (let k = kMin; k <= kMax; k += 1) {
    if (mag[k] <= mag[k - 1] || mag[k] < mag[k + 1]) continue;
    const db = magnitudeToDbfs(mag[k]);
    if (db < floorDb) continue;
    const delta = refinePeakParabolic(mag, k);
    candidates.push({
      hz: (k + delta) * binHz,
      binIndex: k,
      magnitudeDb: db,
      refined: delta !== 0,
    });
  }

  candidates.sort((a, b) => b.magnitudeDb - a.magnitudeDb);
  return candidates.slice(0, maxPeaks);
}

// ─── Spectral shape descriptors ────────────────────────────────────────

export function spectralCentroidHz(
  mag: Float64Array,
  sampleRate: number,
  fftSize: number,
  minHz: number = MIN_ANALYSIS_HZ,
  maxHz: number = MAX_ANALYSIS_HZ,
): number | null {
  const binHz = sampleRate / fftSize;
  const kMin = Math.max(0, Math.round(minHz / binHz));
  const kMax = Math.min(mag.length - 1, Math.round(maxHz / binHz));
  let weighted = 0;
  let total = 0;
  for (let k = kMin; k <= kMax; k += 1) {
    weighted += k * binHz * mag[k];
    total += mag[k];
  }
  return total > 0 ? weighted / total : null;
}

/** Wiener entropy (geometric mean / arithmetic mean of power). ~1 = flat/noise-like, ~0 = tonal. */
export function spectralFlatness(mag: Float64Array, kMin: number, kMax: number): number {
  let logSum = 0;
  let sum = 0;
  let count = 0;
  for (let k = kMin; k <= kMax; k += 1) {
    const p = mag[k] * mag[k];
    if (p > 0) logSum += Math.log(p);
    sum += p;
    count += 1;
  }
  if (count === 0 || sum <= 0) return 0;
  const geoMean = Math.exp(logSum / count);
  const arithMean = sum / count;
  return arithMean > 0 ? geoMean / arithMean : 0;
}

export function spectralRolloffHz(
  mag: Float64Array,
  sampleRate: number,
  fftSize: number,
  fraction = 0.85,
): number | null {
  const binHz = sampleRate / fftSize;
  let total = 0;
  for (let k = 0; k < mag.length; k += 1) total += mag[k] * mag[k];
  if (total <= 0) return null;
  const target = total * fraction;
  let cumulative = 0;
  for (let k = 0; k < mag.length; k += 1) {
    cumulative += mag[k] * mag[k];
    if (cumulative >= target) return k * binHz;
  }
  return (mag.length - 1) * binHz;
}

// ─── Fundamental estimation (Harmonic Product Spectrum) ────────────────

export interface FundamentalEstimate {
  hz: number;
  /** Measured HPS peak prominence (peak / median of the HPS) — a real ratio, never an invented probability. */
  confidence: number;
}

const HPS_MIN_HZ = 50;
const HPS_MAX_HZ = 2000;
const HPS_DOWNSAMPLE_FACTORS = [2, 3, 4, 5];

/**
 * Harmonic Product Spectrum: downsamples the magnitude spectrum by 2,3,4,5
 * and multiplies — the true fundamental is reinforced across all of them,
 * which is why this beats "take the loudest peak" (the classic
 * missing-fundamental / octave-error failure: the loudest partial is
 * frequently NOT f0). Returns null when no candidate has real energy —
 * never forces a fundamental onto an inharmonic or noisy frame, since for
 * a genuinely inharmonic sound (a bell) the HPS peak is weak BY
 * CONSTRUCTION, and that weakness is itself the inharmonicity signal.
 */
export function estimateFundamentalHps(
  mag: Float64Array,
  sampleRate: number,
  fftSize: number,
): FundamentalEstimate | null {
  const binHz = sampleRate / fftSize;
  const kMin = Math.max(1, Math.ceil(HPS_MIN_HZ / binHz));
  const kMax = Math.min(
    Math.floor(mag.length / Math.max(...HPS_DOWNSAMPLE_FACTORS)) - 1,
    Math.floor(HPS_MAX_HZ / binHz),
  );
  if (kMax <= kMin) return null;

  const hps = new Float64Array(kMax - kMin + 1);
  for (let k = kMin; k <= kMax; k += 1) {
    let product = mag[k];
    for (const factor of HPS_DOWNSAMPLE_FACTORS) {
      const idx = k * factor;
      product *= idx < mag.length ? mag[idx] : 0;
    }
    hps[k - kMin] = product;
  }

  let bestIdx = -1;
  let bestVal = 0;
  for (let i = 0; i < hps.length; i += 1) {
    if (hps[i] > bestVal) {
      bestVal = hps[i];
      bestIdx = i;
    }
  }
  if (bestIdx < 0 || bestVal <= 0) return null;

  const sorted = Array.from(hps).sort((a, b) => a - b);
  const rawMedian = sorted[Math.floor(sorted.length / 2)];
  // A spectrally sparse frame (a clean tone, or heavily lossy-compressed
  // audio that has quantized most bins to near-zero — this module's own
  // documented realistic OSINT case) can leave the HPS median at or near
  // the numerical floor, sometimes exactly 0. Dividing by that — or by an
  // arbitrary absolute constant unrelated to the signal's own scale —
  // produced confidence values in the HUNDREDS OF BILLIONS on real
  // browser-decoded audio (found live on 2026-08-26, not by a unit test):
  // a numerical artifact rendered as if it were a measurement, exactly
  // what this module exists to avoid. Flooring the denominator relative
  // to the peak's OWN scale keeps the gate meaningful regardless of input
  // amplitude, and caps how large a ratio can ever be reported: beyond
  // roughly a million-to-one, "how much more prominent" is not a
  // physically meaningful distinction for 16-24 bit audio, so it is
  // capped rather than shown as false precision.
  const median = Math.max(rawMedian, bestVal * 1e-6);
  const confidence = bestVal / median;
  // A prominence indistinguishable from the noise floor is not a real
  // detection — require the peak to meaningfully exceed the median.
  if (confidence < 2) return null;

  const k = bestIdx + kMin;
  const delta = refinePeakParabolic(mag, Math.min(k, mag.length - 2));
  return { hz: (k + delta) * binHz, confidence };
}

// ─── Harmonicity ─────────────────────────────────────────────────────────

export interface HarmonicityResult {
  /** 0 = fully inharmonic (bell-like), 1 = fully harmonic (voice/music-like). Power-weighted. */
  ratio: number;
  matchedHarmonics: number[];
  /** Every measured peak's frequency / f0 — the primary hand-off to a classifier. */
  partialRatios: number[];
  meanDeviationCents: number | null;
}

const HARMONICITY_MAX_MULTIPLE = 8;
const HARMONICITY_TOLERANCE_FRACTION = 0.03;

/**
 * For m=1..8, looks for a measured peak within
 * max(3% of m*f0, EFFECTIVE_RESOLUTION_HZ) of m*f0 — the max() matters: at
 * f0=100Hz, 3% is 3Hz, tighter than this instrument can resolve, so a
 * cents-only tolerance would reject real harmonics as inharmonic.
 */
export function harmonicity(peaks: SpectralPeak[], f0: number): HarmonicityResult {
  const partialRatios = peaks.map((p) => p.hz / f0);
  if (peaks.length === 0 || f0 <= 0) {
    return { ratio: 0, matchedHarmonics: [], partialRatios, meanDeviationCents: null };
  }

  let totalPower = 0;
  let matchedPower = 0;
  const matchedHarmonics: number[] = [];
  const deviationsCents: number[] = [];

  for (const peak of peaks) {
    const power = 10 ** (peak.magnitudeDb / 10);
    totalPower += power;

    let bestMultiple = -1;
    let bestDeviation = Infinity;
    for (let m = 1; m <= HARMONICITY_MAX_MULTIPLE; m += 1) {
      const target = m * f0;
      const tolerance = Math.max(HARMONICITY_TOLERANCE_FRACTION * target, EFFECTIVE_RESOLUTION_HZ);
      const deviation = Math.abs(peak.hz - target);
      if (deviation <= tolerance && deviation < bestDeviation) {
        bestDeviation = deviation;
        bestMultiple = m;
      }
    }
    if (bestMultiple > 0) {
      matchedPower += power;
      if (!matchedHarmonics.includes(bestMultiple)) matchedHarmonics.push(bestMultiple);
      deviationsCents.push(1200 * Math.log2(peak.hz / (bestMultiple * f0)));
    }
  }

  matchedHarmonics.sort((a, b) => a - b);
  const meanDeviationCents = deviationsCents.length
    ? deviationsCents.reduce((s, d) => s + Math.abs(d), 0) / deviationsCents.length
    : null;

  return {
    ratio: totalPower > 0 ? matchedPower / totalPower : 0,
    matchedHarmonics,
    partialRatios,
    meanDeviationCents,
  };
}

// ─── Per-frame orchestration ─────────────────────────────────────────────

export type FrameStatus = "measured" | "noise-like" | "below-floor";

export interface SpectralFrame {
  /** Seconds — the CENTRE of the analysis window, not its start. */
  time: number;
  status: FrameStatus;
  rmsDbfs: number;
  peakDbfs: number;
  dominant: SpectralPeak | null;
  peaks: SpectralPeak[];
  bandPowerDbfs: (number | null)[];
  bandFraction: (number | null)[];
  centroidHz: number | null;
  flatness: number | null;
  rolloff85Hz: number | null;
  fundamentalHz: number | null;
  fundamentalConfidence: number | null;
  harmonicRatio: number | null;
  matchedHarmonics: number[];
  partialRatios: number[];
  /** null on the very first frame — spectral flux needs a previous frame. */
  spectralFlux: number | null;
}

function rmsOf(frame: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}

function bandPower(mag: Float64Array, sampleRate: number, fftSize: number, band: FrequencyBand): number {
  const binHz = sampleRate / fftSize;
  const kMin = Math.max(0, Math.round(band.minHz / binHz));
  const kMax = Math.min(mag.length - 1, Math.round(band.maxHz / binHz));
  let power = 0;
  for (let k = kMin; k <= kMax; k += 1) power += mag[k] * mag[k];
  return power;
}

function analyseOneFrame(
  samples: Float64Array,
  start: number,
  window: Float64Array,
  sampleRate: number,
  fftSize: number,
  prevMag: Float64Array | null,
): { frame: SpectralFrame; mag: Float64Array } {
  const slice = samples.subarray(start, start + fftSize);
  const rms = rmsOf(slice);
  const rmsDbfs = rms > 0 ? 20 * Math.log10(rms) : -Infinity;

  const mag = magnitudeSpectrum(slice, window);
  let peakLinear = 0;
  for (let k = 0; k < mag.length; k += 1) if (mag[k] > peakLinear) peakLinear = mag[k];
  const peakDbfs = magnitudeToDbfs(peakLinear);

  const totalBandPower = FREQUENCY_BANDS.reduce((s, b) => s + bandPower(mag, sampleRate, fftSize, b), 0);

  let spectralFlux: number | null = null;
  if (prevMag) {
    let flux = 0;
    for (let k = 0; k < mag.length; k += 1) flux += Math.max(0, mag[k] - prevMag[k]);
    spectralFlux = flux;
  }

  const time = (start + fftSize / 2) / sampleRate;

  if (!Number.isFinite(rmsDbfs) || rmsDbfs < SILENCE_FLOOR_DBFS) {
    return {
      mag,
      frame: {
        time,
        status: "below-floor",
        rmsDbfs: Number.isFinite(rmsDbfs) ? rmsDbfs : SILENCE_FLOOR_DBFS,
        peakDbfs: Number.isFinite(peakDbfs) ? peakDbfs : SILENCE_FLOOR_DBFS,
        dominant: null,
        peaks: [],
        bandPowerDbfs: FREQUENCY_BANDS.map(() => null),
        bandFraction: FREQUENCY_BANDS.map(() => null),
        centroidHz: null,
        flatness: null,
        rolloff85Hz: null,
        fundamentalHz: null,
        fundamentalConfidence: null,
        harmonicRatio: null,
        matchedHarmonics: [],
        partialRatios: [],
        spectralFlux,
      },
    };
  }

  const binHz = sampleRate / fftSize;
  const flatness = spectralFlatness(
    mag,
    Math.max(1, Math.ceil(MIN_ANALYSIS_HZ / binHz)),
    Math.min(mag.length - 1, Math.floor(MAX_ANALYSIS_HZ / binHz)),
  );

  if (flatness > NOISE_FLATNESS_THRESHOLD) {
    return {
      mag,
      frame: {
        time,
        status: "noise-like",
        rmsDbfs,
        peakDbfs,
        dominant: null,
        peaks: [],
        bandPowerDbfs: FREQUENCY_BANDS.map((b) => magnitudeToDbfs(Math.sqrt(bandPower(mag, sampleRate, fftSize, b)))),
        bandFraction: FREQUENCY_BANDS.map((b) =>
          totalBandPower > 0 ? bandPower(mag, sampleRate, fftSize, b) / totalBandPower : null,
        ),
        centroidHz: spectralCentroidHz(mag, sampleRate, fftSize),
        flatness,
        rolloff85Hz: spectralRolloffHz(mag, sampleRate, fftSize),
        fundamentalHz: null,
        fundamentalConfidence: null,
        harmonicRatio: null,
        matchedHarmonics: [],
        partialRatios: [],
        spectralFlux,
      },
    };
  }

  const peaks = findPeaks(mag, sampleRate, fftSize);
  const dominant = peaks[0] ?? null;
  const fundamental = estimateFundamentalHps(mag, sampleRate, fftSize);
  const h = fundamental ? harmonicity(peaks, fundamental.hz) : null;

  return {
    mag,
    frame: {
      time,
      status: "measured",
      rmsDbfs,
      peakDbfs,
      dominant,
      peaks,
      bandPowerDbfs: FREQUENCY_BANDS.map((b) => magnitudeToDbfs(Math.sqrt(bandPower(mag, sampleRate, fftSize, b)))),
      bandFraction: FREQUENCY_BANDS.map((b) =>
        totalBandPower > 0 ? bandPower(mag, sampleRate, fftSize, b) / totalBandPower : null,
      ),
      centroidHz: spectralCentroidHz(mag, sampleRate, fftSize),
      flatness,
      rolloff85Hz: spectralRolloffHz(mag, sampleRate, fftSize),
      fundamentalHz: fundamental?.hz ?? null,
      fundamentalConfidence: fundamental?.confidence ?? null,
      harmonicRatio: h?.ratio ?? null,
      matchedHarmonics: h?.matchedHarmonics ?? [],
      partialRatios: h?.partialRatios ?? [],
      spectralFlux,
    },
  };
}

// ─── Spectrogram pooling ─────────────────────────────────────────────────

export interface Spectrogram {
  columns: number;
  rows: number;
  rowHz: Float32Array;
  columnTime: Float32Array;
  /** rows x columns, row-major. dB, clamped to [dbFloor, dbCeiling]. */
  db: Float32Array;
  dbFloor: number;
  dbCeiling: number;
  /** Below this frequency, log-spaced rows are narrower than one FFT bin — interpolated, not resolved. */
  interpolatedBelowHz: number;
}

function buildSpectrogram(
  frameMags: Float64Array[],
  frameTimes: number[],
  sampleRate: number,
  fftSize: number,
): Spectrogram {
  const columns = Math.min(SPECTROGRAM_COLUMNS, Math.max(1, frameMags.length));
  const rows = SPECTROGRAM_ROWS;
  const binHz = sampleRate / fftSize;

  const rowHz = new Float32Array(rows);
  const logMin = Math.log(SPECTROGRAM_MIN_HZ);
  const logMax = Math.log(Math.min(SPECTROGRAM_MAX_HZ, sampleRate / 2));
  for (let r = 0; r < rows; r += 1) {
    rowHz[r] = Math.exp(logMin + ((logMax - logMin) * r) / (rows - 1));
  }
  // Row spacing narrower than one bin means that row is interpolated
  // between bins, not independently resolved — flagged explicitly rather
  // than silently implying finer resolution than the FFT actually has.
  let interpolatedBelowHz = SPECTROGRAM_MIN_HZ;
  for (let r = 1; r < rows; r += 1) {
    if (rowHz[r] - rowHz[r - 1] >= binHz) {
      interpolatedBelowHz = rowHz[r];
      break;
    }
  }

  const columnTime = new Float32Array(columns);
  const db = new Float32Array(rows * columns);
  const framesPerColumn = frameMags.length / columns;

  for (let c = 0; c < columns; c += 1) {
    const startFrame = Math.floor(c * framesPerColumn);
    const endFrame = Math.max(startFrame + 1, Math.floor((c + 1) * framesPerColumn));
    let timeSum = 0;
    let timeCount = 0;
    const pooled = new Float64Array(BIN_COUNT);
    for (let f = startFrame; f < endFrame && f < frameMags.length; f += 1) {
      const mag = frameMags[f];
      for (let k = 0; k < mag.length; k += 1) pooled[k] += mag[k];
      timeSum += frameTimes[f];
      timeCount += 1;
    }
    columnTime[c] = timeCount > 0 ? timeSum / timeCount : 0;
    const divisor = Math.max(1, endFrame - startFrame);
    for (let k = 0; k < pooled.length; k += 1) pooled[k] /= divisor;

    for (let r = 0; r < rows; r += 1) {
      const exactBin = rowHz[r] / binHz;
      const lo = Math.max(0, Math.min(pooled.length - 1, Math.floor(exactBin)));
      const hi = Math.min(pooled.length - 1, lo + 1);
      const frac = exactBin - lo;
      const magAt = pooled[lo] * (1 - frac) + pooled[hi] * frac;
      const dbVal = magnitudeToDbfs(magAt);
      db[r * columns + c] = Math.max(
        SPECTROGRAM_DB_FLOOR,
        Math.min(SPECTROGRAM_DB_CEILING, Number.isFinite(dbVal) ? dbVal : SPECTROGRAM_DB_FLOOR),
      );
    }
  }

  return {
    columns,
    rows,
    rowHz,
    columnTime,
    db,
    dbFloor: SPECTROGRAM_DB_FLOOR,
    dbCeiling: SPECTROGRAM_DB_CEILING,
    interpolatedBelowHz,
  };
}

// ─── Top-level analysis ───────────────────────────────────────────────────

export interface SpectralAnalysisOptions {
  fftSize?: number;
  hopSize?: number;
}

export interface SpectralAnalysis {
  sampleRate: number;
  fftSize: number;
  hopSize: number;
  frameCount: number;
  durationSeconds: number;
  binSpacingHz: number;
  effectiveResolutionHz: number;
  windowSeconds: number;
  frameIntervalSeconds: number;
  nyquistHz: number;
  analysedRangeHz: [number, number];
  /** fftSize/hopSize, clamped to 1. <1 means the audio was SAMPLED, with real gaps between analysed windows. */
  coverage: number;
  bands: FrequencyBand[];
  frames: SpectralFrame[];
  spectrogram: Spectrogram;
  truncated: boolean;
  limits: string[];
  method: string;
}

/**
 * Pure: takes decoded PCM (never a File — see audio-extract-client.ts for
 * that half) and returns a full spectral analysis. Deterministic — the
 * same samples always produce the same result.
 */
export function analyseSpectrum(
  samples: Float32Array,
  sampleRate: number,
  options: SpectralAnalysisOptions = {},
  onProgress?: (done: number, total: number) => void,
): SpectralAnalysis {
  const fftSize = options.fftSize ?? FFT_SIZE;
  if (fftSize <= 0 || (fftSize & (fftSize - 1)) !== 0) {
    throw new Error(`analyseSpectrum: fftSize must be a power of two, received ${fftSize}.`);
  }
  const requestedHop = options.hopSize ?? fftSize / 2;

  const totalSampleCount = samples.length;
  const durationSeconds = totalSampleCount / sampleRate;

  const maxWindows = Math.max(1, Math.floor((totalSampleCount - fftSize) / 1) + 1);
  const naiveFrameCount = totalSampleCount >= fftSize ? Math.floor((totalSampleCount - fftSize) / requestedHop) + 1 : 0;

  let hop = requestedHop;
  let truncated = false;
  if (naiveFrameCount > MAX_FRAMES && naiveFrameCount > 0) {
    hop = Math.max(1, Math.ceil((totalSampleCount - fftSize) / MAX_FRAMES));
    truncated = true;
  }

  const binSpacingHz = sampleRate / fftSize;
  const effectiveResolutionHz = 2 * binSpacingHz;
  const windowSeconds = fftSize / sampleRate;
  const frameIntervalSeconds = hop / sampleRate;
  const coverage = Math.min(1, fftSize / hop);

  const window = hannWindow(fftSize);
  const doubleSamples = new Float64Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) doubleSamples[i] = samples[i];

  const frames: SpectralFrame[] = [];
  const frameMags: Float64Array[] = [];
  const frameTimes: number[] = [];

  if (totalSampleCount >= fftSize) {
    let prevMag: Float64Array | null = null;
    let start = 0;
    let count = 0;
    while (start + fftSize <= totalSampleCount && frames.length < MAX_FRAMES) {
      const { frame, mag } = analyseOneFrame(doubleSamples, start, window, sampleRate, fftSize, prevMag);
      frames.push(frame);
      frameMags.push(mag);
      frameTimes.push(frame.time);
      prevMag = mag;
      start += hop;
      count += 1;
      if (onProgress && count % 64 === 0) onProgress(count, Math.min(naiveFrameCount, MAX_FRAMES));
    }
  }

  const spectrogram = buildSpectrogram(frameMags, frameTimes, sampleRate, fftSize);

  const limits: string[] = [
    `Bin spacing is ${binSpacingHz.toFixed(1)}Hz, but the real two-tone resolution is ` +
      `~${effectiveResolutionHz.toFixed(1)}Hz (the Hann window's main-lobe width) — two tones closer ` +
      `than that merge into one apparent peak.`,
    `Frequencies below ${MIN_ANALYSIS_HZ}Hz are not reliably measurable at this window length ` +
      `(fewer than 5 cycles fit in the ${(windowSeconds * 1000).toFixed(0)}ms window).`,
    `Frequencies above ${MAX_ANALYSIS_HZ}Hz sit inside the resampler's anti-alias rolloff and are not analysed.`,
    `Spectrogram rows below ~${spectrogram.interpolatedBelowHz.toFixed(0)}Hz are interpolated between FFT bins, not independently resolved.`,
  ];
  if (coverage < 1) {
    limits.push(
      `This file was long enough that analysis samples the audio at ${(coverage * 100).toFixed(0)}% ` +
        `coverage rather than continuously — a brief sound can fall entirely between analysed windows.`,
    );
  }
  limits.push(
    "Levels are dBFS relative to digital full scale, never real-world sound pressure (SPL) — the " +
      "recording chain's gain is unknown, so how loud it was in the room is not recoverable.",
  );
  limits.push(
    "A lossy-codec re-encode (the realistic case for redistributed video) smears transients across " +
      "the compression block, which can bias onset timing and decay measurements — see the acoustic " +
      "events section.",
  );

  return {
    sampleRate,
    fftSize,
    hopSize: hop,
    frameCount: frames.length,
    durationSeconds,
    binSpacingHz,
    effectiveResolutionHz,
    windowSeconds,
    frameIntervalSeconds,
    nyquistHz: sampleRate / 2,
    analysedRangeHz: [MIN_ANALYSIS_HZ, MAX_ANALYSIS_HZ],
    coverage,
    bands: FREQUENCY_BANDS,
    frames,
    spectrogram,
    truncated,
    limits,
    method:
      `Radix-2 FFT (size ${fftSize}, Hann window, ${(coverage * 100).toFixed(0)}% coverage) over ` +
      `${sampleRate}Hz mono PCM decoded from this file's audio track in this browser. Levels are dBFS; ` +
      `frequencies below ${MIN_ANALYSIS_HZ}Hz or above ${MAX_ANALYSIS_HZ}Hz are outside the analysed range.`,
  };
}

// ─── Acoustic events (onset / decay / partial stability) ──────────────────

export interface AcousticEvent {
  onsetTime: number;
  /** +/- half the frame interval — the real time resolution of onset detection. */
  onsetUncertaintySeconds: number;
  peakDbfs: number;
  /** Seconds to decay 60dB from peak, extrapolated from a real linear fit over DECAY_FIT_RANGE_DB. Null when the fit's R^2 is below DECAY_FIT_MIN_R2. */
  decayToMinus60Seconds: number | null;
  decayFitR2: number | null;
  /** Cents/second drift of the dominant partial across the event. Near 0 = stable (bell-like), large = sweeping (siren-like). */
  partialDriftCentsPerSecond: number | null;
  harmonicRatio: number | null;
  matchedHarmonics: number[];
  partialRatios: number[];
  /** Built only from measured facts — see analyseSpectrum's SpectralFrame. Never a category label. */
  descriptor: string;
}

function medianAbsoluteDeviation(values: number[]): { median: number; mad: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const deviations = sorted.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  const mad = deviations[Math.floor(deviations.length / 2)] ?? 0;
  return { median, mad };
}

function linearRegression(xs: number[], ys: number[]): { slope: number; intercept: number; r2: number } {
  const n = xs.length;
  if (n < 2) return { slope: 0, intercept: 0, r2: 0 };
  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const slope = denX > 0 ? num / denX : 0;
  const intercept = meanY - slope * meanX;
  const r2 = denX > 0 && denY > 0 ? (num * num) / (denX * denY) : 0;
  return { slope, intercept, r2 };
}

/**
 * Onset detection via spectral flux, thresholded with a sliding median+MAD
 * (robust — a plain mean/std is skewed by the few large onsets this is
 * trying to find), with a refractory period so one strike isn't reported
 * as several. For each onset, fits a real decay slope and measures partial
 * drift — the honest way to describe "an impulsive, resonant sound" without
 * naming what caused it.
 */
export function detectAcousticEvents(analysis: SpectralAnalysis): AcousticEvent[] {
  const { frames, frameIntervalSeconds } = analysis;
  if (frames.length < ONSET_MEDIAN_WINDOW_FRAMES + 2) return [];

  const flux = frames.map((f) => f.spectralFlux ?? 0);
  const events: AcousticEvent[] = [];
  let lastOnsetIndex = -Infinity;

  // A real bug found live (not by a unit test) on 2026-08-26: a single
  // genuine strike followed by a long, smoothly decaying tail reported as
  // FIVE separate acoustic events. Root cause was the `mad || 1e-9` fallback
  // below — during a quiet, flux-homogeneous decay tail the local window's
  // MAD collapses to exactly 0, and an absolute constant unrelated to this
  // signal's own scale turns the threshold into ~6e-9, small enough that
  // ordinary floating-point residue in a monotonically decaying spectrum
  // (never exactly bit-for-bit flat) trivially "crosses" it. Flooring MAD
  // relative to this clip's OWN observed flux range — the same fix already
  // applied to estimateFundamentalHps's median-collapse bug — keeps the
  // threshold meaningful regardless of input amplitude.
  const maxFlux = flux.reduce((m, v) => Math.max(m, v), 0);
  const madFloor = maxFlux * 1e-4;

  for (let i = 1; i < frames.length; i += 1) {
    const windowStart = Math.max(0, i - ONSET_MEDIAN_WINDOW_FRAMES);
    const localWindow = flux.slice(windowStart, i);
    if (localWindow.length < 4) continue;
    const { median, mad } = medianAbsoluteDeviation(localWindow);
    const threshold = median + 6 * Math.max(mad, madFloor);
    if (flux[i] <= threshold) continue;
    if (i - lastOnsetIndex < ONSET_REFRACTORY_FRAMES) continue;
    if (frames[i].status !== "measured") continue;

    lastOnsetIndex = i;
    const onsetFrame = frames[i];

    // Decay fit: gather (time, dBFS-below-peak) samples following the onset
    // that fall within DECAY_FIT_RANGE_DB, and fit a line.
    const peakDb = onsetFrame.rmsDbfs;
    const xs: number[] = [];
    const ys: number[] = [];
    for (let j = i; j < Math.min(frames.length, i + 200); j += 1) {
      const belowPeak = peakDb - frames[j].rmsDbfs;
      if (belowPeak < -DECAY_FIT_RANGE_DB[0]) continue;
      if (belowPeak > -DECAY_FIT_RANGE_DB[1]) break;
      xs.push(frames[j].time - onsetFrame.time);
      ys.push(frames[j].rmsDbfs);
    }
    let decayToMinus60Seconds: number | null = null;
    let decayFitR2: number | null = null;
    if (xs.length >= 3) {
      const fit = linearRegression(xs, ys);
      decayFitR2 = fit.r2;
      if (fit.r2 >= DECAY_FIT_MIN_R2 && fit.slope < 0) {
        decayToMinus60Seconds = -60 / fit.slope;
      }
    }

    // Partial drift: track the dominant peak's frequency across the
    // measured frames following onset, in cents/second.
    let driftCentsPerSecond: number | null = null;
    const trackedHz: number[] = [];
    const trackedT: number[] = [];
    for (let j = i; j < Math.min(frames.length, i + 40); j += 1) {
      if (frames[j].status === "measured" && frames[j].dominant) {
        trackedHz.push(frames[j].dominant!.hz);
        trackedT.push(frames[j].time - onsetFrame.time);
      }
    }
    if (trackedHz.length >= 3) {
      const centsSeries = trackedHz.map((hz) => 1200 * Math.log2(hz / trackedHz[0]));
      const fit = linearRegression(trackedT, centsSeries);
      driftCentsPerSecond = fit.slope;
    }

    const partials = onsetFrame.dominant
      ? onsetFrame.peaks.map((p) => p.hz / onsetFrame.dominant!.hz)
      : onsetFrame.partialRatios;

    const parts: string[] = [
      `Impulsive onset at ${onsetFrame.time.toFixed(2)}s (+/-${(frameIntervalSeconds / 2 * 1000).toFixed(0)}ms)`,
    ];
    if (decayToMinus60Seconds !== null) {
      parts.push(`followed by a ${decayToMinus60Seconds.toFixed(1)}s decay (fit R^2 ${decayFitR2!.toFixed(2)})`);
    } else if (decayFitR2 !== null) {
      parts.push(`decay was not well-fit by an exponential over the measured range (R^2 ${decayFitR2.toFixed(2)})`);
    }
    if (onsetFrame.harmonicRatio !== null) {
      parts.push(
        onsetFrame.harmonicRatio > 0.6
          ? `harmonic ratio ${onsetFrame.harmonicRatio.toFixed(2)} — energy mostly on integer multiples of the fundamental`
          : `harmonic ratio ${onsetFrame.harmonicRatio.toFixed(2)} — energy mostly NOT on integer multiples of the fundamental (inharmonic)`,
      );
    }
    parts.push("what object produced it is not determinable from the spectrum alone");

    events.push({
      onsetTime: onsetFrame.time,
      onsetUncertaintySeconds: frameIntervalSeconds / 2,
      peakDbfs: onsetFrame.peakDbfs,
      decayToMinus60Seconds,
      decayFitR2,
      partialDriftCentsPerSecond: driftCentsPerSecond,
      harmonicRatio: onsetFrame.harmonicRatio,
      matchedHarmonics: onsetFrame.matchedHarmonics,
      partialRatios: partials,
      descriptor: `${parts.join(", ")}.`,
    });
  }

  return events;
}

// ─── Classifier hand-off ───────────────────────────────────────────────────

export interface SpectralFeatureSeries {
  times: Float32Array;
  /** 0=measured 1=noise-like 2=below-floor */
  status: Uint8Array;
  /** NaN where status !== measured — NaN is the deliberate sentinel: it propagates through arithmetic instead of silently reading as zero. */
  dominantHz: Float32Array;
  rmsDbfs: Float32Array;
  bandFractions: Float32Array[];
  centroidHz: Float32Array;
  flatness: Float32Array;
  harmonicRatio: Float32Array;
  fundamentalHz: Float32Array;
  spectralFlux: Float32Array;
  bands: FrequencyBand[];
  frameIntervalSeconds: number;
  effectiveResolutionHz: number;
}

const STATUS_CODE: Record<FrameStatus, number> = { measured: 0, "noise-like": 1, "below-floor": 2 };

/** Pure conversion of a full SpectralAnalysis into the typed-array shape a classifier (or any downstream consumer) can iterate without reaching into internals. */
export function toClassifierFeatures(a: SpectralAnalysis): SpectralFeatureSeries {
  const n = a.frames.length;
  const times = new Float32Array(n);
  const status = new Uint8Array(n);
  const dominantHz = new Float32Array(n);
  const rmsDbfs = new Float32Array(n);
  const bandFractions = a.bands.map(() => new Float32Array(n));
  const centroidHz = new Float32Array(n);
  const flatness = new Float32Array(n);
  const harmonicRatio = new Float32Array(n);
  const fundamentalHz = new Float32Array(n);
  const spectralFlux = new Float32Array(n);

  for (let i = 0; i < n; i += 1) {
    const f = a.frames[i];
    times[i] = f.time;
    status[i] = STATUS_CODE[f.status];
    dominantHz[i] = f.dominant ? f.dominant.hz : NaN;
    rmsDbfs[i] = Number.isFinite(f.rmsDbfs) ? f.rmsDbfs : NaN;
    for (let b = 0; b < a.bands.length; b += 1) {
      const v = f.bandFraction[b];
      bandFractions[b][i] = v === null ? NaN : v;
    }
    centroidHz[i] = f.centroidHz ?? NaN;
    flatness[i] = f.flatness ?? NaN;
    harmonicRatio[i] = f.harmonicRatio ?? NaN;
    fundamentalHz[i] = f.fundamentalHz ?? NaN;
    spectralFlux[i] = f.spectralFlux ?? NaN;
  }

  return {
    times,
    status,
    dominantHz,
    rmsDbfs,
    bandFractions,
    centroidHz,
    flatness,
    harmonicRatio,
    fundamentalHz,
    spectralFlux,
    bands: a.bands,
    frameIntervalSeconds: a.frameIntervalSeconds,
    effectiveResolutionHz: a.effectiveResolutionHz,
  };
}

// ─── Honesty surface ────────────────────────────────────────────────────

export const SPECTRAL_CANNOT_DETERMINE: string[] = [
  "What physical object produced a resonance — only its measured spectral characteristics " +
    "(partial frequencies, harmonic ratio, decay). Identifying a SPECIFIC source (e.g. which " +
    "cathedral's bell) would need a reference recording of that exact source to fingerprint " +
    "against, the same constraint this system's own pHash near-duplicate image matching " +
    "already operates under — no reference audio corpus is held.",
  "Real-world sound pressure level (SPL) — levels here are dBFS relative to digital full " +
    "scale, and the recording chain's gain is unknown, so how loud it was in the room is not " +
    "recoverable.",
  "Whether measured degradation (a decay slope, a spectral cliff) is a property of the " +
    "recorded event or an artefact of lossy re-encoding, without a known-clean reference.",
];

export interface SpectralFindingsSummary {
  findings: { label: string; detail: string; strength: "observed" }[];
  cannotDetermine: string[];
  summary: string;
}

/** Mirrors imaging.ts's assessProvenance: ordered findings + explicit cannotDetermine, never a single score. */
export function describeSpectralAnalysis(analysis: SpectralAnalysis, events: AcousticEvent[]): SpectralFindingsSummary {
  const findings: SpectralFindingsSummary["findings"] = [];

  const measuredFrames = analysis.frames.filter((f) => f.status === "measured");
  if (measuredFrames.length > 0) {
    const meanHarmonic = measuredFrames
      .filter((f) => f.harmonicRatio !== null)
      .reduce((s, f, _i, arr) => s + (f.harmonicRatio ?? 0) / arr.length, 0);
    if (measuredFrames.some((f) => f.harmonicRatio !== null)) {
      findings.push({
        label: "Tonal structure",
        detail:
          meanHarmonic > 0.6
            ? `Measured harmonic ratio averages ${meanHarmonic.toFixed(2)} across tonal frames — energy mostly falls on integer multiples of a fundamental (consistent with voice, music, or an electronic tone).`
            : `Measured harmonic ratio averages ${meanHarmonic.toFixed(2)} across tonal frames — energy mostly does NOT fall on integer multiples of a fundamental (consistent with a struck, resonant, inharmonic source such as a bell or impact).`,
        strength: "observed",
      });
    }
  }

  for (const event of events.slice(0, 10)) {
    findings.push({ label: `Acoustic event at ${event.onsetTime.toFixed(2)}s`, detail: event.descriptor, strength: "observed" });
  }

  const coveragePct = (measuredFrames.length / Math.max(1, analysis.frames.length)) * 100;
  findings.push({
    label: "Signal coverage",
    detail: `${coveragePct.toFixed(0)}% of analysed windows carried a measurable tonal signal above the silence floor; the remainder was silence or noise-like.`,
    strength: "observed",
  });

  const summary =
    events.length > 0
      ? `${events.length} acoustic event(s) detected via real onset/decay measurement. None of this identifies a specific source — see below.`
      : "No impulsive acoustic events were detected above the onset threshold in this recording.";

  return { findings, cannotDetermine: SPECTRAL_CANNOT_DETERMINE, summary };
}

// ─── Plain-language summary ────────────────────────────────────────────

export interface AnalystAudioSummary {
  /** One sentence, the first thing a non-specialist reads. */
  headline: string;
  /** A handful of short, plain-English observations — each still a direct restatement of a real measured value, never a new claim. */
  bullets: string[];
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** Standard equal-temperament Hz -> note name (A4 = 440Hz) — a fixed, real conversion, not an estimate. */
function hzToNoteName(hz: number): string {
  const midi = Math.round(69 + 12 * Math.log2(hz / 440));
  const note = NOTE_NAMES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1;
  return `${note}${octave}`;
}

/** Reuses this module's own FREQUENCY_BANDS labels rather than inventing a second frequency-range taxonomy. */
function registerLabel(hz: number): string {
  const band = FREQUENCY_BANDS.find((b) => hz >= b.minHz && hz < b.maxHz);
  return (band ?? FREQUENCY_BANDS[FREQUENCY_BANDS.length - 1]).label.toLowerCase();
}

function fmtSecPlain(s: number): string {
  return s >= 60
    ? `${Math.floor(s / 60)}:${Math.round(s % 60).toString().padStart(2, "0")}`
    : `${s.toFixed(2)}s`;
}

/**
 * Translates the same measured analysis into plain English for a reader who
 * isn't doing signal processing — every sentence here is a direct
 * restatement of a real computed value above (a note name from a real Hz
 * conversion, a real onset time, a real decay fit), never a new inference.
 * Deliberately says nothing describeSpectralAnalysis's evidentiary findings
 * don't already say more precisely — this is a friendlier front door to the
 * same facts, not a second, looser analysis.
 */
export function summariseForAnalyst(analysis: SpectralAnalysis, events: AcousticEvent[]): AnalystAudioSummary {
  const measuredFrames = analysis.frames.filter((f) => f.status === "measured");

  if (measuredFrames.length === 0) {
    return {
      headline: "No usable sound was found to analyse.",
      bullets: [
        `${analysis.durationSeconds.toFixed(1)}s of audio was checked; none of it carried a clear enough signal above the noise floor to describe.`,
      ],
    };
  }

  const headline =
    events.length === 0
      ? "This clip has no sharp, standalone sound event — whatever is there is continuous or gradual rather than a single strike or burst."
      : events.length === 1
        ? `One distinct sound event was found, at ${fmtSecPlain(events[0].onsetTime)}.`
        : `${events.length} distinct sound events were found, the first at ${fmtSecPlain(events[0].onsetTime)}.`;

  const bullets: string[] = [];

  let loudest: SpectralFrame | null = null;
  for (const f of measuredFrames) {
    if (!loudest || f.rmsDbfs > loudest.rmsDbfs) loudest = f;
  }
  if (loudest?.dominant) {
    bullets.push(
      `At its loudest moment (${fmtSecPlain(loudest.time)}), the dominant pitch is around ` +
        `${hzToNoteName(loudest.dominant.hz)} (~${loudest.dominant.hz.toFixed(0)}Hz) — a ${registerLabel(loudest.dominant.hz)} sound.`,
    );
  }

  // Prefer the detected events' own harmonic ratio over a whole-clip mean
  // when events exist: averaging in the long, quiet decay tail alongside a
  // sharp, well-defined onset can land on the opposite verdict from what
  // the per-event line below states, which reads as a direct contradiction
  // to someone reading both in plain English. The events are the specific
  // moments this summary is actually describing, so anchor to them.
  const eventRatios = events.map((e) => e.harmonicRatio).filter((r): r is number => r !== null);
  const withRatio = measuredFrames.filter((f) => f.harmonicRatio !== null);
  const meanRatio =
    eventRatios.length > 0
      ? eventRatios.reduce((s, r) => s + r, 0) / eventRatios.length
      : withRatio.length > 0
        ? withRatio.reduce((s, f) => s + (f.harmonicRatio as number), 0) / withRatio.length
        : null;
  if (meanRatio !== null) {
    bullets.push(
      meanRatio > 0.6
        ? "The sound is tonal — its energy lines up on clean multiples of a base pitch, the pattern typical of a voice, a musical note, or a steady electronic tone."
        : "The sound is not clearly tonal — its energy does NOT line up on clean multiples of a base pitch, the pattern typical of an impact, a bell-like ring, or general noise rather than a voice or musical note.",
    );
  }

  for (const event of events.slice(0, 5)) {
    const parts = [`${fmtSecPlain(event.onsetTime)} —`];
    parts.push(
      event.decayToMinus60Seconds !== null
        ? `rings for about ${event.decayToMinus60Seconds.toFixed(1)}s before fading below the noise floor`
        : "its fade-out could not be reliably measured",
    );
    if (event.harmonicRatio !== null) {
      parts.push(event.harmonicRatio > 0.6 ? "(tonal)." : "(not tonal — impact/resonance-like).");
    } else {
      parts.push(".");
    }
    bullets.push(parts.join(" "));
  }

  const coveragePct = (measuredFrames.length / Math.max(1, analysis.frames.length)) * 100;
  bullets.push(
    `Based on ${analysis.durationSeconds.toFixed(1)}s of audio (${coveragePct.toFixed(0)}% of it carried a measurable signal; the rest was quiet or noise-like).`,
  );
  bullets.push(
    "This describes the sound itself, not its source — it does not say what made the sound, who is speaking, or how loud it really was.",
  );

  return { headline, bullets };
}

// ─── Reference-fingerprint matching ────────────────────────────────────
//
// Answers "does this sound resemble one I've heard before", never "what is
// this sound" from nothing — the audio analogue of pHash near-duplicate
// image matching (findNearDuplicates in imaging.ts), which needs a
// reference corpus and cannot identify an object from first principles
// either. A high similarity score is real evidence worth an analyst's
// attention; it is not, and is never rendered as, a confirmed identity.

export interface AudioFingerprint {
  /** The reference frame's own dominant (loudest) partial, Hz — descriptive only (shown as "reference pitch" in the UI), never part of the similarity score itself, so a real pitch-shifted match to the same object isn't penalised. */
  referenceHz: number;
  /**
   * Real measured partial frequencies, each expressed as a ratio to the
   * LOWEST-frequency peak actually measured in the same frame — not the
   * loudest peak, and not an estimated fundamental. Anchoring on "loudest"
   * was tried first and found unstable: which partial ends up loudest can
   * flip between two near-identical signals at different absolute pitches
   * purely from FFT bin-alignment/leakage, which then makes physically
   * identical partial structures look unrelated. The lowest-frequency real
   * peak is a stable, well-defined anchor across a pitch shift. Anchoring
   * on HPS's estimated fundamental was also tried and rejected — the same
   * f0-instability-on-inharmonic-content already documented and fixed
   * elsewhere in this file (estimateFundamentalHps) would carry straight
   * into every fingerprint of exactly the bell-like sounds this feature
   * exists for.
   */
  partialRatios: number[];
  /** 0 = fully inharmonic, 1 = fully harmonic. Null if no fundamental could be estimated at the reference moment. */
  harmonicRatio: number | null;
  /** Real 7-band energy distribution at the reference moment — captures overall spectral "colour" independent of exact pitch. Null entries are genuinely unmeasured, never treated as zero. */
  bandFraction: (number | null)[];
}

/** Ratios to the lowest-frequency real peak — see AudioFingerprint.partialRatios for why. */
function partialRatiosFromLowestPeak(peaks: SpectralPeak[]): number[] {
  if (peaks.length === 0) return [];
  const anchorHz = Math.min(...peaks.map((p) => p.hz));
  return peaks.map((p) => p.hz / anchorHz).sort((a, b) => a - b);
}

/**
 * Extracts a fingerprint from the clip's most representative measured
 * moment: the loudest peak of the strongest detected acoustic event if one
 * exists (a well-defined onset+decay is a better reference than an
 * arbitrary instant), falling back to the single loudest measured frame
 * for a continuous tone with no discrete event. Returns null if nothing in
 * the clip was ever measured — never fabricates a fingerprint from silence
 * or noise.
 */
export function extractFingerprint(analysis: SpectralAnalysis, events: AcousticEvent[]): AudioFingerprint | null {
  if (events.length > 0) {
    const strongest = events.reduce((best, e) => (e.peakDbfs > best.peakDbfs ? e : best), events[0]);
    const frame = analysis.frames.find((f) => f.time === strongest.onsetTime && f.status === "measured");
    if (frame?.dominant) {
      return {
        referenceHz: frame.dominant.hz,
        partialRatios: partialRatiosFromLowestPeak(frame.peaks),
        harmonicRatio: strongest.harmonicRatio,
        bandFraction: frame.bandFraction,
      };
    }
  }

  let loudest: SpectralFrame | null = null;
  for (const f of analysis.frames) {
    if (f.status === "measured" && (loudest === null || f.rmsDbfs > loudest.rmsDbfs)) loudest = f;
  }
  if (!loudest?.dominant) return null;

  return {
    referenceHz: loudest.dominant.hz,
    partialRatios: partialRatiosFromLowestPeak(loudest.peaks),
    harmonicRatio: loudest.harmonicRatio,
    bandFraction: loudest.bandFraction,
  };
}

export interface FingerprintMatch {
  /** Weighted average of the available sub-scores below, 0..1. Never computed from a single component alone. */
  overallSimilarity: number;
  /** Fraction of partial ratios that found a close match in the other fingerprint (Jaccard-like — penalises both missing and spurious partials). Null if either side measured no partials. */
  partialRatioSimilarity: number | null;
  /** 1 - |difference|. Null if either side has no harmonic ratio. */
  harmonicRatioSimilarity: number | null;
  /** Cosine similarity over frequency bands both sides actually measured. Null if fewer than 3 bands are comparable — never computed from a near-empty comparison. */
  spectralShapeSimilarity: number | null;
}

const PARTIAL_RATIO_MATCH_TOLERANCE = 0.05; // 5% — matches harmonicity()'s own spirit of a real, stated tolerance, not an exact-match requirement

function partialRatioSimilarity(a: number[], b: number[]): number | null {
  if (a.length === 0 || b.length === 0) return null;
  let matched = 0;
  for (const ra of a) {
    if (b.some((rb) => Math.abs(ra - rb) / rb <= PARTIAL_RATIO_MATCH_TOLERANCE)) matched += 1;
  }
  return matched / Math.max(a.length, b.length);
}

function spectralShapeSimilarity(a: (number | null)[], b: (number | null)[]): number | null {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  let comparable = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const va = a[i];
    const vb = b[i];
    if (va === null || vb === null) continue;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
    comparable += 1;
  }
  if (comparable < 3 || normA === 0 || normB === 0) return null;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function compareFingerprints(query: AudioFingerprint, reference: AudioFingerprint): FingerprintMatch {
  const partial = partialRatioSimilarity(query.partialRatios, reference.partialRatios);
  const harmonic =
    query.harmonicRatio !== null && reference.harmonicRatio !== null
      ? 1 - Math.abs(query.harmonicRatio - reference.harmonicRatio)
      : null;
  const shape = spectralShapeSimilarity(query.bandFraction, reference.bandFraction);

  const parts = [partial, harmonic, shape].filter((v): v is number => v !== null);
  const overall = parts.length > 0 ? parts.reduce((s, v) => s + v, 0) / parts.length : 0;

  return {
    overallSimilarity: overall,
    partialRatioSimilarity: partial,
    harmonicRatioSimilarity: harmonic,
    spectralShapeSimilarity: shape,
  };
}

export const AUDIO_SPECTRAL_GAPS: Gap[] = [
  {
    capability: "Identifying a specific real-world sound source from nothing (which bell, which siren, whose voice)",
    requires:
      "A reference recording of that exact source to fingerprint-match against — extractFingerprint/compareFingerprints below now provide exactly this, the audio analogue of this system's pHash near-duplicate image matching, which needs the same kind of reference corpus.",
    limitation:
      "A spectrum alone still cannot name an object it has never heard before. Matching only works against references an analyst has actually supplied — a high similarity score is evidence worth reviewing, never a confirmed identity, and an unmatched sound is not proof it lacks one.",
  },
  {
    capability: "Real-world sound pressure level (SPL) / loudness",
    requires: "A calibrated recording chain with known microphone sensitivity and gain.",
    limitation:
      "Levels here are dBFS relative to digital full scale. The gain applied during original recording and any subsequent re-encoding is unknown, so absolute loudness is not recoverable from the file alone.",
  },
  {
    capability: "Distinguishing a genuine acoustic decay from a codec/compression artefact",
    requires: "A known-clean, uncompressed reference recording of the same event.",
    limitation:
      "Lossy audio codecs (the realistic case for redistributed/re-uploaded video) can smear transients and flatten dynamic range. A measured decay slope on such a file is a real measurement of the FILE, which may differ from the true acoustic event.",
  },
];
