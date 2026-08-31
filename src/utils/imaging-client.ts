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
 *   - Nothing third-party is pulled INTO the browser either. Both c2pa and
 *     tesseract.js default to loading their worker script and WASM engine from
 *     a CDN at the moment the analyst presses the button; both are instead
 *     emitted from node_modules as first-party assets (Vite `?url`) and served
 *     from our own origin. Third-party JavaScript executing on an analyst's
 *     machine mid-analysis is not acceptable here, and a CDN dependency would
 *     make the tool unusable on a network without egress.
 *
 * Every import that touches WASM or a large bundle is DYNAMIC, so none of it is
 * pulled into the SSR bundle or the initial page load. The pure algorithms live
 * in imaging.ts, which this file imports and never the reverse.
 */

import {
  detectSceneCuts,
  grayscaleAutocontrastRgba,
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

// ─── OCR engine assets: first-party, never a CDN ───────────────────────────

/**
 * WebAssembly SIMD probes, inlined.
 *
 * These two byte sequences are exactly the modules `wasm-feature-detect`
 * (Apache-2.0, v1.8.0 — already installed, tesseract.js depends on it) hands to
 * WebAssembly.validate, and they are the same two checks tesseract.js runs
 * inside its own worker when it is left to choose a core. Inlining them keeps
 * our choice identical to the library's while adding no dependency to
 * package.json, which matters because the Docker build runs
 * `bun install --frozen-lockfile`.
 */
const WASM_SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15,
  253, 98, 11,
]);
const WASM_RELAXED_SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 15, 1, 13, 0, 65, 1, 253, 15,
  65, 2, 253, 15, 253, 128, 2, 11,
]);

/**
 * Resolve the Tesseract worker script and WASM core as FIRST-PARTY assets.
 *
 * Left alone, tesseract.js 7.0.0 loads BOTH from jsDelivr at the moment OCR is
 * run — `dist/worker.min.js` and a `tesseract.js-core` build. That is
 * third-party JavaScript executing on the analyst's machine while they examine
 * sensitive media, undisclosed, and it makes OCR impossible without egress.
 * Vite's `?url` emits the installed files as our own assets instead, exactly as
 * getC2pa() above does for the C2PA toolkit.
 *
 * WHICH CORE. tesseract.js-core 7.0.0 ships six builds — {plain, simd,
 * relaxedsimd} x {full, -lstm} — and each `*.wasm.js` is self-contained: the
 * .wasm is embedded as base64, which is why no separate .wasm request is ever
 * made and why corePath points at the .wasm.js, not the .wasm. The "-lstm"
 * halves drop the legacy engine and are what OEM.LSTM_ONLY needs; that is the
 * `1` passed to createWorker below, so the two must be changed together.
 *
 * Why probe rather than hard-code: picking a build the browser cannot compile
 * does NOT fail loudly. worker-script/index.js calls the core factory with no
 * .catch and only resolves on success, so a CompileError leaves the createWorker
 * promise pending forever and the UI simply hangs. The plain build is the
 * fallback because every WASM-capable engine can run it. Passing an explicit
 * file also bypasses tesseract's own directory-based detection, which is
 * unavoidable here: Vite content-hashes emitted asset names, so there is no
 * directory of predictably-named files to hand it.
 */
async function resolveOcrEngine(): Promise<{
  workerPath: string;
  corePath: string;
  coreBuild: string;
}> {
  const workerPath = (await import("tesseract.js/dist/worker.min.js?url")).default;

  if (WebAssembly.validate(WASM_RELAXED_SIMD_PROBE)) {
    return {
      workerPath,
      coreBuild: "relaxedsimd-lstm",
      corePath: (await import("tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js?url"))
        .default,
    };
  }
  if (WebAssembly.validate(WASM_SIMD_PROBE)) {
    return {
      workerPath,
      coreBuild: "simd-lstm",
      corePath: (await import("tesseract.js-core/tesseract-core-simd-lstm.wasm.js?url")).default,
    };
  }
  return {
    workerPath,
    coreBuild: "lstm",
    corePath: (await import("tesseract.js-core/tesseract-core-lstm.wasm.js?url")).default,
  };
}

/**
 * Language models (.traineddata) — the one thing still fetched from elsewhere.
 *
 * Deliberately NOT bundled. The fourteen packs in OCR_LANGUAGES total ~27.6 MB
 * compressed (measured against the CDN on 2026-08-12: 0.98 MB for Urdu up to
 * 5.4 MB for Sanskrit), and tesseract accepts a single FLAT directory for every
 * language — `${langPath}/${lang}.traineddata.gz`, no per-language segment — so
 * it is all fourteen or none. "All" means ~28 MB of model data in a
 * scale-to-zero container image, paid as cold-start weight on every revision,
 * to serve an analyst who typically selects one or two languages.
 *
 * So the default keeps tesseract.js 7.0.0's own per-language CDN layout,
 * verified 200 on 2026-08-12:
 *   https://cdn.jsdelivr.net/npm/@tesseract.js-data/<lang>/4.0.0_best_int/<lang>.traineddata.gz
 * The browser then caches each pack in IndexedDB (idb-keyval). This is DATA
 * consumed by our WASM, not third-party code executed in the analyst's browser —
 * a materially smaller exposure than the worker and core above — but it is still
 * a remote fetch, so the UI names it.
 *
 * AIR-GAPPED / no-egress deployment: serve the needed `<lang>.traineddata.gz`
 * files from one flat directory on this origin and rebuild with
 *   VITE_TESSERACT_LANG_PATH=/tessdata
 * (an absolute path or a full URL). With it set, OCR contacts nothing but this
 * origin. It is read at BUILD time — it must be present for `bun run build` /
 * the `az acr build` arguments, NOT set as a container-app env var.
 */
const RAW_LANG_PATH = import.meta.env?.VITE_TESSERACT_LANG_PATH;
const LOCAL_TRAINEDDATA_PATH: string | null =
  typeof RAW_LANG_PATH === "string" && RAW_LANG_PATH.trim() !== ""
    ? RAW_LANG_PATH.trim().replace(/\/+$/, "")
    : null;

export interface OcrAssetProvenance {
  /** Worker script + WASM engine. Always served by this deployment. */
  engine: "first-party";
  /** Where .traineddata comes from at analysis time. */
  trainedData: "first-party" | "jsdelivr-cdn";
  /** The exact location an analyst can check against the network tab. */
  trainedDataUrl: string;
  /** Verbatim UI text. Render it as-is; do not paraphrase it in a component. */
  disclosure: string;
}

/**
 * What OCR touches on the network, stated exactly. Rendered next to the OCR
 * control on both the image and video routes.
 */
export const OCR_ASSET_PROVENANCE: OcrAssetProvenance = LOCAL_TRAINEDDATA_PATH
  ? {
      engine: "first-party",
      trainedData: "first-party",
      trainedDataUrl: `${LOCAL_TRAINEDDATA_PATH}/<lang>.traineddata.gz`,
      disclosure:
        "OCR runs entirely in this browser tab and the image is never uploaded. The Tesseract " +
        "worker script, the WebAssembly engine and the language models are all served by this " +
        `deployment from ${LOCAL_TRAINEDDATA_PATH}/ — no third-party host is contacted at any ` +
        "point, so OCR works with no external network access.",
    }
  : {
      engine: "first-party",
      trainedData: "jsdelivr-cdn",
      trainedDataUrl:
        "https://cdn.jsdelivr.net/npm/@tesseract.js-data/<lang>/4.0.0_best_int/<lang>.traineddata.gz",
      disclosure:
        "OCR runs entirely in this browser tab and the image is never uploaded. The Tesseract " +
        "worker script and WebAssembly engine are served by this deployment, so no third-party " +
        "code is fetched or executed here. Language models are not bundled: the first OCR run " +
        "for each language downloads <lang>.traineddata.gz from the public jsDelivr CDN " +
        "(cdn.jsdelivr.net/npm/@tesseract.js-data), roughly 1-6 MB per language, and the browser " +
        "then caches it in IndexedDB. That request discloses this machine's IP address and the " +
        "language codes selected — nothing else, and never the image. An air-gapped deployment " +
        "must host those files itself and rebuild with VITE_TESSERACT_LANG_PATH set to their " +
        "directory.",
    };

/**
 * Upscale threshold and cap. Tesseract's own guidance targets roughly 300
 * DPI-equivalent text; a screenshot or frame-grab is routinely far below
 * that. Only ever scales UP — a source already larger than the cap is left
 * alone rather than downscaled, since that would only lose legibility.
 */
const OCR_MIN_LONG_EDGE = 1600;
const OCR_MAX_LONG_EDGE = 3200;

/**
 * Grayscale + percentile autocontrast + upscale-if-small, before Tesseract
 * ever sees the image — see grayscaleAutocontrastRgba's doc comment in
 * imaging.ts for what this does and does not fix, and the live verification
 * behind both. Returns a canvas; tesseract.js accepts one directly, so no
 * extra Blob round-trip is needed.
 */
async function preprocessForOcr(source: File | Blob | string): Promise<HTMLCanvasElement> {
  const url = typeof source === "string" ? source : URL.createObjectURL(source);
  try {
    const img = await loadImageElement(url);
    const longEdge = Math.max(img.naturalWidth, img.naturalHeight);
    const scale =
      longEdge < OCR_MIN_LONG_EDGE ? Math.min(OCR_MIN_LONG_EDGE / longEdge, OCR_MAX_LONG_EDGE / longEdge) : 1;
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));

    const { canvas, ctx } = canvas2d(width, height);
    ctx.drawImage(img, 0, 0, width, height);
    const imageData = ctx.getImageData(0, 0, width, height);
    imageData.data.set(grayscaleAutocontrastRgba(imageData.data));
    ctx.putImageData(imageData, 0, 0);
    return canvas;
  } finally {
    if (typeof source !== "string") URL.revokeObjectURL(url);
  }
}

/**
 * Run Tesseract over an image.
 *
 * The worker script and WASM engine come from this deployment (see
 * resolveOcrEngine). Traineddata is fetched on first use per language — from
 * this origin if VITE_TESSERACT_LANG_PATH was set at build time, otherwise from
 * the CDN named in OCR_ASSET_PROVENANCE — so the first run for a language needs
 * network unless a mirror is configured. That is surfaced through onProgress
 * rather than appearing as a hang.
 */
export async function runOcr(
  source: File | Blob | string,
  languages: string[],
  onProgress?: (p: OcrProgress) => void,
): Promise<OcrReport> {
  if (languages.length === 0) {
    throw new MediaError("Select at least one language before running OCR.", "ocr");
  }

  const { createWorker, PSM } = await import("tesseract.js");
  let worker: any;
  let coreBuild = "unresolved";
  try {
    // workerPath and corePath are OUR assets. Without them tesseract.js 7.0.0
    // fetches dist/worker.min.js and a tesseract.js-core build from
    // cdn.jsdelivr.net at this exact moment. The `1` is OEM.LSTM_ONLY and must
    // stay in step with the "-lstm" core resolveOcrEngine returns. langPath is
    // passed only when a first-party mirror was configured at build time; left
    // unset, tesseract keeps its own per-language CDN layout, which
    // OCR_ASSET_PROVENANCE states verbatim in the UI.
    const engine = await resolveOcrEngine();
    coreBuild = engine.coreBuild;
    worker = await createWorker(languages, 1, {
      workerPath: engine.workerPath,
      corePath: engine.corePath,
      ...(LOCAL_TRAINEDDATA_PATH ? { langPath: LOCAL_TRAINEDDATA_PATH } : {}),
      logger: (m: any) => onProgress?.({ status: m.status ?? "", progress: m.progress ?? 0 }),
    });
    // Tesseract's default page-segmentation mode (AUTO) assumes a single
    // uniform block of text, the scanned-document case. This app's real
    // inputs are OSINT material — video frames, screenshots, title cards,
    // memes — routinely a small text block sharing the frame with a photo,
    // logo or decorative graphic, which AUTO's layout analysis regularly
    // misreads as more text and garbles. Verified live 2026-08-20 against a
    // reproduction of exactly that composition: AUTO returned near-total
    // garbage ("Ea a) RI Xa A= ...") at mean confidence ~24; SPARSE_TEXT —
    // "find as much text as possible, in no particular order", built for
    // this exact case — correctly recovered "AI POWERED" / "DIGITAL HEALTH
    // CARD". AUTO_OSD scored about the same; SPARSE_TEXT is the
    // semantically correct mode for content with no assumed page layout.
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
    // tesseract.js 7's `output` param controls which parts of the result are
    // populated — `blocks` (the only place word-level text/confidence/bbox
    // live, nested blocks[].paragraphs[].lines[].words[]) is NOT included by
    // default. Left unset, `data.blocks` comes back null and every word is
    // silently lost even though `data.text`/`data.confidence` succeed —
    // verified live: a real image recognized with 95% confidence and the
    // correct text, yet reported zero words, because nothing ever asked for
    // block data. See interpretOcr's flattenOcrWords for the other half.
    const preprocessed = await preprocessForOcr(source);
    const result = await worker.recognize(preprocessed, {}, { text: true, blocks: true });
    return interpretOcr(result, languages);
  } catch (err: any) {
    throw new MediaError(
      `OCR failed for [${languages.join(", ")}] on the ${coreBuild} core: ` +
        `${err?.message ?? String(err)}. The worker script and WebAssembly engine are served by ` +
        `this deployment, so this is not a CDN failure. ` +
        (LOCAL_TRAINEDDATA_PATH
          ? `Language models are read from ${LOCAL_TRAINEDDATA_PATH}/<lang>.traineddata.gz — ` +
            `check that every selected language is present there.`
          : `Language models are still fetched on first use from ` +
            `cdn.jsdelivr.net/npm/@tesseract.js-data — check network access if this is the ` +
            `first run for one of these languages.`),
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

/**
 * Re-seeks the source video and captures ONE frame at full quality — no
 * lossy re-encoding, same resolution cap as any other decode path here.
 *
 * `extractKeyframes` above stores every frame as a JPEG data URL at quality
 * 0.6, deliberately: up to `maxFrames` (60) full-resolution data URLs held
 * in React state at once would be tens of megabytes of strings. That
 * trade-off is fine for the thumbnail grid, but OCR and the AI-analysis
 * panel were reading the SAME degraded copy — verified live: legible,
 * high-contrast on-screen text (a title card, not fine print) produced
 * zero OCR words, because 60%-quality JPEG's blocking artifacts around
 * thin character strokes are exactly what breaks Tesseract's segmentation.
 * A single on-demand frame has none of the 60-frames-at-once memory
 * pressure the thumbnail path is optimized against, so this re-decodes the
 * one frame the analyst actually selected, straight to a lossless PNG
 * blob, only when they ask to analyse it.
 */
export async function extractFrameBlob(file: File | Blob, time: number): Promise<Blob> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;

  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () =>
        reject(new MediaError("Video could not be decoded by this browser.", "video"));
      video.src = url;
    });

    const width = Math.max(1, video.videoWidth);
    const height = Math.max(1, video.videoHeight);
    const scale = Math.min(1, MAX_ANALYSIS_EDGE / Math.max(width, height));
    const cw = Math.max(1, Math.round(width * scale));
    const ch = Math.max(1, Math.round(height * scale));
    const { canvas, ctx } = canvas2d(cw, ch);

    await new Promise<void>((resolve, reject) => {
      const onSeeked = () => {
        video.removeEventListener("seeked", onSeeked);
        resolve();
      };
      video.addEventListener("seeked", onSeeked);
      video.onerror = () => reject(new MediaError(`Seek to ${time.toFixed(1)}s failed.`, "video"));
      video.currentTime = time;
    });

    ctx.drawImage(video, 0, 0, cw, ch);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new MediaError("Could not encode the extracted frame.", "video");
    return blob;
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

/**
 * Crops one rectangular region out of `source` at full quality — no
 * MAX_ANALYSIS_EDGE downscaling, unlike `decodeImage` above, since this is
 * for an analyst zooming into a detail (a license plate, a weapon), not bulk
 * pixel analysis. `box` is `[x0, y0, x1, y1]` in the SAME pixel space the
 * caller's coordinates already are in — for a Grounding DINO detection, that
 * is the exact image `Blob` that was sent to `/ai/detect`, since ai-service
 * returns box coordinates relative to whatever image it actually received
 * (see `ai-service/app/detect.py`'s `target_sizes`) — so the caller must crop
 * from that SAME blob, never a separately-loaded/rescaled copy, or the crop
 * will land on the wrong region.
 */
export async function cropImageRegion(source: Blob, box: [number, number, number, number]): Promise<Blob> {
  const url = URL.createObjectURL(source);
  try {
    const img = await loadImageElement(url);
    const [bx0, by0, bx1, by1] = box;
    const left = Math.max(0, Math.min(bx0, bx1));
    const top = Math.max(0, Math.min(by0, by1));
    const right = Math.min(img.naturalWidth, Math.max(bx0, bx1));
    const bottom = Math.min(img.naturalHeight, Math.max(by0, by1));
    const width = Math.max(1, Math.round(right - left));
    const height = Math.max(1, Math.round(bottom - top));

    const { canvas, ctx } = canvas2d(width, height);
    ctx.drawImage(img, left, top, width, height, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new MediaError("Could not export the cropped region as an image.", "crop");
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
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
