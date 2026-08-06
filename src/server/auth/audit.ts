import type { Database } from "../db";
import { logger } from "../logger";

/**
 * Security audit trail.
 *
 * Distinct from `src/server/logger.ts`: that is operational telemetry which a
 * container log driver may rotate away, this is a durable record of who did
 * what, kept in the database and readable in the UI. Rows are append-only —
 * nothing in the codebase updates or deletes an AuditLog, and deleting a user
 * nulls the foreign key rather than cascading, so the history of a removed
 * account survives them.
 */

export const AUDIT_ACTIONS = {
  LOGIN_SUCCESS: "auth.login.success",
  LOGIN_FAILED: "auth.login.failed",
  LOGIN_BLOCKED: "auth.login.blocked",
  LOGOUT: "auth.logout",
  SESSION_EXPIRED: "auth.session.expired",
  SESSION_REVOKED: "auth.session.revoked",
  UNAUTHORIZED_ACCESS: "auth.access.denied",
  PASSWORD_CHANGED: "user.password.changed",
  PASSWORD_RESET: "user.password.reset",
  USER_CREATED: "user.created",
  USER_UPDATED: "user.updated",
  USER_DELETED: "user.deleted",
  USER_ENABLED: "user.enabled",
  USER_DISABLED: "user.disabled",
  ROLE_CHANGED: "user.role.changed",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/** Human-readable labels for the audit table in the admin UI. */
export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  [AUDIT_ACTIONS.LOGIN_SUCCESS]: "Signed in",
  [AUDIT_ACTIONS.LOGIN_FAILED]: "Failed sign-in",
  [AUDIT_ACTIONS.LOGIN_BLOCKED]: "Sign-in blocked (rate limit)",
  [AUDIT_ACTIONS.LOGOUT]: "Signed out",
  [AUDIT_ACTIONS.SESSION_EXPIRED]: "Session expired",
  [AUDIT_ACTIONS.SESSION_REVOKED]: "Session revoked",
  [AUDIT_ACTIONS.UNAUTHORIZED_ACCESS]: "Access denied",
  [AUDIT_ACTIONS.PASSWORD_CHANGED]: "Password changed",
  [AUDIT_ACTIONS.PASSWORD_RESET]: "Password reset by admin",
  [AUDIT_ACTIONS.USER_CREATED]: "User created",
  [AUDIT_ACTIONS.USER_UPDATED]: "User updated",
  [AUDIT_ACTIONS.USER_DELETED]: "User deleted",
  [AUDIT_ACTIONS.USER_ENABLED]: "User enabled",
  [AUDIT_ACTIONS.USER_DISABLED]: "User disabled",
  [AUDIT_ACTIONS.ROLE_CHANGED]: "Role changed",
};

export interface RequestOrigin {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface AuditEntry extends RequestOrigin {
  action: AuditAction;
  /** The account that performed the action, when there is one. */
  userId?: string | null;
  /** Username at the time, preserved so a deleted account is still readable. */
  actorLabel?: string | null;
  targetId?: string | null;
  targetLabel?: string | null;
  /** Non-sensitive structured context. Serialised to JSON. */
  detail?: Record<string, unknown> | null;
}

/**
 * Field names never written to the audit detail blob, regardless of what a
 * caller passes. Belt and braces alongside the logger's own redaction.
 */
const FORBIDDEN_DETAIL_KEYS = /password|secret|token|hash|credential/i;

function safeDetail(detail: Record<string, unknown> | null | undefined): string | null {
  if (!detail) return null;

  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    clean[key] = FORBIDDEN_DETAIL_KEYS.test(key) ? "[redacted]" : value;
  }

  try {
    return JSON.stringify(clean);
  } catch {
    return null;
  }
}

/**
 * Append an audit row.
 *
 * Never throws. An audit write failing means the database is unreachable, in
 * which case the operation being audited has already failed on its own — so
 * re-throwing here would only replace a useful error with a confusing one. The
 * failure is logged at error level so it is still visible.
 */
export async function recordAudit(db: Database, entry: AuditEntry): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        action: entry.action,
        userId: entry.userId ?? null,
        actorLabel: entry.actorLabel ?? null,
        targetId: entry.targetId ?? null,
        targetLabel: entry.targetLabel ?? null,
        detail: safeDetail(entry.detail),
        ipAddress: entry.ipAddress ?? null,
        userAgent: entry.userAgent ?? null,
      },
    });
  } catch (error) {
    logger.error("audit write failed", {
      action: entry.action,
      userId: entry.userId,
      error,
    });
  }
}

export interface AuditPage {
  entries: Array<{
    id: string;
    action: AuditAction;
    actionLabel: string;
    userId: string | null;
    actorLabel: string | null;
    targetId: string | null;
    targetLabel: string | null;
    detail: Record<string, unknown> | null;
    ipAddress: string | null;
    createdAt: string;
  }>;
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

/** Read the audit trail, most recent first. */
export async function listAudit(
  db: Database,
  input: { userId?: string; action?: string; page: number; pageSize: number },
): Promise<AuditPage> {
  const where = {
    ...(input.userId ? { userId: input.userId } : {}),
    ...(input.action ? { action: input.action } : {}),
  };

  const [total, rows] = await Promise.all([
    db.auditLog.count({ where }),
    db.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
    }),
  ]);

  return {
    entries: rows.map((row) => ({
      id: row.id,
      action: row.action as AuditAction,
      actionLabel: AUDIT_ACTION_LABELS[row.action as AuditAction] ?? row.action,
      userId: row.userId,
      actorLabel: row.actorLabel,
      targetId: row.targetId,
      targetLabel: row.targetLabel,
      detail: parseDetail(row.detail),
      ipAddress: row.ipAddress,
      createdAt: row.createdAt.toISOString(),
    })),
    total,
    page: input.page,
    pageSize: input.pageSize,
    pageCount: Math.max(1, Math.ceil(total / input.pageSize)),
  };
}

function parseDetail(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
