import { describe, expect, test } from "bun:test";

import {
  DEFAULT_ROLE,
  PERMISSIONS,
  ROLES,
  isRole,
  parseRole,
  permissionsFor,
  roleAtLeast,
  roleHasPermission,
  rolesByPrivilege,
  type Role,
} from "../src/lib/roles";

describe("role hierarchy", () => {
  test("is ordered least to most privileged", () => {
    expect(ROLES).toEqual(["Guest", "Employee", "Manager", "Admin"]);
  });

  test("every role outranks itself", () => {
    for (const role of ROLES) expect(roleAtLeast(role, role)).toBe(true);
  });

  test("Admin satisfies every requirement", () => {
    for (const role of ROLES) expect(roleAtLeast("Admin", role)).toBe(true);
  });

  test("Guest satisfies nothing above itself", () => {
    expect(roleAtLeast("Guest", "Guest")).toBe(true);
    expect(roleAtLeast("Guest", "Employee")).toBe(false);
    expect(roleAtLeast("Guest", "Manager")).toBe(false);
    expect(roleAtLeast("Guest", "Admin")).toBe(false);
  });

  test("Employee cannot reach Manager or Admin", () => {
    expect(roleAtLeast("Employee", "Employee")).toBe(true);
    expect(roleAtLeast("Employee", "Manager")).toBe(false);
    expect(roleAtLeast("Employee", "Admin")).toBe(false);
  });

  test("Manager outranks Employee but not Admin", () => {
    expect(roleAtLeast("Manager", "Employee")).toBe(true);
    expect(roleAtLeast("Manager", "Admin")).toBe(false);
  });

  test("rolesByPrivilege lists most privileged first", () => {
    expect(rolesByPrivilege()).toEqual(["Admin", "Manager", "Employee", "Guest"]);
  });

  test("the default role is the least privileged", () => {
    // A new account must never default to anything that grants access.
    expect(DEFAULT_ROLE).toBe("Guest");
    expect(permissionsFor(DEFAULT_ROLE)).toEqual([]);
  });
});

describe("parseRole", () => {
  test("accepts every declared role", () => {
    for (const role of ROLES) expect(parseRole(role)).toBe(role);
  });

  test("throws rather than defaulting on an unknown value", () => {
    // Failing closed matters: silently mapping an unrecognised value to Guest
    // would hide a broken migration, and mapping it upward would be privilege
    // escalation straight out of the database.
    expect(() => parseRole("Superuser")).toThrow(/Unrecognised role/);
    expect(() => parseRole("admin")).toThrow(/Unrecognised role/);
    expect(() => parseRole("")).toThrow();
    expect(() => parseRole(null)).toThrow();
    expect(() => parseRole(undefined)).toThrow();
    expect(() => parseRole(3)).toThrow();
  });

  test("is case-sensitive", () => {
    expect(() => parseRole("ADMIN")).toThrow();
    expect(() => parseRole("Admin ")).toThrow();
  });
});

describe("isRole", () => {
  test("narrows only exact matches", () => {
    expect(isRole("Admin")).toBe(true);
    expect(isRole("admin")).toBe(false);
    expect(isRole(null)).toBe(false);
    expect(isRole(42)).toBe(false);
  });
});

describe("permissions", () => {
  test("Guest holds none", () => {
    expect(permissionsFor("Guest")).toEqual([]);
    for (const permission of PERMISSIONS) {
      expect(roleHasPermission("Guest", permission)).toBe(false);
    }
  });

  test("Admin holds all of them", () => {
    const admin = permissionsFor("Admin");
    for (const permission of PERMISSIONS) {
      expect(admin).toContain(permission);
      expect(roleHasPermission("Admin", permission)).toBe(true);
    }
  });

  test("higher roles inherit everything beneath them", () => {
    // The whole point of an ordered hierarchy: a Manager must never be missing
    // something an Employee has.
    const ascending: Role[] = ["Guest", "Employee", "Manager", "Admin"];

    for (let i = 1; i < ascending.length; i += 1) {
      const lower = permissionsFor(ascending[i - 1]!);
      const higher = permissionsFor(ascending[i]!);
      for (const permission of lower) expect(higher).toContain(permission);
    }
  });

  test("only Admin may manage users or credentials", () => {
    for (const role of ROLES) {
      const expected = role === "Admin";
      expect(roleHasPermission(role, "users:manage")).toBe(expected);
      expect(roleHasPermission(role, "credentials:manage")).toBe(expected);
    }
  });

  test("Employee can analyse but cannot read the audit log", () => {
    expect(roleHasPermission("Employee", "intel:analyse")).toBe(true);
    expect(roleHasPermission("Employee", "intel:write")).toBe(true);
    expect(roleHasPermission("Employee", "audit:read")).toBe(false);
    expect(roleHasPermission("Employee", "report:generate")).toBe(false);
  });

  test("Manager gains reporting and audit access", () => {
    expect(roleHasPermission("Manager", "report:generate")).toBe(true);
    expect(roleHasPermission("Manager", "audit:read")).toBe(true);
  });

  test("permissionsFor returns a copy, not the internal set", () => {
    // A caller mutating the returned array must not be able to grant itself
    // a capability for every other caller in the process.
    const first = permissionsFor("Admin");
    first.push("intel:read");
    expect(permissionsFor("Admin")).not.toBe(first);
    expect(permissionsFor("Admin").filter((p) => p === "intel:read")).toHaveLength(1);
  });
});
