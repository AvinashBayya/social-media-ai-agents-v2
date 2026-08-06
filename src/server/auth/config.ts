import { authEnv } from "../env";
import type { LoginConfig } from "./login";
import type { Argon2Params } from "./password";
import type { RateLimitConfig } from "./rate-limit";

/**
 * Turns validated environment into the config objects the auth services take.
 *
 * The services themselves never read `process.env` — every one of them accepts
 * its settings as an argument. That is what lets the tests drive them with
 * deliberately weak Argon2 parameters (a real 19 MiB hash makes a test suite
 * take minutes) and a one-attempt rate limit, without touching the environment.
 * This module is the single place where the two meet.
 */

export function argonParams(): Argon2Params {
  const env = authEnv();
  return {
    memoryKib: env.ARGON2_MEMORY_KIB,
    iterations: env.ARGON2_ITERATIONS,
    parallelism: env.ARGON2_PARALLELISM,
  };
}

export function rateLimitConfig(): RateLimitConfig {
  const env = authEnv();
  return {
    maxAttempts: env.LOGIN_MAX_ATTEMPTS,
    windowSeconds: env.LOGIN_WINDOW_SECONDS,
    lockoutSeconds: env.LOGIN_LOCKOUT_SECONDS,
  };
}

/**
 * "Remember me" multiplier. A ticked box extends the session to 30 days;
 * unticked it stays at SESSION_MAX_AGE (8 hours by default).
 */
const REMEMBER_ME_SECONDS = 30 * 24 * 60 * 60;

export function loginConfig(): LoginConfig {
  const env = authEnv();
  return {
    argon: argonParams(),
    rateLimit: rateLimitConfig(),
    sessionMaxAgeSeconds: env.SESSION_MAX_AGE,
    rememberMaxAgeSeconds: REMEMBER_ME_SECONDS,
  };
}
