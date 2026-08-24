import { describe, expect, it } from "bun:test";

import {
  describeDenial,
  rateLimitDecision,
  resetRateLimitRuntime,
  type HeaderLike,
} from "../src/utils/rate-limit-runtime";
import {
  type RateLimitConfig,
  TIER_DEFAULTS,
  createRateLimitState,
  readRateLimitConfig,
} from "../src/utils/rate-limit";
import { UNKNOWN_CLIENT_KEY } from "../src/utils/client-ip";
import { RateLimitedError, sanitiseError, toClientError } from "../src/utils/operational-error";

/** Headers stub. Case-insensitive like a real `Headers`. */
function headersOf(map: Record<string, string>): HeaderLike {
  const lower = Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower[name.toLowerCase()] ?? null };
}

function configWith(overrides: Partial<RateLimitConfig> = {}): RateLimitConfig {
  return {
    mode: "enforce",
    tiers: TIER_DEFAULTS,
    maxKeys: 10_000,
    sweepEvery: 512,
    sweepMs: 60_000,
    trustedProxyHops: 1,
    ipv6PrefixBits: 64,
    expectedReplicas: 1,
    ...overrides,
  };
}

const FORWARDED = headersOf({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" });

describe("tier resolution through the runtime", () => {
  it("puts the credential vault on strict (5/min)", () => {
    const out = rateLimitDecision({
      headers: FORWARDED,
      meta: { name: "getCredentials", filename: "src/routes/settings.tsx" },
      now: 0,
      state: createRateLimitState(),
      config: configWith(),
    });
    expect(out.tierName).toBe("strict");
    expect(out.decision.limit).toBe(5);
  });

  it("falls back to the filename when the name is unlisted", () => {
    const out = rateLimitDecision({
      headers: FORWARDED,
      meta: { name: "somethingBrandNew", filename: "src/utils/llm.ts" },
      now: 0,
      state: createRateLimitState(),
      config: configWith(),
    });
    expect(out.tierName).toBe("expensive");
  });

  it("gives an entirely unknown function moderate, never loose", () => {
    const out = rateLimitDecision({
      headers: FORWARDED,
      meta: { name: "mysteryFn", filename: "src/utils/nowhere.ts" },
      now: 0,
      state: createRateLimitState(),
      config: configWith(),
    });
    expect(out.tierName).toBe("moderate");
    expect(out.tierName).not.toBe("loose");
  });

  it("survives a runtime that supplies no meta at all", () => {
    const out = rateLimitDecision({
      headers: FORWARDED,
      meta: undefined,
      now: 0,
      state: createRateLimitState(),
      config: configWith(),
    });
    expect(out.tierName).toBe("moderate");
    expect(out.functionName).toBeNull();
  });
});

describe("client key resolution", () => {
  it("keys on the RIGHTMOST x-forwarded-for entry at one hop", () => {
    // The leftmost entry is entirely caller-supplied; keying on it is the
    // trap client-ip.ts exists to avoid.
    const out = rateLimitDecision({
      headers: FORWARDED,
      meta: { name: "anything" },
      now: 0,
      state: createRateLimitState(),
      config: configWith(),
    });
    expect(out.clientKey).toBe("5.6.7.8");
    expect(out.keySource).toBe("forwarded");
  });

  it("does not let a spoofed left entry mint a fresh identity", () => {
    const state = createRateLimitState();
    const config = configWith();
    // Same real peer, a different forged leftmost entry every time.
    const decisions = Array.from({ length: 7 }, (_unused, i) =>
      rateLimitDecision({
        headers: headersOf({ "x-forwarded-for": `10.0.0.${i}, 5.6.7.8` }),
        meta: { name: "getCredentials" },
        now: 0,
        state,
        config,
      }),
    );
    expect(decisions.every((d) => d.clientKey === "5.6.7.8")).toBe(true);
    expect(decisions[5].decision.allowed).toBe(false);
  });

  it("treats absent headers as unattributable and applies the TIGHTER tier", () => {
    const out = rateLimitDecision({
      headers: null,
      meta: { name: "anything" },
      now: 0,
      state: createRateLimitState(),
      config: configWith(),
    });
    expect(out.clientKey).toBe(UNKNOWN_CLIENT_KEY);
    expect(out.keySource).toBe("unknown");
    // unknownIp is 60/min, below global's 240 — not an exemption.
    expect(TIER_DEFAULTS.unknownIp.limit).toBeLessThan(TIER_DEFAULTS.global.limit);
  });

  it("reports why the key landed where it did, for the observe log", () => {
    const out = rateLimitDecision({
      headers: null,
      meta: { name: "anything" },
      now: 0,
      state: createRateLimitState(),
      config: configWith(),
    });
    expect(out.keyDetail).toContain("RATE_LIMIT_TRUSTED_PROXY_HOPS");
  });
});

describe("both dimensions are enforced", () => {
  it("denies on the global ceiling even while the caller's own tier has room", () => {
    const state = createRateLimitState();
    const config = configWith();
    // `loose` is 120/min; `global` is 240/min. Spend the global ceiling using a
    // different tier, then show a loose call is refused despite its own budget.
    for (let i = 0; i < 240; i += 1) {
      rateLimitDecision({
        headers: FORWARDED,
        meta: { name: "mysteryFn", filename: "src/utils/nowhere.ts" },
        now: 0,
        state,
        config,
      });
    }
    const out = rateLimitDecision({
      headers: FORWARDED,
      meta: { name: "getLlmStats" },
      now: 0,
      state,
      config,
    });
    expect(out.tierName).toBe("loose");
    expect(out.decision.allowed).toBe(false);
    expect(out.deniedBy).toBe("global");
  });

  it("denies on the per-tier limit while the global ceiling has room", () => {
    const state = createRateLimitState();
    const config = configWith();
    const decisions = Array.from({ length: 6 }, () =>
      rateLimitDecision({
        headers: FORWARDED,
        meta: { name: "revealCredential" },
        now: 0,
        state,
        config,
      }),
    );
    expect(decisions.slice(0, 5).every((d) => d.decision.allowed)).toBe(true);
    expect(decisions[5].decision.allowed).toBe(false);
    expect(decisions[5].deniedBy).toBe("strict");
  });

  it("keeps separate callers in separate buckets", () => {
    const state = createRateLimitState();
    const config = configWith();
    for (let i = 0; i < 6; i += 1) {
      rateLimitDecision({
        headers: headersOf({ "x-forwarded-for": "9.9.9.9" }),
        meta: { name: "getCredentials" },
        now: 0,
        state,
        config,
      });
    }
    const other = rateLimitDecision({
      headers: headersOf({ "x-forwarded-for": "8.8.8.8" }),
      meta: { name: "getCredentials" },
      now: 0,
      state,
      config,
    });
    expect(other.decision.allowed).toBe(true);
  });
});

describe("modes", () => {
  it("observe reports a denial without the caller having to act on it", () => {
    const state = createRateLimitState();
    const config = configWith({ mode: "observe" });
    let last = rateLimitDecision({
      headers: FORWARDED,
      meta: { name: "getCredentials" },
      now: 0,
      state,
      config,
    });
    for (let i = 0; i < 5; i += 1) {
      last = rateLimitDecision({
        headers: FORWARDED,
        meta: { name: "getCredentials" },
        now: 0,
        state,
        config,
      });
    }
    expect(last.decision.allowed).toBe(false);
    expect(last.mode).toBe("observe");
  });

  it("carries the configured mode through so the middleware can branch", () => {
    const out = rateLimitDecision({
      headers: FORWARDED,
      meta: { name: "getCredentials" },
      now: 0,
      state: createRateLimitState(),
      config: configWith({ mode: "off" }),
    });
    expect(out.mode).toBe("off");
  });

  it("defaults to observe when RATE_LIMIT_MODE is unset", () => {
    expect(readRateLimitConfig({}).mode).toBe("observe");
  });
});

describe("denial logging", () => {
  it("names the function, tier, dimension and key source", () => {
    const state = createRateLimitState();
    const config = configWith();
    let out = rateLimitDecision({
      headers: FORWARDED,
      meta: { name: "getCredentials" },
      now: 0,
      state,
      config,
    });
    for (let i = 0; i < 5; i += 1) {
      out = rateLimitDecision({
        headers: FORWARDED,
        meta: { name: "getCredentials" },
        now: 0,
        state,
        config,
      });
    }
    const line = describeDenial(out);
    expect(line).toContain("getCredentials");
    expect(line).toContain("strict");
    expect(line).toContain("forwarded");
  });

  it("does not put the client address in the log line", () => {
    const state = createRateLimitState();
    const config = configWith({ mode: "observe" });
    let out = rateLimitDecision({
      headers: FORWARDED,
      meta: { name: "getCredentials" },
      now: 0,
      state,
      config,
    });
    for (let i = 0; i < 5; i += 1) {
      out = rateLimitDecision({
        headers: FORWARDED,
        meta: { name: "getCredentials" },
        now: 0,
        state,
        config,
      });
    }
    expect(describeDenial(out)).not.toContain("5.6.7.8");
  });
});

describe("the denial reaches the client as a usable error", () => {
  it("maps RateLimitedError to RATE_LIMITED and preserves retryAfterMs", () => {
    const sanitised = sanitiseError(new RateLimitedError("Backing off.", 20_000, "strict"), "abc123");
    expect(sanitised.code).toBe("RATE_LIMITED");
    expect(sanitised.retryAfterMs).toBe(20_000);
    expect(sanitised.correlationId).toBe("abc123");
  });

  it("strips the stack, which is what leaks container paths to the browser", () => {
    const err = toClientError(
      sanitiseError(new RateLimitedError("Backing off.", 20_000, "strict"), "abc123"),
    );
    expect(err.stack).toBe("");
    // ~40 existing call sites render `err.message`; it must be the real reason.
    expect(err.message).toBe("Backing off.");
    expect((err as { code?: string }).code).toBe("RATE_LIMITED");
  });
});

describe("runtime singletons", () => {
  it("reuses one config and one state across calls", () => {
    resetRateLimitRuntime();
    const first = rateLimitDecision({ headers: FORWARDED, meta: { name: "getLlmStats" }, now: 0 });
    const second = rateLimitDecision({ headers: FORWARDED, meta: { name: "getLlmStats" }, now: 0 });
    // A shared state means the second call consumed budget the first left.
    expect(second.decision.remaining).toBe(first.decision.remaining - 1);
    resetRateLimitRuntime();
  });
});
