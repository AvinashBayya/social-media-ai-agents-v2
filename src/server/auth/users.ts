import type {
  AssignRoleInput,
  CreateUserInput,
  ListUsersInput,
  ResetPasswordInput,
  SetUserActiveInput,
  UpdateUserInput,
} from "@/lib/auth-schemas";
import type { Role } from "@/lib/roles";
import { parseRole } from "@/lib/roles";

import type { Database } from "../db";
import { AUDIT_ACTIONS, recordAudit, type RequestOrigin } from "./audit";
import { conflict, forbidden, notFound } from "./errors";
import { hashPassword, type Argon2Params } from "./password";
import { revokeAllSessionsForUser } from "./sessions";

/**
 * User management.
 *
 * Every function takes the database as its first argument rather than reaching
 * for the singleton. That is what lets the test suite run the real logic
 * against an in-memory SQLite database, and it keeps these functions callable
 * from the seed script, which runs outside the server runtime entirely.
 *
 * The invariant that matters most here is the last-administrator rule: the
 * system must never reach a state with no way to administer it. Deleting,
 * disabling or demoting the final active Admin is refused, not warned about.
 */

/** Shape returned to the client. Never includes `passwordHash`. */
export interface PublicUser {
  id: string;
  username: string;
  email: string;
  role: Role;
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface UserRow {
  id: string;
  username: string;
  email: string;
  role: string;
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Project a database row to the client shape.
 *
 * `passwordHash` is absent from the return type *and* never read here, so it
 * cannot leak by being spread accidentally — the mapping is explicit for
 * exactly that reason.
 */
export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    role: parseRole(row.role),
    isActive: row.isActive,
    mustChangePassword: row.mustChangePassword,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Actor performing an administrative action, for auditing and self-checks. */
export interface Actor extends RequestOrigin {
  id: string;
  username: string;
  role: Role;
}

// ─── Lookups ───────────────────────────────────────────────────────────────

/**
 * Find by username or email in one query.
 *
 * Both columns are stored lowercased, so the caller's input is lowered to
 * match. SQLite's default collation is case-sensitive; normalising on write
 * and on read is what makes "Admin" and "admin" the same account instead of
 * two accounts one of which can never be logged into.
 */
export async function findUserByIdentifier(db: Database, identifier: string) {
  const needle = identifier.trim().toLowerCase();
  if (!needle) return null;

  return db.user.findFirst({
    where: { OR: [{ username: needle }, { email: needle }] },
  });
}

export async function findUserById(db: Database, id: string) {
  return db.user.findUnique({ where: { id } });
}

export async function countActiveAdmins(db: Database, excludeUserId?: string): Promise<number> {
  return db.user.count({
    where: {
      role: "Admin",
      isActive: true,
      ...(excludeUserId ? { id: { not: excludeUserId } } : {}),
    },
  });
}

/**
 * Refuse an operation that would remove the last way into the system.
 *
 * Called before delete, disable and demote. Checked against the database
 * rather than a cached count, because two admins demoting each other
 * concurrently would otherwise both see "one other admin exists" and both
 * succeed.
 */
async function assertNotLastAdmin(db: Database, userId: string, operation: string): Promise<void> {
  const target = await db.user.findUnique({ where: { id: userId } });
  if (!target) throw notFound(`User ${userId} not found`);

  if (target.role !== "Admin" || !target.isActive) return;

  const remaining = await countActiveAdmins(db, userId);
  if (remaining === 0) {
    throw forbidden(
      `Refusing to ${operation} the last active administrator (${target.username}). ` +
        `Promote another account to Admin first.`,
    );
  }
}

async function assertIdentityAvailable(
  db: Database,
  input: { username?: string; email?: string },
  excludeUserId?: string,
): Promise<void> {
  const clauses = [
    ...(input.username ? [{ username: input.username }] : []),
    ...(input.email ? [{ email: input.email }] : []),
  ];
  if (clauses.length === 0) return;

  const existing = await db.user.findFirst({
    where: {
      OR: clauses,
      ...(excludeUserId ? { id: { not: excludeUserId } } : {}),
    },
  });

  if (!existing) return;

  const fieldErrors: Record<string, string> = {};
  if (input.username && existing.username === input.username) {
    fieldErrors.username = "That username is already taken.";
  }
  if (input.email && existing.email === input.email) {
    fieldErrors.email = "That email address is already registered.";
  }

  throw conflict(`Identity collision on user ${existing.id}`, fieldErrors);
}

// ─── Mutations ─────────────────────────────────────────────────────────────

export async function createUser(
  db: Database,
  input: CreateUserInput,
  argon: Argon2Params,
  actor: Actor,
): Promise<PublicUser> {
  await assertIdentityAvailable(db, { username: input.username, email: input.email });

  const created = await db.user.create({
    data: {
      username: input.username,
      email: input.email,
      passwordHash: await hashPassword(input.password, argon),
      role: input.role,
      isActive: input.isActive,
      mustChangePassword: input.mustChangePassword,
    },
  });

  await recordAudit(db, {
    action: AUDIT_ACTIONS.USER_CREATED,
    userId: actor.id,
    actorLabel: actor.username,
    targetId: created.id,
    targetLabel: created.username,
    detail: { role: created.role, isActive: created.isActive },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return toPublicUser(created);
}

export async function updateUser(
  db: Database,
  input: UpdateUserInput,
  actor: Actor,
): Promise<PublicUser> {
  const existing = await findUserById(db, input.id);
  if (!existing) throw notFound(`User ${input.id} not found`);

  await assertIdentityAvailable(db, { username: input.username, email: input.email }, input.id);

  // A role change or a deactivation arriving through the generic update path
  // must respect the same last-admin rule as the dedicated endpoints.
  const losesAdmin =
    (input.role !== undefined && input.role !== "Admin") || input.isActive === false;
  if (losesAdmin) {
    await assertNotLastAdmin(db, input.id, "demote or disable");
  }

  const updated = await db.user.update({
    where: { id: input.id },
    data: {
      ...(input.username !== undefined ? { username: input.username } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    },
  });

  const changed: Record<string, unknown> = {};
  if (input.username !== undefined && input.username !== existing.username) {
    changed.username = { from: existing.username, to: input.username };
  }
  if (input.email !== undefined && input.email !== existing.email) {
    changed.email = { from: existing.email, to: input.email };
  }
  if (input.role !== undefined && input.role !== existing.role) {
    changed.role = { from: existing.role, to: input.role };
  }
  if (input.isActive !== undefined && input.isActive !== existing.isActive) {
    changed.isActive = { from: existing.isActive, to: input.isActive };
  }

  await recordAudit(db, {
    action: AUDIT_ACTIONS.USER_UPDATED,
    userId: actor.id,
    actorLabel: actor.username,
    targetId: updated.id,
    targetLabel: updated.username,
    detail: changed,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  // A role change alters what existing sessions are allowed to do. Rather than
  // let a demoted user keep elevated access until their cookie expires, end
  // their sessions and make them sign in again under the new role.
  if (input.role !== undefined && input.role !== existing.role) {
    await revokeAllSessionsForUser(db, updated.id);
    await recordAudit(db, {
      action: AUDIT_ACTIONS.ROLE_CHANGED,
      userId: actor.id,
      actorLabel: actor.username,
      targetId: updated.id,
      targetLabel: updated.username,
      detail: { from: existing.role, to: updated.role },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
    });
  }

  if (input.isActive === false) {
    await revokeAllSessionsForUser(db, updated.id);
  }

  return toPublicUser(updated);
}

export async function assignRole(
  db: Database,
  input: AssignRoleInput,
  actor: Actor,
): Promise<PublicUser> {
  return updateUser(db, { id: input.id, role: input.role }, actor);
}

export async function setUserActive(
  db: Database,
  input: SetUserActiveInput,
  actor: Actor,
): Promise<PublicUser> {
  const existing = await findUserById(db, input.id);
  if (!existing) throw notFound(`User ${input.id} not found`);

  if (!input.isActive) {
    if (existing.id === actor.id) {
      throw forbidden("You cannot disable your own account.");
    }
    await assertNotLastAdmin(db, input.id, "disable");
  }

  const updated = await db.user.update({
    where: { id: input.id },
    data: { isActive: input.isActive },
  });

  // Disabling must take effect immediately, not when the cookie expires.
  const revoked = input.isActive ? 0 : await revokeAllSessionsForUser(db, updated.id);

  await recordAudit(db, {
    action: input.isActive ? AUDIT_ACTIONS.USER_ENABLED : AUDIT_ACTIONS.USER_DISABLED,
    userId: actor.id,
    actorLabel: actor.username,
    targetId: updated.id,
    targetLabel: updated.username,
    detail: { sessionsRevoked: revoked },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return toPublicUser(updated);
}

export async function deleteUser(db: Database, id: string, actor: Actor): Promise<void> {
  const existing = await findUserById(db, id);
  if (!existing) throw notFound(`User ${id} not found`);

  if (existing.id === actor.id) {
    throw forbidden("You cannot delete your own account.");
  }
  await assertNotLastAdmin(db, id, "delete");

  // Sessions cascade on delete; the audit rows do not — their userId is set to
  // null so what this account did stays on the record.
  await db.user.delete({ where: { id } });

  await recordAudit(db, {
    action: AUDIT_ACTIONS.USER_DELETED,
    userId: actor.id,
    actorLabel: actor.username,
    targetId: existing.id,
    targetLabel: existing.username,
    detail: { role: existing.role, email: existing.email },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });
}

export async function resetPassword(
  db: Database,
  input: ResetPasswordInput,
  argon: Argon2Params,
  actor: Actor,
): Promise<PublicUser> {
  const existing = await findUserById(db, input.id);
  if (!existing) throw notFound(`User ${input.id} not found`);

  const updated = await db.user.update({
    where: { id: input.id },
    data: {
      passwordHash: await hashPassword(input.password, argon),
      mustChangePassword: input.mustChangePassword,
    },
  });

  // Whoever held the old password must not keep an open session.
  const revoked = await revokeAllSessionsForUser(db, updated.id);

  await recordAudit(db, {
    action: AUDIT_ACTIONS.PASSWORD_RESET,
    userId: actor.id,
    actorLabel: actor.username,
    targetId: updated.id,
    targetLabel: updated.username,
    detail: { sessionsRevoked: revoked, mustChangePassword: updated.mustChangePassword },
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
  });

  return toPublicUser(updated);
}

// ─── Listing ───────────────────────────────────────────────────────────────

export interface UserPage {
  users: PublicUser[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export async function listUsers(db: Database, input: ListUsersInput): Promise<UserPage> {
  const search = input.search?.trim().toLowerCase();

  const where = {
    ...(input.role ? { role: input.role } : {}),
    ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    ...(search
      ? {
          // `contains` is a LIKE against columns already stored lowercased, so
          // this is case-insensitive without needing mode: "insensitive",
          // which the SQLite connector does not support.
          OR: [{ username: { contains: search } }, { email: { contains: search } }],
        }
      : {}),
  };

  const [total, rows] = await Promise.all([
    db.user.count({ where }),
    db.user.findMany({
      where,
      orderBy: { [input.sort]: input.direction },
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
    }),
  ]);

  return {
    users: rows.map(toPublicUser),
    total,
    page: input.page,
    pageSize: input.pageSize,
    pageCount: Math.max(1, Math.ceil(total / input.pageSize)),
  };
}
