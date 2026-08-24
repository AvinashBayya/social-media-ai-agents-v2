import { describe, expect, test } from "bun:test";
import {
  getActiveTargetType,
  getRecentTargets,
  withRecentTarget,
  TARGET_TYPES,
} from "../src/utils/active-target";

// bun test has no window/localStorage shim (matches this project's own
// pattern — credibility.ts's localStorage-backed profile functions aren't
// unit-tested either). What IS testable here without a DOM: the pure
// recency-list logic, and that every SSR-guarded getter fails safe (null/
// empty) rather than throwing when window is undefined — both real,
// meaningful behavior, not just an artifact of the test environment.

describe("withRecentTarget (pure recency-list update)", () => {
  test("prepends a new target to an empty list", () => {
    expect(withRecentTarget([], "google.com")).toEqual(["google.com"]);
  });

  test("moves a re-searched target to the front instead of duplicating it", () => {
    const result = withRecentTarget(["openai.com", "google.com"], "google.com");
    expect(result).toEqual(["google.com", "openai.com"]);
  });

  test("dedup is case-insensitive but keeps the newest casing", () => {
    const result = withRecentTarget(["Google.com"], "GOOGLE.COM");
    expect(result).toEqual(["GOOGLE.COM"]);
  });

  test("caps the list length, dropping the oldest entries", () => {
    const existing = Array.from({ length: 12 }, (_, i) => `target-${i}`);
    const result = withRecentTarget(existing, "newest", 12);
    expect(result).toHaveLength(12);
    expect(result[0]).toBe("newest");
    expect(result).not.toContain("target-11"); // the oldest, pushed out
  });

  test("respects a custom max independent of the default", () => {
    const result = withRecentTarget(["a", "b", "c"], "d", 2);
    expect(result).toEqual(["d", "a"]);
  });
});

describe("SSR guards — no window/localStorage in this environment", () => {
  test("getActiveTargetType returns null rather than throwing", () => {
    expect(getActiveTargetType()).toBeNull();
  });

  test("getRecentTargets returns an empty array rather than throwing", () => {
    expect(getRecentTargets()).toEqual([]);
  });
});

describe("TARGET_TYPES", () => {
  test("every value is unique", () => {
    const values = TARGET_TYPES.map((t) => t.value);
    expect(new Set(values).size).toBe(values.length);
  });

  test("every entry has a non-empty label", () => {
    for (const t of TARGET_TYPES) {
      expect(t.label.length).toBeGreaterThan(0);
    }
  });
});
