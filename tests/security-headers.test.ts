import { describe, expect, it } from "bun:test";

import {
  contentSecurityPolicy,
  cspMode,
  isHttpsRequest,
  securityHeaders,
  withSecurityHeaders,
} from "../src/utils/security-headers";

describe("unconditional headers", () => {
  const h = securityHeaders({ env: {} });

  it("sets nosniff, framing, referrer and permissions policy", () => {
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["permissions-policy"]).toContain("geolocation=()");
  });

  it("sends HSTS only over HTTPS", () => {
    expect(securityHeaders({ https: false, env: {} })["strict-transport-security"]).toBeUndefined();
    expect(securityHeaders({ https: true, env: {} })["strict-transport-security"]).toContain(
      "max-age=31536000",
    );
  });
});

describe("CSP mode", () => {
  it("defaults to report-only rather than enforcing an unverified policy", () => {
    expect(cspMode({})).toBe("report-only");
    const h = securityHeaders({ env: {} });
    expect(h["content-security-policy-report-only"]).toBeTruthy();
    expect(h["content-security-policy"]).toBeUndefined();
  });

  it("enforces when asked", () => {
    const h = securityHeaders({ env: { CSP_MODE: "enforce" } });
    expect(h["content-security-policy"]).toBeTruthy();
    expect(h["content-security-policy-report-only"]).toBeUndefined();
  });

  it("emits nothing when switched off", () => {
    const h = securityHeaders({ env: { CSP_MODE: "off" } });
    expect(h["content-security-policy"]).toBeUndefined();
    expect(h["content-security-policy-report-only"]).toBeUndefined();
  });

  it("treats an unrecognised value as report-only, not as off", () => {
    expect(cspMode({ CSP_MODE: "nonsense" })).toBe("report-only");
  });
});

describe("the policy covers what this app actually does", () => {
  const csp = contentSecurityPolicy();

  it("permits the browser-side Jetstream websocket", () => {
    // The container scales to zero, so the firehose socket runs in the browser.
    // Without wss: in connect-src, Module 3 collection stops entirely.
    expect(csp).toContain("wss:");
  });

  it("permits blob workers for the c2pa and tesseract WASM engines", () => {
    expect(csp).toContain("worker-src 'self' blob:");
  });

  it("permits the privacy-mode YouTube embed", () => {
    expect(csp).toContain("https://www.youtube-nocookie.com");
  });

  it("permits remote collected media, which is referenced and never re-hosted", () => {
    expect(csp).toContain("img-src 'self' data: blob: https:");
  });

  it("denies plugins and framing outright", () => {
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
  });
});

describe("withSecurityHeaders", () => {
  it("preserves status and body", async () => {
    const res = withSecurityHeaders(new Response("hello", { status: 418 }), false);
    expect(res.status).toBe(418);
    expect(await res.text()).toBe("hello");
  });

  it("works on a Response with immutable headers", () => {
    // Redirect responses have guarded headers; mutating them throws, which is
    // why a new Response is constructed rather than headers being set in place.
    const immutable = Response.redirect("https://example.com", 302);
    expect(() => withSecurityHeaders(immutable, true)).not.toThrow();
    expect(withSecurityHeaders(immutable, true).headers.get("x-frame-options")).toBe("DENY");
  });

  it("does not overwrite a header the handler deliberately set", () => {
    const res = withSecurityHeaders(
      new Response("x", { headers: { "x-frame-options": "SAMEORIGIN" } }),
      false,
    );
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });
});

describe("isHttpsRequest", () => {
  it("reads x-forwarded-proto, which is what the ingress sets", () => {
    // Behind Container Apps the connection to the container is plain HTTP, so
    // reading url.protocol would suppress HSTS on every production response.
    const req = new Request("http://internal/x", {
      headers: { "x-forwarded-proto": "https" },
    });
    expect(isHttpsRequest(req)).toBe(true);
  });

  it("takes the first entry when several proxies appended one", () => {
    const req = new Request("http://internal/x", {
      headers: { "x-forwarded-proto": "https, http" },
    });
    expect(isHttpsRequest(req)).toBe(true);
  });

  it("falls back to the URL scheme", () => {
    expect(isHttpsRequest(new Request("https://example.com/"))).toBe(true);
    expect(isHttpsRequest(new Request("http://example.com/"))).toBe(false);
  });
});
