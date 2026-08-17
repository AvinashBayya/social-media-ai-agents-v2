/**
 * Rate limiter — the impure half.
 *
 * `rate-limit.ts` is pure: `now` injected, state passed in, no timers, no
 * `Date.now()`, no env read at call time. That is what makes its escalation
 * curve testable, and it must stay that way. But something has to own the
 * process-wide counter map and the parsed config, and something has to turn a
 * `Request`'s headers plus a `serverFnMeta` into a decision. That is this file.
 *
 * Same split the rest of `src/utils/` already uses — `imaging.ts` pure /
 * `imaging-client.ts` touching WASM and the DOM, `credibility.ts` synchronous /
 * `credibility-llm.ts` making the call, `analysis.ts` / `analysis-llm.ts`. The
 * decision logic lives HERE rather than in the middleware for the same reason
 * `llm.ts` keeps `summariseText` outside its `createServerFn` wrapper: a
 * middleware body cannot be reached by `bun test`, because it only ever runs
 * inside the Start runtime.
 *
 * WHY TWO DIMENSIONS PER REQUEST. A per-tier limit alone lets a caller spend
 * `strict` + `expensive` + `moderate` + `loose` budgets concurrently — 165
 * requests a minute while never exceeding any single tier. A global-only limit
 * alone lets 240 credential-vault attempts a minute through. `checkAllDimensions`
 * denies if either denies and reports the longer backoff, so the two compose
 * without either needing to know about the other.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO. It does not decide whether to deny.
 * It returns the decision and the mode, and the caller acts. Observe mode is
 * the whole reason: a module that threw on its own would have no way to express
 * "this would have been denied", which is the only output observe mode has.
 */

import type { ClientKeyResolution } from "./client-ip";
import { UNKNOWN_CLIENT_KEY, resolveClientKey } from "./client-ip";
import type {
  RateLimitConfig,
  RateLimitDecision,
  RateLimitMode,
  RateLimitSnapshot,
  RateLimitState,
  TierName,
} from "./rate-limit";
import {
  assertReplicaAssumption,
  checkAllDimensions,
  createRateLimitState,
  rateLimitSnapshot,
  readRateLimitConfig,
} from "./rate-limit";
import type { ServerFnIdentity } from "./rate-limit-tiers";
import { resolveTier } from "./rate-limit-tiers";

// ─── Process singletons ────────────────────────────────────────────────────

let sharedConfig: RateLimitConfig | null = null;
let sharedState: RateLimitState | null = null;

/**
 * Parse the config once per process.
 *
 * `assertReplicaAssumption` fires here rather than at import time so that the
 * warning lands in the request log of a deployment that is actually serving,
 * not in a build log nobody reads. It is a no-op at one replica.
 */
export function rateLimitConfig(): RateLimitConfig {
  if (!sharedConfig) {
    sharedConfig = readRateLimitConfig();
    assertReplicaAssumption(sharedConfig);
  }
  return sharedConfig;
}

export function rateLimitState(): RateLimitState {
  if (!sharedState) sharedState = createRateLimitState();
  return sharedState;
}

/**
 * Drop both singletons. For tests that need a clean process view; production
 * code must not call this — discarding the state map forgets every active
 * block and strike, which is precisely the reset an abuser wants.
 */
export function resetRateLimitRuntime(): void {
  sharedConfig = null;
  sharedState = null;
}

// ─── Decision ──────────────────────────────────────────────────────────────

/** Anything with a case-insensitive `get`. A `Headers` in practice. */
export interface HeaderLike {
  get(name: string): string | null;
}

/** Stands in for absent headers. Yields UNKNOWN_CLIENT_KEY, never an exemption. */
const NO_HEADERS: HeaderLike = { get: () => null };

export interface RateLimitDecisionInput {
  /** Null when the runtime could not expose them — treated as unattributable. */
  headers: HeaderLike | null;
  /** `serverFnMeta` from function middleware. Unknown → `moderate`, never `loose`. */
  meta: ServerFnIdentity | null | undefined;
  now: number;
  /** Injected by tests so the singletons are never touched. */
  state?: RateLimitState;
  config?: RateLimitConfig;
  peerAddress?: string | null;
}

export interface RateLimitOutcome {
  decision: RateLimitDecision;
  /** Which dimension denied, or null when allowed. */
  deniedBy: string | null;
  tierName: TierName;
  clientKey: string;
  /** `forwarded` | `peer` | `unknown` — the answer to "why one bucket?". */
  keySource: ClientKeyResolution["source"];
  /** Authored by `resolveClientKey`. Logged verbatim in observe mode. */
  keyDetail: string;
  mode: RateLimitMode;
  /** Server-fn name when the runtime supplied one. Null is a real state. */
  functionName: string | null;
}

/**
 * Resolve caller, tier and verdict for one server-function call.
 *
 * Does not throw and does not deny — see the module header. `mode` is returned
 * so the caller can act on it.
 */
export function rateLimitDecision(input: RateLimitDecisionInput): RateLimitOutcome {
  const config = input.config ?? rateLimitConfig();
  const state = input.state ?? rateLimitState();

  const resolution = resolveClientKey(input.headers ?? NO_HEADERS, {
    trustedProxyHops: config.trustedProxyHops,
    ipv6PrefixBits: config.ipv6PrefixBits,
    peerAddress: input.peerAddress ?? null,
  });

  const tierName = resolveTier(input.meta);

  // An unattributable caller gets `unknownIp` (60/min) rather than `global`
  // (240/min) on the ceiling dimension. Tighter, not exempt — client-ip.ts's
  // stance, and softening it here would undo it.
  const ceiling =
    resolution.key === UNKNOWN_CLIENT_KEY ? config.tiers.unknownIp : config.tiers.global;

  const { decision, deniedBy } = checkAllDimensions(
    state,
    [
      { name: "global", key: resolution.key, tier: ceiling },
      { name: tierName, key: resolution.key, tier: config.tiers[tierName] },
    ],
    input.now,
    { maxKeys: config.maxKeys, sweepEvery: config.sweepEvery, sweepMs: config.sweepMs },
  );

  return {
    decision,
    deniedBy,
    tierName,
    clientKey: resolution.key,
    keySource: resolution.source,
    keyDetail: resolution.detail,
    mode: config.mode,
    functionName: input.meta?.name?.trim() || null,
  };
}

/**
 * One log line for a denial.
 *
 * Authored from values we chose — a tier name, a dimension name, a source
 * enum, integers — plus `keyDetail`, which `resolveClientKey` authors. The
 * client key itself is an IP and is NOT included: this string is built to be
 * safe to log, and `operational-error.ts` exists because concatenating
 * addresses into messages is how they escape.
 */
export function describeDenial(outcome: RateLimitOutcome): string {
  const fn = outcome.functionName ?? "an unnamed server function";
  const verb = outcome.mode === "enforce" ? "denied" : "would have denied";
  return (
    `rate-limit[${outcome.mode}]: ${verb} ${fn} (tier ${outcome.tierName}, ` +
    `dimension ${outcome.deniedBy ?? "unknown"}, strike ${outcome.decision.strikes}, ` +
    `retry after ${Math.ceil(outcome.decision.retryAfterMs / 1000)}s). ` +
    `Client key source: ${outcome.keySource} — ${outcome.keyDetail}`
  );
}

/** Current limiter state for an operator panel. Wraps the pure snapshot. */
export function rateLimitStatus(now: number): RateLimitSnapshot {
  return rateLimitSnapshot(rateLimitState(), rateLimitConfig(), now);
}
