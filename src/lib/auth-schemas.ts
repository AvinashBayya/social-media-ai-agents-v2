import { z } from "zod";

import { ROLES } from "@/lib/roles";

/**
 * Validation schemas for every auth input.
 *
 * Isomorphic on purpose: the login and admin forms validate with exactly the
 * schema the server enforces, so the browser cannot show a green field the
 * server will reject. The client copy is a convenience only — every server
 * function re-parses, because client-side validation is a UX feature and never
 * a security control.
 *
 * Follows the existing zod convention in src/utils/ — `PascalCaseSchema` const
 * with an inferred type exported directly beneath it.
 */

// ─── Primitives ────────────────────────────────────────────────────────────

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 32;
export const PASSWORD_MIN = 8;
/**
 * Argon2id has no input-length limit of its own, unlike bcrypt's 72 bytes. The
 * cap exists to bound work per request — without it a multi-megabyte password
 * is a cheap way to pin a CPU core.
 */
export const PASSWORD_MAX = 256;

export const UsernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(USERNAME_MIN, `Username must be at least ${USERNAME_MIN} characters.`)
  .max(USERNAME_MAX, `Username must be at most ${USERNAME_MAX} characters.`)
  .regex(
    /^[a-z][a-z0-9._-]*$/,
    "Username must start with a letter and use only letters, numbers, dot, underscore or hyphen.",
  );

export const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, "Email address is too long.")
  .email("Enter a valid email address.");

export const RoleSchema = z.enum(ROLES);

/**
 * Password policy. Deliberately complexity-based rather than length-only,
 * because the seeded `Admin@123` account has to satisfy it — and that account
 * is created with `mustChangePassword`, so the weak default cannot survive
 * first login.
 */
export const PasswordSchema = z
  .string()
  .min(PASSWORD_MIN, `Password must be at least ${PASSWORD_MIN} characters.`)
  .max(PASSWORD_MAX, `Password must be at most ${PASSWORD_MAX} characters.`)
  .regex(/[a-z]/, "Password must include a lowercase letter.")
  .regex(/[A-Z]/, "Password must include an uppercase letter.")
  .regex(/[0-9]/, "Password must include a digit.")
  .regex(/[^A-Za-z0-9]/, "Password must include a symbol.");

/**
 * Passwords that pass the complexity rules but are still among the first
 * things any credential-stuffing list tries. Short list on purpose — this is a
 * guard rail, not a substitute for a breach-corpus check, which needs a data
 * source we do not have offline.
 */
const OBVIOUS_PASSWORDS = new Set([
  "password@1",
  "password@123",
  "passw0rd!",
  "qwerty@123",
  "welcome@123",
  "admin@1234",
  "sentinel@1",
  "sentinel@123",
  "changeme@1",
  "letmein@123",
]);

/**
 * Password rules that need to see other fields — rejects a password that
 * contains the username or the local part of the email, which is the most
 * common way a "complex" password ends up trivially guessable.
 */
export function refinePasswordAgainstIdentity<T extends { password: string }>(
  schema: z.ZodType<T>,
  identityOf: (value: T) => string[],
): z.ZodEffects<z.ZodType<T>, T, T> {
  return schema.superRefine((value, ctx) => {
    const password = value.password.toLowerCase();

    if (OBVIOUS_PASSWORDS.has(password)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["password"],
        message: "That password is too easily guessed. Choose another.",
      });
      return;
    }

    for (const identity of identityOf(value)) {
      const needle = identity.trim().toLowerCase();
      if (needle.length >= 3 && password.includes(needle)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["password"],
          message: "Password must not contain your username or email.",
        });
        return;
      }
    }
  });
}

// ─── Authentication ────────────────────────────────────────────────────────

/**
 * Login accepts either a username or an email in one field, so the form does
 * not have to ask which. Not validated against the username/email formats:
 * rejecting a malformed identifier early would confirm which format is in use
 * and leaks a little of the account namespace. Anything not found simply fails
 * as bad credentials.
 */
export const LoginSchema = z.object({
  identifier: z
    .string()
    .trim()
    .min(1, "Enter your username or email.")
    .max(254, "That value is too long."),
  password: z.string().min(1, "Enter your password.").max(PASSWORD_MAX),
  /** Extends the session to the "remember me" lifetime when true. */
  remember: z.boolean().optional().default(false),
});
export type LoginInput = z.infer<typeof LoginSchema>;

export const ChangePasswordSchema = refinePasswordAgainstIdentity(
  z.object({
    currentPassword: z.string().min(1, "Enter your current password."),
    password: PasswordSchema,
  }),
  () => [],
).refine((value) => value.currentPassword !== value.password, {
  path: ["password"],
  message: "New password must be different from the current one.",
});
export type ChangePasswordInput = z.infer<typeof ChangePasswordSchema>;

// ─── Admin user management ─────────────────────────────────────────────────

export const CreateUserSchema = refinePasswordAgainstIdentity(
  z.object({
    username: UsernameSchema,
    email: EmailSchema,
    password: PasswordSchema,
    role: RoleSchema,
    isActive: z.boolean().optional().default(true),
    /** Force the new account to choose its own password at first login. */
    mustChangePassword: z.boolean().optional().default(true),
  }),
  (value) => [value.username, value.email.split("@")[0] ?? ""],
);
export type CreateUserInput = z.infer<typeof CreateUserSchema>;

export const UpdateUserSchema = z.object({
  id: z.string().min(1),
  username: UsernameSchema.optional(),
  email: EmailSchema.optional(),
  role: RoleSchema.optional(),
  isActive: z.boolean().optional(),
});
export type UpdateUserInput = z.infer<typeof UpdateUserSchema>;

export const ResetPasswordSchema = z.object({
  id: z.string().min(1),
  password: PasswordSchema,
  /** Default true: an admin-chosen password should not remain in use. */
  mustChangePassword: z.boolean().optional().default(true),
});
export type ResetPasswordInput = z.infer<typeof ResetPasswordSchema>;

export const UserIdSchema = z.object({ id: z.string().min(1) });
export type UserIdInput = z.infer<typeof UserIdSchema>;

export const SetUserActiveSchema = z.object({
  id: z.string().min(1),
  isActive: z.boolean(),
});
export type SetUserActiveInput = z.infer<typeof SetUserActiveSchema>;

export const AssignRoleSchema = z.object({
  id: z.string().min(1),
  role: RoleSchema,
});
export type AssignRoleInput = z.infer<typeof AssignRoleSchema>;

/** Listing, search and pagination for the admin user table. */
export const ListUsersSchema = z.object({
  search: z.string().trim().max(120).optional(),
  role: RoleSchema.optional(),
  isActive: z.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(["createdAt", "username", "email", "role", "lastLoginAt"]).default("createdAt"),
  direction: z.enum(["asc", "desc"]).default("desc"),
});
export type ListUsersInput = z.infer<typeof ListUsersSchema>;

/** Audit log query for the admin view. */
export const ListAuditSchema = z.object({
  userId: z.string().optional(),
  action: z.string().max(64).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListAuditInput = z.infer<typeof ListAuditSchema>;

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Flatten zod issues into `{ field: message }` for form rendering. Only the
 * first message per field is kept — showing four complexity failures at once
 * is noise.
 */
export function fieldErrorsFrom(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_";
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}
