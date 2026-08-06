import { z } from "zod";

/**
 * Role model.
 *
 * Roles are ordered — each one subsumes the capabilities of those below it —
 * because that is what makes `requireRole("Manager")` mean "Manager or better"
 * rather than "Manager exactly", which is almost never what a route wants.
 *
 * Fine-grained capability checks go through `PERMISSIONS` instead of comparing
 * role names at call sites. Adding a capability then means editing one table
 * here rather than hunting for every `role === "Admin"` in the codebase.
 *
 * SQLite cannot express this as a database enum (see prisma/schema.prisma), so
 * this module is the single source of truth and every write path validates
 * against it.
 */

export const ROLES = ["Guest", "Employee", "Manager", "Admin"] as const;

export type Role = (typeof ROLES)[number];

/** Higher outranks lower. Contiguous and ascending — do not leave gaps. */
const ROLE_RANK: Record<Role, number> = {
  Guest: 0,
  Employee: 1,
  Manager: 2,
  Admin: 3,
};

export const RoleSchema = z.enum(ROLES);

/** The role assigned when none is specified. Deliberately the least powerful. */
export const DEFAULT_ROLE: Role = "Guest";

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/**
 * Narrow a value read back from the database to a `Role`.
 *
 * Throws rather than defaulting. A row whose role is not recognised means the
 * database disagrees with the code — silently treating it as `Guest` would
 * mask a failed migration, and treating it as anything higher would be an
 * outright privilege escalation.
 */
export function parseRole(value: unknown): Role {
  if (!isRole(value)) {
    throw new Error(
      `Unrecognised role ${JSON.stringify(value)}. Valid roles: ${ROLES.join(", ")}.`,
    );
  }
  return value;
}

/** True when `role` is at least as privileged as `minimum`. */
export function roleAtLeast(role: Role, minimum: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

/** Roles ordered most privileged first — for admin dropdowns. */
export function rolesByPrivilege(): Role[] {
  return [...ROLES].sort((a, b) => ROLE_RANK[b] - ROLE_RANK[a]);
}

// ─── Capabilities ──────────────────────────────────────────────────────────

/**
 * Discrete capabilities. Named for what they permit, not for who holds them,
 * so a permission can be moved between roles without renaming it.
 */
export const PERMISSIONS = [
  /** Read the intelligence surfaces: dashboards, news, social, GIS. */
  "intel:read",
  /** Run collection and analysis that costs an upstream API call. */
  "intel:analyse",
  /** Create and edit investigations, watchlists and evidence. */
  "intel:write",
  /** Generate and export intelligence products. */
  "report:generate",
  /** Read and write the third-party credential vault. */
  "credentials:manage",
  /** Create, edit, disable and delete user accounts. */
  "users:manage",
  /** Read the security audit log. */
  "audit:read",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Capability grants per role. Each role lists only what it adds; the effective
 * set is the union of its own grants and every role beneath it, resolved by
 * `permissionsFor`.
 *
 * Guest is intentionally empty — an authenticated Guest can reach the shell
 * and their own profile and nothing else. Read access is a grant, not a
 * default, because this is a defence intelligence tool.
 */
const ROLE_GRANTS: Record<Role, readonly Permission[]> = {
  Guest: [],
  Employee: ["intel:read", "intel:analyse", "intel:write"],
  Manager: ["report:generate", "audit:read"],
  Admin: ["credentials:manage", "users:manage"],
};

const EFFECTIVE: Record<Role, ReadonlySet<Permission>> = (() => {
  const out = {} as Record<Role, ReadonlySet<Permission>>;
  const ascending = [...ROLES].sort((a, b) => ROLE_RANK[a] - ROLE_RANK[b]);

  const accumulated: Permission[] = [];
  for (const role of ascending) {
    accumulated.push(...ROLE_GRANTS[role]);
    out[role] = new Set(accumulated);
  }
  return out;
})();

/** Every capability a role holds, including those inherited from lower roles. */
export function permissionsFor(role: Role): Permission[] {
  return [...EFFECTIVE[role]];
}

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return EFFECTIVE[role].has(permission);
}
