import { describe, expect, test } from "bun:test";
import {
  isBookmarked,
  migrateBookmarks,
  pinnedBookmarks,
  removeBookmark,
  setBookmarkCase,
  shortlisted,
  toggleBookmark,
  type Bookmark,
} from "../src/utils/bookmark-store";

const NOW = "2026-08-17T12:00:00.000Z";

const ITEM = {
  url: "https://example.com/a",
  title: "Headline about a launch",
  source: "Reuters",
  publishedAt: "2026-08-17T09:00:00.000Z",
  text: "Headline about a launch. Body text.",
};

describe("migrateBookmarks", () => {
  test("a v1 URL string keeps its URL and reports every other field as absent", () => {
    // v1 stored ONLY the URL. Back-filling a headline, publisher or date here
    // would manufacture provenance for a record that never had any.
    const [b] = migrateBookmarks(["https://example.com/old"]);
    expect(b.url).toBe("https://example.com/old");
    expect(b.title).toBeNull();
    expect(b.source).toBeNull();
    expect(b.publishedAt).toBeNull();
    expect(b.text).toBeNull();
    expect(b.caseId).toBeNull();
    expect(b.bookmarkedAt).toBeNull();
  });

  test("v2 records round-trip unchanged", () => {
    const original: Bookmark = { ...ITEM, caseId: "INV-1001", bookmarkedAt: NOW };
    expect(migrateBookmarks([original])).toEqual([original]);
  });

  test("a mixed v1/v2 array migrates both", () => {
    const out = migrateBookmarks([
      "https://example.com/old",
      { ...ITEM, caseId: null, bookmarkedAt: NOW },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].title).toBeNull();
    expect(out[1].title).toBe(ITEM.title);
  });

  test("junk is dropped rather than producing a record with no URL", () => {
    expect(migrateBookmarks([null, 42, {}, { url: "" }, "  "])).toEqual([]);
    expect(migrateBookmarks("not an array")).toEqual([]);
    expect(migrateBookmarks(undefined)).toEqual([]);
  });
});

describe("toggleBookmark", () => {
  test("adds a record carrying what the feed reported", () => {
    const list = toggleBookmark([], ITEM, NOW);
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({ ...ITEM, caseId: null, bookmarkedAt: NOW });
  });

  test("an undated item is stored undated, never stamped with now", () => {
    const list = toggleBookmark([], { url: "https://example.com/b" }, NOW);
    expect(list[0].publishedAt).toBeNull();
    // bookmarkedAt IS real — it is when the analyst clicked, not a publication time.
    expect(list[0].bookmarkedAt).toBe(NOW);
  });

  test("toggling an existing url removes it", () => {
    const added = toggleBookmark([], ITEM, NOW);
    expect(toggleBookmark(added, ITEM, NOW)).toEqual([]);
  });
});

describe("setBookmarkCase", () => {
  test("records the case on an already-shortlisted item", () => {
    const list = setBookmarkCase(toggleBookmark([], ITEM, NOW), ITEM, "INV-1001", NOW);
    expect(list[0].caseId).toBe("INV-1001");
  });

  test("pinning an item that was never shortlisted still records where it went", () => {
    const list = setBookmarkCase([], ITEM, "INV-1002", NOW);
    expect(list).toHaveLength(1);
    expect(list[0].caseId).toBe("INV-1002");
  });

  test("unpinning clears the case without dropping the record", () => {
    const pinned = setBookmarkCase([], ITEM, "INV-1001", NOW);
    const cleared = setBookmarkCase(pinned, ITEM, null, NOW);
    expect(cleared).toHaveLength(1);
    expect(cleared[0].caseId).toBeNull();
  });
});

describe("partitioning", () => {
  test("shortlisted and pinned are disjoint and cover the list", () => {
    const list = setBookmarkCase(
      toggleBookmark(toggleBookmark([], ITEM, NOW), { url: "https://example.com/c" }, NOW),
      ITEM,
      "INV-1001",
      NOW,
    );
    expect(list).toHaveLength(2);
    expect(shortlisted(list)).toHaveLength(1);
    expect(pinnedBookmarks(list)).toHaveLength(1);
    expect(shortlisted(list).length + pinnedBookmarks(list).length).toBe(list.length);
  });
});

describe("isBookmarked / removeBookmark", () => {
  test("membership is by url", () => {
    const list = toggleBookmark([], ITEM, NOW);
    expect(isBookmarked(list, ITEM.url)).toBe(true);
    expect(isBookmarked(list, "https://example.com/other")).toBe(false);
    expect(isBookmarked(removeBookmark(list, ITEM.url), ITEM.url)).toBe(false);
  });
});
