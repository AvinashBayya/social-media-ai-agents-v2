import type { ReactNode } from "react";

/**
 * Highlights the searched target wherever it's rendered — /news, /osint,
 * and every other route that already tracks the active target in local
 * state via the app-wide `sentinel_target_changed` listener pattern.
 *
 * A single, literal-string, case-insensitive match — not a fuzzy or
 * per-word match. "Ankit Bhatt" highlights the phrase "Ankit Bhatt", not
 * every independent occurrence of "Ankit" or "Bhatt" — matching how the
 * search bar itself treats the target as one string, not a keyword set.
 */

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Splits `text` on case-insensitive occurrences of `query` and wraps each
 * match in a `<mark>`. Returns `text` unchanged (no wrapping, no keys) when
 * `query` is empty/whitespace-only or does not occur in `text` — a bare
 * string is a valid `ReactNode`, so callers needn't special-case "no match".
 */
export function highlightMatches(text: string, query: string | null | undefined): ReactNode {
  const q = (query ?? "").trim();
  if (!q || !text) return text;
  const re = new RegExp(`(${escapeRegExp(q)})`, "gi");
  const parts = text.split(re);
  if (parts.length <= 1) return text;
  // String.split with a single capturing group alternates
  // [unmatched, matched, unmatched, matched, ...] — odd indices are always
  // the captured matches, so no separate regex test (and its lastIndex
  // statefulness) is needed here.
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="rounded-sm bg-yellow-400 px-0.5 text-black">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

export function Highlight({ text, query }: { text: string; query: string | null | undefined }) {
  return <>{highlightMatches(text, query)}</>;
}
