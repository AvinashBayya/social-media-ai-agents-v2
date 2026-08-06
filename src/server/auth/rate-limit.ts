import type { Database } from "../db";

/**
 * Login throttling and account lockout.
 *
 * Backed by the LoginAttempt table rather than an in-process counter. An
 * in-memory limiter is per-instance and per-process-lifetime: it resets on
 * every restart, does not exist across replicas, and on a container app that
 * scales to zero it is effectively erased between bursts of traffic. Storing
 * attempts makes the limit hold across all three.
 *
 * Two independent windows are enforced:
 *  - per identifier, which stops an attacker grinding one account
 *  - per IP, which stops them spreading the same guess across many accounts
 *
 * Successful logins clear the identifier's failures so a user who eventually
 * remembers their password is not left locked out by their own typos.
 */

export interface RateLimitConfig {
  maxAttempts: number;
  windowSeconds: number;
  lockoutSeconds: number;
}

export interface RateLimitVerdict {
  blocked: boolean;
  /** Failures counted inside the current window. */
  failures: number;
  /** Attempts left before lockout. Zero once blocked. */
  remaining: number;
  /** When the block lifts. Null when not blocked. */
  retryAfter: Date | null;
  /** Which window tripped — used for the audit detail, not shown to the user. */
  scope: "identifier" | "ip" | null;
}

/** Normalise so `Admin`, ` admin ` and `ADMIN` share one bucket. */
export function normaliseIdentifier(identifier: string): string {
  return identifier.trim().toLowerCase();
}

async function countFailures(
  db: Database,
  where: { identifier?: string; ipAddress?: string },
  since: Date,
): Promise<{ failures: number; latest: Date | null }> {
  const rows = await db.loginAttempt.findMany({
    where: { ...where, successful: false, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });

  return { failures: rows.length, latest: rows[0]?.createdAt ?? null };
}

/**
 * Decide whether a login attempt may proceed. Call before verifying the
 * password — the whole point is to not spend an Argon2 verification on a
 * request that is already over the limit.
 *
 * `now` is injected so tests can advance time without sleeping.
 */
export async function checkLoginAllowed(
  db: Database,
  input: { identifier: string; ipAddress?: string | null },
  config: RateLimitConfig,
  now: Date = new Date(),
): Promise<RateLimitVerdict> {
  const identifier = normaliseIdentifier(input.identifier);
  const since = new Date(now.getTime() - config.windowSeconds * 1000);

  const byIdentifier = await countFailures(db, { identifier }, since);

  if (byIdentifier.failures >= config.maxAttempts && byIdentifier.latest) {
    return {
      blocked: true,
      failures: byIdentifier.failures,
      remaining: 0,
      retryAfter: new Date(byIdentifier.latest.getTime() + config.lockoutSeconds * 1000),
      scope: "identifier",
    };
  }

  // The IP window is deliberately more permissive: a shared NAT egress on an
  // intranet can legitimately produce several users' typos at once. It exists
  // to catch spraying across many accounts, not to punish a busy office.
  if (input.ipAddress) {
    const ipAllowance = config.maxAttempts * 4;
    const byIp = await countFailures(db, { ipAddress: input.ipAddress }, since);

    if (byIp.failures >= ipAllowance && byIp.latest) {
      return {
        blocked: true,
        failures: byIp.failures,
        remaining: 0,
        retryAfter: new Date(byIp.latest.getTime() + config.lockoutSeconds * 1000),
        scope: "ip",
      };
    }
  }

  return {
    blocked: false,
    failures: byIdentifier.failures,
    remaining: Math.max(0, config.maxAttempts - byIdentifier.failures),
    retryAfter: null,
    scope: null,
  };
}

/**
 * Record the outcome of an attempt. Always call, success or failure.
 *
 * `now` is written explicitly rather than left to the column default. The
 * default would use the database's wall clock while `checkLoginAllowed` reads
 * the injected clock, so the two halves of the limiter would disagree the
 * moment a caller supplies a time — which is exactly what a test of lockout
 * expiry does.
 */
export async function recordLoginAttempt(
  db: Database,
  input: { identifier: string; ipAddress?: string | null; successful: boolean },
  now: Date = new Date(),
): Promise<void> {
  await db.loginAttempt.create({
    data: {
      identifier: normaliseIdentifier(input.identifier),
      ipAddress: input.ipAddress ?? null,
      successful: input.successful,
      createdAt: now,
    },
  });
}

/** Clear an identifier's failures after a correct password. */
export async function clearLoginFailures(db: Database, identifier: string): Promise<void> {
  await db.loginAttempt.deleteMany({
    where: { identifier: normaliseIdentifier(identifier), successful: false },
  });
}

/**
 * Drop attempt rows older than the window so the table does not grow without
 * bound. Called opportunistically from the login path rather than on a timer —
 * the app has no scheduler, and a table only written on login attempts does
 * not need one.
 */
export async function pruneLoginAttempts(
  db: Database,
  config: RateLimitConfig,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(
    now.getTime() - Math.max(config.windowSeconds, config.lockoutSeconds) * 1000 * 2,
  );

  const { count } = await db.loginAttempt.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return count;
}
