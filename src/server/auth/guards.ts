import type { Permission, Role } from "@/lib/roles";
import { roleAtLeast, roleHasPermission } from "@/lib/roles";

import { db } from "../db";
import { logger } from "../logger";
import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { currentAuth, type AuthContext } from "./context";
import { forbidden, passwordChangeRequired, unauthenticated } from "./errors";
import type { SessionUser } from "./sessions";

/**
 * Authorisation guards.
 *
 * These are the server-side enforcement points. Everything the browser does —
 * the root route guard, the filtered navigation, the disabled buttons — is
 * presentation. A caller who crafts their own request reaches these functions
 * and nothing else, so this is the layer that has to be right.
 *
 * Each guard returns the authenticated context so the caller does not have to
 * resolve it a second time:
 *
 *   const { user } = await requireRole("Manager");
 */

export interface AuthenticatedContext extends AuthContext {
  user: SessionUser;
  session: NonNullable<AuthContext["session"]>;
}

async function denied(
  context: AuthContext,
  required: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await recordAudit(db(), {
    action: AUDIT_ACTIONS.UNAUTHORIZED_ACCESS,
    userId: context.user?.id ?? null,
    actorLabel: context.user?.username ?? null,
    detail: { required, ...detail },
    ipAddress: context.origin.ipAddress,
    userAgent: context.origin.userAgent,
  });

  logger.warn("authorisation denied", {
    userId: context.user?.id,
    role: context.user?.role,
    required,
    ...detail,
  });
}

/**
 * Require a live session.
 *
 * Throws `UNAUTHENTICATED` (401), which the browser turns into a redirect to
 * the login page. Note this is *not* audited: an expired session is an
 * ordinary event, and logging every one would bury the denials that matter.
 */
export async function requireAuth(): Promise<AuthenticatedContext> {
  const context = await currentAuth();

  if (!context.user || !context.session) {
    throw unauthenticated("No live session for request");
  }

  return context as AuthenticatedContext;
}

/**
 * Require a live session whose account is not pending a forced password change.
 *
 * Applied to everything except the change-password endpoint itself — otherwise
 * a seeded account could keep using its known default password indefinitely by
 * simply never visiting the change screen.
 */
export async function requireActiveSession(): Promise<AuthenticatedContext> {
  const context = await requireAuth();

  if (context.user.mustChangePassword) {
    throw passwordChangeRequired();
  }

  return context;
}

/** Require at least `minimum` in the role hierarchy. */
export async function requireRole(minimum: Role): Promise<AuthenticatedContext> {
  const context = await requireActiveSession();

  if (!roleAtLeast(context.user.role, minimum)) {
    await denied(context, minimum, { held: context.user.role });
    throw forbidden(`Role ${context.user.role} is below required ${minimum}`);
  }

  return context;
}

/** Require a specific capability. Preferred over comparing role names. */
export async function requirePermission(permission: Permission): Promise<AuthenticatedContext> {
  const context = await requireActiveSession();

  if (!roleHasPermission(context.user.role, permission)) {
    await denied(context, permission, { held: context.user.role });
    throw forbidden(`Role ${context.user.role} lacks ${permission}`);
  }

  return context;
}

/** Shorthand for `requireRole("Admin")`. */
export async function requireAdmin(): Promise<AuthenticatedContext> {
  return requireRole("Admin");
}

/**
 * Allow the request when the caller is acting on their own record, or holds
 * the given permission. Used so a user can read their own profile without
 * being granted the administrative capability to read everyone's.
 */
export async function requireSelfOrPermission(
  targetUserId: string,
  permission: Permission,
): Promise<AuthenticatedContext> {
  const context = await requireActiveSession();

  if (context.user.id === targetUserId) return context;

  if (!roleHasPermission(context.user.role, permission)) {
    await denied(context, permission, { held: context.user.role, targetUserId });
    throw forbidden(`Role ${context.user.role} lacks ${permission} for ${targetUserId}`);
  }

  return context;
}
