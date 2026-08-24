// Global Target Acquisition State Manager
// Synchronizes active search target across top navbar and all intelligence routes

export function getActiveTarget(): string {
  if (typeof window === "undefined") return "google.com";
  const urlParams = new URLSearchParams(window.location.search);
  const q = urlParams.get("q");
  if (q && q.trim()) {
    localStorage.setItem("sentinel_active_target", q.trim());
    return q.trim();
  }
  return localStorage.getItem("sentinel_active_target") || "google.com";
}

export function setActiveTarget(query: string) {
  if (typeof window === "undefined") return;
  const trimmed = query.trim();
  if (!trimmed) return;

  localStorage.setItem("sentinel_active_target", trimmed);
  rememberRecentTarget(trimmed);

  const url = new URL(window.location.href);
  url.searchParams.set("q", trimmed);
  window.history.pushState({}, "", url.toString());

  // Dispatch custom event for reactive UI updates
  window.dispatchEvent(new CustomEvent("sentinel_target_changed", { detail: trimmed }));
}

/**
 * What kind of thing the analyst is searching for — a UI-set classification
 * of the CURRENT search, not an inferred/guessed one. Real, structural type
 * information (e.g. which bucket a watchlist entry is stored under) is used
 * to filter suggestions where it exists; nothing here classifies a target's
 * type automatically, since that would be a guess presented as a fact.
 */
export const TARGET_TYPES = [
  { value: "person", label: "Person" },
  { value: "company", label: "Company / Org" },
  { value: "domain", label: "Domain" },
  { value: "topic", label: "Topic" },
  { value: "social_handle", label: "Social Handle" },
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone" },
] as const;
export type TargetType = (typeof TARGET_TYPES)[number]["value"];

const TARGET_TYPE_KEY = "sentinel_active_target_type";

export function getActiveTargetType(): TargetType | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(TARGET_TYPE_KEY);
  return (TARGET_TYPES.find((t) => t.value === raw)?.value as TargetType | undefined) ?? null;
}

export function setActiveTargetType(type: TargetType | null) {
  if (typeof window === "undefined") return;
  if (type) localStorage.setItem(TARGET_TYPE_KEY, type);
  else localStorage.removeItem(TARGET_TYPE_KEY);
  window.dispatchEvent(new CustomEvent("sentinel_target_type_changed", { detail: type }));
}

/**
 * Real search history, not a suggestion engine — this is exactly what the
 * analyst themselves searched, in their own browser, most recent first.
 * There is no external "did you mean" service to query for free, so this
 * (plus real investigations/watchlist entries, wired in app-shell.tsx) is
 * what backs the search bar's autocomplete instead of an invented one.
 */
const RECENT_TARGETS_KEY = "sentinel_recent_targets";
const RECENT_TARGETS_MAX = 12;

/**
 * Pure recency-list update — moves `next` to the front, deduping
 * case-insensitively (re-searching "Google.com" then "GOOGLE.COM" keeps one
 * entry, the newest casing) and capping length. Extracted from
 * `rememberRecentTarget` so the actual list logic is unit-testable without a
 * DOM (this project's `bun test` has no localStorage/window shim — the same
 * reason `credibility.ts` keeps its deterministic scoring separate from its
 * localStorage-backed profile functions).
 */
export function withRecentTarget(existing: string[], next: string, max = RECENT_TARGETS_MAX): string[] {
  const deduped = existing.filter((t) => t.toLowerCase() !== next.toLowerCase());
  return [next, ...deduped].slice(0, max);
}

export function getRecentTargets(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(RECENT_TARGETS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

function rememberRecentTarget(target: string): void {
  if (typeof window === "undefined") return;
  const next = withRecentTarget(getRecentTargets(), target);
  try {
    localStorage.setItem(RECENT_TARGETS_KEY, JSON.stringify(next));
  } catch {
    // Quota exceeded or private-mode failure — recent-search history is a
    // convenience; the search itself already succeeded via setActiveTarget.
  }
}
