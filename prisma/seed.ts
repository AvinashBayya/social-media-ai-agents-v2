import { PrismaLibSql } from "@prisma/adapter-libsql";
import { z } from "zod";

import { PrismaClient } from "../src/generated/prisma/client";
import {
  EmailSchema,
  PasswordSchema,
  UsernameSchema,
  fieldErrorsFrom,
} from "../src/lib/auth-schemas";
import { hashPassword, DEFAULT_ARGON2_PARAMS } from "../src/server/auth/password";

/**
 * Seed the initial administrator.
 *
 * Runs as its own process (`bun run db:seed`), outside the TanStack Start
 * runtime — which is exactly why the auth logic lives in plain functions
 * taking a database argument rather than inside server-function handlers.
 * Nothing here could call a server function.
 *
 * Idempotent: re-running never overwrites an existing account's password, so
 * it is safe to run against a database that is already in use.
 */

/**
 * Bun loads `.env` automatically; Node does not and does not expose
 * `loadEnvFile` on every runtime. Only reach for it when the variables are
 * genuinely missing, so this script runs under either.
 */
if (!process.env.DATABASE_URL) {
  try {
    const nodeProcess = (await import("node:process")) as {
      loadEnvFile?: (path?: string) => void;
    };
    nodeProcess.loadEnvFile?.();
  } catch {
    // Variables may be injected by the environment instead of a .env file.
  }
}

const DEFAULT_PASSWORD = "Admin@123";

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    console.error(`[seed] ${name} is not set and has no default.`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const databaseUrl = required("DATABASE_URL");
  const username = required("SEED_ADMIN_USERNAME", "admin");
  const email = required("SEED_ADMIN_EMAIL", "admin@sentinel.local");
  const password = required("SEED_ADMIN_PASSWORD", DEFAULT_PASSWORD);

  // The default password is public knowledge — it is in the README and in this
  // file. Allowing it in production would be shipping a known credential.
  if (process.env.NODE_ENV === "production" && password === DEFAULT_PASSWORD) {
    console.error(
      "[seed] Refusing to seed the default password with NODE_ENV=production.\n" +
        "       Set SEED_ADMIN_PASSWORD to something else first.",
    );
    process.exit(1);
  }

  // Base complexity is enforced, but deliberately NOT the rule that forbids a
  // password containing its own username. The documented bootstrap credential
  // is admin / Admin@123, which trips exactly that rule — and it is acceptable
  // here only because the account is created with mustChangePassword, so the
  // credential cannot survive first sign-in. Every password a user chooses
  // afterwards goes through the full policy including that rule.
  const candidate = z
    .object({
      username: UsernameSchema,
      email: EmailSchema,
      password: PasswordSchema,
    })
    .safeParse({ username, email, password });

  if (!candidate.success) {
    console.error("[seed] Seed account does not satisfy the account policy:");
    for (const [field, message] of Object.entries(fieldErrorsFrom(candidate.error))) {
      console.error(`  - ${field}: ${message}`);
    }
    process.exit(1);
  }

  if (candidate.data.password.toLowerCase().includes(candidate.data.username)) {
    console.warn(
      `[seed] WARNING: the seed password contains the username. This is tolerated only ` +
        `because the account is created with a forced password change.`,
    );
  }

  const adapter = new PrismaLibSql({ url: databaseUrl });
  const prisma = new PrismaClient({ adapter });

  try {
    const existing = await prisma.user.findFirst({
      where: { OR: [{ username: candidate.data.username }, { email: candidate.data.email }] },
    });

    if (existing) {
      console.log(
        `[seed] User "${existing.username}" already exists (role ${existing.role}). ` +
          `Left untouched — the seed never resets an existing password.`,
      );
      return;
    }

    const created = await prisma.user.create({
      data: {
        username: candidate.data.username,
        email: candidate.data.email,
        passwordHash: await hashPassword(candidate.data.password, DEFAULT_ARGON2_PARAMS),
        role: "Admin",
        isActive: true,
        // Forces the change-password screen on first sign-in, so the default
        // credential cannot survive it.
        mustChangePassword: true,
      },
    });

    console.log(`[seed] Created administrator "${created.username}" <${created.email}>.`);
    if (password === DEFAULT_PASSWORD) {
      console.log(`[seed] Password is the default "${DEFAULT_PASSWORD}".`);
      console.log("[seed] You will be required to change it at first sign-in.");
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error("[seed] Failed:", error);
  process.exit(1);
});
