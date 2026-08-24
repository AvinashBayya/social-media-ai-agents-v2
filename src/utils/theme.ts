// Global Theme Preference Manager — mirrors active-target.ts's exact idiom:
// SSR-safe getter/setter, localStorage-backed, reactive via a CustomEvent.

export type ThemePreference = "light" | "dark" | "system";

const THEME_KEY = "sentinel_theme";
export const THEME_EVENT = "sentinel_theme_changed";

/**
 * An ABSENT key means "never touched the toggle" and resolves to "dark" —
 * not "system". The app was hardcoded dark before this toggle existed; if
 * unset silently followed the OS preference, any existing user whose
 * device happens to be in light mode would see their theme flip the moment
 * this ships, despite never having chosen anything. "System" is only ever
 * applied when the analyst explicitly selects it, which is why the stored
 * value for that case is the literal string "system", not an absent key —
 * the two states must stay distinguishable.
 */
export function getThemePreference(): ThemePreference {
  if (typeof window === "undefined") return "dark";
  const stored = localStorage.getItem(THEME_KEY);
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "dark";
}

/** Resolves "system" against the OS preference; "light"/"dark" pass through unchanged. */
export function resolveTheme(pref: ThemePreference): "light" | "dark" {
  if (pref !== "system") return pref;
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function setThemePreference(pref: ThemePreference): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(THEME_KEY, pref);
  document.documentElement.classList.toggle("dark", resolveTheme(pref) === "dark");
  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: pref }));
}
