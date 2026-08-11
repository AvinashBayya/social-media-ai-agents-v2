/**
 * Module 4 — browser-side imaging. Canvas, WASM and video decoding.
 *
 * Everything here runs IN THE BROWSER and nothing runs on the server. That is a
 * deliberate architecture, not an accident of where the libraries work:
 *
 *   - The container scales to zero and has no GPU, so server-side media
 *     processing would be slow, cold-started and metered.
 *   - Tesseract and the C2PA toolkit both ship as WebAssembly. The analyst's
 *     own machine does the work at no cost.
 *   - Uploaded media never leaves the browser. For a defence tool that is worth
 *     saying out loud: an analyst examining a sensitive image is not uploading
 *     it to our container, because there is nothing to upload it to.
 *
 * Every import that touches WASM or a large bundle is DYNAMIC, so none of it is
 * pulled into the SSR bundle or the initial page load. The pure algorithms live
 * in imaging.ts, which this file imports and never the reverse.
 */

import {
  detectSceneCuts,
  hashRgba,
  interpretC2pa,
  interpretExif,
  interpretOcr,
  type C2paReport,
  type ExifReport,
  type Keyframe,
  type OcrReport,
  type SceneReport,
} from "./imaging";

export class MediaError extends Error {
  readonly stage: string;
  constructor(message: string, stage: string) {
    super(message);
    this.name = "MediaError";
    this.stage = stage;
  }
}

// ─── Decoding ──────────────────────────────────────────────────────────────

export interface DecodedImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Longest edge the analysis canvas will use. Bounds memory on a 50MP upload. */
const MAX_ANALYSIS_EDGE = 1600;

function canvas2d(
  width: number,
  height: number,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new MediaError("Canvas 2D context unavailable in this browser.", "decode");
  return { canvas, ctx };
}

export async function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Needed so a remote image can be read back off the canvas. A server without
    // permissive CORS taints the canvas and pixel access throws — reported as
    // such rather than silently producing no hash.
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () =>
      reject(new MediaError(`Image could not be loaded from ${src.slice(0, 120)}`, "decode"));
    img.src = src;
  });
}

/** Decode to RGBA, downscaling anything very large first. */
export async function decodeImage(source: File | Blob | string): Promise<DecodedImage> {
  const url = typeof source === "string" ? source : URL.createObjectURL(source);
  try {
    const img = await loadImageElement(url);
    const scale = Math.min(1, MAX_ANALYSIS_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));

    const { ctx } = canvas2d(width, height);
    ctx.drawImage(img, 0, 0, width, height);
    try {
      const { data } = ctx.getImageData(0, 0, width, height);
      return { data, width, height };
    } catch {
      throw new MediaError(
        "Pixel data could not be read: the image is served without permissive CORS headers, " +
          "which taints the canvas. Download the file and upload it directly to analyse it.",
        "decode",
      );
    }
  } finally {
    if (typeof source !== "string") URL.revokeObjectURL(url);
  }
}

/** Perceptual hash of any image source. */
export async function hashImage(source: File | Blob | string): Promise<string> {
  const { data, width, height } = await decodeImage(source);
  return hashRgba(data, width, height);
}

// ─── EXIF ──────────────────────────────────────────────────────────────────

export async function readExif(file: File | Blob): Promise<ExifReport> {
  const { default: exifr } = await import("exifr");
  try {
    // `true` asks exifr for every segment it can parse, which is what the raw
    // dump displays. A file with no metadata resolves to undefined, and
    // interpretExif reports that as absence rather than as a failure.
    const parsed = await exifr.parse(file as any, true);
    return interpretExif(parsed);
  } catch (err: any) {
    // A parser failure is NOT absence. Returning "no EXIF" here would turn a
    // broken read into a finding about the image.
    throw new MediaError(`EXIF could not be parsed: ${err?.message ?? String(err)}`, "exif");
  }
}

// ─── C2PA ──────────────────────────────────────────────────────────────────

let c2paInstance: any = null;

/**
 * Initialise the contentauth toolkit once per page.
 *
 * The WASM binary and worker are resolved through Vite's ?url handling so they
 * are emitted as real assets and served from our own origin — no CDN, which
 * matters both for the offline case and because a defence tool should not be
 * fetching its verification toolkit from a third party at analysis time.
 */
async function getC2pa(): Promise<any> {
  if (c2paInstance) return c2paInstance;
  const { createC2pa } = await import("c2pa");
  const wasmSrc = (await import("c2pa/dist/assets/wasm/toolkit_bg.wasm?url")).default;
  const workerSrc = (await import("c2pa/dist/c2pa.worker.min.js?url")).default;
  c2paInstance = await createC2pa({ wasmSrc, workerSrc });
  return c2paInstance;
}

export async function readC2pa(source: File | Blob | string): Promise<C2paReport> {
  try {
    const c2pa = await getC2pa();
    const result = await c2pa.read(source as any);
    return interpretC2pa(result);
  } catch (err: any) {
    // Surfaced as status "error", which the UI renders differently from
    // "absent" — "we could not check" is not "there is nothing there".
    return interpretC2pa(null, err?.message ?? String(err));
  }
}

// ─── OCR ───────────────────────────────────────────────────────────────────

export interface OcrProgress {
  status: string;
  progress: number;
}

/**
 * Run Tesseract over an image.
 *
 * Traineddata is fetched on first use per language (roughly 1-15 MB each,
 * cached by the browser afterwards), so the first Indic run needs network. That
 * is surfaced through onProgress rather than appearing as a hang.
 */
export async function runOcr(
  source: File | Blob | string,
  languages: string[],
  onProgress?: (p: OcrProgress) => void,
): Promise<OcrReport> {
  if (languages.length === 0) {
    throw new MediaError("Select at least one language before running OCR.", "ocr");
  }

  const { createWorker } = await import("tesseract.js");
  let worker: any;
  try {
    worker = await createWorker(languages, 1, {
      logger: (m: any) => onProgress?.({ status: m.status ?? "", progress: m.progress ?? 0 }),
    });
    const result = await worker.recognize(source as any);
    return interpretOcr(result, languages);
  } catch (err: any) {
    throw new MediaError(
      `OCR failed for [${languages.join(", ")}]: ${err?.message ?? String(err)}. ` +
        `Language data is downloaded on first use — check network access if this is the ` +
        `first run for this language.`,
      "ocr",
    );
  } finally {
    try {
      await worker?.terminate();
    } catch {
      /* worker already gone */
    }
  }
}

// ─── Video keyframes ───────────────────────────────────────────────────────

export interface KeyframeResult {
  frames: Keyframe[];
  duration: number;
  scenes: SceneReport;
  /** True when sampling stopped at maxFrames before reaching the end. */
  truncated: boolean;
}

/**
 * Extract keyframes by seeking a hidden <video> and painting to a canvas.
 *
 * Entirely in-browser: no ffmpeg, no server, no GPU. Sampling at a fixed
 * interval means everything downstream — scene cuts, corpus matching — is
 * accurate only to within one interval, which the reports state rather than
 * imply away.
 */
export async function extractKeyframes(
  file: File | Blob,
  intervalSeconds = 2,
  maxFrames = 60,
  onProgress?: (done: number, total: number) => void,
): Promise<KeyframeResult> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;

  try {
    const duration = await new Promise<number>((resolve, reject) => {
      video.onloadedmetadata = () => resolve(video.duration);
      video.onerror = () =>
        reject(new MediaError("Video could not be decoded by this browser.", "video"));
      video.src = url;
    });

    if (!Number.isFinite(duration) || duration <= 0) {
      throw new MediaError(
        "Video duration is not reported by the browser, so frames cannot be sampled at " +
          "fixed points. Some streamed or fragmented files behave this way.",
        "video",
      );
    }

    const width = Math.max(1, video.videoWidth);
    const height = Math.max(1, video.videoHeight);
    const scale = Math.min(1, MAX_ANALYSIS_EDGE / Math.max(width, height));
    const cw = Math.max(1, Math.round(width * scale));
    const ch = Math.max(1, Math.round(height * scale));
    const { canvas, ctx } = canvas2d(cw, ch);

    const wanted = Math.floor(duration / intervalSeconds) + 1;
    const total = Math.min(wanted, maxFrames);
    const frames: Keyframe[] = [];

    for (let i = 0; i < total; i += 1) {
      const time = Math.min(i * intervalSeconds, Math.max(0, duration - 0.05));
      await new Promise<void>((resolve, reject) => {
        const onSeeked = () => {
          video.removeEventListener("seeked", onSeeked);
          resolve();
        };
        video.addEventListener("seeked", onSeeked);
        video.onerror = () =>
          reject(new MediaError(`Seek to ${time.toFixed(1)}s failed.`, "video"));
        video.currentTime = time;
      });

      ctx.drawImage(video, 0, 0, cw, ch);
      const { data } = ctx.getImageData(0, 0, cw, ch);
      frames.push({
        time,
        hash: hashRgba(data, cw, ch),
        // Small JPEG thumbnails: 60 full-resolution data URLs would be tens of
        // megabytes of strings held in React state.
        dataUrl: canvas.toDataURL("image/jpeg", 0.6),
      });
      onProgress?.(i + 1, total);
    }

    return {
      frames,
      duration,
      scenes: detectSceneCuts(frames),
      truncated: wanted > maxFrames,
    };
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

/** Re-encode one keyframe data URL as a Blob so OCR can consume it. */
export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl);
  return res.blob();
}

// ─── Corpus persistence ────────────────────────────────────────────────────

import type { HashedImage } from "./imaging";

const CORPUS_KEY = "sentinel_image_hashes";
/** Bounded so localStorage cannot fill up over a long session. */
const CORPUS_MAX = 500;

/**
 * The image-hash corpus, persisted in localStorage.
 *
 * Cross-article matching only works if hashes outlive the page, and there is no
 * database. This is a demo-grade store with the same limitation as the LLM
 * cache: per-browser, and lost when site data is cleared. Postgres with a
 * BK-tree index is what this becomes for real use.
 */
export function loadImageCorpus(): HashedImage[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(CORPUS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveImageCorpus(images: HashedImage[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CORPUS_KEY, JSON.stringify(images.slice(-CORPUS_MAX)));
  } catch {
    // Quota exceeded. Silently dropping is acceptable here — the corpus is a
    // convenience, and the caller's in-memory list is unaffected.
  }
}

/** Add or replace by id, keeping the store bounded. */
export function rememberImage(image: HashedImage): HashedImage[] {
  const existing = loadImageCorpus().filter((i) => i.id !== image.id);
  const next = [...existing, image].slice(-CORPUS_MAX);
  saveImageCorpus(next);
  return next;
}
