import { describe, expect, test } from "bun:test";
import { mergeTimeline, timelineFromGdeltEvents, timelineFromNewsItems } from "../src/utils/timeline";
import type { GeoRecord } from "../src/utils/geo";
import type { NewsItem } from "../src/utils/news-aggregation";

function gdeltRecord(overrides: Partial<GeoRecord> = {}): GeoRecord {
  return {
    id: "gdelt-event-1",
    layer: "gdeltEvents",
    lat: 28.6,
    lon: 77.2,
    precision: "city",
    locates: "GDELT's geocoded action location (New Delhi, India)",
    title: "Protested — New Delhi, India",
    source: "GDELT 2.0 Events",
    url: "https://example.com/story",
    timestamp: "2026-08-19T10:00:00Z",
    magnitude: 5,
    magnitudeLabel: "5 mention(s) across monitored sources",
    detail: {},
    credibility: null,
    ...overrides,
  };
}

function newsItem(overrides: Partial<NewsItem> = {}): NewsItem {
  return {
    title: "A real headline",
    link: "https://example.com/article",
    source: "BBC World News",
    publishedAt: "2026-08-19T08:00:00Z",
    summary: "A real summary",
    ...overrides,
  };
}

describe("timelineFromGdeltEvents", () => {
  test("maps a GDELT event record to a timeline entry", () => {
    const [entry] = timelineFromGdeltEvents([gdeltRecord()]);
    expect(entry).toMatchObject({
      id: "gdelt-event-1",
      kind: "event",
      title: "Protested — New Delhi, India",
      sourceUrl: "https://example.com/story",
      timestamp: "2026-08-19T10:00:00Z",
    });
  });

  test("excludes records from other layers, never mislabels them as events", () => {
    const entries = timelineFromGdeltEvents([gdeltRecord({ layer: "seismic", id: "usgs-1" })]);
    expect(entries).toEqual([]);
  });

  test("a null timestamp passes through as null, never a fabricated instant", () => {
    const [entry] = timelineFromGdeltEvents([gdeltRecord({ timestamp: null })]);
    expect(entry!.timestamp).toBeNull();
  });
});

describe("timelineFromNewsItems", () => {
  test("maps a news item to a timeline entry", () => {
    const [entry] = timelineFromNewsItems([newsItem()]);
    expect(entry).toMatchObject({
      id: "https://example.com/article",
      kind: "news",
      title: "A real headline",
      sourceUrl: "https://example.com/article",
      sourceLabel: "BBC World News",
    });
  });
});

describe("mergeTimeline", () => {
  test("merges and sorts newest-first across both kinds", () => {
    const events = timelineFromGdeltEvents([gdeltRecord({ timestamp: "2026-08-19T10:00:00Z" })]);
    const news = timelineFromNewsItems([newsItem({ publishedAt: "2026-08-19T12:00:00Z" })]);
    const merged = mergeTimeline(events, news);
    expect(merged.map((e) => e.kind)).toEqual(["news", "event"]);
  });

  test("undated entries sort after every dated entry", () => {
    const events = timelineFromGdeltEvents([
      gdeltRecord({ id: "a", timestamp: null }),
      gdeltRecord({ id: "b", timestamp: "2026-08-19T10:00:00Z" }),
    ]);
    const merged = mergeTimeline(events);
    expect(merged.map((e) => e.id)).toEqual(["b", "a"]);
  });

  test("an empty input produces an empty timeline, not a placeholder entry", () => {
    expect(mergeTimeline([], [])).toEqual([]);
  });
});
