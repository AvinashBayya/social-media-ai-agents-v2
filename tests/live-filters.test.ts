import { describe, expect, test } from "bun:test";
import {
  DATE_WINDOWS,
  DEFAULT_WINDOW_ID,
  WINDOW_REACH_NOTE,
  windowHours,
  withinWindow,
} from "../src/utils/live-filters";

const NOW = Date.parse("2026-08-17T12:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

describe("DATE_WINDOWS", () => {
  test("offers an unbounded option", () => {
    const any = DATE_WINDOWS.find((w) => w.id === "any");
    expect(any).toBeDefined();
    expect(any!.hours).toBeNull();
  });

  test("window ids are unique and the default is one of them", () => {
    const ids = DATE_WINDOWS.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(DEFAULT_WINDOW_ID);
  });

  test("the reach note states that a wider window cannot fetch older items", () => {
    expect(WINDOW_REACH_NOTE).toContain("cannot fetch older items");
  });
});

describe("windowHours", () => {
  test("resolves the known windows", () => {
    expect(windowHours("24h")).toBe(24);
    expect(windowHours("7d")).toBe(168);
    expect(windowHours("30d")).toBe(720);
  });

  test("'any' and an unknown id both mean no cutoff — an unrecognised id must fail open", () => {
    expect(windowHours("any")).toBeNull();
    expect(windowHours("not-a-window")).toBeNull();
  });
});

describe("withinWindow", () => {
  test("keeps items inside the window and drops items outside it", () => {
    expect(withinWindow(hoursAgo(1), "24h", NOW)).toBe(true);
    expect(withinWindow(hoursAgo(23), "24h", NOW)).toBe(true);
    expect(withinWindow(hoursAgo(25), "24h", NOW)).toBe(false);
  });

  test("a wider window admits what a narrower one excluded", () => {
    const sixDays = hoursAgo(24 * 6);
    expect(withinWindow(sixDays, "24h", NOW)).toBe(false);
    expect(withinWindow(sixDays, "7d", NOW)).toBe(true);
    expect(withinWindow(sixDays, "30d", NOW)).toBe(true);
    expect(withinWindow(sixDays, "any", NOW)).toBe(true);
  });

  test("'any time' admits an item of any age", () => {
    expect(withinWindow("1999-01-01T00:00:00.000Z", "any", NOW)).toBe(true);
    expect(withinWindow(hoursAgo(24 * 365 * 20), "any", NOW)).toBe(true);
  });

  test("an undated item passes every window", () => {
    // Deliberate: live.tsx maps a dateless RSS item to null rather than stamping
    // the moment of collection onto it. Filtering it out would delete real
    // reporting on the strength of a field the publisher never supplied.
    for (const w of DATE_WINDOWS) {
      expect(withinWindow(null, w.id, NOW)).toBe(true);
    }
  });

  test("an unparseable date is treated as absent, not as the epoch", () => {
    expect(withinWindow("not a date", "24h", NOW)).toBe(true);
    expect(withinWindow("", "24h", NOW)).toBe(true);
  });

  test("a future-dated item is kept rather than dropped on a clock difference", () => {
    expect(withinWindow(new Date(NOW + 3_600_000).toISOString(), "24h", NOW)).toBe(true);
  });

  test("the boundary is inclusive", () => {
    expect(withinWindow(hoursAgo(24), "24h", NOW)).toBe(true);
  });
});
