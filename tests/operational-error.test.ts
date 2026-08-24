import { describe, expect, it } from "bun:test";

import {
  NotAuthorisedError,
  OperationalError,
  RateLimitedError,
  extractErrno,
  newCorrelationId,
  redactInfrastructure,
  sanitiseError,
  statusForCode,
  toClientError,
} from "../src/utils/operational-error";
import { LlmUnavailableError } from "../src/utils/llm";
import { SocialUnavailableError } from "../src/utils/social";
import { InputContractError } from "../src/utils/validation";

const CID = "abc123def456";

describe("correlation ids", () => {
  it("is 12 chars and has no dashes", () => {
    const id = newCorrelationId();
    expect(id).toMatch(/^[0-9a-f]{12}$/);
  });

  it("is not a counter or a timestamp", () => {
    // Either would leak request volume / idle periods to an outside observer.
    const ids = new Set(Array.from({ length: 50 }, () => newCorrelationId()));
    expect(ids.size).toBe(50);
    const sorted = [...ids].sort();
    expect(sorted.join("")).not.toBe([...ids].join(""));
  });
});

describe("sanitiseError preserves the analytical signal", () => {
  it("keeps 'collection failed' distinct from 'nothing matched'", () => {
    const err = new SocialUnavailableError("Reddit rate limited this request", "reddit", 429);
    const out = sanitiseError(err, CID);
    expect(out.code).toBe("SOURCE_UNAVAILABLE");
    expect(out.reason).toContain("reddit");
    expect(out.reason).toContain("429");
    // The load-bearing sentence: an analyst must not read this as an empty
    // result set.
    expect(out.reason).toContain("not a statement that nothing matched");
  });

  it("keeps the provider label and status for an LLM failure", () => {
    const err = new LlmUnavailableError("boom", { provider: "primary", status: 503 });
    const out = sanitiseError(err, CID);
    expect(out.code).toBe("LLM_UNAVAILABLE");
    expect(out.source).toBe("primary");
    expect(out.reason).toContain("503");
    expect(out.reason).toContain("not an empty result");
  });

  it("keeps the errno for a store failure because it is actionable", () => {
    const err = new Error("ENOSPC: no space left on device, write '/app/data/x.json'");
    err.name = "ProfileStoreError";
    const out = sanitiseError(err, CID);
    expect(out.reason).toContain("ENOSPC");
  });
});

describe("sanitiseError removes infrastructure", () => {
  it("drops the upstream response body from an LLM error", () => {
    const body = '{"error":{"message":"org_id=org-7788 project=proj-991 quota exceeded"}}';
    const err = new LlmUnavailableError(`primary (sarvam-105b) returned HTTP 429: ${body}`, {
      provider: "primary",
      status: 429,
    });
    const out = sanitiseError(err, CID);
    expect(out.reason).not.toContain("org-7788");
    expect(out.reason).not.toContain("proj-991");
    expect(out.reason).not.toContain("sarvam-105b");
  });

  it("drops internal addresses from a collector error", () => {
    const err = new SocialUnavailableError(
      "Mastodon request failed: connect ECONNREFUSED 10.0.3.14:8080",
      "mastodon",
    );
    const out = sanitiseError(err, CID);
    expect(out.reason).not.toContain("10.0.3.14");
    expect(out.reason).not.toContain("ECONNREFUSED");
  });

  it("drops the absolute path from a store error", () => {
    const err = new Error("ENOSPC: no space left on device, write '/app/data/profiles.json'");
    err.name = "ProfileStoreError";
    const out = sanitiseError(err, CID);
    expect(out.reason).not.toContain("/app/data");
  });

  it("gives an unknown error nothing but a reference", () => {
    const err = new Error("TypeError: Cannot read properties of undefined (reading 'foo')");
    const out = sanitiseError(err, CID);
    expect(out.code).toBe("INTERNAL");
    expect(out.reason).not.toContain("TypeError");
    expect(out.reason).toContain(CID);
    // Must not imply a result was produced.
    expect(out.reason).toContain("Nothing was returned");
  });
});

describe("sanitiseError dispatches by name, not instanceof", () => {
  it("classifies a duplicated class correctly", () => {
    // Two copies of a class across a module boundary make instanceof fail,
    // which would silently downgrade a well-described failure to INTERNAL.
    const impostor = new Error("Reddit refused the request");
    impostor.name = "SocialUnavailableError";
    Object.assign(impostor, { platform: "reddit", status: 403 });
    expect(sanitiseError(impostor, CID).code).toBe("SOURCE_UNAVAILABLE");
  });
});

describe("specific error classes", () => {
  it("maps a rate limit to 429 and carries the wait", () => {
    const out = sanitiseError(new RateLimitedError("slow down", 4500, "strict"), CID);
    expect(out.code).toBe("RATE_LIMITED");
    expect(out.retryAfterMs).toBe(4500);
    expect(statusForCode(out.code)).toBe(429);
  });

  it("maps an authorisation failure to 401", () => {
    const out = sanitiseError(new NotAuthorisedError("revealCredential"), CID);
    expect(out.code).toBe("NOT_AUTHORISED");
    expect(statusForCode(out.code)).toBe(401);
    expect(out.reason).not.toContain("revealCredential");
  });

  it("passes an InputContractError through unchanged — it is already path-only", () => {
    const err = new InputContractError("SocialMastodonInput", [
      { path: "instance", message: "host is not on the permitted list for this source" },
    ]);
    const out = sanitiseError(err, CID);
    expect(out.code).toBe("INPUT_REJECTED");
    expect(out.reason).toContain("instance");
    expect(statusForCode(out.code)).toBe(400);
  });

  it("respects a pre-built OperationalError", () => {
    const err = new OperationalError(
      { reason: "Authored reason.", code: "SOURCE_UNAVAILABLE", correlationId: "old" },
      { secret: "detail stays here" },
    );
    const out = sanitiseError(err, CID);
    expect(out.reason).toBe("Authored reason.");
    expect(out.correlationId).toBe(CID);
  });
});

describe("toClientError", () => {
  it("puts the reason in `message` so existing catch sites keep working", () => {
    // ~40 sites do `setError(err?.message ?? String(err))`. They must render
    // safe text with no changes.
    const err = toClientError({ reason: "Reddit did not return results.", code: "SOURCE_UNAVAILABLE", correlationId: CID });
    expect(err.message).toBe("Reddit did not return results.");
  });

  it("empties the stack — seroval copies it to the browser otherwise", () => {
    const err = toClientError({ reason: "x", code: "INTERNAL", correlationId: CID });
    expect(err.stack).toBe("");
  });

  it("attaches the code and correlation id as own properties", () => {
    const err = toClientError({
      reason: "x",
      code: "RATE_LIMITED",
      correlationId: CID,
      retryAfterMs: 1000,
    });
    expect((err as unknown as { code: string }).code).toBe("RATE_LIMITED");
    expect((err as unknown as { correlationId: string }).correlationId).toBe(CID);
    expect((err as unknown as { retryAfterMs: number }).retryAfterMs).toBe(1000);
  });

  it("carries no reference to the original detail", () => {
    const sanitised = sanitiseError(
      new LlmUnavailableError("HTTP 401: {\"key\":\"sk_live_abc\"}", { provider: "primary", status: 401 }),
      CID,
    );
    const client = toClientError(sanitised);
    expect(JSON.stringify({ ...client, message: client.message })).not.toContain("sk_live_abc");
  });
});

describe("redactInfrastructure backstop", () => {
  it("scrubs addresses, paths and errnos", () => {
    const scrubbed = redactInfrastructure(
      "connect ECONNREFUSED 10.0.3.14:8080 while writing /app/data/credentials.json",
    );
    expect(scrubbed).not.toContain("10.0.3.14");
    expect(scrubbed).not.toContain("/app/data/credentials.json");
    expect(scrubbed).not.toContain("ECONNREFUSED");
  });

  it("caps length", () => {
    expect(redactInfrastructure("x".repeat(5000)).length).toBeLessThanOrEqual(500);
  });
});

describe("extractErrno", () => {
  it("finds a node errno", () => {
    expect(extractErrno("ENOSPC: no space left")).toBe("ENOSPC");
    expect(extractErrno("EACCES: permission denied")).toBe("EACCES");
    expect(extractErrno("something else entirely")).toBeNull();
  });
});
