import { describe, expect, test } from "bun:test";

import {
  ChangePasswordSchema,
  CreateUserSchema,
  EmailSchema,
  ListUsersSchema,
  LoginSchema,
  PASSWORD_MAX,
  PasswordSchema,
  UsernameSchema,
  fieldErrorsFrom,
} from "../src/lib/auth-schemas";

/** A password that satisfies every complexity rule, sharing no identity text. */
const STRONG = "Kestrel!42Vane";

describe("UsernameSchema", () => {
  test("lowercases and trims, so casing cannot create a duplicate account", () => {
    // SQLite unique indexes are case-sensitive; normalising here is what stops
    // "Admin" and "admin" becoming two rows, one of which is unreachable.
    expect(UsernameSchema.parse("  Analyst_01  ")).toBe("analyst_01");
  });

  test("accepts letters, digits, dot, underscore and hyphen after a leading letter", () => {
    for (const value of ["ab3", "a.b_c-d", "analyst.one"]) {
      expect(() => UsernameSchema.parse(value)).not.toThrow();
    }
  });

  test("rejects names that do not start with a letter", () => {
    for (const value of ["1abc", "_abc", ".abc", "-abc"]) {
      expect(() => UsernameSchema.parse(value)).toThrow();
    }
  });

  test("rejects out-of-range lengths and illegal characters", () => {
    expect(() => UsernameSchema.parse("ab")).toThrow();
    expect(() => UsernameSchema.parse("a".repeat(33))).toThrow();
    expect(() => UsernameSchema.parse("a b")).toThrow();
    expect(() => UsernameSchema.parse("a@b")).toThrow();
    expect(() => UsernameSchema.parse("análisis")).toThrow();
  });
});

describe("EmailSchema", () => {
  test("lowercases and trims", () => {
    expect(EmailSchema.parse("  Analyst@Sentinel.LOCAL ")).toBe("analyst@sentinel.local");
  });

  test("rejects malformed addresses", () => {
    for (const value of ["", "no-at-sign", "a@", "@b.com", "a b@c.com"]) {
      expect(() => EmailSchema.parse(value)).toThrow();
    }
  });
});

describe("PasswordSchema", () => {
  test("accepts a password meeting every rule", () => {
    expect(() => PasswordSchema.parse(STRONG)).not.toThrow();
  });

  test("requires each character class", () => {
    expect(() => PasswordSchema.parse("kestrel!42vane")).toThrow(/uppercase/i);
    expect(() => PasswordSchema.parse("KESTREL!42VANE")).toThrow(/lowercase/i);
    expect(() => PasswordSchema.parse("Kestrel!Vane")).toThrow(/digit/i);
    expect(() => PasswordSchema.parse("Kestrel42Vane")).toThrow(/symbol/i);
  });

  test("enforces the minimum length", () => {
    expect(() => PasswordSchema.parse("Ab1!def")).toThrow(/at least/i);
  });

  test("caps the maximum length", () => {
    // Argon2 has no bcrypt-style input limit, so without a cap a multi-megabyte
    // password is a cheap way to pin a CPU core on every login attempt.
    const huge = "Ab1!" + "x".repeat(PASSWORD_MAX);
    expect(() => PasswordSchema.parse(huge)).toThrow(/at most/i);
  });
});

describe("CreateUserSchema", () => {
  const base = { username: "analyst", email: "analyst@sentinel.local", role: "Employee" as const };

  test("accepts a well-formed account", () => {
    const parsed = CreateUserSchema.parse({ ...base, password: STRONG });
    expect(parsed.username).toBe("analyst");
    expect(parsed.role).toBe("Employee");
    // New accounts must choose their own password rather than keep an
    // administrator-chosen one.
    expect(parsed.mustChangePassword).toBe(true);
    expect(parsed.isActive).toBe(true);
  });

  test("rejects a password containing the username", () => {
    expect(() => CreateUserSchema.parse({ ...base, password: "Analyst@2026" })).toThrow(
      /must not contain/i,
    );
  });

  test("rejects a password containing the email local part", () => {
    expect(() =>
      CreateUserSchema.parse({
        username: "jdoe",
        email: "kestrel@sentinel.local",
        role: "Employee",
        password: "Kestrel@2026",
      }),
    ).toThrow(/must not contain/i);
  });

  test("rejects obvious passwords even when they satisfy the rules", () => {
    expect(() => CreateUserSchema.parse({ ...base, password: "Password@123" })).toThrow(
      /easily guessed/i,
    );
  });

  test("rejects an unknown role", () => {
    expect(() =>
      CreateUserSchema.parse({ ...base, role: "Superuser", password: STRONG }),
    ).toThrow();
  });
});

describe("LoginSchema", () => {
  test("does not impose the username format on the identifier", () => {
    // Rejecting a malformed identifier early would tell an attacker which
    // format the namespace uses. Anything unknown simply fails as bad
    // credentials instead.
    expect(() => LoginSchema.parse({ identifier: "!!!", password: "x" })).not.toThrow();
    expect(() =>
      LoginSchema.parse({ identifier: "someone@example.com", password: "x" }),
    ).not.toThrow();
  });

  test("requires both fields", () => {
    expect(() => LoginSchema.parse({ identifier: "", password: "x" })).toThrow();
    expect(() => LoginSchema.parse({ identifier: "admin", password: "" })).toThrow();
  });

  test("defaults remember to false", () => {
    expect(LoginSchema.parse({ identifier: "admin", password: "x" }).remember).toBe(false);
  });

  test("caps the password length so login cannot be used as a CPU sink", () => {
    expect(() =>
      LoginSchema.parse({ identifier: "admin", password: "x".repeat(PASSWORD_MAX + 1) }),
    ).toThrow();
  });
});

describe("ChangePasswordSchema", () => {
  test("accepts a valid change", () => {
    expect(() =>
      ChangePasswordSchema.parse({ currentPassword: "Old!Pass99", password: STRONG }),
    ).not.toThrow();
  });

  test("rejects reusing the current password", () => {
    expect(() => ChangePasswordSchema.parse({ currentPassword: STRONG, password: STRONG })).toThrow(
      /different/i,
    );
  });

  test("applies the full policy to the new password", () => {
    expect(() =>
      ChangePasswordSchema.parse({ currentPassword: "Old!Pass99", password: "weak" }),
    ).toThrow();
  });
});

describe("ListUsersSchema", () => {
  test("supplies sane defaults", () => {
    const parsed = ListUsersSchema.parse({});
    expect(parsed).toMatchObject({
      page: 1,
      pageSize: 20,
      sort: "createdAt",
      direction: "desc",
    });
  });

  test("coerces numeric strings from a query string", () => {
    const parsed = ListUsersSchema.parse({ page: "3", pageSize: "50" });
    expect(parsed.page).toBe(3);
    expect(parsed.pageSize).toBe(50);
  });

  test("bounds pageSize so a caller cannot request the whole table", () => {
    expect(() => ListUsersSchema.parse({ pageSize: 1000 })).toThrow();
    expect(() => ListUsersSchema.parse({ page: 0 })).toThrow();
  });

  test("rejects an unlisted sort column", () => {
    // Guards the ORDER BY built from this value.
    expect(() => ListUsersSchema.parse({ sort: "passwordHash" })).toThrow();
  });
});

describe("fieldErrorsFrom", () => {
  test("keeps the first message per field", () => {
    const result = CreateUserSchema.safeParse({
      username: "1bad",
      email: "nope",
      password: "weak",
      role: "Employee",
    });

    expect(result.success).toBe(false);
    if (result.success) return;

    const errors = fieldErrorsFrom(result.error);
    expect(Object.keys(errors)).toContain("username");
    expect(Object.keys(errors)).toContain("email");
    expect(Object.keys(errors)).toContain("password");
    // One message per field — four simultaneous complexity failures is noise.
    expect(typeof errors.password).toBe("string");
  });
});
