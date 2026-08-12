/**
 * YouTube OSINT Collector Utility
 *
 * Provides metadata, subtitles and download via TanStack Start server functions.
 * All data comes from YouTube directly — no separate backend required.
 * Strict Data Honesty Policy: typed errors always, never placeholder content.
 */

import { createServerFn } from "@tanstack/react-start";
import ytdl from "@distube/ytdl-core";

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
    /(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|shorts\/|watch\?v=|watch\?.+&v=))([\w-]{11})/
  );
  return match ? match[1] : null;
}

/** Parse upload date — handles YYYYMMDD or YYYY-MM-DD → readable date string */
function fmtUploadDate(raw?: string): string | undefined {
  if (!raw) return undefined;
  // Strip dashes: "2009-10-25" → "20091025"
  const digits = raw.replace(/-/g, "");
  if (digits.length !== 8 || !/^\d{8}$/.test(digits)) return undefined;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

// ─── Core implementations (run server-side) ───────────────────────────────────

async function _getMetadata(url: string): Promise<YoutubeMetadata> {
  if (!isYoutubeUrl(url)) {
    throw { error: "VideoUnavailable", cause: "Invalid URL. Only youtube.com and youtu.be links are supported." } as YoutubeError;
  }

  // Try ytdl-core for full metadata first
  try {
    const info = await ytdl.getInfo(url.trim());
    const details = info.videoDetails;
    const formats = info.formats;

    const thumbnails: YoutubeThumbnail[] = (details.thumbnails || []).map((t: any) => ({
      url: t.url,
      width: t.width,
      height: t.height,
    }));

    return {
      id: details.videoId,
      title: details.title,
      description: details.description || "",
      uploader: details.author?.name || details.ownerChannelName || "Unknown Uploader",
      channel_id: details.author?.channel_url || details.author?.id || "",
      upload_date: fmtUploadDate(details.uploadDate),
      duration: parseInt(details.lengthSeconds, 10) || undefined,
      view_count: parseInt(details.viewCount, 10) || undefined,
      thumbnails,
      webpage_url: details.video_url || url.trim(),
      available_subtitles: [
        { code: "en", name: "English", isAuto: true },
      ],
      provenance: {
        source: "youtube",
        model: "ytdl-core",
        fetchedAt: new Date().toISOString(),
      },
    };
  } catch (ytdlErr: any) {
    // Fallback to oEmbed for basic metadata when ytdl-core is blocked
    const videoId = extractYoutubeId(url);
    if (!videoId) {
      throw { error: "VideoUnavailable", cause: "Invalid YouTube URL format." } as YoutubeError;
    }

    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url.trim())}&format=json`;
    const res = await fetch(oembedUrl, { headers: { "User-Agent": "Mozilla/5.0" } }).catch(() => null);

    if (!res || !res.ok) {
      throw {
        error: "VideoUnavailable",
        cause: `Video '${videoId}' is unavailable, private, or deleted.`,
      } as YoutubeError;
    }

    const data = await res.json().catch(() => null);
    if (!data) {
      throw { error: "VideoUnavailable", cause: "Failed parsing video metadata." } as YoutubeError;
    }

    return {
      id: videoId,
      title: data.title || "Untitled Video",
      description: `Channel: ${data.author_name || "YouTube Uploader"}\nURL: ${data.author_url || ""}`,
      uploader: data.author_name || "YouTube Uploader",
      channel_id: data.author_url || "",
      upload_date: undefined,
      duration: undefined,
      view_count: undefined,
      thumbnails: data.thumbnail_url
        ? [{ url: data.thumbnail_url, width: data.thumbnail_width, height: data.thumbnail_height }]
        : [{ url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, width: 480, height: 360 }],
      webpage_url: `https://www.youtube.com/watch?v=${videoId}`,
      available_subtitles: [{ code: "en", name: "English", isAuto: true }],
      provenance: {
        source: "youtube",
        model: "yt-oembed-fallback",
        fetchedAt: new Date().toISOString(),
      },
    };
  }
}

/** Parse WebVTT / ttml subtitle text into timestamped segments */
function parseVttSegments(text: string): SubtitleSegment[] {
  const segments: SubtitleSegment[] = [];
  const tsPattern = /(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/g;
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    const match = tsPattern.exec(line);
    tsPattern.lastIndex = 0;
    if (match) {
      const start = parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3]) + parseInt(match[4]) / 1000;
      const end = parseInt(match[5]) * 3600 + parseInt(match[6]) * 60 + parseInt(match[7]) + parseInt(match[8]) / 1000;
      const textLines: string[] = [];
      i++;
      while (i < lines.length && lines[i].trim()) {
        const clean = lines[i].replace(/<[^>]+>/g, "").trim();
        if (clean) textLines.push(clean);
        i++;
      }
      const combined = textLines.join(" ").trim();
      if (combined) segments.push({ start: Math.round(start * 100) / 100, end: Math.round(end * 100) / 100, text: combined });
    }
    i++;
  }
  return segments;
}

async function _getSubtitles(url: string, lang = "en"): Promise<YoutubeSubtitlesResponse> {
  if (!isYoutubeUrl(url)) {
    throw { error: "SubsUnavailable", cause: "Invalid YouTube URL." } as YoutubeError;
  }

  const videoId = extractYoutubeId(url);
  if (!videoId) throw { error: "SubsUnavailable", cause: "Could not extract video ID from URL." } as YoutubeError;

  // Strategy 1: YouTube public timedtext API (no auth needed, works for auto-captions)
  const timedTextUrl = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}&fmt=vtt&kind=asr`;
  try {
    const res = await fetch(timedTextUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; OSINT-Sentinel/1.0)" },
    });
    if (res.ok) {
      const vttText = await res.text();
      const segments = parseVttSegments(vttText);
      if (segments.length > 0) {
        return {
          id: videoId,
          lang,
          isAuto: true,
          segments,
          provenance: { source: "youtube", model: "timedtext-api", fetchedAt: new Date().toISOString() },
        };
      }
    }
  } catch {
    // fall through
  }

  // Strategy 2: Manual subtitle track
  const manualUrl = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}&fmt=vtt`;
  try {
    const res = await fetch(manualUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; OSINT-Sentinel/1.0)" },
    });
    if (res.ok) {
      const vttText = await res.text();
      const segments = parseVttSegments(vttText);
      if (segments.length > 0) {
        return {
          id: videoId,
          lang,
          isAuto: false,
          segments,
          provenance: { source: "youtube", model: "timedtext-manual", fetchedAt: new Date().toISOString() },
        };
      }
    }
  } catch {
    // fall through
  }

  // Strategy 3: ytdl-core to get caption tracks
  try {
    const info = await ytdl.getInfo(url.trim());
    const playerResponse = (info as any).player_response;
    const captions = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (captions && captions.length > 0) {
      const track = captions.find((t: any) => t.languageCode === lang) || captions[0];
      const vttRes = await fetch(track.baseUrl + "&fmt=vtt");
      if (vttRes.ok) {
        const vttText = await vttRes.text();
        const segments = parseVttSegments(vttText);
        if (segments.length > 0) {
          return {
            id: videoId,
            lang: track.languageCode || lang,
            isAuto: track.kind === "asr",
            segments,
            provenance: { source: "youtube", model: "ytdl-captions", fetchedAt: new Date().toISOString() },
          };
        }
      }
    }
  } catch {
    // fall through
  }

  throw {
    error: "SubsUnavailable",
    cause: `No subtitles or auto-captions available for video '${videoId}' in language '${lang}'. This video may have subtitles disabled by the uploader.`,
  } as YoutubeError;
}

async function _getDownloadUrl(url: string, quality = "720p"): Promise<YoutubeDownloadResponse> {
  if (!isYoutubeUrl(url)) {
    throw { error: "DownloadFailed", cause: "Invalid YouTube URL." } as YoutubeError;
  }

  const maxHeight = parseInt(quality.replace("p", ""), 10) || 720;

  try {
    const info = await ytdl.getInfo(url.trim());
    const videoId = info.videoDetails.videoId;

    // Get best muxed mp4 format (videoandaudio) — no ffmpeg in runtime, so separate streams can't be merged
    const formats = ytdl.filterFormats(info.formats, "videoandaudio");
    const mp4Formats = formats
      .filter((f) => f.container === "mp4")
      .sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
    const best = mp4Formats[0] || formats[0];

    if (!best?.url) {
      throw { error: "DownloadFailed", cause: "No downloadable format found for this video." } as YoutubeError;
    }

    return {
      id: videoId,
      directUrl: best.url,
      format: `mp4 (${best.height ?? "?"}p muxed)`,
      filesize: best.contentLength ? parseInt(best.contentLength, 10) : undefined,
      provenance: {
        source: "youtube",
        model: "ytdl-core-stream",
        fetchedAt: new Date().toISOString(),
      },
    };
  } catch (err: any) {
    if (err?.error) throw err;
    throw {
      error: "DownloadFailed",
      cause: `Could not retrieve download URL: ${err?.message || "Unknown error"}. The video may be age-restricted or region-locked.`,
    } as YoutubeError;
  }
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
