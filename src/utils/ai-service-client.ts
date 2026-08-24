/**
 * Browser client for `ai-service` (Module 4 local models) — Grounding DINO
 * object detection, Florence-2 image description, InsightFace face
 * detection + reference-set matching.
 *
 * Unlike imaging.ts/imaging-client.ts (EXIF, C2PA, pHash, Tesseract OCR —
 * all WASM, in this tab), these three run on ai-service's own host: the
 * uploaded image bytes leave the browser. Every call site that uses this
 * client must disclose that, the same way OCR_ASSET_PROVENANCE discloses
 * what a Tesseract run fetches.
 *
 * Same honesty discipline as llm.ts: every failure throws
 * AiServiceUnavailableError with the real upstream cause. No fallback
 * result, no fabricated score — a service that is not running is reported
 * as exactly that, not as "zero detections found".
 */

const DEFAULT_BASE_URL = "http://localhost:8000";

function baseUrl(): string {
  const raw = (import.meta as any).env?.VITE_AI_SERVICE_URL;
  return (typeof raw === "string" && raw.trim() ? raw.trim() : DEFAULT_BASE_URL).replace(/\/+$/, "");
}

export class AiServiceUnavailableError extends Error {
  readonly endpoint: string;
  readonly status?: number;
  constructor(message: string, opts: { endpoint: string; status?: number }) {
    super(message);
    this.name = "AiServiceUnavailableError";
    this.endpoint = opts.endpoint;
    this.status = opts.status;
  }
}

function unreachable(endpoint: string, err: unknown): AiServiceUnavailableError {
  return new AiServiceUnavailableError(
    `Could not reach ai-service at ${baseUrl()}${endpoint}: ${(err as any)?.message ?? String(err)}. ` +
      `Is it running? From ai-service/: uvicorn app.main:app --reload`,
    { endpoint },
  );
}

async function postForm(endpoint: string, form: FormData): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}${endpoint}`, { method: "POST", body: form });
  } catch (err) {
    throw unreachable(endpoint, err);
  }

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const cause = body?.cause ?? body?.error ?? "no error detail returned";
    throw new AiServiceUnavailableError(
      `ai-service ${endpoint} returned HTTP ${res.status}: ${cause}`,
      { endpoint, status: res.status },
    );
  }
  return body;
}

/**
 * What the Local AI Analysis panel touches, stated exactly — mirrors
 * OCR_ASSET_PROVENANCE's role for the in-browser OCR panel. Rendered next
 * to that panel's controls.
 */
export const AI_SERVICE_PROVENANCE = {
  disclosure:
    "Unlike the panels above, this section is not in-browser WASM: the image is sent to " +
    "ai-service, a separate local backend, over HTTP. Nothing leaves this machine in normal " +
    "local development, but this is a real network call, not a client-side computation.",
  models:
    "Object detection: Grounding DINO tiny (Apache 2.0). Deliberately not Ultralytics YOLO, " +
    "which is AGPL-3.0 and would force open-sourcing this entire system without a commercial " +
    "licence. Description and scene-text OCR: Florence-2 (MIT) — the same model instance " +
    "serves both, via different task prompts. Face detection/matching: InsightFace (MIT).",
} as const;

export interface AiServiceHealth {
  status: string;
  device: string;
  models: Record<string, string>;
}

export async function aiServiceHealth(): Promise<AiServiceHealth> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}/health`);
  } catch (err) {
    throw unreachable("/health", err);
  }
  if (!res.ok) {
    throw new AiServiceUnavailableError(`ai-service /health returned HTTP ${res.status}`, {
      endpoint: "/health",
      status: res.status,
    });
  }
  return res.json();
}

export interface AiDetection {
  label: string;
  score: number;
  box: [number, number, number, number];
}
export interface AiDetectResult {
  detections: AiDetection[];
  provenance: { model: string; version: string };
}

/** prompts: open-vocabulary phrases, e.g. ["a rifle", "a military vehicle"]. */
export async function aiServiceDetect(file: Blob, prompts: string[]): Promise<AiDetectResult> {
  const form = new FormData();
  form.append("file", file, "image");
  form.append("prompts", prompts.join(","));
  return postForm("/ai/detect", form);
}

export interface AiDescribeResult {
  description: string;
  provenance: { model: string; version: string };
}

export async function aiServiceDescribe(file: Blob): Promise<AiDescribeResult> {
  const form = new FormData();
  form.append("file", file, "image");
  return postForm("/ai/describe", form);
}

export interface AiOcrVlmResult {
  text: string;
  provenance: { model: string; version: string };
}

/**
 * Scene-text OCR via Florence-2 — a sibling of the in-browser Tesseract OCR
 * (imaging-client.ts's runOcr), not a replacement. Reaches for a different
 * tool for a different failure mode: Tesseract needs no network and no
 * server, and is the right choice for a clean document/screenshot; this
 * sends the image to ai-service and is the one that actually works when
 * legible text shares the frame with a busy photographic background,
 * which Tesseract's layout analysis structurally struggles with — verified
 * live 2026-08-20 against a real composition of that kind.
 */
export async function aiServiceOcrVlm(file: Blob): Promise<AiOcrVlmResult> {
  const form = new FormData();
  form.append("file", file, "image");
  return postForm("/ai/ocr/vlm", form);
}

export interface AiFaceReference {
  id: string;
  file: Blob;
}
export interface AiFace {
  box: [number, number, number, number];
  landmarks: [number, number][];
  matchId: string | null;
  matchScore: number | null;
}
export interface AiFacesResult {
  faces: AiFace[];
  provenance: { model: string; version: string };
}

/**
 * `references` are photos the caller supplies for THIS call only — there is
 * no persisted watchlist anywhere in this client or in ai-service, and no
 * open-web search. Omit `references` for detection-only; every returned
 * face's matchId/matchScore stays null until a reference is supplied and
 * clears ai-service's similarity threshold.
 */
export async function aiServiceFaces(
  file: Blob,
  references: AiFaceReference[] = [],
): Promise<AiFacesResult> {
  const form = new FormData();
  form.append("file", file, "image");
  for (const ref of references) form.append("references", ref.file, ref.id);
  if (references.length) form.append("reference_ids", references.map((r) => r.id).join(","));
  return postForm("/ai/faces", form);
}
