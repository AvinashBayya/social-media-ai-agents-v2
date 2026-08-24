import { describe, expect, test } from "bun:test";
import { summarizeCategoryCounts } from "../src/utils/llm";

describe("summarizeCategoryCounts", () => {
  test("returns the plurality label with its real share of analyzed items", () => {
    const summary = summarizeCategoryCounts({ negative: 3, neutral: 1, positive: 1 }, 5);
    expect(summary).toEqual({ label: "negative", pct: 60 });
  });

  test("a tie at the top reports 'mixed' rather than picking one arbitrarily", () => {
    const summary = summarizeCategoryCounts({ positive: 2, negative: 2 }, 4);
    expect(summary?.label).toBe("mixed");
    expect(summary?.pct).toBe(50);
  });

  test("a three-way tie is also 'mixed'", () => {
    const summary = summarizeCategoryCounts({ positive: 1, negative: 1, neutral: 1 }, 3);
    expect(summary?.label).toBe("mixed");
  });

  test("the percentage denominator is analyzedCount, not the sum of counts — honest about partial coverage", () => {
    // Only 3 of 5 sampled articles actually analyzed successfully (2 failed).
    const summary = summarizeCategoryCounts({ positive: 3 }, 5);
    expect(summary?.pct).toBe(60);
  });

  test("zero analyzed items returns null, never a fabricated summary", () => {
    expect(summarizeCategoryCounts({}, 0)).toBeNull();
    expect(summarizeCategoryCounts({ positive: 0, negative: 0 }, 0)).toBeNull();
  });

  test("an empty counts object with a positive analyzedCount still returns null (no real labels to report)", () => {
    expect(summarizeCategoryCounts({}, 3)).toBeNull();
  });

  test("a single dominant category with no tie is reported as-is", () => {
    const summary = summarizeCategoryCounts({ critical: 4, positive: 1 }, 5);
    expect(summary).toEqual({ label: "critical", pct: 80 });
  });

  test("also works for threatLevel results, not just sentiment — it's generic", () => {
    const summary = summarizeCategoryCounts({ low: 1, medium: 2, high: 1, critical: 1 }, 5);
    expect(summary).toEqual({ label: "medium", pct: 40 });
  });
});
