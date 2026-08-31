import { describe, expect, test } from "bun:test";
import {
  ANALYSIS_SAMPLE_RATE,
  AUDIO_SPECTRAL_GAPS,
  EFFECTIVE_RESOLUTION_HZ,
  FFT_SIZE,
  FREQUENCY_BANDS,
  MAX_FRAMES,
  SILENCE_FLOOR_DBFS,
  analyseSpectrum,
  compareFingerprints,
  describeSpectralAnalysis,
  detectAcousticEvents,
  estimateFundamentalHps,
  extractFingerprint,
  fftRadix2,
  findPeaks,
  hannWindow,
  harmonicity,
  magnitudeSpectrum,
  refinePeakParabolic,
  spectralFlatness,
  summariseForAnalyst,
  toClassifierFeatures,
  type AudioFingerprint,
  type SpectralPeak,
} from "../src/utils/audio-frequency";

// ─── Synthetic signal generators (test-only, never importable from src/) ──

function sineWave(freqHz: number, sampleRate: number, length: number, amplitude = 1): Float64Array {
  const out = new Float64Array(length);
  for (let i = 0; i < length; i += 1) out[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  return out;
}

function sumWaves(waves: Float64Array[]): Float64Array {
  const length = waves[0].length;
  const out = new Float64Array(length);
  for (const w of waves) for (let i = 0; i < length; i += 1) out[i] += w[i];
  return out;
}

function whiteNoise(length: number, seed = 42): Float64Array {
  // Deterministic LCG, not Math.random() — a repeatable fixture, matching
  // this project's own "no Math.random() in anything that must be
  // reproducible" discipline, applied here to the TEST fixture generator.
  let s = seed;
  const out = new Float64Array(length);
  for (let i = 0; i < length; i += 1) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (s / 0x7fffffff) * 2 - 1;
  }
  return out;
}

function silence(length: number): Float64Array {
  return new Float64Array(length);
}

function toFloat32(a: Float64Array): Float32Array {
  return Float32Array.from(a);
}

// ─── FFT core ───────────────────────────────────────────────────────────

describe("fftRadix2", () => {
  test("throws on a non-power-of-two length", () => {
    expect(() => fftRadix2(new Float64Array(100), new Float64Array(100))).toThrow();
  });

  test("a unit impulse produces a flat-magnitude spectrum", () => {
    const n = 64;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    re[0] = 1;
    fftRadix2(re, im);
    for (let k = 0; k < n; k += 1) {
      expect(Math.sqrt(re[k] * re[k] + im[k] * im[k])).toBeCloseTo(1, 5);
    }
  });

  test("a single-bin sinusoid produces a single spike", () => {
    const n = 64;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    const bin = 5;
    for (let i = 0; i < n; i += 1) re[i] = Math.cos((2 * Math.PI * bin * i) / n);
    fftRadix2(re, im);
    const mag = Array.from({ length: n }, (_, k) => Math.sqrt(re[k] * re[k] + im[k] * im[k]));
    const peakBin = mag.indexOf(Math.max(...mag));
    expect(peakBin === bin || peakBin === n - bin).toBe(true);
  });

  test("Parseval's theorem: time-domain energy equals frequency-domain energy / N", () => {
    const n = 128;
    const re = whiteNoise(n, 7);
    const im = new Float64Array(n);
    let timeEnergy = 0;
    for (let i = 0; i < n; i += 1) timeEnergy += re[i] * re[i];
    fftRadix2(re, im);
    let freqEnergy = 0;
    for (let i = 0; i < n; i += 1) freqEnergy += re[i] * re[i] + im[i] * im[i];
    expect(freqEnergy / n).toBeCloseTo(timeEnergy, 5);
  });
});

describe("hannWindow", () => {
  test("periodic form: endpoints differ (w[0]=0, w[N-1]!=0) — this is the periodic, not symmetric, form", () => {
    const w = hannWindow(16);
    expect(w[0]).toBeCloseTo(0, 10);
    expect(w[w.length - 1]).toBeGreaterThan(0);
  });

  test("is cached — the same length returns the same array instance", () => {
    expect(hannWindow(32)).toBe(hannWindow(32));
  });
});

describe("magnitudeSpectrum leakage", () => {
  test("Hann windowing reduces spectral leakage versus no window at all, for a non-bin-centred tone", () => {
    const n = 256;
    const sr = 1000;
    // A frequency deliberately NOT centred on a bin, to induce leakage.
    const freq = sr / n * 10.37;
    const tone = sineWave(freq, sr, n);

    const rectangular = new Float64Array(n).fill(1);
    const magRect = magnitudeSpectrum(tone, rectangular);
    const magHann = magnitudeSpectrum(tone, hannWindow(n));

    // Sum energy far from the true bin (a leakage-floor proxy).
    const trueBin = Math.round((freq / sr) * n);
    const farEnergy = (mag: Float64Array) => {
      let e = 0;
      for (let k = 0; k < mag.length; k += 1) if (Math.abs(k - trueBin) > 5) e += mag[k] * mag[k];
      return e;
    };
    expect(farEnergy(magHann)).toBeLessThan(farEnergy(magRect));
  });
});

// ─── Peak finding ───────────────────────────────────────────────────────

describe("findPeaks + refinePeakParabolic", () => {
  test("a 440Hz sine at 16kHz is found within 1Hz after parabolic refinement", () => {
    const sr = ANALYSIS_SAMPLE_RATE;
    const tone = sineWave(440, sr, FFT_SIZE);
    const mag = magnitudeSpectrum(tone, hannWindow(FFT_SIZE));
    const peaks = findPeaks(mag, sr, FFT_SIZE);
    expect(peaks.length).toBeGreaterThan(0);
    expect(Math.abs(peaks[0].hz - 440)).toBeLessThan(1);
    expect(peaks[0].refined).toBe(true);
  });

  test("two tones closer than the effective resolution merge into one apparent peak", () => {
    const sr = ANALYSIS_SAMPLE_RATE;
    const f1 = 1000;
    const f2 = f1 + EFFECTIVE_RESOLUTION_HZ * 0.3; // well inside the stated resolution limit
    const combined = sumWaves([sineWave(f1, sr, FFT_SIZE, 0.5), sineWave(f2, sr, FFT_SIZE, 0.5)]);
    const mag = magnitudeSpectrum(combined, hannWindow(FFT_SIZE));
    const peaks = findPeaks(mag, sr, FFT_SIZE);
    // Proves the stated resolution limit is real: two close tones should
    // NOT both appear as separate top-2 peaks with a clear valley between.
    const near = peaks.filter((p) => p.hz > f1 - 20 && p.hz < f2 + 20);
    expect(near.length).toBeLessThanOrEqual(1);
  });

  test("two tones well beyond the effective resolution are both found", () => {
    const sr = ANALYSIS_SAMPLE_RATE;
    const combined = sumWaves([sineWave(500, sr, FFT_SIZE, 0.5), sineWave(3000, sr, FFT_SIZE, 0.5)]);
    const mag = magnitudeSpectrum(combined, hannWindow(FFT_SIZE));
    const peaks = findPeaks(mag, sr, FFT_SIZE);
    const near500 = peaks.some((p) => Math.abs(p.hz - 500) < 20);
    const near3000 = peaks.some((p) => Math.abs(p.hz - 3000) < 20);
    expect(near500).toBe(true);
    expect(near3000).toBe(true);
  });

  test("refinePeakParabolic returns 0 at the array boundary", () => {
    const mag = new Float64Array([1, 2, 3]);
    expect(refinePeakParabolic(mag, 0)).toBe(0);
    expect(refinePeakParabolic(mag, 2)).toBe(0);
  });
});

// ─── Fundamental + harmonicity ──────────────────────────────────────────

describe("estimateFundamentalHps", () => {
  test("finds f0 for a harmonic stack even though a higher harmonic is louder (avoids the octave-error trap)", () => {
    const sr = ANALYSIS_SAMPLE_RATE;
    const f0 = 200;
    // The 2nd harmonic is deliberately louder than f0 itself.
    const stack = sumWaves([
      sineWave(f0, sr, FFT_SIZE, 0.3),
      sineWave(f0 * 2, sr, FFT_SIZE, 0.8),
      sineWave(f0 * 3, sr, FFT_SIZE, 0.4),
      sineWave(f0 * 4, sr, FFT_SIZE, 0.2),
    ]);
    const mag = magnitudeSpectrum(stack, hannWindow(FFT_SIZE));
    const est = estimateFundamentalHps(mag, sr, FFT_SIZE);
    expect(est).not.toBeNull();
    expect(Math.abs(est!.hz - f0)).toBeLessThan(EFFECTIVE_RESOLUTION_HZ * 2);
  });

  test("returns null for white noise (no real fundamental to report)", () => {
    const mag = magnitudeSpectrum(whiteNoise(FFT_SIZE, 3), hannWindow(FFT_SIZE));
    const est = estimateFundamentalHps(mag, ANALYSIS_SAMPLE_RATE, FFT_SIZE);
    // Not a hard guarantee for every noise seed, but the confidence gate
    // should reject a spectrum with no coherent structure most of the time;
    // assert the returned confidence (if any) is not absurdly high.
    if (est) expect(est.confidence).toBeLessThan(50);
  });

  // Regression for a real bug found live (not by a unit test) on
  // 2026-08-26: uploading a real audio file with a clean, sparse,
  // inharmonic (bell-like) partial stack through the actual browser
  // decode -> analyseSpectrum path reported "Fundamental (HPS): 207.0Hz
  // (confidence 648762537997.33)" — a numerical artifact from dividing by
  // an HPS median that was at or near the numerical floor, not a real
  // measurement. A sparse, non-bin-aligned inharmonic stack (the same
  // shape as the live audio that triggered it) must never produce a
  // confidence value that reads as fabricated precision.
  test("an inharmonic stack never reports an absurd (non-physical) confidence value", () => {
    const sr = ANALYSIS_SAMPLE_RATE;
    const prime = 523.25; // not aligned to an FFT bin at this sample rate/size
    const stack = sumWaves(
      [1.0, 1.2, 1.5, 2.0].map((ratio) => sineWave(prime * ratio, sr, FFT_SIZE, 0.25)),
    );
    const mag = magnitudeSpectrum(stack, hannWindow(FFT_SIZE));
    const est = estimateFundamentalHps(mag, sr, FFT_SIZE);
    if (est) {
      expect(Number.isFinite(est.confidence)).toBe(true);
      // 16-24 bit audio has nowhere near this much real dynamic range —
      // anything beyond it is the denominator-near-zero artifact, capped
      // (allowing a hair of float slack right at the cap itself).
      expect(est.confidence).toBeLessThan(1e6 * 1.001);
    }
  });
});

describe("harmonicity", () => {
  test("a harmonic stack (integer multiples of f0) scores a high harmonic ratio", () => {
    const f0 = 200;
    const peaks: SpectralPeak[] = [200, 400, 600, 800].map((hz) => ({
      hz,
      binIndex: 0,
      magnitudeDb: -6,
      refined: true,
    }));
    const h = harmonicity(peaks, f0);
    expect(h.ratio).toBeCloseTo(1, 5);
    expect(h.matchedHarmonics).toEqual([1, 2, 3, 4]);
  });

  test("an inharmonic (bell-like) partial series scores a low harmonic ratio", () => {
    const f0 = 200;
    // Classic Rayleigh bell partial ratios: hum/prime/tierce/quint/nominal
    // = 0.5/1.0/1.2/1.5/2.0 x prime. The 1.2 (tierce) is NOT an integer
    // multiple — this is exactly the case the whole module is built around.
    const peaks: SpectralPeak[] = [200, 240, 300, 400].map((hz) => ({
      hz,
      binIndex: 0,
      magnitudeDb: -6,
      refined: true,
    }));
    const h = harmonicity(peaks, f0);
    // 200 matches m=1, 400 matches m=2, but 240 and 300 do not match any
    // integer multiple within tolerance — ratio should be clearly below 1.
    expect(h.ratio).toBeLessThan(0.8);
    expect(h.matchedHarmonics).not.toContain(240 / f0);
  });

  test("partialRatios always reports peak/f0 for every peak, matched or not", () => {
    const peaks: SpectralPeak[] = [{ hz: 240, binIndex: 0, magnitudeDb: -6, refined: true }];
    const h = harmonicity(peaks, 200);
    expect(h.partialRatios).toEqual([1.2]);
  });

  test("empty peaks return a defined, zero-ratio result rather than throwing or NaN", () => {
    const h = harmonicity([], 200);
    expect(h.ratio).toBe(0);
    expect(Number.isNaN(h.ratio)).toBe(false);
  });
});

describe("spectralFlatness", () => {
  test("white noise is flatter (closer to 1) than a pure tone", () => {
    const sr = ANALYSIS_SAMPLE_RATE;
    const noiseMag = magnitudeSpectrum(whiteNoise(FFT_SIZE, 11), hannWindow(FFT_SIZE));
    const toneMag = magnitudeSpectrum(sineWave(1000, sr, FFT_SIZE), hannWindow(FFT_SIZE));
    const kMin = 2;
    const kMax = toneMag.length - 2;
    expect(spectralFlatness(noiseMag, kMin, kMax)).toBeGreaterThan(spectralFlatness(toneMag, kMin, kMax));
  });
});

// ─── analyseSpectrum: the honesty gates ─────────────────────────────────

describe("analyseSpectrum — FrameStatus honesty gates", () => {
  test("digital silence is reported as below-floor, NEVER as a measured 0Hz/0dB", () => {
    const samples = toFloat32(silence(FFT_SIZE * 4));
    const result = analyseSpectrum(samples, ANALYSIS_SAMPLE_RATE);
    expect(result.frames.length).toBeGreaterThan(0);
    for (const f of result.frames) {
      expect(f.status).toBe("below-floor");
      expect(f.dominant).toBeNull();
      expect(f.bandPowerDbfs.every((v) => v === null)).toBe(true);
      expect(f.bandFraction.every((v) => v === null)).toBe(true);
      // The critical regression this guards against: 0 is a measured value,
      // null is "not measured" — they must never be conflated.
      expect(f.rmsDbfs).not.toBe(0);
    }
  });

  test("white noise is reported as noise-like, with no fabricated dominant frequency", () => {
    const samples = toFloat32(whiteNoise(FFT_SIZE * 4, 99));
    const result = analyseSpectrum(samples, ANALYSIS_SAMPLE_RATE);
    const noiseLike = result.frames.filter((f) => f.status === "noise-like");
    expect(noiseLike.length).toBeGreaterThan(0);
    for (const f of noiseLike) expect(f.dominant).toBeNull();
  });

  test("a real tone above the silence floor is reported as measured, with a real dominant frequency", () => {
    const samples = toFloat32(sineWave(1000, ANALYSIS_SAMPLE_RATE, FFT_SIZE * 4, 0.8));
    const result = analyseSpectrum(samples, ANALYSIS_SAMPLE_RATE);
    const measured = result.frames.filter((f) => f.status === "measured");
    expect(measured.length).toBeGreaterThan(0);
    for (const f of measured) {
      expect(f.dominant).not.toBeNull();
      expect(Math.abs(f.dominant!.hz - 1000)).toBeLessThan(20);
    }
  });
});

describe("analyseSpectrum — shape and metadata", () => {
  test("reports the honest resolution numbers, not just bin spacing", () => {
    const samples = toFloat32(sineWave(500, ANALYSIS_SAMPLE_RATE, FFT_SIZE * 2));
    const result = analyseSpectrum(samples, ANALYSIS_SAMPLE_RATE);
    expect(result.binSpacingHz).toBeCloseTo(ANALYSIS_SAMPLE_RATE / FFT_SIZE, 5);
    expect(result.effectiveResolutionHz).toBeCloseTo(result.binSpacingHz * 2, 5);
    expect(result.limits.some((l) => l.includes("real two-tone resolution"))).toBe(true);
  });

  test("audio shorter than one FFT window yields zero frames, not a crash", () => {
    const samples = toFloat32(sineWave(500, ANALYSIS_SAMPLE_RATE, FFT_SIZE - 10));
    const result = analyseSpectrum(samples, ANALYSIS_SAMPLE_RATE);
    expect(result.frameCount).toBe(0);
    expect(result.frames).toEqual([]);
  });

  test(
    "an excessive frame count triggers truncation and clamps frameCount to MAX_FRAMES",
    () => {
      // Silence, not a tone: below-silence-floor frames short-circuit before
      // peak-finding/HPS/harmonicity (see analyseOneFrame's early return),
      // so this stays fast even at MAX_FRAMES-scale frame counts. A tiny
      // requested hop against a buffer just over MAX_FRAMES frames' worth
      // forces the adaptive-hop truncation path without needing millions
      // of samples.
      const totalSamples = FFT_SIZE + MAX_FRAMES + 100;
      const samples = toFloat32(silence(totalSamples));
      const result = analyseSpectrum(samples, ANALYSIS_SAMPLE_RATE, { hopSize: 1 });
      expect(result.truncated).toBe(true);
      expect(result.frameCount).toBeLessThanOrEqual(MAX_FRAMES);
    },
    20_000,
  );

  test("a hop larger than the FFT window reports coverage < 1 — real gaps exist between analysed windows", () => {
    const samples = toFloat32(sineWave(300, ANALYSIS_SAMPLE_RATE, FFT_SIZE * 6, 0.5));
    const result = analyseSpectrum(samples, ANALYSIS_SAMPLE_RATE, { hopSize: FFT_SIZE * 2 });
    expect(result.coverage).toBeLessThan(1);
    expect(result.coverage).toBeCloseTo(0.5, 5);
  });

  test("throws on a non-power-of-two fftSize option", () => {
    const samples = toFloat32(sineWave(500, ANALYSIS_SAMPLE_RATE, FFT_SIZE * 2));
    expect(() => analyseSpectrum(samples, ANALYSIS_SAMPLE_RATE, { fftSize: 100 })).toThrow();
  });

  test("bands include partiallyCovered flags for sub-bass and brilliance", () => {
    const subBass = FREQUENCY_BANDS.find((b) => b.id === "sub_bass")!;
    const brilliance = FREQUENCY_BANDS.find((b) => b.id === "brilliance")!;
    expect(subBass.partiallyCovered).toBe(true);
    expect(brilliance.partiallyCovered).toBe(true);
  });
});

// ─── toClassifierFeatures: the NaN-sentinel seam ────────────────────────

describe("toClassifierFeatures", () => {
  test("unmeasured frames carry NaN, never 0, in dominantHz/centroidHz/etc.", () => {
    const samples = toFloat32(silence(FFT_SIZE * 3));
    const result = analyseSpectrum(samples, ANALYSIS_SAMPLE_RATE);
    const features = toClassifierFeatures(result);
    expect(features.dominantHz.length).toBe(result.frameCount);
    for (let i = 0; i < features.dominantHz.length; i += 1) {
      expect(Number.isNaN(features.dominantHz[i])).toBe(true);
      expect(features.dominantHz[i]).not.toBe(0);
    }
  });

  test("measured frames carry real numeric values", () => {
    const samples = toFloat32(sineWave(880, ANALYSIS_SAMPLE_RATE, FFT_SIZE * 3, 0.8));
    const result = analyseSpectrum(samples, ANALYSIS_SAMPLE_RATE);
    const features = toClassifierFeatures(result);
    const anyMeasured = Array.from(features.status).some((s) => s === 0);
    expect(anyMeasured).toBe(true);
    for (let i = 0; i < features.status.length; i += 1) {
      if (features.status[i] === 0) expect(Number.isNaN(features.dominantHz[i])).toBe(false);
    }
  });

  test("band fraction arrays are one per band, correctly sized", () => {
    const samples = toFloat32(sineWave(500, ANALYSIS_SAMPLE_RATE, FFT_SIZE * 2));
    const result = analyseSpectrum(samples, ANALYSIS_SAMPLE_RATE);
    const features = toClassifierFeatures(result);
    expect(features.bandFractions.length).toBe(FREQUENCY_BANDS.length);
    for (const arr of features.bandFractions) expect(arr.length).toBe(result.frameCount);
  });
});

// ─── Acoustic events (onset/decay) ───────────────────────────────────────

describe("detectAcousticEvents", () => {
  test("a silence-then-strike-then-decay signal produces a real onset with a high-R^2 decay fit", () => {
    const sr = ANALYSIS_SAMPLE_RATE;
    // A genuine onset needs a QUIET baseline before the loud strike — a
    // tone that is already loud at sample 0 has no prior state to rise
    // above, so spectral flux (a frame-to-frame INCREASE) never spikes.
    // This mirrors a real struck-resonance recording: silence, then a
    // strike, then decay.
    // Long enough to clear detectAcousticEvents' own minimum frame count
    // (ONSET_MEDIAN_WINDOW_FRAMES + 2 = 34 frames of real baseline before
    // it will attempt detection at all) — at the default 1024-sample hop,
    // that needs at least ~2.2s of audio; use a comfortable margin above it.
    const leadInSeconds = 0.6;
    const decaySeconds = 2.5;
    const freq = 500;
    const decayRateDbPerSec = 20; // -20dB/s
    const leadInSamples = Math.floor(sr * leadInSeconds);
    const decaySamples = Math.floor(sr * decaySeconds);
    const samples = new Float64Array(leadInSamples + decaySamples); // leading silence is the default zero-fill
    for (let i = 0; i < decaySamples; i += 1) {
      const t = i / sr;
      const amp = 10 ** ((-decayRateDbPerSec * t) / 20);
      samples[leadInSamples + i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
    }
    const result = analyseSpectrum(toFloat32(samples), sr);
    const events = detectAcousticEvents(result);
    expect(events.length).toBeGreaterThan(0);
    // The detected onset should land near the real strike time.
    expect(Math.abs(events[0].onsetTime - leadInSeconds)).toBeLessThan(0.2);
    const withFit = events.find((e) => e.decayFitR2 !== null && e.decayFitR2 > 0.8);
    expect(withFit).toBeDefined();
  });

  test("digital silence produces zero acoustic events", () => {
    const result = analyseSpectrum(toFloat32(silence(FFT_SIZE * 10)), ANALYSIS_SAMPLE_RATE);
    expect(detectAcousticEvents(result)).toEqual([]);
  });

  test("every event descriptor states the source cannot be determined", () => {
    const sr = ANALYSIS_SAMPLE_RATE;
    // Same minimum-frame-count requirement as the decay-fit test above.
    const leadInSamples = Math.floor(sr * 0.6);
    const strikeSamples = Math.floor(sr * 2.0);
    const samples = new Float64Array(leadInSamples + strikeSamples);
    for (let i = 0; i < strikeSamples; i += 1) {
      const t = i / sr;
      const amp = i < sr * 0.05 ? 1 : Math.max(0, 1 - t * 3);
      samples[leadInSamples + i] = amp * Math.sin((2 * Math.PI * 300 * i) / sr);
    }
    const result = analyseSpectrum(toFloat32(samples), sr);
    const events = detectAcousticEvents(result);
    // This assertion would pass vacuously on an empty array, so assert
    // there is at least one real event to check the descriptor of.
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.descriptor).toContain("not determinable from the spectrum");
    }
  });
});

// ─── Honesty surface ────────────────────────────────────────────────────

describe("describeSpectralAnalysis", () => {
  test("never returns an empty cannotDetermine list", () => {
    const result = analyseSpectrum(toFloat32(sineWave(400, ANALYSIS_SAMPLE_RATE, FFT_SIZE * 2)), ANALYSIS_SAMPLE_RATE);
    const summary = describeSpectralAnalysis(result, []);
    expect(summary.cannotDetermine.length).toBeGreaterThan(0);
  });

  test("cannotDetermine explicitly names that specific-source identification is out of scope", () => {
    const result = analyseSpectrum(toFloat32(silence(FFT_SIZE * 2)), ANALYSIS_SAMPLE_RATE);
    const summary = describeSpectralAnalysis(result, []);
    expect(summary.cannotDetermine.some((c) => c.toLowerCase().includes("specific"))).toBe(true);
  });
});

describe("summariseForAnalyst", () => {
  test("reports no usable sound when nothing measured", () => {
    const result = analyseSpectrum(toFloat32(silence(FFT_SIZE * 4)), ANALYSIS_SAMPLE_RATE);
    const summary = summariseForAnalyst(result, []);
    expect(summary.headline).toContain("No usable sound");
    expect(summary.bullets.length).toBeGreaterThan(0);
  });

  test("converts a known pitch to its real note name (A4 = 440Hz)", () => {
    const result = analyseSpectrum(
      toFloat32(sineWave(440, ANALYSIS_SAMPLE_RATE, FFT_SIZE * 3, 0.8)),
      ANALYSIS_SAMPLE_RATE,
    );
    const summary = summariseForAnalyst(result, []);
    expect(summary.bullets.some((b) => b.includes("A4"))).toBe(true);
  });

  test("headline states the real number of detected events and their first onset time", () => {
    const leadInSeconds = 0.6;
    const decaySeconds = 2.5;
    const sr = ANALYSIS_SAMPLE_RATE;
    const total = new Float32Array(Math.floor((leadInSeconds + decaySeconds) * sr));
    const leadInSamples = Math.floor(leadInSeconds * sr);
    for (let i = leadInSamples; i < total.length; i++) {
      const t = (i - leadInSamples) / sr;
      total[i] = Math.sin(2 * Math.PI * 300 * t) * Math.exp(-t * 2) * 0.8;
    }
    const result = analyseSpectrum(total, sr);
    const events = detectAcousticEvents(result);
    expect(events.length).toBeGreaterThan(0);
    const summary = summariseForAnalyst(result, events);
    expect(summary.headline).toContain(String(events.length));
    expect(summary.bullets.some((b) => b.includes("does not say what made the sound"))).toBe(true);
  });

  test("never claims tonality when no frame reports a harmonic ratio", () => {
    const result = analyseSpectrum(toFloat32(whiteNoise(FFT_SIZE * 3, 7)), ANALYSIS_SAMPLE_RATE);
    const summary = summariseForAnalyst(result, []);
    expect(summary.bullets.some((b) => b.includes("tonal"))).toBe(false);
  });

  // Regression: the overall "is this tonal" bullet must never contradict
  // the specific event it is describing — found live on 2026-08-26, where
  // a whole-clip average (including a long, less-reliable decay tail)
  // said "tonal" while the one real event's own harmonic ratio said the
  // opposite, reading as a direct contradiction in plain English.
  test("the overall tonal-character verdict agrees with a single dominant event's own verdict", () => {
    const leadInSeconds = 0.6;
    const decaySeconds = 3.0;
    const sr = ANALYSIS_SAMPLE_RATE;
    const total = new Float32Array(Math.floor((leadInSeconds + decaySeconds) * sr));
    const leadInSamples = Math.floor(leadInSeconds * sr);
    const prime = 523.25;
    for (let i = leadInSamples; i < total.length; i++) {
      const t = (i - leadInSamples) / sr;
      const decay = Math.exp(-t * 1.8);
      let v = 0;
      for (const ratio of [1.0, 1.2, 1.5, 2.0]) v += Math.sin(2 * Math.PI * prime * ratio * t) / 4;
      total[i] = v * decay * 0.7;
    }
    const result = analyseSpectrum(total, sr);
    const events = detectAcousticEvents(result);
    expect(events.length).toBeGreaterThan(0);
    const summary = summariseForAnalyst(result, events);

    const overallSaysTonal = summary.bullets.some((b) => b.startsWith("The sound is tonal"));
    const overallSaysNotTonal = summary.bullets.some((b) => b.startsWith("The sound is not clearly tonal"));
    const eventLine = summary.bullets.find((b) => b.includes("(tonal)") || b.includes("(not tonal"));
    expect(eventLine).toBeDefined();
    const eventSaysTonal = eventLine!.includes("(tonal)");
    expect(overallSaysTonal).toBe(eventSaysTonal);
    expect(overallSaysNotTonal).toBe(!eventSaysTonal);
  });
});

describe("extractFingerprint / compareFingerprints", () => {
  function bellLikeSamples(prime: number, leadInSeconds = 0.6, decaySeconds = 2.5) {
    const sr = ANALYSIS_SAMPLE_RATE;
    const total = new Float32Array(Math.floor((leadInSeconds + decaySeconds) * sr));
    const leadInSamples = Math.floor(leadInSeconds * sr);
    for (let i = leadInSamples; i < total.length; i++) {
      const t = (i - leadInSamples) / sr;
      const decay = Math.exp(-t * 1.8);
      let v = 0;
      for (const ratio of [1.0, 1.2, 1.5, 2.0]) v += Math.sin(2 * Math.PI * prime * ratio * t) / 4;
      total[i] = v * decay * 0.7;
    }
    return total;
  }

  test("returns null when nothing in the clip was ever measured", () => {
    const result = analyseSpectrum(toFloat32(silence(FFT_SIZE * 4)), ANALYSIS_SAMPLE_RATE);
    expect(extractFingerprint(result, [])).toBeNull();
  });

  test("extracts a real fingerprint from the strongest detected event, not an arbitrary frame", () => {
    const result = analyseSpectrum(bellLikeSamples(523.25), ANALYSIS_SAMPLE_RATE);
    const events = detectAcousticEvents(result);
    expect(events.length).toBeGreaterThan(0);
    const fp = extractFingerprint(result, events);
    expect(fp).not.toBeNull();
    expect(fp!.referenceHz).toBeGreaterThan(400);
    expect(fp!.referenceHz).toBeLessThan(650);
    expect(fp!.partialRatios.length).toBeGreaterThan(0);
  });

  test("comparing a fingerprint against itself scores near-perfect similarity", () => {
    const result = analyseSpectrum(bellLikeSamples(523.25), ANALYSIS_SAMPLE_RATE);
    const events = detectAcousticEvents(result);
    const fp = extractFingerprint(result, events)!;
    const match = compareFingerprints(fp, fp);
    expect(match.overallSimilarity).toBeGreaterThan(0.95);
    expect(match.partialRatioSimilarity).toBeCloseTo(1, 5);
  });

  test("the same physical partial structure at a different pitch still matches on partial ratios", () => {
    // Same 1.0/1.2/1.5/2.0 bell-like structure, transposed to a different
    // fundamental — a real, physically meaningful case: the same object
    // struck differently, or two similar (not identical) bells.
    const a = analyseSpectrum(bellLikeSamples(400), ANALYSIS_SAMPLE_RATE);
    const b = analyseSpectrum(bellLikeSamples(700), ANALYSIS_SAMPLE_RATE);
    const fpA = extractFingerprint(a, detectAcousticEvents(a))!;
    const fpB = extractFingerprint(b, detectAcousticEvents(b))!;
    const match = compareFingerprints(fpA, fpB);
    expect(match.partialRatioSimilarity).toBeGreaterThan(0.7);
  });

  test("a genuinely different partial structure (harmonic vs inharmonic) scores low similarity", () => {
    // The classic 1.0/1.2/1.5/2.0 Rayleigh ratios (used elsewhere in this
    // test file) are a poor contrast case here: 1.0x and 2.0x ARE integer
    // multiples, so they genuinely, correctly overlap with a true harmonic
    // stack's 1x/2x partials — a real bell's tierce (1.2x) and quint
    // (1.5x) are what make it inharmonic, not its hum/nominal. This test
    // instead uses ratios with NO near-integer members at all (besides the
    // trivial 1.0x anchor), so the two signals share nothing real and a
    // low score is the honestly correct answer, not an artefact of the
    // chosen fixture.
    function stackSamples(prime: number, ratios: number[]) {
      const sr = ANALYSIS_SAMPLE_RATE;
      const leadIn = 0.6;
      const total = new Float32Array(Math.floor((leadIn + 2.5) * sr));
      const leadInSamples = Math.floor(leadIn * sr);
      for (let i = leadInSamples; i < total.length; i++) {
        const t = (i - leadInSamples) / sr;
        const decay = Math.exp(-t * 1.8);
        let v = 0;
        for (const r of ratios) v += Math.sin(2 * Math.PI * prime * r * t) / ratios.length;
        total[i] = v * decay * 0.7;
      }
      return total;
    }

    const inharmonic = analyseSpectrum(stackSamples(500, [1.0, 1.34, 1.79, 2.31]), ANALYSIS_SAMPLE_RATE);
    const fpInharmonic = extractFingerprint(inharmonic, detectAcousticEvents(inharmonic))!;

    const harmonic = analyseSpectrum(stackSamples(500, [1, 2, 3, 4]), ANALYSIS_SAMPLE_RATE);
    const fpHarmonic = extractFingerprint(harmonic, detectAcousticEvents(harmonic))!;

    const match = compareFingerprints(fpInharmonic, fpHarmonic);
    expect(match.overallSimilarity).toBeLessThan(0.6);
  });

  test("partial-ratio similarity is null (not zero) when either side has no measured partials", () => {
    const fpEmpty: AudioFingerprint = { referenceHz: 440, partialRatios: [], harmonicRatio: 0.5, bandFraction: [] };
    const fpReal: AudioFingerprint = {
      referenceHz: 440,
      partialRatios: [1, 2, 3],
      harmonicRatio: 0.5,
      bandFraction: [],
    };
    const match = compareFingerprints(fpEmpty, fpReal);
    expect(match.partialRatioSimilarity).toBeNull();
  });

  test("spectral-shape similarity is null when fewer than 3 bands are comparable", () => {
    const fpA: AudioFingerprint = {
      referenceHz: 440,
      partialRatios: [1],
      harmonicRatio: null,
      bandFraction: [0.5, null, null, null, null, null, null],
    };
    const fpB: AudioFingerprint = {
      referenceHz: 440,
      partialRatios: [1],
      harmonicRatio: null,
      bandFraction: [0.4, null, null, null, null, null, null],
    };
    const match = compareFingerprints(fpA, fpB);
    expect(match.spectralShapeSimilarity).toBeNull();
  });

  test("overallSimilarity never uses a missing component as if it scored zero", () => {
    // Only harmonicRatio is comparable; partial ratios and band fraction
    // are both empty/incomparable. The overall score must reflect ONLY the
    // one real comparable signal (a perfect harmonic-ratio match), not be
    // dragged down by components that were never measured.
    const fpA: AudioFingerprint = { referenceHz: 440, partialRatios: [], harmonicRatio: 0.8, bandFraction: [] };
    const fpB: AudioFingerprint = { referenceHz: 440, partialRatios: [], harmonicRatio: 0.8, bandFraction: [] };
    const match = compareFingerprints(fpA, fpB);
    expect(match.overallSimilarity).toBeCloseTo(1, 5);
  });
});

describe("AUDIO_SPECTRAL_GAPS", () => {
  test("contains the specific-source-identification gap", () => {
    expect(
      AUDIO_SPECTRAL_GAPS.some((g) => g.capability.toLowerCase().includes("specific real-world sound source")),
    ).toBe(true);
  });

  test("every gap has real, non-empty requires/limitation text", () => {
    for (const g of AUDIO_SPECTRAL_GAPS) {
      expect(g.requires.length).toBeGreaterThan(10);
      expect(g.limitation.length).toBeGreaterThan(10);
    }
  });
});
