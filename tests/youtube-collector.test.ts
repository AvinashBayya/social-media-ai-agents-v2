import { describe, expect, test } from "bun:test";
import {
  YT_INNERTUBE_CLIENTS,
  captionTracksOf,
  captionTracksToLangs,
  decodeXmlEntities,
  extractYoutubeId,
  fmtUploadDate,
  isYoutubeUrl,
  muxedFormats,
  parseSubtitleBody,
  parseTimedTextXml,
  parseVttSegments,
} from "../src/utils/youtube-collector";

/**
 * YouTube ingestion, after the 2026-08-12 InnerTube rewrite.
 *
 * Three faults were shipping at once and presented as one. The assertions here
 * pin each of them shut:
 *
 *  1. `&fmt=vtt` is silently ignored — YouTube returns `<timedtext format="3">`
 *     XML whatever you ask for. A WebVTT parser found zero timestamps in it, so
 *     the page reported "No subtitles or auto-captions available" for a video
 *     that had just returned 93,199 bytes of captions. Reporting absence when
 *     the evidence is present is the failure this project exists to avoid.
 *  2. `available_subtitles` was the constant `[{ code: "en", isAuto: true }]`,
 *     so the language dropdown offered English auto-captions for every video on
 *     earth, including ones with no captions at all.
 *  3. The download error asserted "The video may be age-restricted or
 *     region-locked" on every failure — a cause nothing had measured.
 *
 * The XML below is a verbatim excerpt of what YouTube served for b6g6rDDt9x8 on
 * 2026-08-12, rollup duplication and all.
 */

const REAL_TIMEDTEXT = `<?xml version="1.0" encoding="utf-8" ?><timedtext format="3">
<head>
<ws id="0"/>
<wp id="1" ap="6" ah="20" av="100" rc="2" cc="40"/>
</head>
<body>
<w t="0" id="1" wp="1" ws="1"/>
<p t="750" d="7839" w="1">[Music]</p>
<p t="9270" w="1" a="1">
</p>
<p t="9280" d="6399" w="1"><s ac="255">ridiculous</s><s t="960" ac="255"> ridiculous</s><s t="1520" ac="255"> transitions</s></p>
<p t="12070" d="3609" w="1" a="1">
</p>
<p t="12080" d="4560" w="1"><s ac="255">okay</s><s t="479" ac="255"> what&#39;s</s><s t="719" ac="255"> up</s><s t="960" ac="255"> mkbhd</s><s t="1599" ac="255"> here</s></p>
</body>
</timedtext>`;

// ─── URL handling ──────────────────────────────────────────────────────────

describe("URL handling", () => {
  test("accepts every YouTube host form and rejects lookalikes", () => {
    for (const u of [
      "https://www.youtube.com/watch?v=b6g6rDDt9x8",
      "https://youtu.be/b6g6rDDt9x8",
      "https://m.youtube.com/watch?v=b6g6rDDt9x8",
      "https://www.youtube.com/shorts/b6g6rDDt9x8",
    ]) {
      expect(isYoutubeUrl(u)).toBe(true);
    }
    // A hostname merely *containing* youtube.com is a different site.
    expect(isYoutubeUrl("https://youtube.com.evil.example/watch?v=x")).toBe(false);
    expect(isYoutubeUrl("not a url")).toBe(false);
    expect(isYoutubeUrl("")).toBe(false);
  });

  test("extracts the id from every supported form", () => {
    for (const u of [
      "https://www.youtube.com/watch?v=b6g6rDDt9x8",
      "https://youtu.be/b6g6rDDt9x8",
      "https://www.youtube.com/shorts/b6g6rDDt9x8",
      "https://www.youtube.com/embed/b6g6rDDt9x8",
      "https://www.youtube.com/watch?list=PL123&v=b6g6rDDt9x8",
    ]) {
      expect(extractYoutubeId(u)).toBe("b6g6rDDt9x8");
    }
    expect(extractYoutubeId("https://www.youtube.com/watch?v=short")).toBeNull();
  });
});

// ─── Upload date ───────────────────────────────────────────────────────────

describe("fmtUploadDate", () => {
  test("normalises all three shapes the sources actually return", () => {
    // InnerTube WEB microformat — the only source of an upload date, and the
    // shape the old parser rejected outright, leaving the tile reading "Unknown".
    expect(fmtUploadDate("2020-11-10T16:04:48-08:00")).toBe("2020-11-10");
    expect(fmtUploadDate("2009-10-25")).toBe("2009-10-25");
    expect(fmtUploadDate("20091025")).toBe("2009-10-25");
  });

  test("an unparseable value is undefined, never a guess", () => {
    expect(fmtUploadDate("yesterday")).toBeUndefined();
    expect(fmtUploadDate("")).toBeUndefined();
    expect(fmtUploadDate(undefined)).toBeUndefined();
  });
});

// ─── The caption parser that was missing ───────────────────────────────────

describe("parseTimedTextXml", () => {
  const segments = parseTimedTextXml(REAL_TIMEDTEXT);

  test("reads the real payload the VTT parser returned nothing for", () => {
    // The exact regression: this document produced 0 segments, which the caller
    // then reported as the video having no captions.
    expect(parseVttSegments(REAL_TIMEDTEXT)).toHaveLength(0);
    expect(segments.length).toBe(3);
  });

  test("t and d are milliseconds and become seconds", () => {
    expect(segments[0]).toEqual({ start: 0.75, end: 8.59, text: "[Music]" });
  });

  test("word-level <s> children concatenate in document order", () => {
    expect(segments[1].text).toBe("ridiculous ridiculous transitions");
  });

  test("entities are decoded", () => {
    expect(segments[2].text).toBe("okay what's up mkbhd here");
  });

  test("empty rollup placeholders are skipped, not emitted as silent cues", () => {
    for (const s of segments) expect(s.text.trim().length).toBeGreaterThan(0);
  });

  test("a cue with no duration still yields a segment", () => {
    const one = parseTimedTextXml(`<timedtext format="3"><body><p t="5000">hello</p></body></timedtext>`);
    expect(one).toEqual([{ start: 5, end: 5, text: "hello" }]);
  });

  test("junk in, empty out — never a fabricated segment", () => {
    expect(parseTimedTextXml("")).toEqual([]);
    expect(parseTimedTextXml("<html><body>not captions</body></html>")).toEqual([]);
  });
});

describe("parseSubtitleBody", () => {
  test("sniffs the format from the bytes, not from the fmt we requested", () => {
    // We ask for fmt=vtt and YouTube ignores it, so the request is not evidence
    // of the response format.
    expect(parseSubtitleBody(REAL_TIMEDTEXT).length).toBe(3);
  });

  test("still parses genuine WebVTT, so a future switch back keeps working", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:04.000",
      "first line",
      "",
      "00:00:04.000 --> 00:00:07.500",
      "second line",
    ].join("\n");
    const segs = parseSubtitleBody(vtt);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toEqual({ start: 1, end: 4, text: "first line" });
    expect(segs[1].text).toBe("second line");
  });

  test("an unreadable payload yields no segments rather than a partial invention", () => {
    expect(parseSubtitleBody("<html>403 Forbidden</html>")).toEqual([]);
    expect(parseSubtitleBody("")).toEqual([]);
  });
});

describe("decodeXmlEntities", () => {
  test("handles named, decimal and hex forms", () => {
    expect(decodeXmlEntities("a &amp; b")).toBe("a & b");
    expect(decodeXmlEntities("what&#39;s")).toBe("what's");
    expect(decodeXmlEntities("&#x2014;")).toBe("—");
    expect(decodeXmlEntities("&lt;tag&gt;")).toBe("<tag>");
  });
});

// ─── Caption track list: measured, never constant ──────────────────────────

describe("captionTracksOf / captionTracksToLangs", () => {
  const player = {
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          {
            baseUrl: "https://www.youtube.com/api/timedtext?v=x&signed=1",
            languageCode: "en",
            kind: "asr",
            name: { simpleText: "English (auto-generated)" },
          },
          {
            baseUrl: "https://www.youtube.com/api/timedtext?v=x&signed=2",
            languageCode: "hi",
            name: { runs: [{ text: "Hindi" }] },
          },
          // No baseUrl — unusable, so it must not be offered in the dropdown.
          { languageCode: "ta", name: { simpleText: "Tamil" } },
        ],
      },
    },
  };

  test("reads real tracks and marks ASR separately from an uploader's own", () => {
    const tracks = captionTracksOf(player);
    expect(tracks).toHaveLength(2);
    expect(tracks[0]).toMatchObject({ languageCode: "en", isAuto: true });
    expect(tracks[1]).toMatchObject({ languageCode: "hi", name: "Hindi", isAuto: false });
  });

  test("a video with no captions yields an empty list, not a fabricated English track", () => {
    // The regression: this was hardcoded to [{ code: "en", isAuto: true }], so
    // the UI offered auto-captions for videos that had none.
    expect(captionTracksOf({})).toEqual([]);
    expect(captionTracksToLangs(captionTracksOf({}))).toEqual([]);
    expect(captionTracksOf({ captions: { playerCaptionsTracklistRenderer: {} } })).toEqual([]);
  });

  test("the language list mirrors the tracks exactly", () => {
    const langs = captionTracksToLangs(captionTracksOf(player));
    expect(langs).toEqual([
      { code: "en", name: "English (auto-generated)", isAuto: true },
      { code: "hi", name: "Hindi", isAuto: false },
    ]);
  });
});

// ─── Formats ───────────────────────────────────────────────────────────────

describe("muxedFormats", () => {
  test("keeps only formats with a usable URL", () => {
    // ytdl-core's failure mode was returning a format whose URL never got
    // deciphered. A format without a URL is not a download.
    const json = {
      streamingData: {
        formats: [{ itag: 18, url: "https://cdn/x" }, { itag: 22 }],
        adaptiveFormats: [{ itag: 137, url: "https://cdn/y" }],
      },
    };
    const out = muxedFormats(json);
    expect(out).toHaveLength(1);
    expect(out[0].itag).toBe(18);
  });

  test("adaptive-only responses yield nothing downloadable", () => {
    // Correct: the runtime has no ffmpeg, so separate video and audio streams
    // cannot become a single artifact.
    expect(muxedFormats({ streamingData: { adaptiveFormats: [{ itag: 137, url: "u" }] } })).toEqual(
      [],
    );
    expect(muxedFormats({})).toEqual([]);
  });
});

// ─── Client registry ───────────────────────────────────────────────────────

describe("YT_INNERTUBE_CLIENTS", () => {
  test("at least one client can serve a muxed download", () => {
    expect(YT_INNERTUBE_CLIENTS.some((c) => c.yieldsMuxed)).toBe(true);
  });

  test("the muxed-capable client is tried first", () => {
    // ANDROID is the only client returning itag 18; ordering it after IOS would
    // make every download attempt fall through to the broken ytdl-core path.
    expect(YT_INNERTUBE_CLIENTS[0].yieldsMuxed).toBe(true);
  });

  test("WEB is not in the playback pool", () => {
    // It answered UNPLAYABLE — "Video unavailable" for a video ANDROID served
    // normally. That is the bot-detection wall, and it must not gate playback.
    for (const c of YT_INNERTUBE_CLIENTS) {
      expect(c.context.clientName).not.toBe("WEB");
    }
  });

  test("every client declares a matching user agent and version", () => {
    for (const c of YT_INNERTUBE_CLIENTS) {
      expect(c.userAgent.length).toBeGreaterThan(10);
      expect(String(c.context.clientVersion ?? "").length).toBeGreaterThan(0);
      expect(c.key).toMatch(/^innertube-/);
    }
  });
});
