import { describe, expect, it } from "bun:test";
import { z } from "zod";

import {
  DEFAULT_MAX_PAYLOAD_BYTES,
  InputContractError,
  absoluteHttpUrl,
  actorPattern,
  allowedHosts,
  bareHost,
  boundedArray,
  boundedScore,
  boundedText,
  hashtagPattern,
  hostAllowlist,
  httpUrlWithHostAllowlist,
  identifierLike,
  isBlockedHost,
  jsonSizeLimit,
  positiveLimit,
  telegramChannelPattern,
  validate,
} from "../src/utils/validation";

describe("validate()", () => {
  const schema = z.object({ text: boundedText(10) });
  const check = validate(schema, "TestInput");

  it("returns parsed data on success", () => {
    expect(check({ text: "hello" })).toEqual({ text: "hello" });
  });

  it("throws InputContractError naming the contract", () => {
    expect(() => check({ text: "" })).toThrow(InputContractError);
    try {
      check({ text: "" });
    } catch (err) {
      expect((err as InputContractError).contract).toBe("TestInput");
      expect((err as InputContractError).message).toContain("TestInput");
    }
  });

  it("names the failing PATH but never echoes the offending value", () => {
    const secret = "sk_live_ThisShouldNeverAppearInAnError";
    try {
      check({ text: secret });
      throw new Error("should have thrown");
    } catch (err) {
      const e = err as InputContractError;
      expect(e.message).not.toContain(secret);
      expect(e.paths).toContain("text");
      // The value is retained for the server-side log only, not the message.
      expect(e.issues[0].path).toBe("text");
    }
  });

  it("rejects a completely wrong shape rather than coercing it", () => {
    expect(() => check("just a string")).toThrow(InputContractError);
    expect(() => check(null)).toThrow(InputContractError);
    expect(() => check([])).toThrow(InputContractError);
  });
});

describe("string primitives", () => {
  it("boundedText enforces the ceiling", () => {
    expect(boundedText(5).safeParse("abcde").success).toBe(true);
    expect(boundedText(5).safeParse("abcdef").success).toBe(false);
    expect(boundedText(5).safeParse("   ").success).toBe(false);
  });

  it("identifierLike rejects whitespace and markup", () => {
    expect(identifierLike().safeParse("bluesky-1").success).toBe(true);
    expect(identifierLike().safeParse("a b").success).toBe(false);
    expect(identifierLike().safeParse("<script>").success).toBe(false);
    expect(identifierLike().safeParse("../../etc/passwd").success).toBe(false);
  });

  it("hashtagPattern accepts Indic scripts including combining marks", () => {
    // Devanagari vowel signs are \p{M}, not \p{L}. A [\p{L}\p{N}_] class
    // rejects this string while accepting its bare consonants — unacceptable
    // on a platform built around 15 Indian languages.
    expect(hashtagPattern.safeParse("#सुरक्षा").success).toBe(true);
    expect(hashtagPattern.safeParse("#বাংলা").success).toBe(true);
    expect(hashtagPattern.safeParse("#தமிழ்").success).toBe(true);
    expect(hashtagPattern.safeParse("defence").success).toBe(true);
    expect(hashtagPattern.safeParse("has space").success).toBe(false);
    expect(hashtagPattern.safeParse("a/../b").success).toBe(false);
  });

  it("telegramChannelPattern matches the existing collector guard", () => {
    expect(telegramChannelPattern.safeParse("@durov").success).toBe(true);
    expect(telegramChannelPattern.safeParse("durov").success).toBe(true);
    expect(telegramChannelPattern.safeParse("ab").success).toBe(false);
    expect(telegramChannelPattern.safeParse("has/slash").success).toBe(false);
  });

  it("actorPattern accepts handles and DIDs", () => {
    expect(actorPattern.safeParse("alice.bsky.social").success).toBe(true);
    expect(actorPattern.safeParse("did:plc:abc123").success).toBe(true);
    expect(actorPattern.safeParse("no-dots").success).toBe(false);
  });
});

describe("numeric primitives", () => {
  it("positiveLimit bounds and rejects non-integers", () => {
    expect(positiveLimit(40).safeParse(10).success).toBe(true);
    expect(positiveLimit(40).safeParse(41).success).toBe(false);
    expect(positiveLimit(40).safeParse(0).success).toBe(false);
    expect(positiveLimit(40).safeParse(-1).success).toBe(false);
    expect(positiveLimit(40).safeParse(1.5).success).toBe(false);
  });

  it("boundedScore rejects NaN and Infinity", () => {
    expect(boundedScore(0, 1).safeParse(0.5).success).toBe(true);
    expect(boundedScore(0, 1).safeParse(Number.NaN).success).toBe(false);
    expect(boundedScore(0, 1).safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
  });
});

describe("collections", () => {
  it("boundedArray caps length", () => {
    expect(boundedArray(z.string(), 2).safeParse(["a", "b"]).success).toBe(true);
    expect(boundedArray(z.string(), 2).safeParse(["a", "b", "c"]).success).toBe(false);
  });

  it("jsonSizeLimit rejects an oversized payload", () => {
    const schema = z.object({ blob: z.string() }).superRefine(jsonSizeLimit(100));
    expect(schema.safeParse({ blob: "x".repeat(10) }).success).toBe(true);
    expect(schema.safeParse({ blob: "x".repeat(500) }).success).toBe(false);
  });

  it("has a sane default ceiling", () => {
    expect(DEFAULT_MAX_PAYLOAD_BYTES).toBe(262_144);
  });
});

describe("bareHost", () => {
  it("strips scheme, path, query and fragment", () => {
    expect(bareHost("https://mastodon.social/api/v1/x?y=1#z")).toBe("mastodon.social");
  });

  it("strips a port — the case the old sanitiser missed", () => {
    // `.replace(/\/.*$/,"")` left this intact, so `169.254.169.254:80` reached
    // the fetch verbatim.
    expect(bareHost("169.254.169.254:80")).toBe("169.254.169.254");
    expect(bareHost("internal-svc:8080")).toBe("internal-svc");
  });

  it("strips userinfo so the host cannot be smuggled after an @", () => {
    expect(bareHost("mastodon.social@169.254.169.254")).toBe("169.254.169.254");
    expect(bareHost("https://user:pass@internal-host/x")).toBe("internal-host");
  });

  it("handles bracketed IPv6 without truncating it", () => {
    expect(bareHost("[2001:db8::1]:443")).toBe("2001:db8::1");
  });
});

describe("isBlockedHost", () => {
  it("blocks cloud metadata", () => {
    expect(isBlockedHost("169.254.169.254")).toBe(true);
  });

  it("blocks loopback, RFC1918 and link-local", () => {
    for (const h of ["127.0.0.1", "10.0.3.14", "192.168.1.1", "172.16.0.1", "localhost", "::1"]) {
      expect(isBlockedHost(h)).toBe(true);
    }
  });

  it("blocks internal service suffixes", () => {
    expect(isBlockedHost("sentinel-web.internal")).toBe(true);
    expect(isBlockedHost("printer.local")).toBe(true);
  });

  it("permits ordinary public hosts", () => {
    expect(isBlockedHost("mastodon.social")).toBe(false);
    expect(isBlockedHost("203.0.113.7")).toBe(false);
  });
});

describe("hostAllowlist", () => {
  const ALLOWED = ["mastodon.social", "mstdn.social"] as const;
  const schema = hostAllowlist(ALLOWED, undefined, {});

  it("accepts a listed host", () => {
    expect(schema.safeParse("mastodon.social").success).toBe(true);
    expect(schema.safeParse("https://mastodon.social/").success).toBe(true);
  });

  it("rejects an unlisted host", () => {
    expect(schema.safeParse("evil.example").success).toBe(false);
  });

  it("rejects the SSRF payloads that reach the old sanitiser intact", () => {
    for (const payload of [
      "169.254.169.254",
      "169.254.169.254:80",
      "127.0.0.1:3000",
      "10.0.3.14",
      "mastodon.social@169.254.169.254",
      "http://localhost:8080/",
      "sentinel-web.internal",
    ]) {
      expect(schema.safeParse(payload).success).toBe(false);
    }
  });

  it("widens from env but still refuses blocked ranges", () => {
    const widened = hostAllowlist(ALLOWED, "EXTRA", { EXTRA: "infosec.exchange,169.254.169.254" });
    expect(widened.safeParse("infosec.exchange").success).toBe(true);
    expect(widened.safeParse("169.254.169.254").success).toBe(false);
  });

  it("allowedHosts normalises its entries", () => {
    const set = allowedHosts(["https://mastodon.social/"], undefined, {});
    expect(set.has("mastodon.social")).toBe(true);
  });
});

describe("httpUrlWithHostAllowlist", () => {
  const schema = httpUrlWithHostAllowlist(["api.example.com"], undefined, {});

  it("accepts an allowlisted https URL", () => {
    expect(schema.safeParse("https://api.example.com/v1/thing").success).toBe(true);
  });

  it("rejects http, embedded credentials, and blocked hosts", () => {
    expect(schema.safeParse("http://api.example.com/").success).toBe(false);
    expect(schema.safeParse("https://u:p@api.example.com/").success).toBe(false);
    expect(schema.safeParse("https://169.254.169.254/").success).toBe(false);
    expect(schema.safeParse("not a url").success).toBe(false);
  });
});

describe("absoluteHttpUrl", () => {
  it("rejects javascript: and data: schemes", () => {
    expect(absoluteHttpUrl.safeParse("javascript:alert(1)").success).toBe(false);
    expect(absoluteHttpUrl.safeParse("data:text/html,<script>").success).toBe(false);
    expect(absoluteHttpUrl.safeParse("https://example.com/a.jpg").success).toBe(true);
  });
});
