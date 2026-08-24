/**
 * Server-side audio transcription via Sarvam's Speech-to-Text API — Module 4
 * (Video Intelligence), for a user-uploaded video's audio track. Sarvam is
 * an approved provider (Apache 2.0, Indian) per CLAUDE.md; this reuses the
 * SAME `LLM_API_KEY` already configured for chat (empirically verified live
 * against the real endpoints below — Sarvam's `api-subscription-key` header
 * accepts it) rather than requiring a second credential to set up.
 *
 * Sarvam exposes two genuinely different shapes, both verified live end to
 * end against the real API before this file was written:
 *
 *   SYNC   `POST /speech-to-text` — one multipart call, response inline.
 *          Documented limit: clips under 30 seconds.
 *   BATCH  A five-step async job (init -> upload-files -> PUT to a
 *          presigned Azure Blob SAS URL -> start -> poll status -> download-
 *          files -> GET the result JSON from a second presigned URL).
 *          Handles files up to 2 hours.
 *
 * The batch job is driven by the CLIENT polling `checkTranscriptionJob`
 * repeatedly, not by this server holding one request open for however long
 * the job takes — a multi-minute (or multi-hour, for a 2-hour file) held
 * connection would risk a gateway/proxy timeout long before Sarvam finishes.
 * `startAudioTranscription` only ever does the synchronous part (init +
 * upload + start, or the full sync call for a short clip) and returns
 * immediately.
 *
 * Every failure throws `TranscriptionUnavailableError` with the real
 * upstream cause — no fallback text, no fabricated transcript. A job that
 * Sarvam itself reports as Failed surfaces Sarvam's own error_message.
 */

import { createServerFn } from "@tanstack/react-start";

/** Sarvam's own documented cutoff for the synchronous endpoint. A few
 * seconds of safety margin rather than cutting it exactly at 30. */
const SYNC_MAX_DURATION_S = 27;

const SYNC_TIMEOUT_MS = 30_000;
const JOB_CALL_TIMEOUT_MS = 20_000;
const UPLOAD_TIMEOUT_MS = 120_000;

export class TranscriptionUnavailableError extends Error {
  readonly status?: number;
  constructor(message: string, opts?: { status?: number }) {
    super(message);
    this.name = "TranscriptionUnavailableError";
    this.status = opts?.status;
  }
}

function sttBaseUrl(): string {
  const raw = process.env.SARVAM_STT_BASE_URL;
  return (typeof raw === "string" && raw.trim() ? raw.trim() : "https://api.sarvam.ai").replace(
    /\/+$/,
    "",
  );
}

function apiKey(): string {
  const key = process.env.SARVAM_API_KEY || process.env.LLM_API_KEY;
  if (!key) {
    throw new TranscriptionUnavailableError(
      "No Sarvam API key configured. Set SARVAM_API_KEY, or LLM_API_KEY (the same Sarvam " +
        "key already used for chat/report generation works for speech-to-text too).",
    );
  }
  return key;
}

/**
 * Sarvam's declared Content-Type whitelist, verified live 2026-08-20 from
 * the real 400 body both endpoints return for a rejected type (identical on
 * sync and batch). Notably: video containers are almost entirely rejected —
 * `video/webm` is explicitly allowed, but a browser-uploaded `video/mp4`
 * (what `<input type="file">` reports for an .mp4 upload) is NOT, even
 * though the public docs describe "MP4/M4A" as a supported format — in
 * practice that means the audio-only M4A variant (`audio/mp4`), not an
 * arbitrary video/mp4 container. Rather than reject every non-WebM video
 * upload outright, or silently mislabel it as an audio/* type Sarvam would
 * then fail to demux, unrecognised types fall back to the ALSO-whitelisted
 * `application/octet-stream` — verified live end-to-end (sync and the full
 * batch job) to actually decode correctly, not just pass the type check.
 */
const SARVAM_ACCEPTED_CONTENT_TYPES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/mpeg3",
  "audio/x-mpeg-3",
  "audio/x-mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/pcm_s16le",
  "audio/l16",
  "audio/raw",
  "application/octet-stream",
  "audio/aac",
  "audio/x-aac",
  "audio/aiff",
  "audio/x-aiff",
  "audio/ogg",
  "audio/opus",
  "audio/flac",
  "audio/x-flac",
  "audio/mp4",
  "audio/x-m4a",
  "audio/amr",
  "audio/x-ms-wma",
  "audio/webm",
  "video/webm",
]);

export function sarvamContentType(browserType: string): string {
  const normalised = browserType.trim().toLowerCase();
  return SARVAM_ACCEPTED_CONTENT_TYPES.has(normalised) ? normalised : "application/octet-stream";
}

export interface TranscriptionResult {
  transcript: string;
  languageCode: string | null;
  languageProbability: number | null;
  requestId: string | null;
  mode: "sync" | "batch";
}

function toResult(json: any, mode: "sync" | "batch"): TranscriptionResult {
  return {
    transcript: typeof json?.transcript === "string" ? json.transcript : "",
    languageCode: typeof json?.language_code === "string" ? json.language_code : null,
    languageProbability:
      typeof json?.language_probability === "number" ? json.language_probability : null,
    requestId: typeof json?.request_id === "string" ? json.request_id : null,
    mode,
  };
}

// ─── Sync path — clips under ~27s ───────────────────────────────────────────

async function transcribeSync(file: File): Promise<TranscriptionResult> {
  const form = new FormData();
  // FormData takes the multipart part's Content-Type from the Blob itself,
  // not from an append() argument — re-wrap in a Blob carrying a type
  // Sarvam actually accepts (see sarvamContentType's comment) rather than
  // the browser's own, often-rejected, file.type.
  const typedBlob = new Blob([file], { type: sarvamContentType(file.type) });
  form.append("file", typedBlob, file.name);
  form.append("model", "saaras:v3");
  form.append("mode", "transcribe");
  form.append("language_code", "unknown");

  let res: Response;
  try {
    res = await fetch(`${sttBaseUrl()}/speech-to-text`, {
      method: "POST",
      headers: { "api-subscription-key": apiKey() },
      body: form,
      signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
    });
  } catch (err: any) {
    throw new TranscriptionUnavailableError(
      `Could not reach Sarvam speech-to-text: ${err?.message ?? String(err)}`,
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new TranscriptionUnavailableError(
      `Sarvam speech-to-text returned HTTP ${res.status}: ${body.slice(0, 300)}`,
      { status: res.status },
    );
  }
  return toResult(await res.json(), "sync");
}

// ─── Batch path — up to 2 hours, driven by client-side polling ─────────────

interface JobParameters {
  language_code: string;
  model: string;
  mode: string;
  with_timestamps: boolean;
}

async function jobCall(path: string, body: unknown, method: "GET" | "POST" = "POST"): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${sttBaseUrl()}${path}`, {
      method,
      headers: {
        "api-subscription-key": apiKey(),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(JOB_CALL_TIMEOUT_MS),
    });
  } catch (err: any) {
    throw new TranscriptionUnavailableError(
      `Could not reach Sarvam speech-to-text batch API (${path}): ${err?.message ?? String(err)}`,
    );
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new TranscriptionUnavailableError(
      `Sarvam batch API ${path} returned HTTP ${res.status}: ${JSON.stringify(json)?.slice(0, 300)}`,
      { status: res.status },
    );
  }
  return json;
}

/** Starts a batch job: init -> get a presigned upload URL -> PUT the file bytes -> start. */
async function startBatchJob(file: File): Promise<{ jobId: string; filename: string }> {
  const jobParameters: JobParameters = {
    language_code: "unknown",
    model: "saaras:v3",
    mode: "transcribe",
    with_timestamps: false,
  };
  const init = await jobCall("/speech-to-text/job/v1", { job_parameters: jobParameters });
  const jobId = init?.job_id;
  if (typeof jobId !== "string" || !jobId) {
    throw new TranscriptionUnavailableError(
      "Sarvam batch job initiation did not return a job_id.",
    );
  }

  const filename = file.name || "upload.bin";
  const uploadInfo = await jobCall("/speech-to-text/job/v1/upload-files", {
    job_id: jobId,
    files: [filename],
  });
  const uploadUrl = uploadInfo?.upload_urls?.[filename]?.file_url;
  if (typeof uploadUrl !== "string" || !uploadUrl) {
    throw new TranscriptionUnavailableError(
      `Sarvam did not return a presigned upload URL for job ${jobId}.`,
    );
  }

  let putRes: Response;
  try {
    putRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "x-ms-blob-type": "BlockBlob",
        "Content-Type": sarvamContentType(file.type),
      },
      body: file,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (err: any) {
    throw new TranscriptionUnavailableError(
      `Uploading the video to Sarvam's storage failed: ${err?.message ?? String(err)}`,
    );
  }
  if (!putRes.ok) {
    const body = await putRes.text().catch(() => "");
    throw new TranscriptionUnavailableError(
      `Uploading the video to Sarvam's storage returned HTTP ${putRes.status}: ${body.slice(0, 300)}`,
      { status: putRes.status },
    );
  }

  await jobCall(`/speech-to-text/job/v1/${jobId}/start`, undefined);
  return { jobId, filename };
}

export type TranscriptionJobPoll =
  | { done: false; jobState: string }
  | { done: true; result: TranscriptionResult }
  | { done: true; error: string };

/**
 * One status check — never loops internally. `videos.tsx` calls this
 * repeatedly (e.g. every 4s) while `done` is false. On Completed, this ALSO
 * performs the download step so the caller gets the transcript directly
 * rather than needing a third round trip.
 */
export async function checkTranscriptionJob(jobId: string): Promise<TranscriptionJobPoll> {
  const status = await jobCall(`/speech-to-text/job/v1/${jobId}/status`, undefined, "GET");
  const state = String(status?.job_state ?? "unknown");

  if (state === "Failed") {
    const perFile = status?.job_details?.[0]?.error_message;
    return {
      done: true,
      error: `Sarvam reported the transcription job as Failed: ${
        perFile || status?.error_message || "no error detail returned"
      }`,
    };
  }

  if (state !== "Completed" && state !== "PartiallyCompleted") {
    return { done: false, jobState: state };
  }

  const fileDetail = status?.job_details?.[0];
  if (fileDetail?.state !== "Success") {
    return {
      done: true,
      error: `Sarvam marked this file as ${fileDetail?.state ?? "not successful"}: ${
        fileDetail?.error_message || "no error detail returned"
      }`,
    };
  }
  const outputFilename = fileDetail?.outputs?.[0]?.file_name;
  if (typeof outputFilename !== "string" || !outputFilename) {
    return { done: true, error: "Sarvam completed the job but named no output file." };
  }

  const download = await jobCall("/speech-to-text/job/v1/download-files", {
    job_id: jobId,
    files: [outputFilename],
  });
  const downloadUrl = download?.download_urls?.[outputFilename]?.file_url;
  if (typeof downloadUrl !== "string" || !downloadUrl) {
    return { done: true, error: "Sarvam did not return a presigned download URL for the result." };
  }

  let resultRes: Response;
  try {
    resultRes = await fetch(downloadUrl, { signal: AbortSignal.timeout(JOB_CALL_TIMEOUT_MS) });
  } catch (err: any) {
    return { done: true, error: `Downloading the transcript failed: ${err?.message ?? String(err)}` };
  }
  if (!resultRes.ok) {
    return { done: true, error: `Downloading the transcript returned HTTP ${resultRes.status}.` };
  }
  return { done: true, result: toResult(await resultRes.json(), "batch") };
}

// ─── Entry point ─────────────────────────────────────────────────────────

export type StartTranscriptionResult =
  | { mode: "sync"; result: TranscriptionResult }
  | { mode: "batch"; jobId: string };

/**
 * `durationSeconds` comes from the browser's own decode of the video
 * (`KeyframeResult.duration` in imaging-client.ts) — real, not guessed.
 * Unknown/non-finite duration is treated as "assume long" and routed to the
 * batch path, since that path is the one both endpoints agree handles any
 * length correctly.
 */
export async function startTranscription(
  file: File,
  durationSeconds: number | null,
): Promise<StartTranscriptionResult> {
  const useSync =
    typeof durationSeconds === "number" &&
    Number.isFinite(durationSeconds) &&
    durationSeconds <= SYNC_MAX_DURATION_S;

  if (useSync) {
    return { mode: "sync", result: await transcribeSync(file) };
  }
  const { jobId } = await startBatchJob(file);
  return { mode: "batch", jobId };
}

export const startAudioTranscription = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    if (!(data instanceof FormData)) {
      throw new Error("startAudioTranscription expects FormData");
    }
    const file = data.get("file");
    if (!(file instanceof File)) {
      throw new Error("startAudioTranscription requires a 'file' field");
    }
    const durationRaw = data.get("durationSeconds");
    const durationSeconds =
      typeof durationRaw === "string" && durationRaw.trim() ? Number(durationRaw) : null;
    return { file, durationSeconds };
  })
  .handler(async ({ data }) => startTranscription(data.file, data.durationSeconds));

export const pollAudioTranscription = createServerFn({ method: "POST" })
  .validator((data: { jobId: string }) => data)
  .handler(async ({ data }) => checkTranscriptionJob(data.jobId));

/** Rendered next to the transcription controls — the same disclosure
 * discipline as OCR_ASSET_PROVENANCE / AI_SERVICE_PROVENANCE. */
export const TRANSCRIPTION_PROVENANCE = {
  disclosure:
    "Unlike keyframe extraction, hashing and OCR above, this sends audio to Sarvam " +
    "(api.sarvam.ai), a third-party cloud API, over the network. This is the one action on " +
    "this page where anything leaves the browser — it does not happen until you explicitly " +
    "request a transcript. The video itself is never uploaded: its audio track is decoded " +
    "and re-encoded as a 16kHz mono WAV file in this tab first (src/utils/audio-extract-" +
    "client.ts), and only that WAV is sent.",
  model:
    "Sarvam saaras:v3 (Apache 2.0, Indian) — the approved speech model for this project. " +
    "Clips under 27s use Sarvam's synchronous endpoint; longer clips use its asynchronous " +
    "batch job (init, upload, start, poll, download), which this page polls automatically.",
} as const;
