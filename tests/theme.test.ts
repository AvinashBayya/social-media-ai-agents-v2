import { describe, expect, test } from "bun:test";
import { getThemePreference, resolveTheme, setThemePreference } from "../src/utils/theme";

// bun test has no window/localStorage/matchMedia shim (matches
// active-target.test.ts's own documented pattern) — what's testable here:
// resolveTheme's pure "light"/"dark" passthrough, and that every SSR-guarded
// function fails safe rather than throwing when window is undefined.

describe("resolveTheme (pure passthrough for non-system preferences)", () => {
  test("light resolves to light without touching window", () => {
    expect(resolveTheme("light")).toBe("light");
  });

  test("dark resolves to dark without touching window", () => {
    expect(resolveTheme("dark")).toBe("dark");
  });
});

describe("SSR guards — no window/localStorage in this environment", () => {
  test("getThemePreference defaults to dark, not system — matches the app's pre-toggle behavior for an untouched user", () => {
    expect(getThemePreference()).toBe("dark");
  });

  test("resolveTheme('system') falls back to dark without throwing when window is undefined", () => {
    expect(resolveTheme("system")).toBe("dark");
  });

  test("setThemePreference no-ops rather than throwing", () => {
    expect(() => setThemePreference("light")).not.toThrow();
  });
});
