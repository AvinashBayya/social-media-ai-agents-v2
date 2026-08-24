/**
 * Rate limiter core — sliding window plus a persistent strike counter.
 *
 * Pure on purpose. `now` is injected, the state object is passed in, and there
 * is no `setInterval`, no `Date.now()` and no `Math.random()` anywhere below.
 * That is what makes the escalation behaviour testable, and it matches the
 * convention the rest of `src/utils/` already follows.
 *
 * WHY NOT A PLAIN TOKEN BUCKET. A bucket has no memory of repeat offence: a
 * caller who floods, waits, and floods again meets the identical limit every
 * time. The brief asks for exponential backoff rather than a hard lockout, so
 * each window that exceeds the limit adds a strike, and the block length is
 * `base * 2^(strikes-1)` capped at `maxBackoffMs`. Strikes decay over clean
 * windows, so a caller who behaves is forgiven rather than permanently marked.
 *
 * THE RULE THAT PREVENTS A HARD LOCKOUT: a request arriving DURING an active
 * block is denied but does NOT extend the block and does NOT add a strike.
 * Without that, a client-side retry loop — which is exactly what a stuck UI
 * produces — walks the backoff to its cap and stays there forever. That is the
 * hard lockout the brief rules out, arrived at accidentally.
 *
 * TWO LIMITATIONS, STATED RATHER THAN HIDDEN:
 *
 *   1. State is in-process. The container scales to zero, so every cold start
 *      begins with an empty map and a patient attacker gets a fresh budget each
 *      cycle. This raises the cost of abuse; it does not stop it. Persisting to
 *      `data/` was considered and REJECTED — that directory is documented as
 *      dying with the replica, so persisting there would be a durability claim
 *      the storage cannot honour.
 *   2. This is correct only at a single replica. Raising `maxReplicas` above 1
 *      multiplies every effective limit by the replica count. `assertReplicaAssumption`
 *      exists to make that loud rather than silent.
 */

// ─── Configuration ─────────────────────────────────────────────────────────

export interface TierConfig {
  /** Requests permitted per window before a strike is recorded. */
  limit: number;
  windowMs: number;
  /** Block length for the first strike. Doubles per subsequent strike. */
  baseBackoffMs: number;
  maxBackoffMs: number;
  /** Clean windows that must elapse to shed one strike. */
  strikeDecayWindows: number;
}

export type TierName = "strict" | "expensive" | "moderate" | "loose" | "global" | "unknownIp";

/**
 * Defaults, chosen so a working analyst never meets them and an abuser does.
 *
 * `strict` covers the credential vault: five attempts a minute is generous for
 * a human pressing Save and hostile to anyone enumerating.
 * `expensive` covers anything that spends real money or upstream quota.
 * `unknownIp` is deliberately tighter than `global` — a request we cannot
 * attribute must not get the same budget as one we can.
 */
export const TIER_DEFAULTS: Record<TierName, TierConfig> = {
  strict: {
    limit: 5,
    windowMs: 60_000,
    baseBackoffMs: 30_000,
    maxBackoffMs: 900_000,
    strikeDecayWindows: 10,
  },
  expensive: {
    limit: 10,
    windowMs: 60_000,
    baseBackoffMs: 20_000,
    maxBackoffMs: 600_000,
    strikeDecayWindows: 5,
  },
  moderate: {
    limit: 30,
    windowMs: 60_000,
    baseBackoffMs: 10_000,
    maxBackoffMs: 300_000,
    strikeDecayWindows: 5,
  },
  loose: {
    limit: 120,
    windowMs: 60_000,
    baseBackoffMs: 5_000,
    maxBackoffMs: 60_000,
    strikeDecayWindows: 3,
  },
  global: {
    limit: 240,
    windowMs: 60_000,
    baseBackoffMs: 10_000,
    maxBackoffMs: 300_000,
    strikeDecayWindows: 5,
  },
  unknownIp: {
    limit: 60,
    windowMs: 60_000,
    baseBackoffMs: 30_000,
    maxBackoffMs: 300_000,
    strikeDecayWindows: 5,
  },
};

/** Upper bound on tracked keys. ~120 bytes/entry, so 10k is roughly 1.2 MB. */
export const DEFAULT_MAX_KEYS = 10_000;
/** Checks between lazy sweeps. No timer — see the module header. */
export const DEFAULT_SWEEP_EVERY = 512;
export const DEFAULT_SWEEP_MS = 60_000;

// ─── Env parsing ───────────────────────────────────────────────────────────

/**
 * Read a positive integer from the environment.
 *
 * A malformed value falls back to the default AND WARNS NAMING THE VARIABLE.
 * Silently accepting garbage is how a security control gets disabled by a typo
 * and nobody finds out until it matters.
 */
export function readPositiveInt(
  name: string,
  fallback: number,
  env: Record<string, string | undefined> = process.env,
  warn: (msg: string) => void = console.warn,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    warn(
      `rate-limit: ${name}="${raw}" is not a positive integer. Falling back to ${fallback}. ` +
        `The limit is NOT disabled.`,
    );
    return fallback;
  }
  return parsed;
}

/** Build one tier's config from env, falling back per-field. */
export function readTierConfig(
  tier: TierName,
  defaults: TierConfig = TIER_DEFAULTS[tier],
  env: Record<string, string | undefined> = process.env,
  warn: (msg: string) => void = console.warn,
): TierConfig {
  const prefix = `RATE_LIMIT_${tier.toUpperCase()}`;
  return {
    limit: readPositiveInt(`${prefix}_LIMIT`, defaults.limit, env, warn),
    windowMs: readPositiveInt(`${prefix}_WINDOW_MS`, defaults.windowMs, env, warn),
    baseBackoffMs: readPositiveInt(`${prefix}_BASE_BACKOFF_MS`, defaults.baseBackoffMs, env, warn),
    maxBackoffMs: readPositiveInt(`${prefix}_MAX_BACKOFF_MS`, defaults.maxBackoffMs, env, warn),
    strikeDecayWindows: readPositiveInt(
      `${prefix}_STRIKE_DECAY_WINDOWS`,
      defaults.strikeDecayWindows,
      env,
      warn,
    ),
  };
}

export type RateLimitMode = "observe" | "enforce" | "off";

export interface RateLimitConfig {
  mode: RateLimitMode;
  tiers: Record<TierName, TierConfig>;
  maxKeys: number;
  sweepEvery: number;
  sweepMs: number;
  trustedProxyHops: number;
  ipv6PrefixBits: number;
  expectedReplicas: number;
}

/**
 * Assemble the whole config from env.
 *
 * Mode defaults to `observe`, not `enforce`. Deploying straight to enforce
 * risks collapsing every caller into one bucket if the proxy hop count is
 * wrong for this ingress — which locks out the demo. Observe first, read the
 * logs, then flip.
 */
export function readRateLimitConfig(
  env: Record<string, string | undefined> = process.env,
  warn: (msg: string) => void = console.warn,
): RateLimitConfig {
  const rawMode = (env.RATE_LIMIT_MODE ?? "observe").trim().toLowerCase();
  const mode: RateLimitMode =
    rawMode === "enforce" || rawMode === "off" || rawMode === "observe"
      ? (rawMode as RateLimitMode)
      : (warn(
          `rate-limit: RATE_LIMIT_MODE="${env.RATE_LIMIT_MODE}" is not one of ` +
            `observe|enforce|off. Falling back to observe.`,
        ),
        "observe");

  const tiers = Object.fromEntries(
    (Object.keys(TIER_DEFAULTS) as TierName[]).map((t) => [t, readTierConfig(t, TIER_DEFAULTS[t], env, warn)]),
  ) as Record<TierName, TierConfig>;

  return {
    mode,
    tiers,
    maxKeys: readPositiveInt("RATE_LIMIT_MAX_KEYS", DEFAULT_MAX_KEYS, env, warn),
    sweepEvery: readPositiveInt("RATE_LIMIT_SWEEP_EVERY", DEFAULT_SWEEP_EVERY, env, warn),
    sweepMs: readPositiveInt("RATE_LIMIT_SWEEP_MS", DEFAULT_SWEEP_MS, env, warn),
    trustedProxyHops: readPositiveInt("RATE_LIMIT_TRUSTED_PROXY_HOPS", 1, env, warn),
    ipv6PrefixBits: readPositiveInt("RATE_LIMIT_IPV6_PREFIX_BITS", 64, env, warn),
    expectedReplicas: readPositiveInt("RATE_LIMIT_EXPECTED_REPLICAS", 1, env, warn),
  };
}

/**
 * Warn when the deployment breaks this limiter's core assumption.
 * Called once at boot; returns the message so a test can assert on it.
 */
export function assertReplicaAssumption(
  config: RateLimitConfig,
  warn: (msg: string) => void = console.warn,
): string | null {
  if (config.expectedReplicas <= 1) return null;
  const msg =
    `rate-limit: RATE_LIMIT_EXPECTED_REPLICAS=${config.expectedReplicas}. This limiter keeps ` +
    `counters in process memory, so every effective limit is multiplied by the replica count. ` +
    `A tier configured at N requests/window actually permits up to ${config.expectedReplicas}N.`;
  warn(msg);
  return msg;
}

// ─── State ─────────────────────────────────────────────────────────────────

export interface RateLimitEntry {
  windowStart: number;
  count: number;
  strikes: number;
  /** Epoch ms until which requests are refused. 0 when not blocked. */
  blockedUntil: number;
  lastSeen: number;
  /** Consecutive windows completed without exceeding the limit. */
  cleanWindows: number;
}

export interface RateLimitState {
  /** Insertion-ordered, so approximate-LRU eviction is free. */
  entries: Map<string, RateLimitEntry>;
  checksSinceSweep: number;
  lastSweep: number;
}

export function createRateLimitState(): RateLimitState {
  return { entries: new Map(), checksSinceSweep: 0, lastSweep: 0 };
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Requests left in the current window. 0 when blocked. */
  remaining: number;
  limit: number;
  /** Epoch ms at which the current window rolls. */
  resetAtMs: number;
  retryAfterMs: number;
  strikes: number;
  /** Operator-facing explanation. Never a placeholder. */
  reason: string;
}

// ─── Jitter ────────────────────────────────────────────────────────────────

/**
 * Deterministic ±10% jitter derived from the key.
 *
 * Not `Math.random()`: this module must stay pure so its escalation curve is
 * testable, and the codebase already bans that call in reachable code. Keying
 * the jitter on the caller still de-synchronises retry storms across distinct
 * callers, which is the only property jitter is here for.
 */
export function keyJitter(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  // Map to [-0.1, 0.1]
  return ((hash >>> 0) % 2001) / 10000 - 0.1;
}

export function backoffFor(entry: RateLimitEntry, tier: TierConfig, key: string): number {
  const exponent = Math.max(0, entry.strikes - 1);
  // Cap the exponent before shifting so 2**strikes cannot overflow to Infinity
  // on a long-lived offender.
  const raw = tier.baseBackoffMs * 2 ** Math.min(exponent, 30);
  const capped = Math.min(raw, tier.maxBackoffMs);
  return Math.max(1, Math.round(capped * (1 + keyJitter(key))));
}

// ─── The check ─────────────────────────────────────────────────────────────

export function checkRateLimit(
  state: RateLimitState,
  key: string,
  tier: TierConfig,
  now: number,
  opts: { maxKeys?: number; sweepEvery?: number; sweepMs?: number } = {},
): RateLimitDecision {
  const maxKeys = opts.maxKeys ?? DEFAULT_MAX_KEYS;
  const sweepEvery = opts.sweepEvery ?? DEFAULT_SWEEP_EVERY;
  const sweepMs = opts.sweepMs ?? DEFAULT_SWEEP_MS;

  state.checksSinceSweep += 1;
  if (state.checksSinceSweep >= sweepEvery || now - state.lastSweep > sweepMs) {
    sweep(state, tier.windowMs, now);
  }

  let entry = state.entries.get(key);
  if (!entry) {
    entry = {
      windowStart: now,
      count: 0,
      strikes: 0,
      blockedUntil: 0,
      lastSeen: now,
      cleanWindows: 0,
    };
  } else {
    // Touch for LRU: delete + set moves the key to the back of the Map's
    // insertion order, so the front is always the least recently used.
    state.entries.delete(key);
  }
  entry.lastSeen = now;

  // 1. Active block. Denied, but NOT extended and NOT re-struck — see header.
  if (entry.blockedUntil > now) {
    state.entries.set(key, entry);
    evictIfNeeded(state, maxKeys, now);
    return {
      allowed: false,
      remaining: 0,
      limit: tier.limit,
      resetAtMs: entry.windowStart + tier.windowMs,
      retryAfterMs: entry.blockedUntil - now,
      strikes: entry.strikes,
      reason:
        `Rate limit backoff is active for another ${Math.ceil((entry.blockedUntil - now) / 1000)}s. ` +
        `Retrying sooner does not extend it.`,
    };
  }

  // 2. Roll the window, decaying strikes across clean ones.
  if (now - entry.windowStart >= tier.windowMs) {
    const elapsedWindows = Math.floor((now - entry.windowStart) / tier.windowMs);
    const wasClean = entry.count <= tier.limit;
    entry.cleanWindows = wasClean ? entry.cleanWindows + elapsedWindows : 0;
    while (entry.strikes > 0 && entry.cleanWindows >= tier.strikeDecayWindows) {
      entry.strikes -= 1;
      entry.cleanWindows -= tier.strikeDecayWindows;
    }
    entry.windowStart = now;
    entry.count = 0;
    entry.blockedUntil = 0;
  }

  // 3. Count and decide.
  entry.count += 1;
  if (entry.count > tier.limit) {
    entry.strikes += 1;
    entry.cleanWindows = 0;
    const backoff = backoffFor(entry, tier, key);
    entry.blockedUntil = now + backoff;
    state.entries.set(key, entry);
    evictIfNeeded(state, maxKeys, now);
    return {
      allowed: false,
      remaining: 0,
      limit: tier.limit,
      resetAtMs: entry.windowStart + tier.windowMs,
      retryAfterMs: backoff,
      strikes: entry.strikes,
      reason:
        `Exceeded ${tier.limit} requests in ${Math.round(tier.windowMs / 1000)}s ` +
        `(strike ${entry.strikes}). Backing off for ${Math.ceil(backoff / 1000)}s.`,
    };
  }

  state.entries.set(key, entry);
  evictIfNeeded(state, maxKeys, now);
  return {
    allowed: true,
    remaining: tier.limit - entry.count,
    limit: tier.limit,
    resetAtMs: entry.windowStart + tier.windowMs,
    retryAfterMs: 0,
    strikes: entry.strikes,
    reason: "Within limit.",
  };
}

/**
 * Check several dimensions at once (per-IP and per-account, say).
 *
 * Denies if ANY dimension denies, and reports the longest backoff — a caller
 * told to wait for the shorter of two active blocks would retry into the
 * longer one and learn nothing.
 */
export function checkAllDimensions(
  state: RateLimitState,
  dimensions: Array<{ name: string; key: string; tier: TierConfig }>,
  now: number,
  opts: { maxKeys?: number; sweepEvery?: number; sweepMs?: number } = {},
): { decision: RateLimitDecision; deniedBy: string | null } {
  let worst: RateLimitDecision | null = null;
  let deniedBy: string | null = null;

  for (const d of dimensions) {
    const decision = checkRateLimit(state, `${d.name}:${d.key}`, d.tier, now, opts);

    if (!decision.allowed) {
      // A denial always outranks an allowance; between two denials the longer
      // backoff wins, so the caller is told the wait that actually applies.
      if (!worst || worst.allowed || decision.retryAfterMs > worst.retryAfterMs) {
        worst = decision;
        deniedBy = d.name;
      }
      continue;
    }

    // Among allowances, report the dimension closest to its ceiling — that is
    // the one whose x-ratelimit-remaining header is meaningful.
    if (!worst) worst = decision;
    else if (worst.allowed && decision.remaining < worst.remaining) worst = decision;
  }

  return {
    decision: worst ?? {
      allowed: true,
      remaining: 0,
      limit: 0,
      resetAtMs: now,
      retryAfterMs: 0,
      strikes: 0,
      reason: "No dimensions configured.",
    },
    deniedBy,
  };
}

// ─── Bounds ────────────────────────────────────────────────────────────────

/**
 * Drop idle entries. Never drops a blocked or striked entry — forgetting an
 * active offender is the one thing a sweep must not do.
 */
export function sweep(state: RateLimitState, windowMs: number, now: number): number {
  const cutoff = now - windowMs * 2;
  let dropped = 0;
  for (const [key, entry] of state.entries) {
    if (entry.blockedUntil > now || entry.strikes > 0) continue;
    if (entry.lastSeen < cutoff) {
      state.entries.delete(key);
      dropped += 1;
    }
  }
  state.checksSinceSweep = 0;
  state.lastSweep = now;
  return dropped;
}

/**
 * Enforce the hard key cap.
 *
 * EVICTION IS ITSELF A BYPASS: flood the map with junk keys and a real
 * offender's strike record is forgotten. Two things blunt it. First, keys are
 * derived from the TRUSTED proxy hop (see client-ip.ts), so they cannot be
 * minted freely. Second, the first pass here skips anything blocked or
 * striked, and only if that yields nothing does the second pass evict them.
 * The residual risk is real and is documented rather than claimed away.
 */
export function evictIfNeeded(state: RateLimitState, maxKeys: number, now: number): number {
  if (state.entries.size <= maxKeys) return 0;

  let evicted = 0;
  // Pass 1 — clean entries only, oldest first.
  for (const [key, entry] of state.entries) {
    if (state.entries.size <= maxKeys) break;
    if (entry.blockedUntil > now || entry.strikes > 0) continue;
    state.entries.delete(key);
    evicted += 1;
  }

  // Pass 2 — nothing clean left; the map is entirely offenders. Evict oldest.
  for (const key of state.entries.keys()) {
    if (state.entries.size <= maxKeys) break;
    state.entries.delete(key);
    evicted += 1;
  }

  return evicted;
}

// ─── Observability ─────────────────────────────────────────────────────────

export interface RateLimitSnapshot {
  mode: RateLimitMode;
  trackedKeys: number;
  maxKeys: number;
  blockedKeys: number;
  strikedKeys: number;
  tiers: Record<TierName, TierConfig>;
  trustedProxyHops: number;
  /** Stated, not hidden — see the module header. */
  limitations: string[];
}

export function rateLimitSnapshot(
  state: RateLimitState,
  config: RateLimitConfig,
  now: number,
): RateLimitSnapshot {
  let blocked = 0;
  let striked = 0;
  for (const entry of state.entries.values()) {
    if (entry.blockedUntil > now) blocked += 1;
    if (entry.strikes > 0) striked += 1;
  }
  return {
    mode: config.mode,
    trackedKeys: state.entries.size,
    maxKeys: config.maxKeys,
    blockedKeys: blocked,
    strikedKeys: striked,
    tiers: config.tiers,
    trustedProxyHops: config.trustedProxyHops,
    limitations: [
      "Counters live in process memory and reset on every cold start. The container " +
        "scales to zero, so an attacker who waits out the idle timeout gets a fresh budget.",
      "Correct only at a single replica. Each additional replica multiplies every " +
        "effective limit.",
    ],
  };
}
