/**
 * YouTube OSINT Collector Utility
 *
 * Provides metadata, subtitles and download via TanStack Start server functions.
 * All data comes from YouTube directly — no separate backend required.
 * Strict Data Honesty Policy: typed errors always, never placeholder content.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS BUILT ON INNERTUBE RATHER THAN ytdl-core (rewritten 2026-08-12)
 *
 * Every panel on /youtube was failing at once, and it looked like one fault. It
 * was three, measured against video b6g6rDDt9x8 on 2026-08-12:
 *
 *  1. `@distube/ytdl-core@4.16.12` can no longer read YouTube's player script.
 *     `getInfo` prints "Could not parse decipher function. Stream URLs will be
 *     missing." and "Could not parse n transform function", then returns a
 *     single format whose URL is undeciphered — or throws "Failed to find any
 *     playable formats" outright. Metadata therefore fell through to the oEmbed
 *     fallback, which carries no duration, no view count and no upload date, so
 *     the UI showed three "Unknown" tiles for a video whose real figures were
 *     734s / 4,309,691 views / 2020-11-10. That is a scraper-versus-signature
 *     arms race we cannot win by pinning a version.
 *
 *  2. The unsigned timedtext endpoint is dead. Both subtitle strategies called
 *     `api/timedtext?v=ID&lang=en`, which now answers **HTTP 200 with a
 *     zero-length body** — so they could never succeed, for any video, ever.
 *     Captions now require the signed `baseUrl` from the player response.
 *
 *  3. `&fmt=vtt` is ignored. Even with the signed URL, YouTube returns its own
 *     `<timedtext format="3">` XML whatever `fmt` you ask for. The code fetched
 *     it, ran a WebVTT parser over it, found zero timestamps, and reported "No
 *     subtitles or auto-captions available" — for a video that had just handed
 *     back 93,199 bytes of captions. Reporting absence when the evidence is
 *     present is the failure mode this project exists to avoid.
 *
 * The fix is to ask YouTube the way its own clients do. The InnerTube `player`
 * endpoint is public and keyless, and the ANDROID client returns full metadata,
 * a muxed MP4 whose URL needs **no deciphering**, and the signed caption track —
 * verified end to end: HEAD on the returned URL gave HTTP 200, video/mp4,
 * 22,830,807 bytes. There is no signature to reverse, so failure mode 1 cannot
 * recur. ytdl-core is retained as a fallback and is now imported lazily, so its
 * own load failures (it throws `this.compose is not a function` under Bun's
 * undici shim) can no longer take this whole module down with it.
 *
 * Clients are tried in order and the one that answered is named in
 * `provenance.model`, so a degraded record is always visible as degraded.
 */

import { createServerFn } from "@tanstack/react-start";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface YoutubeThumbnail {
  url: string;
  width?: number;
  height?: number;
}

export interface YoutubeSubLang {
  code: string;
  name: string;
  isAuto: boolean;
}

export interface YoutubeMetadata {
  id: string;
  title: string;
  description: string;
  uploader: string;
  channel_id: string;
  upload_date?: string;
  duration?: number;
  view_count?: number;
  thumbnails: YoutubeThumbnail[];
  webpage_url: string;
  available_subtitles: YoutubeSubLang[];
  provenance: {
    source: string;
    model: string;
    fetchedAt: string;
  };
}

export interface SubtitleSegment {
  start: number;
  end: number;
  text: string;
}

export interface YoutubeSubtitlesResponse {
  id: string;
  lang: string;
  isAuto: boolean;
  segments: SubtitleSegment[];
  provenance: {
    source: string;
    model: string;
    fetchedAt: string;
  };
}

export interface YoutubeDownloadResponse {
  id: string;
  directUrl: string;
  format: string;
  filesize?: number;
  provenance: {
    source: string;
    model: string;
    fetchedAt: string;
  };
}

export interface YoutubeError {
  error: "VideoUnavailable" | "SubsUnavailable" | "DownloadFailed" | string;
  cause: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function isYoutubeUrl(url: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url.trim());
    const host = parsed.hostname.toLowerCase();
    return (
      host === "youtube.com" ||
      host === "www.youtube.com" ||
      host === "m.youtube.com" ||
      host === "youtu.be" ||
      host === "shorts.youtube.com" ||
      host.endsWith(".youtube.com")
    );
  } catch {
    return false;
  }
}

export function extractYoutubeId(url: string): string | null {
  if (!url) return null;
  // Handles: watch?v=ID, youtu.be/ID, /embed/ID, /v/ID, /shorts/ID
  const match = url.match(
    /(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|shorts\/|watch\?v=|watch\?.+&v=))([\w-]{11})/,
  );
  return match ? match[1] : null;
}

/**
 * Normalise an upload date to YYYY-MM-DD.
 *
 * Accepts the three shapes the sources actually produce: ytdl-core's
 * `2009-10-25`, its compact `20091025`, and InnerTube's microformat ISO stamp
 * `2020-11-10T16:04:48-08:00`. Anything else returns undefined rather than a
 * guess — an unparseable date must stay distinguishable from a known one.
 */
export function fmtUploadDate(raw?: string): string | undefined {
  if (!raw) return undefined;
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const digits = raw.replace(/-/g, "");
  if (digits.length !== 8 || !/^\d{8}$/.test(digits)) return undefined;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

// ─── InnerTube ────────────────────────────────────────────────────────────────

export interface InnertubeClient {
  key: string;
  label: string;
  userAgent: string;
  context: Record<string, unknown>;
  /** Whether this client returns muxed (video+audio) formats. */
  yieldsMuxed: boolean;
}

/**
 * The clients we ask, in order.
 *
 * ANDROID first because it is the only one of the four that returns a **muxed**
 * format (itag 18, 360p) — the container has no ffmpeg, so an adaptive-only
 * client gives separate video and audio streams we cannot join. IOS is the
 * fallback for metadata and captions; it returns 32 formats but none muxed.
 *
 * WEB is deliberately absent from the playback path: on 2026-08-12 it answered
 * `playabilityStatus: UNPLAYABLE — "Video unavailable"` for a video the ANDROID
 * client served normally. That is the bot-detection wall ytdl-core walks into.
 * It IS used for the microformat block, which is the only place an upload date
 * appears and which WEB returns even while refusing playback.
 */
export const YT_INNERTUBE_CLIENTS: InnertubeClient[] = [
  {
    key: "innertube-android",
    label: "InnerTube ANDROID",
    userAgent: "com.google.android.youtube/20.10.38 (Linux; U; Android 12) gzip",
    context: {
      clientName: "ANDROID",
      clientVersion: "20.10.38",
      androidSdkVersion: 31,
      osName: "Android",
      osVersion: "12",
      hl: "en",
      gl: "IN",
    },
    yieldsMuxed: true,
  },
  {
    key: "innertube-ios",
    label: "InnerTube IOS",
    userAgent: "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X)",
    context: {
      clientName: "IOS",
      clientVersion: "20.10.4",
      deviceMake: "Apple",
      deviceModel: "iPhone16,2",
      osName: "iPhone",
      osVersion: "18.3.2.22D82",
      hl: "en",
      gl: "IN",
    },
    yieldsMuxed: false,
  },
];

const INNERTUBE_URL = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
const INNERTUBE_TIMEOUT_MS = 15_000;

export interface InnertubeResult {
  client: InnertubeClient;
  json: any;
  /** YouTube's own playability verdict: OK, UNPLAYABLE, LOGIN_REQUIRED, ERROR… */
  status: string;
  /** YouTube's own words for a non-OK status. Never our guess. */
  reason: string | null;
}

/** POST the InnerTube player endpoint as one client. Throws only on transport failure. */
async function innertubePlayer(videoId: string, client: InnertubeClient): Promise<InnertubeResult> {
  const res = await fetch(INNERTUBE_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": client.userAgent,
      "accept-language": "en-US,en;q=0.9",
    },
    body: JSON.stringify({
      videoId,
      context: { client: client.context },
      contentCheckOk: true,
      racyCheckOk: true,
    }),
    signal: AbortSignal.timeout(INNERTUBE_TIMEOUT_MS),
  });
  if (!res.ok)
    throw new Error(`InnerTube ${client.context.clientName} returned HTTP ${res.status}`);
  const json = await res.json();
  const ps = json?.playabilityStatus;
  return {
    client,
    json,
    status: typeof ps?.status === "string" ? ps.status : "UNKNOWN",
    reason:
      [ps?.reason, ps?.errorScreen?.playerErrorMessageRenderer?.subreason?.simpleText]
        .filter((s: unknown) => typeof s === "string" && s)
        .join(" — ") || null,
  };
}

/**
 * First client that reports OK, or the last failure so its reason can be shown.
 *
 * `requireMuxed` narrows the pool to clients that can serve a downloadable
 * single file — asking IOS for a download would always fail, and failing for
 * that reason would look like the video being unavailable.
 */
async function firstPlayableClient(
  videoId: string,
  requireMuxed = false,
): Promise<{ ok: InnertubeResult | null; failures: string[] }> {
  const pool = YT_INNERTUBE_CLIENTS.filter((c) => !requireMuxed || c.yieldsMuxed);
  const failures: string[] = [];
  for (const client of pool) {
    try {
      const result = await innertubePlayer(videoId, client);
      if (result.status === "OK") return { ok: result, failures };
      failures.push(
        `${client.label}: ${result.status}${result.reason ? ` — ${result.reason}` : ""}`,
      );
    } catch (err: any) {
      failures.push(`${client.label}: ${err?.message ?? String(err)}`);
    }
  }
  return { ok: null, failures };
}

/** Formats carrying both video and audio — the only ones downloadable without ffmpeg. */
export function muxedFormats(json: any): any[] {
  return (json?.streamingData?.formats ?? []).filter(
    (f: any) => typeof f?.url === "string" && f.url,
  );
}

export interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  name: string;
  isAuto: boolean;
}

export function captionTracksOf(json: any): CaptionTrack[] {
  const raw = json?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const out: CaptionTrack[] = [];
  for (const t of raw) {
    if (typeof t?.baseUrl !== "string" || !t.baseUrl) continue;
    out.push({
      baseUrl: t.baseUrl,
      languageCode: String(t.languageCode ?? ""),
      name: t.name?.simpleText ?? t.name?.runs?.[0]?.text ?? String(t.languageCode ?? "unknown"),
      // "asr" is YouTube's marker for automatic speech recognition. An analyst
      // must be able to tell a machine transcript from an uploader's own.
      isAuto: t.kind === "asr",
    });
  }
  return out;
}

/**
 * The subtitle languages this video really has.
 *
 * This replaces a hardcoded `[{ code: "en", name: "English", isAuto: true }]`,
 * which claimed English auto-captions existed for *every* video regardless of
 * what YouTube said. The dropdown in the screenshot offered "English (en)
 * [Auto]" for a video whose captions the code then declared unavailable — the
 * list was never evidence, it was a constant.
 */
export function captionTracksToLangs(tracks: CaptionTrack[]): YoutubeSubLang[] {
  return tracks.map((t) => ({ code: t.languageCode, name: t.name, isAuto: t.isAuto }));
}

// ─── Subtitle parsing ─────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

export function decodeXmlEntities(text: string): string {
  return text
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

/** Parse WebVTT / SRT subtitle text into timestamped segments. */
export function parseVttSegments(text: string): SubtitleSegment[] {
  const segments: SubtitleSegment[] = [];
  const tsPattern =
    /(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/g;
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    const match = tsPattern.exec(line);
    tsPattern.lastIndex = 0;
    if (match) {
      const start =
        parseInt(match[1]) * 3600 +
        parseInt(match[2]) * 60 +
        parseInt(match[3]) +
        parseInt(match[4]) / 1000;
      const end =
        parseInt(match[5]) * 3600 +
        parseInt(match[6]) * 60 +
        parseInt(match[7]) +
        parseInt(match[8]) / 1000;
      const textLines: string[] = [];
      i++;
      while (i < lines.length && lines[i].trim()) {
        const clean = lines[i].replace(/<[^>]+>/g, "").trim();
        if (clean) textLines.push(clean);
        i++;
      }
      const combined = textLines.join(" ").trim();
      if (combined)
        segments.push({
          start: Math.round(start * 100) / 100,
          end: Math.round(end * 100) / 100,
          text: combined,
        });
    }
    i++;
  }
  return segments;
}

/**
 * Parse YouTube's `<timedtext format="3">` XML.
 *
 * This is what the caption endpoint actually returns, whatever `fmt` is asked
 * for — the absence of this parser is why 93KB of captions was reported as "no
 * subtitles available". The shape:
 *
 *   <p t="750" d="7839">[Music]</p>                    ← plain cue
 *   <p t="9280" d="6399"><s>ridiculous</s><s t="960"> transitions</s></p>
 *   <p t="9270" a="1"></p>                             ← empty rollup placeholder
 *
 * `t` and `d` are milliseconds. Word-level `<s>` children are concatenated in
 * document order; their text is kept verbatim, including the leading-word
 * repetition auto-captions produce, because de-duplicating it would be us
 * editing the transcript rather than reporting it.
 */
export function parseTimedTextXml(xml: string): SubtitleSegment[] {
  const segments: SubtitleSegment[] = [];
  const pPattern = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
  let match: RegExpExecArray | null;
  while ((match = pPattern.exec(xml)) !== null) {
    const attrs = match[1];
    const inner = match[2];

    const tAttr = attrs.match(/\bt="(-?\d+)"/);
    if (!tAttr) continue;
    const startMs = Number(tAttr[1]);
    const dAttr = attrs.match(/\bd="(-?\d+)"/);
    const durMs = dAttr ? Number(dAttr[1]) : 0;

    // Strip <s> wrappers (keeping their text) and any other markup, then decode.
    const text = decodeXmlEntities(inner.replace(/<[^>]*>/g, ""))
      .replace(/\s+/g, " ")
      .trim();
    // Empty <p> elements are rollup placeholders, not silent cues — skipping
    // them keeps the segment count equal to the number of real spoken lines.
    if (!text) continue;

    segments.push({
      start: Math.round((startMs / 1000) * 100) / 100,
      end: Math.round(((startMs + durMs) / 1000) * 100) / 100,
      text,
    });
  }
  return segments;
}

/**
 * Parse a caption payload without trusting the URL we asked for.
 *
 * `&fmt=vtt` is silently ignored by YouTube, so the format must be decided from
 * the bytes rather than the request. Sniffing both ways also means a future
 * change back to real VTT keeps working.
 */
export function parseSubtitleBody(body: string): SubtitleSegment[] {
  const head = body.slice(0, 400);
  if (/<timedtext|<transcript|<\?xml/i.test(head)) {
    const xml = parseTimedTextXml(body);
    if (xml.length > 0) return xml;
  }
  const vtt = parseVttSegments(body);
  if (vtt.length > 0) return vtt;
  // Order matters only when the sniff was wrong; try the other parser last.
  return parseTimedTextXml(body);
}

// ─── Core implementations (run server-side) ───────────────────────────────────

export type ServerResponse<T> =
  | { success: true; data: T }
  | { success: false; error: string; cause: string };

/**
 * ytdl-core, loaded only when needed.
 *
 * A static import took the entire module down under Bun, where
 * `http-cookie-agent` calls `this.compose` on a Dispatcher that does not have
 * it. Since ytdl-core is now only a fallback, a failure to load it must cost
 * the fallback and nothing else.
 */
async function loadYtdl(): Promise<any | null> {
  try {
    const mod: any = await import("@distube/ytdl-core");
    return mod?.default ?? mod;
  } catch {
    return null;
  }
}

/** WEB microformat — the only source of an upload date. Best effort, never fatal. */
async function fetchMicroformat(videoId: string): Promise<any | null> {
  try {
    const res = await fetch(INNERTUBE_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
      },
      body: JSON.stringify({
        videoId,
        context: { client: { clientName: "WEB", clientVersion: "2.20250312.04.00", hl: "en" } },
      }),
      signal: AbortSignal.timeout(INNERTUBE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.microformat?.playerMicroformatRenderer ?? null;
  } catch {
    return null;
  }
}

function thumbnailsOf(json: any, videoId: string): YoutubeThumbnail[] {
  const raw = json?.videoDetails?.thumbnail?.thumbnails ?? [];
  const mapped: YoutubeThumbnail[] = raw
    .filter((t: any) => typeof t?.url === "string")
    .map((t: any) => ({ url: t.url, width: t.width, height: t.height }));
  if (mapped.length > 0) return mapped;
  return [{ url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, width: 480, height: 360 }];
}

/** `"734"` → 734; anything unparseable → undefined, never 0. */
function intOrUndefined(raw: unknown): number | undefined {
  const n = parseInt(String(raw ?? ""), 10);
  return Number.isFinite(n) ? n : undefined;
}

async function _getMetadata(url: string): Promise<ServerResponse<YoutubeMetadata>> {
  if (!isYoutubeUrl(url)) {
    return {
      success: false,
      error: "VideoUnavailable",
      cause: "Invalid URL. Only youtube.com and youtu.be links are supported.",
    };
  }

  const videoId = extractYoutubeId(url);
  if (!videoId) {
    return {
      success: false,
      error: "VideoUnavailable",
      cause: "Invalid YouTube URL format. Could not extract video ID.",
    };
  }

  const attempts: string[] = [];

  // ── 1. InnerTube. Full metadata, no signature to reverse. ──
  const { ok, failures } = await firstPlayableClient(videoId);
  attempts.push(...failures);
  if (ok) {
    const d = ok.json?.videoDetails ?? {};
    const micro = await fetchMicroformat(videoId);
    const tracks = captionTracksOf(ok.json);
    return {
      success: true,
      data: {
        id: String(d.videoId ?? videoId),
        title: String(d.title ?? "Untitled Video"),
        description: String(d.shortDescription ?? ""),
        uploader: String(d.author ?? "Unknown Uploader"),
        channel_id: String(d.channelId ?? ""),
        upload_date: fmtUploadDate(micro?.publishDate ?? micro?.uploadDate),
        duration: intOrUndefined(d.lengthSeconds),
        view_count: intOrUndefined(d.viewCount),
        thumbnails: thumbnailsOf(ok.json, videoId),
        // Real tracks, from YouTube's own list. Empty means genuinely none.
        available_subtitles: captionTracksToLangs(tracks),
        webpage_url: `https://www.youtube.com/watch?v=${videoId}`,
        provenance: {
          source: "youtube",
          model: ok.client.key,
          fetchedAt: new Date().toISOString(),
        },
      },
    };
  }

  // ── 2. ytdl-core. Kept because it may work when InnerTube shifts. ──
  const ytdl = await loadYtdl();
  if (ytdl) {
    try {
      const info = await ytdl.getInfo(url.trim());
      const details = info.videoDetails;
      const captions =
        (info as any).player_response?.captions?.playerCaptionsTracklistRenderer?.captionTracks ??
        [];
      return {
        success: true,
        data: {
          id: details.videoId,
          title: details.title,
          description: details.description || "",
          uploader: details.author?.name || details.ownerChannelName || "Unknown Uploader",
          channel_id: details.author?.channel_url || details.author?.id || "",
          /*
           * ytdl-core names this `publishDate`, not `uploadDate`.
           *
           * Reading only `uploadDate` meant the field was always undefined on
           * this path, so the page rendered "UPLOAD DATE: Unknown" while
           * duration and view count populated from the same object — and the
           * badge read "Verified ytdl-core", confirming the oEmbed fallback was
           * not the cause. A commit that hardened `fmtUploadDate` did not help
           * because the input was empty, not malformed.
           *
           * For OSINT this field is load-bearing: publication date is how you
           * establish when material appeared. Both spellings are read, and both
           * are allowed to be absent rather than defaulted.
           */
          upload_date: fmtUploadDate(
            (details as any).publishDate ??
              (details as any).uploadDate ??
              (details as any).publishedAt,
          ),
          duration: intOrUndefined(details.lengthSeconds),
          view_count: intOrUndefined(details.viewCount),
          thumbnails: (details.thumbnails || []).map((t: any) => ({
            url: t.url,
            width: t.width,
            height: t.height,
          })),
          available_subtitles: captionTracksToLangs(
            captionTracksOf({
              captions: { playerCaptionsTracklistRenderer: { captionTracks: captions } },
            }),
          ),
          webpage_url: details.video_url || url.trim(),
          provenance: {
            source: "youtube",
            model: "ytdl-core",
            fetchedAt: new Date().toISOString(),
          },
        },
      };
    } catch (err: any) {
      attempts.push(`ytdl-core: ${err?.message ?? String(err)}`);
    }
  } else {
    attempts.push("ytdl-core: module failed to load in this runtime");
  }

  // ── 3. oEmbed. Title and channel only — explicitly a partial record. ──
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(url.trim())}&format=json`,
      { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    if (!data) throw new Error("empty json response");

    return {
      success: true,
      data: {
        id: videoId,
        title: data.title || "Untitled Video",
        description: `Channel: ${data.author_name || "YouTube Uploader"}\nURL: ${data.author_url || ""}`,
        uploader: data.author_name || "YouTube Uploader",
        channel_id: data.author_url || "",
        // Not "unknown because the video has none" — unknown because this
        // endpoint does not carry them. The provenance label says which.
        upload_date: undefined,
        duration: undefined,
        view_count: undefined,
        thumbnails: data.thumbnail_url
          ? [
              {
                url: data.thumbnail_url,
                width: data.thumbnail_width,
                height: data.thumbnail_height,
              },
            ]
          : [{ url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, width: 480, height: 360 }],
        // oEmbed knows nothing about captions. Claiming English auto-captions
        // here is what produced a language dropdown for tracks that did not
        // exist; an empty list is the honest answer.
        available_subtitles: [],
        webpage_url: `https://www.youtube.com/watch?v=${videoId}`,
        provenance: {
          source: "youtube",
          model: "yt-oembed-fallback",
          fetchedAt: new Date().toISOString(),
        },
      },
    };
  } catch (oembedErr: any) {
    attempts.push(`oEmbed: ${oembedErr?.message ?? oembedErr}`);
    return {
      success: false,
      error: "VideoUnavailable",
      cause: `Metadata extraction failed on every source. ${attempts.join(" | ")}`,
    };
  }
}

async function _getSubtitles(
  url: string,
  lang = "en",
): Promise<ServerResponse<YoutubeSubtitlesResponse>> {
  if (!isYoutubeUrl(url)) {
    return { success: false, error: "SubsUnavailable", cause: "Invalid YouTube URL." };
  }

  const videoId = extractYoutubeId(url);
  if (!videoId) {
    return {
      success: false,
      error: "SubsUnavailable",
      cause: "Could not extract video ID from URL.",
    };
  }

  const { ok, failures } = await firstPlayableClient(videoId);
  if (!ok) {
    return {
      success: false,
      error: "SubsUnavailable",
      cause:
        `Could not reach the caption list — YouTube refused the player request, so whether this ` +
        `video has subtitles is unknown rather than answered. ${failures.join(" | ")}`,
    };
  }

  const tracks = captionTracksOf(ok.json);
  if (tracks.length === 0) {
    return {
      success: false,
      error: "SubsUnavailable",
      cause: `Video '${videoId}' has no caption tracks at all — YouTube's track list is empty, so there are no subtitles or auto-captions to fetch in any language.`,
    };
  }

  const track =
    tracks.find((t) => t.languageCode === lang) ??
    tracks.find((t) => t.languageCode.split("-")[0] === lang.split("-")[0]) ??
    null;

  if (!track) {
    const offered = tracks.map((t) => `${t.languageCode} (${t.name})`).join(", ");
    return {
      success: false,
      error: "SubsUnavailable",
      cause: `Video '${videoId}' has captions, but not in '${lang}'. Available: ${offered}.`,
    };
  }

  let body: string;
  try {
    // The signed baseUrl is the only working route: the unsigned
    // api/timedtext?v=ID&lang=en endpoint answers 200 with an empty body.
    const res = await fetch(track.baseUrl, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; OSINT-Sentinel/1.0)" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      return {
        success: false,
        error: "SubsUnavailable",
        cause: `The caption track for '${track.languageCode}' exists but could not be downloaded (HTTP ${res.status}).`,
      };
    }
    body = await res.text();
  } catch (err: any) {
    return {
      success: false,
      error: "SubsUnavailable",
      cause: `The caption track for '${track.languageCode}' exists but the download failed: ${err?.message ?? String(err)}.`,
    };
  }

  const segments = parseSubtitleBody(body);
  if (segments.length === 0) {
    // Present-but-unparseable is a different fact from absent, and it points at
    // us rather than at the uploader. Saying "no subtitles available" here is
    // exactly the bug this rewrite fixes.
    return {
      success: false,
      error: "SubsUnavailable",
      cause:
        `YouTube returned a ${body.length}-byte caption track for '${track.languageCode}' that ` +
        `this parser could not read. The captions exist; the failure is on our side, not the ` +
        `uploader's. First bytes: ${JSON.stringify(body.slice(0, 80))}`,
    };
  }

  return {
    success: true,
    data: {
      id: videoId,
      lang: track.languageCode || lang,
      isAuto: track.isAuto,
      segments,
      provenance: {
        source: "youtube",
        model: `${ok.client.key}+timedtext`,
        fetchedAt: new Date().toISOString(),
      },
    },
  };
}

/** Real byte length from the CDN, or undefined. Never an estimate. */
async function probeFilesize(directUrl: string, userAgent: string): Promise<number | undefined> {
  try {
    const res = await fetch(directUrl, {
      method: "HEAD",
      headers: { "user-agent": userAgent },
      signal: AbortSignal.timeout(10_000),
    });
    const len = parseInt(res.headers.get("content-length") ?? "", 10);
    return Number.isFinite(len) && len > 0 ? len : undefined;
  } catch {
    return undefined;
  }
}

async function _getDownloadUrl(
  url: string,
  quality = "720p",
): Promise<ServerResponse<YoutubeDownloadResponse>> {
  if (!isYoutubeUrl(url)) {
    return { success: false, error: "DownloadFailed", cause: "Invalid YouTube URL." };
  }

  const videoId = extractYoutubeId(url);
  if (!videoId) {
    return {
      success: false,
      error: "DownloadFailed",
      cause: "Invalid YouTube URL format. Could not extract video ID.",
    };
  }

  // Only muxed-capable clients: the runtime has no ffmpeg, so adaptive video and
  // audio streams cannot be joined into a downloadable artifact.
  const { ok, failures } = await firstPlayableClient(videoId, true);
  if (ok) {
    const formats = muxedFormats(ok.json).sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
    const best = formats.find((f) => String(f.mimeType ?? "").includes("mp4")) ?? formats[0];
    if (best) {
      const filesize =
        intOrUndefined(best.contentLength) ?? (await probeFilesize(best.url, ok.client.userAgent));
      return {
        success: true,
        data: {
          id: videoId,
          directUrl: best.url,
          format: `mp4 (${best.qualityLabel ?? `${best.height ?? "?"}p`} muxed, itag ${best.itag ?? "?"})`,
          filesize,
          provenance: {
            source: "youtube",
            model: ok.client.key,
            fetchedAt: new Date().toISOString(),
          },
        },
      };
    }
    failures.push(
      `${ok.client.label}: playable, but returned no muxed format — only separate video and ` +
        `audio streams, which need ffmpeg to join and the runtime has none`,
    );
  }

  // ytdl-core fallback. Currently cannot decipher stream URLs (see the header
  // note), but it is left in place for when YouTube's player script changes.
  const ytdl = await loadYtdl();
  if (ytdl) {
    try {
      const info = await ytdl.getInfo(url.trim());
      const muxed = ytdl
        .filterFormats(info.formats, "videoandaudio")
        .filter((f: any) => f.url)
        .sort((a: any, b: any) => (b.height ?? 0) - (a.height ?? 0));
      const best = muxed.find((f: any) => f.container === "mp4") ?? muxed[0];
      if (best?.url) {
        return {
          success: true,
          data: {
            id: info.videoDetails.videoId,
            directUrl: best.url,
            format: `mp4 (${best.height ?? "?"}p muxed)`,
            filesize: intOrUndefined(best.contentLength),
            provenance: {
              source: "youtube",
              model: "ytdl-core-stream",
              fetchedAt: new Date().toISOString(),
            },
          },
        };
      }
      failures.push("ytdl-core: returned no muxed format with a usable URL");
    } catch (err: any) {
      failures.push(`ytdl-core: ${err?.message ?? String(err)}`);
    }
  } else {
    failures.push("ytdl-core: module failed to load in this runtime");
  }

  // The cause is what the sources said, verbatim. It previously asserted "The
  // video may be age-restricted or region-locked" on every failure — a guess at
  // a cause we had not measured, printed as though it were a finding.
  return {
    success: false,
    error: "DownloadFailed",
    cause: `No downloadable artifact could be retrieved for '${videoId}' (requested ${quality}). ${failures.join(" | ")}`,
  };
}

// ─── TanStack Start Server Functions ─────────────────────────────────────────

export const serverFetchYoutubeMetadata = createServerFn({ method: "POST" })
  .validator((data: { url: string }) => data)
  .handler(async ({ data }) => _getMetadata(data.url));

export const serverFetchYoutubeSubtitles = createServerFn({ method: "POST" })
  .validator((data: { url: string; lang?: string }) => data)
  .handler(async ({ data }) => _getSubtitles(data.url, data.lang ?? "en"));

export const serverDownloadYoutubeVideo = createServerFn({ method: "POST" })
  .validator((data: { url: string; quality?: string }) => data)
  .handler(async ({ data }) => _getDownloadUrl(data.url, data.quality ?? "720p"));
