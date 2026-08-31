import { describe, expect, mock, test } from "bun:test";
import { fetchRevocationEndpoint } from "../src/utils/pdf-revocation-server";

/**
 * The URL this function fetches comes from a certificate embedded in a file
 * an analyst uploaded — untrusted input, and the one genuine SSRF surface
 * this whole feature introduces (see pdf-revocation.ts's header for why the
 * fetch has to happen server-side at all). These tests are the actual
 * security boundary, not a formality.
 */

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = (async (url: any, init: any) => handler(String(url), init)) as typeof fetch;
}

describe("fetchRevocationEndpoint — SSRF and input guards", () => {
  test("rejects a non-http(s) scheme before ever calling fetch", async () => {
    let called = false;
    stubFetch(() => {
      called = true;
      return new Response("");
    });
    const result = await fetchRevocationEndpoint({ url: "file:///etc/passwd", method: "GET", bodyBase64: null, contentType: null });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("scheme");
    expect(called).toBe(false);
  });

  test("rejects an unparseable URL", async () => {
    const result = await fetchRevocationEndpoint({ url: "not a url", method: "GET", bodyBase64: null, contentType: null });
    expect(result.ok).toBe(false);
  });

  test("rejects a literal loopback IP without ever calling fetch — the cloud-metadata-style SSRF case", async () => {
    let called = false;
    stubFetch(() => {
      called = true;
      return new Response("");
    });
    const result = await fetchRevocationEndpoint({ url: "http://127.0.0.1:8080/internal", method: "GET", bodyBase64: null, contentType: null });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("private");
    expect(called).toBe(false);
  });

  test("rejects the real cloud instance-metadata address (169.254.169.254)", async () => {
    const result = await fetchRevocationEndpoint({ url: "http://169.254.169.254/latest/meta-data/", method: "GET", bodyBase64: null, contentType: null });
    expect(result.ok).toBe(false);
  });

  test("rejects a hostname that DNS-resolves to a private address (rebinding-style SSRF)", async () => {
    await mock.module("node:dns/promises", () => ({
      lookup: async () => ({ address: "10.0.0.5", family: 4 }),
    }));
    let called = false;
    stubFetch(() => {
      called = true;
      return new Response("");
    });
    const result = await fetchRevocationEndpoint({ url: "http://internal.rebind.example/", method: "GET", bodyBase64: null, contentType: null });
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
    await mock.module("node:dns/promises", () => ({
      lookup: async () => {
        throw new Error("restored");
      },
    }));
  });

  test("a normal public https URL passes through and returns base64 body bytes", async () => {
    stubFetch(async (url, init) => {
      expect(url).toBe("https://ocsp.example.com/");
      expect(init.method).toBe("GET");
      expect(init.redirect).toBe("error");
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "content-type": "application/ocsp-response" } });
    });
    const result = await fetchRevocationEndpoint({ url: "https://ocsp.example.com/", method: "GET", bodyBase64: null, contentType: null });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.contentType).toBe("application/ocsp-response");
    expect(atob(result.bodyBase64!)).toBe("");
  });

  test("a POST body round-trips as base64 correctly", async () => {
    let receivedBody: Buffer | null = null;
    stubFetch(async (_url, init) => {
      receivedBody = Buffer.from(init.body as any);
      return new Response(new Uint8Array([9]), { status: 200 });
    });
    const bodyBase64 = Buffer.from([0xde, 0xad, 0xbe, 0xef]).toString("base64");
    await fetchRevocationEndpoint({ url: "http://ocsp.example.com/", method: "POST", bodyBase64, contentType: "application/ocsp-request" });
    expect(receivedBody!.toString("hex")).toBe("deadbeef");
  });

  test("a response over the size cap is refused, not silently truncated or crashed on", async () => {
    stubFetch(async () => {
      const big = new Uint8Array(17 * 1024 * 1024);
      return new Response(big, { status: 200 });
    });
    const result = await fetchRevocationEndpoint({ url: "https://ocsp.example.com/", method: "GET", bodyBase64: null, contentType: null });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("too large");
  });

  test("a network failure is reported honestly, never as a fabricated status", async () => {
    stubFetch(async () => {
      throw new Error("ECONNRESET");
    });
    const result = await fetchRevocationEndpoint({ url: "https://ocsp.example.com/", method: "GET", bodyBase64: null, contentType: null });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ECONNRESET");
  });
});
