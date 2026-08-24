import { describe, expect, test } from "bun:test";
import { encodeWavPcm16 } from "../src/utils/audio-extract-client";

// extractAudioAsWav itself needs AudioContext/OfflineAudioContext, which do
// not exist outside a real browser — matches this repo's existing
// convention of not unit-testing DOM-dependent code (imaging-client.ts has
// no test file for the same reason). encodeWavPcm16 is the pure half.

async function parseWav(blob: Blob) {
  const buf = await blob.arrayBuffer();
  const view = new DataView(buf);
  const readStr = (offset: number, len: number) =>
    String.fromCharCode(...new Uint8Array(buf, offset, len));
  return {
    riff: readStr(0, 4),
    wave: readStr(8, 4),
    fmt: readStr(12, 4),
    audioFormat: view.getUint16(20, true),
    numChannels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    bitsPerSample: view.getUint16(34, true),
    dataTag: readStr(36, 4),
    dataSize: view.getUint32(40, true),
    samples: (() => {
      const n = view.getUint32(40, true) / 2;
      const out = new Int16Array(n);
      for (let i = 0; i < n; i++) out[i] = view.getInt16(44 + i * 2, true);
      return out;
    })(),
  };
}

describe("encodeWavPcm16", () => {
  test("produces a well-formed 16-bit mono PCM WAV header", async () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const blob = encodeWavPcm16(samples, 16000);
    expect(blob.type).toBe("audio/wav");

    const wav = await parseWav(blob);
    expect(wav.riff).toBe("RIFF");
    expect(wav.wave).toBe("WAVE");
    expect(wav.fmt).toBe("fmt ");
    expect(wav.audioFormat).toBe(1); // PCM
    expect(wav.numChannels).toBe(1);
    expect(wav.sampleRate).toBe(16000);
    expect(wav.bitsPerSample).toBe(16);
    expect(wav.dataTag).toBe("data");
    expect(wav.dataSize).toBe(samples.length * 2);
  });

  test("round-trips sample values correctly, including clamping at the extremes", async () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1, 1.5, -1.5]);
    const blob = encodeWavPcm16(samples, 16000);
    const wav = await parseWav(blob);
    expect(wav.samples[0]).toBe(0);
    expect(wav.samples[3]).toBe(0x7fff); // +1 clamps to max positive
    expect(wav.samples[4]).toBe(-0x8000); // -1 hits max negative
    expect(wav.samples[5]).toBe(0x7fff); // 1.5 clamps the same as 1
    expect(wav.samples[6]).toBe(-0x8000); // -1.5 clamps the same as -1
  });

  test("an empty sample array produces a valid, empty-data WAV", async () => {
    const blob = encodeWavPcm16(new Float32Array([]), 16000);
    const wav = await parseWav(blob);
    expect(wav.dataSize).toBe(0);
    expect(wav.samples.length).toBe(0);
  });

  test("the file size matches 44-byte header plus 2 bytes per sample", () => {
    const samples = new Float32Array(1000).fill(0);
    const blob = encodeWavPcm16(samples, 16000);
    expect(blob.size).toBe(44 + 1000 * 2);
  });
});
