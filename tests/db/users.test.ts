import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { AUDIT_ACTIONS } from "@/server/auth/audit";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import { createSession, resolveSession } from "@/server/auth/sessions";
import {
  assignRole,
  countActiveAdmins,
  createUser,
  deleteUser,
  listUsers,
  resetPassword,
  setUserActive,
  toPublicUser,
  updateUser,
  type Actor,
} from "@/server/auth/users";

import { createTestDatabase, TEST_ARGON2_PARAMS, type TestDatabase } from "./helpers/test-db";

/**
 * User management.
 *
 * The invariant these tests exist to protect is the last-administrator rule:
 * the system must never be left with no way to administer it. Everything else
 * here is ordinary CRUD.
 */

const STRONG = "Kestrel!42Vane";

let db: TestDatabase;
let admin: Actor;

async function seedAdmin() {
  const row = await db.prisma.user.create({
    data: {
      username: "root",
      email: "root@sentinel.local",
      passwordHash: await hashPassword(STRONG, TEST_ARGON2_PARAMS),
      role: "Admin",
      isActive: true,
    },
  });
  return { id: row.id, username: row.username, role: "Admin" as const };
}

const newUser = (over: Record<string, unknown> = {}) => ({
  username: "analyst",
  email: "analyst@sentinel.local",
  password: STRONG,
  role: "Employee" as const,
  isActive: true,
  mustChangePassword: true,
  ...over,
});

beforeEach(async () => {
  db = await createTestDatabase();
  admin = await seedAdmin();
});

afterEach(async () => {
  await db.close();
});

describe("createUser", () => {
  test("creates an account and hashes the password", async () => {
    const created = await createUser(db.prisma, newUser(), TEST_ARGON2_PARAMS, admin);

    expect(created.username).toBe("analyst");
    expect(created.role).toBe("Employee");
    expect(created.mustChangePassword).toBe(true);

    const row = await db.prisma.user.findUnique({ where: { id: created.id } });
    expect(row?.passwordHash).toStartWith("$argon2id$");
    expect(row?.passwordHash).not.toContain(STRONG);
    expect(await verifyPassword(STRONG, row!.passwordHash)).toBe(true);
  });

  test("never returns the password hash", async () => {
    const created = await createUser(db.prisma, newUser(), TEST_ARGON2_PARAMS, admin);
    expect(JSON.stringify(created)).not.toContain("argon2");
    expect("passwordHash" in created).toBe(false);
  });

  test("rejects a duplicate username with a field error", async () => {
    await createUser(db.prisma, newUser(), TEST_ARGON2_PARAMS, admin);

    await expect(
      createUser(db.prisma, newUser({ email: "other@sentinel.local" }), TEST_ARGON2_PARAMS, admin),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      fieldErrors: { username: expect.stringContaining("taken") },
    });
  });

  test("rejects a duplicate email", async () => {
    await createUser(db.prisma, newUser(), TEST_ARGON2_PARAMS, admin);

    await expect(
      createUser(db.prisma, newUser({ username: "other" }), TEST_ARGON2_PARAMS, admin),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  test("audits the creation", async () => {
    await createUser(db.prisma, newUser(), TEST_ARGON2_PARAMS, admin);
    const audit = await db.prisma.auditLog.findFirst({
      where: { action: AUDIT_ACTIONS.USER_CREATED },
    });

    expect(audit?.userId).toBe(admin.id);
    expect(audit?.targetLabel).toBe("analyst");
  });
});

describe("last-administrator protection", () => {
  test("refuses to delete the only active admin", async () => {
    const other = await createUser(db.prisma, newUser(), TEST_ARGON2_PARAMS, admin);
    const otherActor = { id: other.id, username: other.username, role: "Employee" as const };

    await expect(deleteUser(db.prisma, admin.id, otherActor)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await countActiveAdmins(db.prisma)).toBe(1);
  });

  test("refuses to disable the only active admin", async () => {
    const other = await createUser(db.prisma, newUser(), TEST_ARGON2_PARAMS, admin);
    const otherActor = { id: other.id, username: other.username, role: "Employee" as const };

    await expect(
      setUserActive(db.prisma, { id: admin.id, isActive: false }, otherActor),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  test("refuses to demote the only active admin", async () => {
    await expect(
      assignRole(db.prisma, { id: admin.id, role: "Employee" }, admin),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  test("allows the operation once a second admin exists", async () => {
    const second = await createUser(
      db.prisma,
      newUser({ username: "second", email: "second@sentinel.local", role: "Admin" }),
      TEST_ARGON2_PARAMS,
      admin,
    );

    const demoted = await assignRole(
      db.prisma,
      { id: admin.id, role: "Employee" },
      {
        id: second.id,
        username: second.username,
        role: "Admin",
      },
    );

    expect(demoted.role).toBe("Employee");
    expect(await countActiveAdmins(db.prisma)).toBe(1);
  });

  test("a disabled admin does not count towards the quorum", async () => {
    await createUser(
      db.prisma,
      newUser({
        username: "second",
        email: "second@sentinel.local",
        role: "Admin",
        isActive: false,
      }),
      TEST_ARGON2_PARAMS,
      admin,
    );

    // The second admin exists but cannot sign in, so removing the first would
    // still lock everyone out.
    expect(await countActiveAdmins(db.prisma)).toBe(1);
    await expect(
      assignRole(db.prisma, { id: admin.id, role: "Employee" }, admin),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("self-protection", () => {
  test("refuses to delete your own account", async () => {
    await createUser(
      db.prisma,
      newUser({ username: "second", email: "second@sentinel.local", role: "Admin" }),
      TEST_ARGON2_PARAMS,
      admin,
    );

    await expect(deleteUser(db.prisma, admin.id, admin)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  test("refuses to disable your own account", async () => {
    await createUser(
      db.prisma,
      newUser({ username: "second", email: "second@sentinel.local", role: "Admin" }),
      TEST_ARGON2_PARAMS,
      admin,
    );

    await expect(
      setUserActive(db.prisma, { id: admin.id, isActive: false }, admin),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("session consequences", () => {
  test("disabling an account ends its sessions immediately", async () => {
    const created = await createUser(db.prisma, newUser(), TEST_ARGON2_PARAMS, admin);
    const { token } = await createSession(db.prisma, { userId: created.id, maxAgeSeconds: 3600 });

    await setUserActive(db.prisma, { id: created.id, isActive: false }, admin);

    const { resolved } = await resolveSession(db.prisma, token, {
      rolling: false,
      maxAgeSeconds: 3600,
    });
    expect(resolved).toBeNull();
  });

  test("changing a role ends the affected sessions", async () => {
    const created = await createUser(db.prisma, newUser(), TEST_ARGON2_PARAMS, admin);
    const { token } = await createSession(db.prisma, { userId: created.id, maxAgeSeconds: 3600 });

    // Otherwise a demoted user keeps elevated access until their cookie expires.
    await assignRole(db.prisma, { id: created.id, role: "Guest" }, admin);

    const { resolved } = await resolveSession(db.prisma, token, {
      rolling: false,
      maxAgeSeconds: 3600,
    });
    expect(resolved).toBeNull();
  });

  test("resetting a password ends the sessions of whoever held the old one", async () => {
    const created = await createUser(db.prisma, newUser(), TEST_ARGON2_PARAMS, admin);
    const { token } = await createSession(db.prisma, { userId: created.id, maxAgeSeconds: 3600 });

    const after = await resetPassword(
      db.prisma,
      { id: created.id, password: "Petrel!77Gale", mustChangePassword: true },
      TEST_ARGON2_PARAMS,
      admin,
    );

    expect(after.mustChangePassword).toBe(true);
    const { resolved } = await resolveSession(db.prisma, token, {
      rolling: false,
      maxAgeSeconds: 3600,
    });
    expect(resolved).toBeNull();
  });
});

describe("audit durability", () => {
  test("deleting a user preserves what they did", async () => {
    const created = await createUser(db.prisma, newUser(), TEST_ARGON2_PARAMS, admin);
    await deleteUser(db.prisma, created.id, admin);

    const rows = await db.prisma.auditLog.findMany({ where: { targetId: created.id } });
    expect(rows.length).toBeGreaterThanOrEqual(2);

    // The account is gone but the record of its creation and removal is not.
    const deletion = rows.find((r) => r.action === AUDIT_ACTIONS.USER_DELETED);
    expect(deletion?.targetLabel).toBe("analyst");
  });
});

describe("updateUser", () => {
  test("applies changes and records what changed", async () => {
    const created = await createUser(db.prisma, newUser(), TEST_ARGON2_PARAMS, admin);

    const updated = await updateUser(
      db.prisma,
      { id: created.id, email: "renamed@sentinel.local" },
      admin,
    );

    expect(updated.email).toBe("renamed@sentinel.local");
    const audit = await db.prisma.auditLog.findFirst({
      where: { action: AUDIT_ACTIONS.USER_UPDATED },
      orderBy: { createdAt: "desc" },
    });
    expect(audit?.detail).toContain("renamed@sentinel.local");
  });

  test("rejects an update onto another account's username", async () => {
    await createUser(db.prisma, newUser(), TEST_ARGON2_PARAMS, admin);
    const second = await createUser(
      db.prisma,
      newUser({ username: "second", email: "second@sentinel.local" }),
      TEST_ARGON2_PARAMS,
      admin,
    );

    await expect(
      updateUser(db.prisma, { id: second.id, username: "analyst" }, admin),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  test("throws NOT_FOUND for a missing account", async () => {
    await expect(
      updateUser(db.prisma, { id: "does-not-exist", role: "Guest" }, admin),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("listUsers", () => {
  beforeEach(async () => {
    for (const name of ["alpha", "beta", "gamma", "delta"]) {
      await createUser(
        db.prisma,
        newUser({ username: name, email: `${name}@sentinel.local` }),
        TEST_ARGON2_PARAMS,
        admin,
      );
    }
  });

  test("paginates", async () => {
    const page = await listUsers(db.prisma, {
      page: 1,
      pageSize: 2,
      sort: "username",
      direction: "asc",
    });

    expect(page.users).toHaveLength(2);
    expect(page.total).toBe(5); // 4 created + the seeded admin
    expect(page.pageCount).toBe(3);
    expect(page.users[0]?.username).toBe("alpha");
  });

  test("searches username and email case-insensitively", async () => {
    const page = await listUsers(db.prisma, {
      search: "GAMMA",
      page: 1,
      pageSize: 20,
      sort: "createdAt",
      direction: "desc",
    });

    expect(page.users).toHaveLength(1);
    expect(page.users[0]?.username).toBe("gamma");
  });

  test("filters by role and status", async () => {
    const admins = await listUsers(db.prisma, {
      role: "Admin",
      page: 1,
      pageSize: 20,
      sort: "createdAt",
      direction: "desc",
    });
    expect(admins.total).toBe(1);

    await setUserActive(
      db.prisma,
      {
        id: (await db.prisma.user.findFirst({ where: { username: "beta" } }))!.id,
        isActive: false,
      },
      admin,
    );

    const disabled = await listUsers(db.prisma, {
      isActive: false,
      page: 1,
      pageSize: 20,
      sort: "createdAt",
      direction: "desc",
    });
    expect(disabled.total).toBe(1);
    expect(disabled.users[0]?.username).toBe("beta");
  });

  test("never leaks a password hash in a listing", async () => {
    const page = await listUsers(db.prisma, {
      page: 1,
      pageSize: 20,
      sort: "createdAt",
      direction: "desc",
    });
    expect(JSON.stringify(page)).not.toContain("argon2");
  });
});

describe("toPublicUser", () => {
  test("omits the hash even when handed a full row", async () => {
    const row = await db.prisma.user.findFirst();
    const projected = toPublicUser(row!) as Record<string, unknown>;

    expect(projected.passwordHash).toBeUndefined();
    expect(Object.keys(projected)).not.toContain("passwordHash");
  });
});
