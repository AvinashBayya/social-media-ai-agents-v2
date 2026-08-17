import { describe, expect, it } from "bun:test";

import {
  TIER_DEFAULTS,
  type TierConfig,
  assertReplicaAssumption,
  checkAllDimensions,
  checkRateLimit,
  createRateLimitState,
  evictIfNeeded,
  keyJitter,
  rateLimitSnapshot,
  readPositiveInt,
  readRateLimitConfig,
  readTierConfig,
  sweep,
} from "../src/utils/rate-limit";
import { resolveTier, classifiedFunctionNames } from "../src/utils/rate-limit-tiers";

const TIER: TierConfig = {
  limit: 3,
  windowMs: 1000,
  baseBackoffMs: 100,
  maxBackoffMs: 10_000,
  strikeDecayWindows: 2,
};

/** Drive n requests at a fixed instant and return the decisions. */
function burst(state: ReturnType<typeof createRateLimitState>, key: string, n: number, at: number) {
  return Array.from({ length: n }, () => checkRateLimit(state, key, TIER, at));
}

describe("window behaviour", () => {
  it("allows up to the limit and denies beyond it", () => {
    const state = createRateLimitState();
    const decisions = burst(state, "a", 4, 0);
    expect(decisions.slice(0, 3).every((d) => d.allowed)).toBe(true);
    expect(decisions[3].allowed).toBe(false);
  });

  it("reports remaining accurately", () => {
    const state = createRateLimitState();
    expect(checkRateLimit(state, "a", TIER, 0).remaining).toBe(2);
    expect(checkRateLimit(state, "a", TIER, 0).remaining).toBe(1);
    expect(checkRateLimit(state, "a", TIER, 0).remaining).toBe(0);
  });

  it("resets the count when the window rolls", () => {
    const state = createRateLimitState();
    burst(state, "a", 3, 0);
    // Past the block AND past the window.
    expect(checkRateLimit(state, "a", TIER, 5000).allowed).toBe(true);
  });

  it("keys are independent", () => {
    const state = createRateLimitState();
    burst(state, "a", 4, 0);
    expect(checkRateLimit(state, "b", TIER, 0).allowed).toBe(true);
  });
});

describe("exponential backoff", () => {
  it("escalates across strikes", () => {
    const state = createRateLimitState();
    let now = 0;

    burst(state, "a", 4, now);
    const first = checkRateLimit(state, "a", TIER, now).retryAfterMs;

    // Wait out the first block and the window, then offend again.
    now += 5000;
    burst(state, "a", 4, now);
    const second = checkRateLimit(state, "a", TIER, now).retryAfterMs;

    expect(second).toBeGreaterThan(first);
  });

  it("caps at maxBackoffMs", () => {
    const state = createRateLimitState();
    const tight: TierConfig = { ...TIER, baseBackoffMs: 100, maxBackoffMs: 500 };
    let now = 0;
    for (let i = 0; i < 12; i += 1) {
      now += 60_000;
      for (let j = 0; j < 4; j += 1) checkRateLimit(state, "a", tight, now);
    }
    const decision = checkRateLimit(state, "a", tight, now);
    // Jitter is +/-10%, so allow the band rather than an exact equality.
    expect(decision.retryAfterMs).toBeLessThanOrEqual(Math.ceil(500 * 1.1));
  });

  it("never overflows the exponent on a long-lived offender", () => {
    const state = createRateLimitState();
    let now = 0;
    for (let i = 0; i < 60; i += 1) {
      now += 60_000;
      for (let j = 0; j < 4; j += 1) checkRateLimit(state, "a", TIER, now);
    }
    const decision = checkRateLimit(state, "a", TIER, now);
    expect(Number.isFinite(decision.retryAfterMs)).toBe(true);
    expect(decision.retryAfterMs).toBeLessThanOrEqual(Math.ceil(TIER.maxBackoffMs * 1.1));
  });
});

describe("a retry during an active block does not extend it", () => {
  // This is the property that keeps exponential backoff from degenerating into
  // the hard lockout the brief rules out: a stuck client retry loop must not
  // walk the backoff to its cap.
  it("holds the same deadline across hammering", () => {
    const state = createRateLimitState();
    burst(state, "a", 4, 0);
    const firstDenial = checkRateLimit(state, "a", TIER, 0);

    let last = firstDenial;
    for (let t = 1; t < 50; t += 1) {
      last = checkRateLimit(state, "a", TIER, t);
      expect(last.allowed).toBe(false);
    }

    // Deadline is fixed, so retryAfter shrinks as the clock advances.
    expect(last.retryAfterMs).toBeLessThan(firstDenial.retryAfterMs);
    expect(last.strikes).toBe(firstDenial.strikes);
    expect(last.reason).toContain("does not extend it");
  });
});

describe("strike decay", () => {
  it("forgives a caller after enough clean windows", () => {
    const state = createRateLimitState();
    burst(state, "a", 4, 0);
    expect(checkRateLimit(state, "a", TIER, 0).strikes).toBe(1);

    // Several clean windows: one request each, well past the block.
    let now = 5000;
    for (let i = 0; i < 6; i += 1) {
      now += TIER.windowMs;
      checkRateLimit(state, "a", TIER, now);
    }
    expect(checkRateLimit(state, "a", TIER, now + TIER.windowMs).strikes).toBe(0);
  });
});

describe("memory bounds", () => {
  it("evicts down to the cap", () => {
    const state = createRateLimitState();
    for (let i = 0; i < 50; i += 1) checkRateLimit(state, `k${i}`, TIER, 0, { maxKeys: 10 });
    expect(state.entries.size).toBeLessThanOrEqual(10);
  });

  it("prefers evicting clean entries over blocked ones", () => {
    const state = createRateLimitState();
    burst(state, "offender", 4, 0); // now blocked with a strike
    for (let i = 0; i < 40; i += 1) checkRateLimit(state, `clean${i}`, TIER, 0, { maxKeys: 5 });

    evictIfNeeded(state, 5, 0);
    const survived = [...state.entries.keys()].some((k) => k.includes("offender"));
    expect(survived).toBe(true);
  });

  it("sweep never drops a blocked or striked entry", () => {
    const state = createRateLimitState();
    burst(state, "offender", 4, 0);
    checkRateLimit(state, "quiet", TIER, 0);

    sweep(state, TIER.windowMs, 100_000);
    expect(state.entries.has("offender")).toBe(true);
    expect(state.entries.has("quiet")).toBe(false);
  });
});

describe("multiple dimensions", () => {
  it("denies if any dimension denies and reports the longest wait", () => {
    const state = createRateLimitState();
    const wide: TierConfig = { ...TIER, limit: 100 };

    for (let i = 0; i < 4; i += 1) {
      checkAllDimensions(
        state,
        [
          { name: "ip", key: "203.0.113.7", tier: TIER },
          { name: "global", key: "all", tier: wide },
        ],
        0,
      );
    }
    const { decision, deniedBy } = checkAllDimensions(
      state,
      [
        { name: "ip", key: "203.0.113.7", tier: TIER },
        { name: "global", key: "all", tier: wide },
      ],
      0,
    );
    expect(decision.allowed).toBe(false);
    expect(deniedBy).toBe("ip");
  });
});

describe("configuration", () => {
  it("falls back and warns on a garbage value rather than disabling the limit", () => {
    const warnings: string[] = [];
    const value = readPositiveInt("RATE_LIMIT_X", 42, { RATE_LIMIT_X: "nonsense" }, (m) =>
      warnings.push(m),
    );
    expect(value).toBe(42);
    expect(warnings[0]).toContain("RATE_LIMIT_X");
    expect(warnings[0]).toContain("NOT disabled");
  });

  it("rejects zero and negative values", () => {
    expect(readPositiveInt("X", 10, { X: "0" }, () => {})).toBe(10);
    expect(readPositiveInt("X", 10, { X: "-5" }, () => {})).toBe(10);
  });

  it("reads tier overrides from env", () => {
    const cfg = readTierConfig("strict", TIER_DEFAULTS.strict, { RATE_LIMIT_STRICT_LIMIT: "9" }, () => {});
    expect(cfg.limit).toBe(9);
    expect(cfg.windowMs).toBe(TIER_DEFAULTS.strict.windowMs);
  });

  it("defaults to observe mode, not enforce", () => {
    expect(readRateLimitConfig({}, () => {}).mode).toBe("observe");
  });

  it("warns loudly when more than one replica is expected", () => {
    const warnings: string[] = [];
    const cfg = readRateLimitConfig({ RATE_LIMIT_EXPECTED_REPLICAS: "3" }, () => {});
    assertReplicaAssumption(cfg, (m) => warnings.push(m));
    expect(warnings[0]).toContain("multiplied by the replica count");
  });
});

describe("jitter", () => {
  it("is deterministic for a given key", () => {
    expect(keyJitter("abc")).toBe(keyJitter("abc"));
  });

  it("stays within +/-10%", () => {
    for (const k of ["a", "bb", "203.0.113.7", "2001:db8::/64"]) {
      expect(Math.abs(keyJitter(k))).toBeLessThanOrEqual(0.1001);
    }
  });
});

describe("snapshot", () => {
  it("states its limitations rather than implying durability", () => {
    const state = createRateLimitState();
    const snap = rateLimitSnapshot(state, readRateLimitConfig({}, () => {}), 0);
    expect(snap.limitations.join(" ")).toContain("cold start");
    expect(snap.limitations.join(" ")).toContain("single replica");
  });
});

describe("tier resolution", () => {
  it("puts credential-vault operations in the strictest tier", () => {
    expect(resolveTier({ name: "revealCredential" })).toBe("strict");
    expect(resolveTier({ name: "getCredentials" })).toBe("strict");
    expect(resolveTier({ name: "saveCredentials" })).toBe("strict");
  });

  it("puts metered model calls in the expensive tier", () => {
    expect(resolveTier({ name: "llmReport" })).toBe("expensive");
    expect(resolveTier({ name: "generateIntelligenceProduct" })).toBe("expensive");
  });

  it("falls back on the filename for an unlisted function", () => {
    expect(resolveTier({ name: "someNewVaultFn", filename: "src/utils/credential-vault.ts" })).toBe(
      "strict",
    );
    expect(resolveTier({ name: "someNewCollector", filename: "src/utils/social.ts" })).toBe(
      "moderate",
    );
  });

  it("defaults an unknown function to moderate, never loose", () => {
    // Absence of a classification is a gap, not a licence — same stance as
    // allowsAutomatedCollection() in collection-policy.ts.
    expect(resolveTier({ name: "somethingBrandNew" })).toBe("moderate");
    expect(resolveTier(undefined)).toBe("moderate");
    expect(resolveTier({})).toBe("moderate");
  });

  it("classifies every credential-vault server function explicitly", () => {
    const named = classifiedFunctionNames();
    for (const fn of [
      "getCredentials",
      "saveCredentials",
      "addCredential",
      "deleteCredential",
      "revealCredential",
      "verifyCredential",
    ]) {
      expect(named).toContain(fn);
    }
  });
});
