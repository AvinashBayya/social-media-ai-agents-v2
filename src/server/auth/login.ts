import type { LoginInput } from "@/lib/auth-schemas";

import type { Database } from "../db";
import { logger } from "../logger";
import { AUDIT_ACTIONS, recordAudit, type RequestOrigin } from "./audit";
import { accountDisabled, invalidCredentials, rateLimited } from "./errors";
import {
  hashPassword,
  needsRehash,
  spendDummyVerification,
  verifyPassword,
  type Argon2Params,
} from "./password";
import {
  checkLoginAllowed,
  clearLoginFailures,
  pruneLoginAttempts,
  recordLoginAttempt,
  type RateLimitConfig,
} from "./rate-limit";
import {
  createSession,
  pruneExpiredSessions,
  revokeAllSessionsForUser,
  revokeSession,
  type SessionUser,
} from "./sessions";
import { toPublicUser } from "./users";

/**
 * Login, logout and password change.
 *
 * This module owns the *order* of the checks, which is where most of the
 * security actually lives:
 *
 *  1. rate limit first, so a throttled request never costs an Argon2 verify;
 *  2. password before account status, so "this account is disabled" is only
 *     ever revealed to someone who already proved they know the password —
 *     otherwise the message is a free account-existence oracle;
 *  3. a fresh session token minted only after everything passes, and any
 *     pre-existing cookie destroyed, so a token planted before login can never
 *     become an authenticated one (session fixation).
 */

export interface LoginConfig {
  argon: Argon2Params;
  rateLimit: RateLimitConfig;
  sessionMaxAgeSeconds: number;
  /** Lifetime when "remember me" is ticked. */
  rememberMaxAgeSeconds: number;
}

export interface LoginResult {
  token: string;
  expiresAt: Date;
  user: SessionUser;
}

export async function authenticate(
  db: Database,
  input: LoginInput,
  config: LoginConfig,
  origin: RequestOrigin & { existingToken?: string | null },
  now: Date = new Date(),
): Promise<LoginResult> {
  const identifier = input.identifier.trim().toLowerCase();

  // 1. Throttle before doing any expensive work.
  const verdict = await checkLoginAllowed(
    db,
    { identifier, ipAddress: origin.ipAddress },
    config.rateLimit,
    now,
  );

  if (verdict.blocked) {
    await recordAudit(db, {
      action: AUDIT_ACTIONS.LOGIN_BLOCKED,
      actorLabel: identifier,
      detail: {
        scope: verdict.scope,
        failures: verdict.failures,
        retryAfter: verdict.retryAfter?.toISOString(),
      },
      ipAddress: origin.ipAddress,
      userAgent: origin.userAgent,
    });

    logger.warn("login blocked by rate limit", {
      identifier,
      scope: verdict.scope,
      failures: verdict.failures,
    });

    throw rateLimited(`Locked until ${verdict.retryAfter?.toISOString() ?? "unknown"}`);
  }

  const user = await db.user.findFirst({
    where: { OR: [{ username: identifier }, { email: identifier }] },
  });

  const fail = async (reason: string) => {
    await recordLoginAttempt(
      db,
      { identifier, ipAddress: origin.ipAddress, successful: false },
      now,
    );
    await recordAudit(db, {
      action: AUDIT_ACTIONS.LOGIN_FAILED,
      userId: user?.id ?? null,
      actorLabel: identifier,
      detail: { reason, attemptsRemaining: Math.max(0, verdict.remaining - 1) },
      ipAddress: origin.ipAddress,
      userAgent: origin.userAgent,
    });
    logger.warn("login failed", { identifier, reason });
  };

  // 2. No such account. Spend a comparable amount of CPU anyway so response
  //    time does not distinguish "no such user" from "wrong password".
  if (!user) {
    await spendDummyVerification(input.password, config.argon);
    await fail("unknown-identifier");
    throw invalidCredentials(`No account for ${identifier}`);
  }

  const passwordOk = await verifyPassword(input.password, user.passwordHash);

  if (!passwordOk) {
    await fail("bad-password");
    throw invalidCredentials(`Bad password for ${user.username}`);
  }

  // 3. Only now, with the password proven, is it safe to be specific.
  if (!user.isActive) {
    await fail("account-disabled");
    throw accountDisabled(`Account ${user.username} is disabled`);
  }

  // 4. Upgrade the stored hash if the cost parameters have been raised since
  //    it was written. This is the only moment the plaintext exists to do it.
  if (needsRehash(user.passwordHash, config.argon)) {
    const upgraded = await hashPassword(input.password, config.argon);
    await db.user
      .update({ where: { id: user.id }, data: { passwordHash: upgraded } })
      .catch((error: unknown) =>
        logger.error("password rehash failed", { userId: user.id, error }),
      );
    logger.info("password hash upgraded", { userId: user.id });
  }

  // 5. Destroy any session the browser already held. Prevents an attacker who
  //    planted a known token before login from riding it afterwards.
  if (origin.existingToken) {
    await revokeSession(db, origin.existingToken);
  }

  await clearLoginFailures(db, identifier);
  await recordLoginAttempt(db, { identifier, ipAddress: origin.ipAddress, successful: true }, now);

  const maxAgeSeconds = input.remember ? config.rememberMaxAgeSeconds : config.sessionMaxAgeSeconds;

  const { token, expiresAt } = await createSession(
    db,
    {
      userId: user.id,
      maxAgeSeconds,
      ipAddress: origin.ipAddress,
      userAgent: origin.userAgent,
    },
    now,
  );

  const updated = await db.user.update({
    where: { id: user.id },
    data: { lastLoginAt: now },
  });

  await recordAudit(db, {
    action: AUDIT_ACTIONS.LOGIN_SUCCESS,
    userId: user.id,
    actorLabel: user.username,
    detail: { remember: input.remember, expiresAt: expiresAt.toISOString() },
    ipAddress: origin.ipAddress,
    userAgent: origin.userAgent,
  });

  logger.info("login succeeded", { userId: user.id, role: user.role });

  // Opportunistic housekeeping. The app has no scheduler, and these tables are
  // only written on login, so the login path is the natural place to sweep.
  // Failures are irrelevant to the caller's outcome.
  void Promise.all([
    pruneExpiredSessions(db, now),
    pruneLoginAttempts(db, config.rateLimit, now),
  ]).catch((error: unknown) => logger.warn("auth housekeeping failed", { error }));

  const publicUser = toPublicUser(updated);

  return {
    token,
    expiresAt,
    user: {
      id: publicUser.id,
      username: publicUser.username,
      email: publicUser.email,
      role: publicUser.role,
      isActive: publicUser.isActive,
      mustChangePassword: publicUser.mustChangePassword,
      lastLoginAt: publicUser.lastLoginAt,
      createdAt: publicUser.createdAt,
    },
  };
}

/** End the caller's own session. Idempotent. */
export async function logout(
  db: Database,
  token: string | null | undefined,
  actor: { id: string; username: string } | null,
  origin: RequestOrigin,
): Promise<void> {
  if (token) await revokeSession(db, token);

  if (actor) {
    await recordAudit(db, {
      action: AUDIT_ACTIONS.LOGOUT,
      userId: actor.id,
      actorLabel: actor.username,
      ipAddress: origin.ipAddress,
      userAgent: origin.userAgent,
    });
    logger.info("logout", { userId: actor.id });
  }
}

/**
 * Change your own password.
 *
 * Requires the current password even though the caller is already
 * authenticated — otherwise an unattended logged-in workstation is a complete
 * account takeover.
 */
export async function changeOwnPassword(
  db: Database,
  input: {
    userId: string;
    currentPassword: string;
    newPassword: string;
    currentSessionId?: string;
  },
  argon: Argon2Params,
  origin: RequestOrigin,
): Promise<void> {
  const user = await db.user.findUnique({ where: { id: input.userId } });
  if (!user) throw invalidCredentials(`User ${input.userId} not found`);

  const ok = await verifyPassword(input.currentPassword, user.passwordHash);
  if (!ok) {
    await recordAudit(db, {
      action: AUDIT_ACTIONS.LOGIN_FAILED,
      userId: user.id,
      actorLabel: user.username,
      detail: { reason: "bad-current-password-on-change" },
      ipAddress: origin.ipAddress,
      userAgent: origin.userAgent,
    });
    throw invalidCredentials("Current password did not match");
  }

  await db.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(input.newPassword, argon),
      mustChangePassword: false,
    },
  });

  // Every other device holding a session authenticated with the old password
  // is signed out. The tab doing the change keeps its session.
  const revoked = await revokeAllSessionsForUser(db, user.id, input.currentSessionId);

  await recordAudit(db, {
    action: AUDIT_ACTIONS.PASSWORD_CHANGED,
    userId: user.id,
    actorLabel: user.username,
    detail: { otherSessionsRevoked: revoked },
    ipAddress: origin.ipAddress,
    userAgent: origin.userAgent,
  });

  logger.info("password changed", { userId: user.id, otherSessionsRevoked: revoked });
}
