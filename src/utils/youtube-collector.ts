/**
 * YouTube OSINT Collector Utility
 *
 * Client/server wrapper communicating with the FastAPI Python backend (`yt-dlp` engine).
 * Adheres to strict Data Honesty Policy: returns explicit typed error objects on failure,
 * never fake or placeholder data.
 */

import { createServerFn } from "@tanstack/react-start";

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
  path: string;
  filesize?: number;
  format: string;
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

const BACKEND_URL = process.env.FASTAPI_BACKEND_URL || "http://localhost:8000";

/**
 * Validate host client-side before calling server endpoint
 */
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
      host.endsWith(".youtube.com")
    );
  } catch {
    return false;
  }
}

/**
 * Extract YouTube video ID from standard watch / share links
 */
export function extractYoutubeId(url: string): string | null {
  if (!url) return null;
  const match = url.match(
    /(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/
  );
  return match ? match[1] : null;
}

export async function fetchYoutubeMetadata(url: string): Promise<YoutubeMetadata> {
  if (!isYoutubeUrl(url)) {
    throw {
      error: "VideoUnavailable",
      cause: "Invalid URL host. Only youtube.com and youtu.be links are supported.",
    } as YoutubeError;
  }

  const res = await fetch(`${BACKEND_URL}/osint/youtube/metadata`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: url.trim() }),
  });

  const json = await res.json().catch(() => null);

  if (!res.ok) {
    const errDetail = json?.detail || json || {};
    throw {
      error: errDetail.error || "VideoUnavailable",
      cause: errDetail.cause || `HTTP ${res.status}: Failed fetching video metadata.`,
    } as YoutubeError;
  }

  return json as YoutubeMetadata;
}

export async function fetchYoutubeSubtitles(
  url: string,
  lang = "en"
): Promise<YoutubeSubtitlesResponse> {
  const res = await fetch(`${BACKEND_URL}/osint/youtube/subtitles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: url.trim(), lang }),
  });

  const json = await res.json().catch(() => null);

  if (!res.ok) {
    const errDetail = json?.detail || json || {};
    throw {
      error: errDetail.error || "SubsUnavailable",
      cause: errDetail.cause || `No subtitles available for language '${lang}'.`,
    } as YoutubeError;
  }

  return json as YoutubeSubtitlesResponse;
}

export async function downloadYoutubeVideo(
  url: string,
  quality = "720p"
): Promise<YoutubeDownloadResponse> {
  const res = await fetch(`${BACKEND_URL}/osint/youtube/download`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: url.trim(), quality }),
  });

  const json = await res.json().catch(() => null);

  if (!res.ok) {
    const errDetail = json?.detail || json || {};
    throw {
      error: errDetail.error || "DownloadFailed",
      cause: errDetail.cause || `Video artifact download failed.`,
    } as YoutubeError;
  }

  return json as YoutubeDownloadResponse;
}

// Server functions for TanStack Start routing integration
export const serverFetchYoutubeMetadata = createServerFn({ method: "POST" })
  .validator((data: { url: string }) => data)
  .handler(async ({ data }) => fetchYoutubeMetadata(data.url));

export const serverFetchYoutubeSubtitles = createServerFn({ method: "POST" })
  .validator((data: { url: string; lang?: string }) => data)
  .handler(async ({ data }) => fetchYoutubeSubtitles(data.url, data.lang ?? "en"));

export const serverDownloadYoutubeVideo = createServerFn({ method: "POST" })
  .validator((data: { url: string; quality?: string }) => data)
  .handler(async ({ data }) => downloadYoutubeVideo(data.url, data.quality ?? "720p"));
