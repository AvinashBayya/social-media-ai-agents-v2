import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  checkTranscriptionJob,
  sarvamContentType,
  startTranscription,
  TranscriptionUnavailableError,
} from "../src/utils/transcription";

const originalFetch = globalThis.fetch;
const originalKey = process.env.LLM_API_KEY;
const originalSarvamKey = process.env.SARVAM_API_KEY;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.LLM_API_KEY;
  else process.env.LLM_API_KEY = originalKey;
  if (originalSarvamKey === undefined) delete process.env.SARVAM_API_KEY;
  else process.env.SARVAM_API_KEY = originalSarvamKey;
});

beforeEach(() => {
  process.env.LLM_API_KEY = "test-key";
  delete process.env.SARVAM_API_KEY;
});

function stubFetch(handler: (url: string, init: any) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    return handler(url, init ?? {});
  }) as typeof fetch;
}

function testFile(name = "clip.mp4", type = "video/mp4"): File {
  return new File([new Uint8Array([1, 2, 3, 4])], name, { type });
}

describe("sarvamContentType", () => {
  // The exact whitelist Sarvam's own API returns in its 400 body, verified
  // live 2026-08-20 against both the sync and batch endpoints — a real
  // upload of an .mp4 video (browser-reported type "video/mp4") was
  // rejected with this list, and "video/mp4" is NOT in it (only the
  // audio-only "audio/mp4"/M4A variant is), unlike "video/webm" which is.

  test("passes through a type Sarvam already accepts, unchanged", () => {
    expect(sarvamContentType("audio/wav")).toBe("audio/wav");
    expect(sarvamContentType("video/webm")).toBe("video/webm");
    expect(sarvamContentType("audio/mp4")).toBe("audio/mp4");
  });

  test("is case-insensitive", () => {
    expect(sarvamContentType("AUDIO/WAV")).toBe("audio/wav");
  });

  test("falls back to application/octet-stream for a rejected type — verified live to actually decode", () => {
    // video/mp4 is the exact type a browser reports for an .mp4 upload and
    // the exact type that produced a real HTTP 400 from Sarvam this session.
    expect(sarvamContentType("video/mp4")).toBe("application/octet-stream");
    expect(sarvamContentType("video/quicktime")).toBe("application/octet-stream");
    expect(sarvamContentType("")).toBe("application/octet-stream");
  });
});

describe("startTranscription — sync path (short clips)", () => {
  test("a clip under the sync threshold calls /speech-to-text once and returns the transcript", async () => {
    let calls = 0;
    stubFetch((url) => {
      calls += 1;
      expect(url).toBe("https://api.sarvam.ai/speech-to-text");
      return new Response(
        JSON.stringify({
          request_id: "req-1",
          transcript: "hello world",
          language_code: "en-IN",
          language_probability: 0.9,
        }),
      );
    });

    const outcome = await startTranscription(testFile(), 12);
    expect(calls).toBe(1);
    expect(outcome.mode).toBe("sync");
    expect(outcome.mode === "sync" && outcome.result.transcript).toBe("hello world");
    expect(outcome.mode === "sync" && outcome.result.languageCode).toBe("en-IN");
  });

  test("a clip exactly at the sync threshold still uses sync", async () => {
    stubFetch(() => new Response(JSON.stringify({ transcript: "ok" })));
    const outcome = await startTranscription(testFile(), 27);
    expect(outcome.mode).toBe("sync");
  });

  test("an .mp4 upload (video/mp4) is re-typed to application/octet-stream in the multipart body", async () => {
    let uploadedType: string | undefined;
    stubFetch(async (_url, init) => {
      const form: FormData = init.body;
      const file = form.get("file") as File;
      uploadedType = file.type;
      return new Response(JSON.stringify({ transcript: "" }));
    });
    await startTranscription(testFile("clip.mp4", "video/mp4"), 10);
    expect(uploadedType).toBe("application/octet-stream");
  });

  test("an already-accepted type (e.g. audio/wav) is sent unchanged", async () => {
    let uploadedType: string | undefined;
    stubFetch(async (_url, init) => {
      const form: FormData = init.body;
      uploadedType = (form.get("file") as File).type;
      return new Response(JSON.stringify({ transcript: "" }));
    });
    await startTranscription(testFile("clip.wav", "audio/wav"), 10);
    expect(uploadedType).toBe("audio/wav");
  });

  test("an HTTP error from the sync endpoint throws with the real status and body", async () => {
    stubFetch(() => new Response("bad audio format", { status: 400 }));
    await expect(startTranscription(testFile(), 5)).rejects.toThrow(/HTTP 400/);
  });

  test("no configured key throws before any network call", async () => {
    delete process.env.LLM_API_KEY;
    let called = false;
    stubFetch(() => {
      called = true;
      return new Response("{}");
    });
    await expect(startTranscription(testFile(), 5)).rejects.toThrow(TranscriptionUnavailableError);
    expect(called).toBe(false);
  });

  test("SARVAM_API_KEY takes precedence over LLM_API_KEY when both are set", async () => {
    process.env.SARVAM_API_KEY = "sarvam-specific-key";
    let seenHeader: string | undefined;
    stubFetch((_url, init) => {
      seenHeader = init.headers?.["api-subscription-key"];
      return new Response(JSON.stringify({ transcript: "" }));
    });
    await startTranscription(testFile(), 5);
    expect(seenHeader).toBe("sarvam-specific-key");
  });
});

describe("startTranscription — batch path (long or unknown-duration clips)", () => {
  test("a long clip runs init -> upload-files -> PUT -> start and returns a jobId, without polling", async () => {
    const calls: string[] = [];
    stubFetch((url, init) => {
      calls.push(`${init.method ?? "GET"} ${url}`);
      if (url === "https://api.sarvam.ai/speech-to-text/job/v1") {
        return new Response(JSON.stringify({ job_id: "job-abc", job_state: "Accepted" }));
      }
      if (url === "https://api.sarvam.ai/speech-to-text/job/v1/upload-files") {
        return new Response(
          JSON.stringify({
            job_id: "job-abc",
            job_state: "Accepted",
            upload_urls: { "clip.mp4": { file_url: "https://blob.example/upload?sig=x" } },
          }),
        );
      }
      if (url === "https://blob.example/upload?sig=x") {
        expect(init.headers?.["x-ms-blob-type"]).toBe("BlockBlob");
        // testFile() defaults to video/mp4, which Sarvam's batch /start
        // rejects — verified live 2026-08-20 — so this must be re-typed too.
        expect(init.headers?.["Content-Type"]).toBe("application/octet-stream");
        return new Response(null, { status: 201 });
      }
      if (url === "https://api.sarvam.ai/speech-to-text/job/v1/job-abc/start") {
        return new Response(JSON.stringify({ job_state: "Pending" }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const outcome = await startTranscription(testFile(), 120);
    expect(outcome.mode).toBe("batch");
    expect(outcome.mode === "batch" && outcome.jobId).toBe("job-abc");
    // No status/download calls yet — this call only starts the job.
    expect(calls.some((c) => c.includes("/status"))).toBe(false);
    expect(calls.some((c) => c.includes("download-files"))).toBe(false);
  });

  test("an unknown (null) duration is treated as long and routed to batch, not sync", async () => {
    stubFetch((url) => {
      if (url === "https://api.sarvam.ai/speech-to-text/job/v1") {
        return new Response(JSON.stringify({ job_id: "job-xyz", job_state: "Accepted" }));
      }
      if (url === "https://api.sarvam.ai/speech-to-text/job/v1/upload-files") {
        return new Response(
          JSON.stringify({
            job_id: "job-xyz",
            job_state: "Accepted",
            upload_urls: { "clip.mp4": { file_url: "https://blob.example/upload2" } },
          }),
        );
      }
      if (url === "https://blob.example/upload2") return new Response(null, { status: 201 });
      if (url === "https://api.sarvam.ai/speech-to-text/job/v1/job-xyz/start") {
        return new Response(JSON.stringify({ job_state: "Pending" }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const outcome = await startTranscription(testFile(), null);
    expect(outcome.mode).toBe("batch");
  });

  test("a failed upload PUT throws rather than silently starting the job anyway", async () => {
    stubFetch((url) => {
      if (url === "https://api.sarvam.ai/speech-to-text/job/v1") {
        return new Response(JSON.stringify({ job_id: "job-fail", job_state: "Accepted" }));
      }
      if (url === "https://api.sarvam.ai/speech-to-text/job/v1/upload-files") {
        return new Response(
          JSON.stringify({
            job_id: "job-fail",
            upload_urls: { "clip.mp4": { file_url: "https://blob.example/reject" } },
          }),
        );
      }
      if (url === "https://blob.example/reject") return new Response("denied", { status: 403 });
      throw new Error(`unexpected fetch: ${url}`);
    });
    await expect(startTranscription(testFile(), 300)).rejects.toThrow(/HTTP 403/);
  });
});

describe("checkTranscriptionJob", () => {
  test("a still-running job reports done:false with the real job_state, no download attempted", async () => {
    let downloadCalled = false;
    stubFetch((url) => {
      if (url.endsWith("/status")) return new Response(JSON.stringify({ job_state: "Running" }));
      downloadCalled = true;
      return new Response("{}");
    });
    const poll = await checkTranscriptionJob("job-1");
    expect(poll).toEqual({ done: false, jobState: "Running" });
    expect(downloadCalled).toBe(false);
  });

  test("a Failed job surfaces Sarvam's own error_message, never a fabricated transcript", async () => {
    stubFetch((url) =>
      url.endsWith("/status")
        ? new Response(
            JSON.stringify({
              job_state: "Failed",
              job_details: [{ error_message: "unsupported codec" }],
            }),
          )
        : new Response("{}"),
    );
    const poll = await checkTranscriptionJob("job-2");
    expect(poll.done).toBe(true);
    expect(poll.done && "error" in poll && poll.error).toContain("unsupported codec");
  });

  test("a Completed job downloads the result and returns the real transcript", async () => {
    stubFetch((url) => {
      if (url.endsWith("/status")) {
        return new Response(
          JSON.stringify({
            job_state: "Completed",
            job_details: [
              {
                state: "Success",
                outputs: [{ file_name: "0.json" }],
              },
            ],
          }),
        );
      }
      if (url.endsWith("/download-files")) {
        return new Response(
          JSON.stringify({
            job_id: "job-3",
            download_urls: { "0.json": { file_url: "https://blob.example/result.json" } },
          }),
        );
      }
      if (url === "https://blob.example/result.json") {
        return new Response(
          JSON.stringify({
            request_id: "req-9",
            transcript: "a real transcript",
            language_code: "hi-IN",
            language_probability: 0.7,
          }),
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const poll = await checkTranscriptionJob("job-3");
    expect(poll.done).toBe(true);
    expect(poll.done && "result" in poll && poll.result.transcript).toBe("a real transcript");
    expect(poll.done && "result" in poll && poll.result.mode).toBe("batch");
  });

  test("a Completed job with no successful output file reports an error, not an empty transcript as success", async () => {
    stubFetch((url) =>
      url.endsWith("/status")
        ? new Response(
            JSON.stringify({
              job_state: "Completed",
              job_details: [{ state: "Failure", error_message: "corrupt file" }],
            }),
          )
        : new Response("{}"),
    );
    const poll = await checkTranscriptionJob("job-4");
    expect(poll.done).toBe(true);
    expect(poll.done && "error" in poll && poll.error).toContain("corrupt file");
  });
});
