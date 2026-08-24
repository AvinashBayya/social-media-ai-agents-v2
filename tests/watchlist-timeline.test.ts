import { describe, expect, test } from "bun:test";
import { bucketMatchesByHour, type WatchlistMatch } from "../src/utils/watchlist-store";

/**
 * The chart these buckets feed used to be fabricated.
 *
 * `/subjects` generated seven fixed hour labels whose values came from the loop
 * index — `Math.max(2, Math.round(baseVal * 0.4 + ((idx * 2) % 5)))` for
 * "threats" and `Math.round(150 + idx * 12 + ((idx * idx * 3) % 25))` for a
 * "Total Scans" series measuring an activity this system does not perform —
 * with a floor of 5 so the chart was never empty even when nothing matched.
 *
 * These tests pin the properties that make the replacement honest: an unreported
 * date is never placed on the axis, and an empty match set produces empty
 * columns rather than a plausible-looking curve.
 */

function match(over: Partial<WatchlistMatch> = {}): WatchlistMatch {
  return {
    id: "m1",
    source: "News (Reuters)",
    title: "headline",
    matchValue: "drone",
    matchType: "Keyword",
    date: null,
    severity: null,
    ...over,
  };
}

// 2026-08-17T12:34:00Z — mid-hour on purpose, so bucket alignment is exercised.
const NOW = Date.parse("2026-08-17T12:34:00.000Z");

describe("bucketMatchesByHour", () => {
  test("an empty match set produces empty columns, not a curve", () => {
    const t = bucketMatchesByHour([], NOW, 24);
    expect(t.buckets).toHaveLength(24);
    expect(t.buckets.every((b) => b.matches === 0)).toBe(true);
    expect(t.total).toBe(0);
    expect(t.dated).toBe(0);
    expect(t.undated).toBe(0);
  });

  test("undated matches are counted separately and plotted nowhere", () => {
    const t = bucketMatchesByHour([match(), match({ id: "m2" })], NOW, 24);
    expect(t.undated).toBe(2);
    expect(t.dated).toBe(0);
    expect(t.total).toBe(2);
    // An unreported time is not a time. Nothing may appear on the axis for it.
    expect(t.buckets.reduce((s, b) => s + b.matches, 0)).toBe(0);
  });

  test("an unparseable date counts as undated rather than as the epoch", () => {
    const t = bucketMatchesByHour([match({ date: "not a date" })], NOW, 24);
    expect(t.undated).toBe(1);
    expect(t.dated).toBe(0);
    expect(t.buckets.reduce((s, b) => s + b.matches, 0)).toBe(0);
  });

  test("dated matches land in the hour their source reported", () => {
    const t = bucketMatchesByHour(
      [
        match({ id: "a", date: "2026-08-17T12:05:00.000Z" }),
        match({ id: "b", date: "2026-08-17T12:55:00.000Z" }),
        match({ id: "c", date: "2026-08-17T11:10:00.000Z" }),
      ],
      NOW,
      24,
    );
    expect(t.dated).toBe(3);
    expect(t.outsideWindow).toBe(0);
    expect(t.buckets.reduce((s, b) => s + b.matches, 0)).toBe(3);

    // Both 12:xx matches share one column; the 11:xx one sits in the previous.
    const last = t.buckets[t.buckets.length - 1];
    const previous = t.buckets[t.buckets.length - 2];
    expect(last.matches).toBe(2);
    expect(previous.matches).toBe(1);
  });

  test("matches older than the window are reported, not silently dropped", () => {
    const t = bucketMatchesByHour([match({ date: "2026-08-01T00:00:00.000Z" })], NOW, 24);
    expect(t.dated).toBe(1);
    expect(t.outsideWindow).toBe(1);
    expect(t.buckets.reduce((s, b) => s + b.matches, 0)).toBe(0);
  });

  test("a future-dated match is outside the window rather than clamped into it", () => {
    const t = bucketMatchesByHour([match({ date: "2027-01-01T00:00:00.000Z" })], NOW, 24);
    expect(t.outsideWindow).toBe(1);
    expect(t.buckets.reduce((s, b) => s + b.matches, 0)).toBe(0);
  });

  test("bucket edges are stable within the same hour", () => {
    const early = bucketMatchesByHour([], Date.parse("2026-08-17T12:00:01.000Z"), 6);
    const late = bucketMatchesByHour([], Date.parse("2026-08-17T12:59:59.000Z"), 6);
    expect(early.buckets.map((b) => b.hourStart)).toEqual(late.buckets.map((b) => b.hourStart));
  });

  test("the window length is honoured and never collapses to zero columns", () => {
    expect(bucketMatchesByHour([], NOW, 6).buckets).toHaveLength(6);
    expect(bucketMatchesByHour([], NOW, 0).buckets).toHaveLength(1);
    expect(bucketMatchesByHour([], NOW, -5).buckets).toHaveLength(1);
  });
});
