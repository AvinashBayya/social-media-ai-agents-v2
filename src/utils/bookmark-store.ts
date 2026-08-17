/**
 * Live Monitoring shortlist.
 *
 * The bookmark button on /live was wired and did persist — but it wrote a bare
 * array of URL strings to `sentinel_bookmarks`, and NOTHING in the repository
 * ever read that key back. There was no bookmarks route, no sidebar entry, no
 * export, and no reader outside the one file that wrote it. Bookmarking an item
 * put it somewhere it could never be retrieved from.
 *
 * Worse, storing only the URL threw away the four fields that make a record
 * citable — publisher, publication time, headline and body — so a bookmark could
 * not later be turned into `PinnedEvidence` even by hand.
 *
 * Two changes fix that. The record now carries what the feed reported, and a
 * bookmark can be promoted into an investigation case, with `caseId` recording
 * where it went. "Bookmark" already meant "pin to a case" on /news, /social and
 * /images; /live was the one page where it meant nothing.
 *
 * What is deliberately NOT done here: no field is back-filled. A bookmark
 * migrated from the old string array keeps its URL and reports every other field
 * as absent, because the old store genuinely did not record them. Inventing a
 * headline or a date at migration time would manufacture provenance for an
 * item that never had any.
 */

export const BOOKMARK_KEY = "sentinel_bookmarks";

/**
 * Bumped when the shape changes. v1 was `string[]` of URLs; v2 is the record
 * below. Without the marker a v1 array would be read as a list of objects and
 * every field would come back undefined.
 */
const BOOKMARK_VERSION_KEY = "sentinel_bookmarks_version";
const BOOKMARK_VERSION = "2";

export interface Bookmark {
  url: string;
  /** Headline as the feed reported it. Null for records migrated from v1. */
  title: string | null;
  /** Publisher. Null when the feed named none — never a substituted outlet. */
  source: string | null;
  /** ISO 8601 as the upstream reported it. Null means undated, never "now". */
  publishedAt: string | null;
  /** Article text, for later use as a citable excerpt. */
  text: string | null;
  /** Case this was pinned to, or null while it is only shortlisted. */
  caseId: string | null;
  /** When the analyst clicked. Null for records migrated from v1. */
  bookmarkedAt: string | null;
}

export interface BookmarkInput {
  url: string;
  title?: string | null;
  source?: string | null;
  publishedAt?: string | null;
  text?: string | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

/**
 * Normalise whatever is in storage into v2 records.
 *
 * Exported so the migration is testable without a browser. A v1 entry becomes a
 * record whose only populated field is the URL — that is all v1 stored.
 */
export function migrateBookmarks(raw: unknown): Bookmark[] {
  if (!Array.isArray(raw)) return [];
  const out: Bookmark[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      if (!entry.trim()) continue;
      out.push({
        url: entry,
        title: null,
        source: null,
        publishedAt: null,
        text: null,
        caseId: null,
        bookmarkedAt: null,
      });
      continue;
    }
    if (!isRecord(entry)) continue;
    const url = str(entry.url);
    if (!url) continue;
    out.push({
      url,
      title: str(entry.title),
      source: str(entry.source),
      publishedAt: str(entry.publishedAt),
      text: str(entry.text),
      caseId: str(entry.caseId),
      bookmarkedAt: str(entry.bookmarkedAt),
    });
  }
  return out;
}

export function getBookmarks(): Bookmark[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(BOOKMARK_KEY);
    if (!raw) return [];
    const migrated = migrateBookmarks(JSON.parse(raw));
    if (localStorage.getItem(BOOKMARK_VERSION_KEY) !== BOOKMARK_VERSION) {
      localStorage.setItem(BOOKMARK_KEY, JSON.stringify(migrated));
      localStorage.setItem(BOOKMARK_VERSION_KEY, BOOKMARK_VERSION);
    }
    return migrated;
  } catch {
    // Unreadable or malformed store: start empty rather than resurrecting a
    // partial list, matching how parseDemoSession treats a half-readable record.
    return [];
  }
}

export function saveBookmarks(list: Bookmark[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(BOOKMARK_KEY, JSON.stringify(list));
    localStorage.setItem(BOOKMARK_VERSION_KEY, BOOKMARK_VERSION);
  } catch {
    /* quota — the caller's in-memory list is unaffected */
  }
}

export function isBookmarked(list: Bookmark[], url: string): boolean {
  return list.some((b) => b.url === url);
}

/** Add if absent, remove if present. Returns the new list. */
export function toggleBookmark(list: Bookmark[], input: BookmarkInput, nowIso: string): Bookmark[] {
  if (isBookmarked(list, input.url)) return list.filter((b) => b.url !== input.url);
  return [
    {
      url: input.url,
      title: input.title ?? null,
      source: input.source ?? null,
      publishedAt: input.publishedAt ?? null,
      text: input.text ?? null,
      caseId: null,
      bookmarkedAt: nowIso,
    },
    ...list,
  ];
}

export function removeBookmark(list: Bookmark[], url: string): Bookmark[] {
  return list.filter((b) => b.url !== url);
}

/**
 * Record which case a bookmark reached, or clear it when unpinned.
 *
 * A bookmark whose URL is not in the list is added, so pinning an item that was
 * never shortlisted still leaves a record of where it went.
 */
export function setBookmarkCase(
  list: Bookmark[],
  input: BookmarkInput,
  caseId: string | null,
  nowIso: string,
): Bookmark[] {
  if (isBookmarked(list, input.url)) {
    return list.map((b) => (b.url === input.url ? { ...b, caseId } : b));
  }
  return [
    {
      url: input.url,
      title: input.title ?? null,
      source: input.source ?? null,
      publishedAt: input.publishedAt ?? null,
      text: input.text ?? null,
      caseId,
      bookmarkedAt: nowIso,
    },
    ...list,
  ];
}

/** Shortlisted but not yet in a case. */
export function shortlisted(list: Bookmark[]): Bookmark[] {
  return list.filter((b) => !b.caseId);
}

/** Bookmarks recorded as pinned to a case. */
export function pinnedBookmarks(list: Bookmark[]): Bookmark[] {
  return list.filter((b) => Boolean(b.caseId));
}
