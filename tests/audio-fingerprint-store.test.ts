import { describe, expect, test } from "bun:test";
import {
  parseAudioReferences,
  saveAudioReference,
  deleteAudioReference,
  type StoredAudioReference,
} from "../src/utils/audio-fingerprint-store";
import type { AudioFingerprint } from "../src/utils/audio-frequency";

function makeFingerprint(overrides: Partial<AudioFingerprint> = {}): AudioFingerprint {
  return {
    referenceHz: 523.25,
    partialRatios: [1, 1.2, 1.5, 2.0],
    harmonicRatio: 0.5,
    bandFraction: [0, 0, 0, 1, 0, 0, 0],
    ...overrides,
  };
}

describe("parseAudioReferences", () => {
  test("accepts a well-formed list", () => {
    const raw = [
      { id: "a", name: "Big Ben", fingerprint: makeFingerprint(), savedAt: "2026-08-26T00:00:00.000Z", sourceLabel: "bigben.mp4" },
    ];
    const parsed = parseAudioReferences(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("Big Ben");
  });

  test("rejects a non-array wholesale", () => {
    expect(parseAudioReferences({ not: "an array" })).toEqual([]);
    expect(parseAudioReferences(null)).toEqual([]);
    expect(parseAudioReferences("garbage")).toEqual([]);
  });

  test("drops individual malformed entries without discarding the rest of the corpus", () => {
    const raw = [
      { id: "a", name: "Real one", fingerprint: makeFingerprint(), savedAt: "2026-08-26T00:00:00.000Z", sourceLabel: "" },
      { id: "b", name: "", fingerprint: makeFingerprint(), savedAt: "2026-08-26T00:00:00.000Z", sourceLabel: "" }, // empty name
      { id: "c", name: "Missing fingerprint", savedAt: "2026-08-26T00:00:00.000Z", sourceLabel: "" }, // no fingerprint
      { id: "d", name: "Bad fingerprint shape", fingerprint: { referenceHz: "not a number" }, savedAt: "x", sourceLabel: "" },
      "not even an object",
    ];
    const parsed = parseAudioReferences(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("Real one");
  });

  test("a fingerprint with null harmonicRatio is valid, not a rejection reason", () => {
    const raw = [
      {
        id: "a",
        name: "No harmonic ratio measured",
        fingerprint: makeFingerprint({ harmonicRatio: null }),
        savedAt: "2026-08-26T00:00:00.000Z",
        sourceLabel: "",
      },
    ];
    expect(parseAudioReferences(raw)).toHaveLength(1);
  });
});

describe("saveAudioReference / deleteAudioReference", () => {
  test("save prepends a new entry with a real, non-empty id", () => {
    const saved = saveAudioReference([], { name: "Test", fingerprint: makeFingerprint(), sourceLabel: "x.mp4" }, "2026-08-26T00:00:00.000Z");
    expect(saved).toHaveLength(1);
    expect(saved[0].id.length).toBeGreaterThan(0);
    expect(saved[0].savedAt).toBe("2026-08-26T00:00:00.000Z");
  });

  test("two saves never produce colliding ids, even back to back", () => {
    let list: StoredAudioReference[] = [];
    list = saveAudioReference(list, { name: "One", fingerprint: makeFingerprint(), sourceLabel: "" }, "2026-08-26T00:00:00.000Z");
    list = saveAudioReference(list, { name: "Two", fingerprint: makeFingerprint(), sourceLabel: "" }, "2026-08-26T00:00:01.000Z");
    expect(list).toHaveLength(2);
    expect(list[0].id).not.toBe(list[1].id);
  });

  test("delete then save never reuses a freed id — the exact bug this project's own evidence-store.ts history warns about", () => {
    let list: StoredAudioReference[] = [];
    list = saveAudioReference(list, { name: "A", fingerprint: makeFingerprint(), sourceLabel: "" }, "2026-08-26T00:00:00.000Z");
    const firstId = list[0].id;
    list = deleteAudioReference(list, firstId);
    expect(list).toHaveLength(0);
    list = saveAudioReference(list, { name: "B", fingerprint: makeFingerprint(), sourceLabel: "" }, "2026-08-26T00:00:01.000Z");
    expect(list[0].id).not.toBe(firstId);
  });
});
