import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { AUDIT_ACTIONS } from "@/server/auth/audit";
import { authenticate, changeOwnPassword, logout } from "@/server/auth/login";
import { hashPassword } from "@/server/auth/password";
import {
  createSession,
  hashSessionToken,
  resolveSession,
  revokeSession,
} from "@/server/auth/sessions";

import {
  createTestDatabase,
  TEST_ARGON2_PARAMS,
  TEST_LOGIN_CONFIG,
  type TestDatabase,
} from "./helpers/test-db";

/**
 * End-to-end coverage of the login path against a real database.
 *
 * These assert behaviour the specification calls for and that unit tests on
 * individual functions cannot show: that a wrong password and an unknown
 * username are indistinguishable to the caller, that a disabled account is
 * only revealed after the password has been proven, that the session token is
 * never stored, and that lockout actually engages.
 */

const ORIGIN = { ipAddress: "10.0.0.7", userAgent: "bun-test" };

let database: TestDatabase;

beforeEach(async () => {
  database = await createTestDatabase();
});

afterEach(async () => {
  await database.close();
});

async function seedUser(
  overrides: Partial<{
    username: string;
    email: string;
    password: string;
    role: string;
    isActive: boolean;
    mustChangePassword: boolean;
  }> = {},
) {
  const password = overrides.password ?? "Correct#Horse9";

  const user = await database.prisma.user.create({
    data: {
      username: overrides.username ?? "analyst",
      email: overrides.email ?? "analyst@sentinel.local",
      passwordHash: await hashPassword(password, TEST_ARGON2_PARAMS),
      role: overrides.role ?? "Employee",
      isActive: overrides.isActive ?? true,
      mustChangePassword: overrides.mustChangePassword ?? false,
    },
  });

  return { user, password };
}

describe("authenticate", () => {
  test("accepts correct credentials and opens a session", async () => {
    const { user, password } = await seedUser();

    const result = await authenticate(
      database.prisma,
      { identifier: "analyst", password, remember: false },
      TEST_LOGIN_CONFIG,
      ORIGIN,
    );

    expect(result.user.id).toBe(user.id);
    expect(result.user.role).toBe("Employee");
    expect(result.token).toBeTruthy();
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const sessions = await database.prisma.session.findMany();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.userId).toBe(user.id);
  });

  test("stores only the hash of the session token, never the token", async () => {
    const { password } = await seedUser();

    const result = await authenticate(
      database.prisma,
      { identifier: "analyst", password, remember: false },
      TEST_LOGIN_CONFIG,
      ORIGIN,
    );

    const sessions = await database.prisma.session.findMany();

    expect(sessions[0]!.id).toBe(await hashSessionToken(result.token));
    expect(sessions[0]!.id).not.toBe(result.token);

    // Belt and braces: the raw token must appear nowhere in the row.
    expect(JSON.stringify(sessions[0])).not.toContain(result.token);
  });

  test("logs in by email as well as username", async () => {
    const { password } = await seedUser();

    const result = await authenticate(
      database.prisma,
      { identifier: "ANALYST@Sentinel.local", password, remember: false },
      TEST_LOGIN_CONFIG,
      ORIGIN,
    );

    expect(result.user.username).toBe("analyst");
  });

  test("rejects a wrong password and an unknown user identically", async () => {
    const { password } = await seedUser();

    const wrongPassword = authenticate(
      database.prisma,
      { identifier: "analyst", password: `${password}x`, remember: false },
      TEST_LOGIN_CONFIG,
      ORIGIN,
    ).catch((error: { code?: string }) => error.code);

    const unknownUser = authenticate(
      database.prisma,
      { identifier: "nobody", password, remember: false },
      TEST_LOGIN_CONFIG,
      ORIGIN,
    ).catch((error: { code?: string }) => error.code);

    expect(await wrongPassword).toBe("INVALID_CREDENTIALS");
    // Identical code — the response must not disclose whether the account
    // exists.
    expect(await unknownUser).toBe("INVALID_CREDENTIALS");

    expect(await database.prisma.session.count()).toBe(0);
  });

  test("reveals a disabled account only once the password is proven", async () => {
    const { password } = await seedUser({ isActive: false });

    const withRightPassword = await authenticate(
      database.prisma,
      { identifier: "analyst", password, remember: false },
      TEST_LOGIN_CONFIG,
      ORIGIN,
    ).catch((error: { code?: string }) => error.code);

    const withWrongPassword = await authenticate(
      database.prisma,
      { identifier: "analyst", password: "Wrong#Password1", remember: false },
      TEST_LOGIN_CONFIG,
      ORIGIN,
    ).catch((error: { code?: string }) => error.code);

    expect(withRightPassword).toBe("ACCOUNT_DISABLED");
    // Without the password, "disabled" would be a free account-existence
    // oracle, so it must still read as bad credentials.
    expect(withWrongPassword).toBe("INVALID_CREDENTIALS");
  });

  test("locks the identifier out after the configured number of failures", async () => {
    const { password } = await seedUser();

    for (let attempt = 0; attempt < TEST_LOGIN_CONFIG.rateLimit.maxAttempts; attempt += 1) {
      await authenticate(
        database.prisma,
        { identifier: "analyst", password: "Wrong#Password1", remember: false },
        TEST_LOGIN_CONFIG,
        ORIGIN,
      ).catch(() => undefined);
    }

    // The correct password must now be refused too — otherwise the lockout is
    // only a nuisance to the attacker and no protection at all.
    const code = await authenticate(
      database.prisma,
      { identifier: "analyst", password, remember: false },
      TEST_LOGIN_CONFIG,
      ORIGIN,
    ).catch((error: { code?: string }) => error.code);

    expect(code).toBe("RATE_LIMITED");
  });

  test("clears the failure count after a successful login", async () => {
    const { password } = await seedUser();

    await authenticate(
      database.prisma,
      { identifier: "analyst", password: "Wrong#Password1", remember: false },
      TEST_LOGIN_CONFIG,
      ORIGIN,
    ).catch(() => undefined);

    await authenticate(
      database.prisma,
      { identifier: "analyst", password, remember: false },
      TEST_LOGIN_CONFIG,
      ORIGIN,
    );

    const failures = await database.prisma.loginAttempt.count({
      where: { identifier: "analyst", successful: false },
    });

    expect(failures).toBe(0);
  });

  test("destroys a pre-existing session so a planted token cannot be ridden", async () => {
    const { user, password } = await seedUser();

    const planted = await createSession(database.prisma, {
      userId: user.id,
      maxAgeSeconds: 3600,
    });

    await authenticate(
      database.prisma,
      { identifier: "analyst", password, remember: false },
      TEST_LOGIN_CONFIG,
      { ...ORIGIN, existingToken: planted.token },
    );

    const stillValid = await resolveSession(database.prisma, planted.token, {
      rolling: false,
      maxAgeSeconds: 3600,
    });

    expect(stillValid.resolved).toBeNull();
  });

  test("writes an audit row for success and for failure", async () => {
    const { password } = await seedUser();

    await authenticate(
      database.prisma,
      { identifier: "analyst", password: "Wrong#Password1", remember: false },
      TEST_LOGIN_CONFIG,
      ORIGIN,
    ).catch(() => undefined);

    await authenticate(
      database.prisma,
      { identifier: "analyst", password, remember: false },
      TEST_LOGIN_CONFIG,
      ORIGIN,
    );

    const actions = (await database.prisma.auditLog.findMany()).map((row) => row.action);

    expect(actions).toContain(AUDIT_ACTIONS.LOGIN_FAILED);
    expect(actions).toContain(AUDIT_ACTIONS.LOGIN_SUCCESS);
  });

  test("never records the password in the audit trail", async () => {
    const { password } = await seedUser({ password: "Unmistakable#Value42" });

    await authenticate(
      database.prisma,
      { identifier: "analyst", password, remember: false },
      TEST_LOGIN_CONFIG,
      ORIGIN,
    );

    const rows = JSON.stringify(await database.prisma.auditLog.findMany());
    expect(rows).not.toContain("Unmistakable#Value42");
  });
});

describe("sessions", () => {
  test("resolves a live session and rejects a revoked one", async () => {
    const { user } = await seedUser();

    const { token } = await createSession(database.prisma, {
      userId: user.id,
      maxAgeSeconds: 3600,
    });

    const live = await resolveSession(database.prisma, token, {
      rolling: false,
      maxAgeSeconds: 3600,
    });
    expect(live.resolved?.user.id).toBe(user.id);

    await revokeSession(database.prisma, token);

    const dead = await resolveSession(database.prisma, token, {
      rolling: false,
      maxAgeSeconds: 3600,
    });
    expect(dead.resolved).toBeNull();
    expect(dead.reason).toBe("unknown");
  });

  test("rejects an expired session and deletes the row", async () => {
    const { user } = await seedUser();

    const { token } = await createSession(
      database.prisma,
      { userId: user.id, maxAgeSeconds: 60 },
      new Date(Date.now() - 3600_000),
    );

    const outcome = await resolveSession(database.prisma, token, {
      rolling: false,
      maxAgeSeconds: 3600,
    });

    expect(outcome.resolved).toBeNull();
    expect(outcome.reason).toBe("expired");
    expect(await database.prisma.session.count()).toBe(0);
  });

  test("refuses a session whose account was disabled after sign-in", async () => {
    const { user } = await seedUser();

    const { token } = await createSession(database.prisma, {
      userId: user.id,
      maxAgeSeconds: 3600,
    });

    await database.prisma.user.update({ where: { id: user.id }, data: { isActive: false } });

    const outcome = await resolveSession(database.prisma, token, {
      rolling: false,
      maxAgeSeconds: 3600,
    });

    expect(outcome.resolved).toBeNull();
    expect(outcome.reason).toBe("disabled");
    // Every session for that account is dropped, not just the one presented.
    expect(await database.prisma.session.count()).toBe(0);
  });

  test("logout ends the session and is safe to repeat", async () => {
    const { user, password } = await seedUser();

    const result = await authenticate(
      database.prisma,
      { identifier: "analyst", password, remember: false },
      TEST_LOGIN_CONFIG,
      ORIGIN,
    );

    const actor = { id: user.id, username: user.username };

    await logout(database.prisma, result.token, actor, ORIGIN);
    expect(await database.prisma.session.count()).toBe(0);

    // Logging out twice must not throw.
    await logout(database.prisma, result.token, actor, ORIGIN);

    const actions = (await database.prisma.auditLog.findMany()).map((row) => row.action);
    expect(actions).toContain(AUDIT_ACTIONS.LOGOUT);
  });
});

describe("changeOwnPassword", () => {
  test("replaces the password, clears the flag and revokes other devices", async () => {
    const { user, password } = await seedUser({ mustChangePassword: true });

    const keep = await createSession(database.prisma, { userId: user.id, maxAgeSeconds: 3600 });
    const otherDevice = await createSession(database.prisma, {
      userId: user.id,
      maxAgeSeconds: 3600,
    });

    await changeOwnPassword(
      database.prisma,
      {
        userId: user.id,
        currentPassword: password,
        newPassword: "Replacement#Pass7",
        currentSessionId: await hashSessionToken(keep.token),
      },
      TEST_ARGON2_PARAMS,
      ORIGIN,
    );

    const updated = await database.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(updated.mustChangePassword).toBe(false);

    // The tab performing the change stays signed in; everything else does not.
    const kept = await resolveSession(database.prisma, keep.token, {
      rolling: false,
      maxAgeSeconds: 3600,
    });
    const revoked = await resolveSession(database.prisma, otherDevice.token, {
      rolling: false,
      maxAgeSeconds: 3600,
    });

    expect(kept.resolved).not.toBeNull();
    expect(revoked.resolved).toBeNull();

    // The new password works and the old one does not.
    const withNew = await authenticate(
      database.prisma,
      { identifier: "analyst", password: "Replacement#Pass7", remember: false },
      TEST_LOGIN_CONFIG,
      ORIGIN,
    );
    expect(withNew.user.id).toBe(user.id);

    const withOld = await authenticate(
      database.prisma,
      { identifier: "analyst", password, remember: false },
      TEST_LOGIN_CONFIG,
      ORIGIN,
    ).catch((error: { code?: string }) => error.code);
    expect(withOld).toBe("INVALID_CREDENTIALS");
  });

  test("refuses when the current password is wrong", async () => {
    const { user } = await seedUser();

    const code = await changeOwnPassword(
      database.prisma,
      {
        userId: user.id,
        currentPassword: "Not#TheOne1",
        newPassword: "Replacement#Pass7",
      },
      TEST_ARGON2_PARAMS,
      ORIGIN,
    ).catch((error: { code?: string }) => error.code);

    expect(code).toBe("INVALID_CREDENTIALS");
  });
});
