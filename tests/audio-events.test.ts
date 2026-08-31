import { describe, expect, test } from "bun:test";
import {
  AUDIO_EVENT_GAPS,
  AUDIO_EVENT_CANNOT_DETERMINE,
  groupAudioEvents,
  describeCoverage,
} from "../src/utils/audio-events";
import type { AiAudioEvent, AiAudioEventsResult } from "../src/utils/ai-service-client";

function makeEvent(overrides: Partial<AiAudioEvent> = {}): AiAudioEvent {
  return {
    className: "Speech",
    startTime: 0,
    endTime: 1,
    maxScore: 0.7,
    meanScore: 0.6,
    framesAboveThreshold: 2,
    framesTotal: 3,
    hazard: false,
    ...overrides,
  };
}

function makeResult(events: AiAudioEvent[], coverage?: Partial<AiAudioEventsResult["coverage"]>): AiAudioEventsResult {
  return {
    events,
    coverage: { windowsAnalysed: 10, windowsWithAnyClassAboveThreshold: events.length, ...coverage },
    provenance: { model: "yamnet", version: "loaded (cpu, onnxruntime)" },
  };
}

describe("groupAudioEvents", () => {
  test("splits by the hazard flag ai-service already computed, never re-derives it", () => {
    const result = makeResult([
      makeEvent({ className: "Siren", hazard: true }),
      makeEvent({ className: "Speech", hazard: false }),
      makeEvent({ className: "Explosion", hazard: true }),
    ]);
    const grouped = groupAudioEvents(result);
    expect(grouped.hazards.map((e) => e.className)).toEqual(["Siren", "Explosion"]);
    expect(grouped.other.map((e) => e.className)).toEqual(["Speech"]);
  });

  test("empty events produce empty groups, not an error", () => {
    const grouped = groupAudioEvents(makeResult([]));
    expect(grouped.hazards).toEqual([]);
    expect(grouped.other).toEqual([]);
  });
});

describe("describeCoverage", () => {
  test("reports real coverage numbers, not just an event count", () => {
    const result = makeResult([makeEvent()], { windowsAnalysed: 42, windowsWithAnyClassAboveThreshold: 5 });
    const desc = describeCoverage(result);
    expect(desc).toContain("42");
    expect(desc).toContain("5");
  });

  test("zero windows analysed is stated explicitly, not silently zero events", () => {
    const desc = describeCoverage(makeResult([], { windowsAnalysed: 0, windowsWithAnyClassAboveThreshold: 0 }));
    expect(desc.toLowerCase()).toContain("no windows were analysed");
  });
});

describe("AUDIO_EVENT_GAPS", () => {
  test("names the missing drone/UAV class explicitly", () => {
    expect(AUDIO_EVENT_GAPS.some((g) => /drone|uav/i.test(g.capability) || /drone|uav/i.test(g.limitation))).toBe(
      true,
    );
  });

  test("names emotional-state inference as an explicit non-goal", () => {
    expect(AUDIO_EVENT_GAPS.some((g) => /emotional state|distress/i.test(g.capability))).toBe(true);
  });

  test("every gap has real, non-empty requires/limitation text", () => {
    for (const g of AUDIO_EVENT_GAPS) {
      expect(g.requires.length).toBeGreaterThan(10);
      expect(g.limitation.length).toBeGreaterThan(10);
    }
  });
});

describe("AUDIO_EVENT_CANNOT_DETERMINE", () => {
  test("is non-empty and mentions source identity", () => {
    expect(AUDIO_EVENT_CANNOT_DETERMINE.length).toBeGreaterThan(0);
    expect(AUDIO_EVENT_CANNOT_DETERMINE.some((c) => c.toLowerCase().includes("source"))).toBe(true);
  });
});
