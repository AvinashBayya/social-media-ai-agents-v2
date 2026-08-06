import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PrismaLibSql } from "@prisma/adapter-libsql";

import { PrismaClient } from "@/generated/prisma/client";

/**
 * A throwaway in-memory database for integration tests.
 *
 * Uses the same libSQL adapter the application does — see src/server/db.ts for
 * why it is libSQL rather than better-sqlite3 — so these tests exercise the
 * real driver rather than a stand-in, and they run under `bun test` alongside
 * the rest of the suite.
 *
 * The schema is applied by replaying the actual migration SQL rather than by
 * invoking `prisma migrate`. That means a migration which has drifted from
 * schema.prisma fails here, in a fast test, instead of on a deployment.
 */

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../prisma/migrations",
);

/** Every migration's statements, in the order Prisma would apply them. */
function migrationStatements(): string[] {
  const directories = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const statements: string[] = [];

  for (const directory of directories) {
    const sql = readFileSync(join(MIGRATIONS_DIR, directory, "migration.sql"), "utf-8");

    for (const raw of sql.split(";")) {
      // Drop the `-- CreateTable` comments Prisma emits, then discard whatever
      // is left if it is only whitespace.
      const statement = raw
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .trim();

      if (statement) statements.push(statement);
    }
  }

  return statements;
}

export interface TestDatabase {
  prisma: PrismaClient;
  close: () => Promise<void>;
}

/**
 * Build an isolated database. Every call gets its own `:memory:` instance, so
 * tests cannot observe one another's rows and may run in any order.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const adapter = new PrismaLibSql({ url: ":memory:" });
  const prisma = new PrismaClient({ adapter });

  for (const statement of migrationStatements()) {
    await prisma.$executeRawUnsafe(statement);
  }

  return {
    prisma,
    close: async () => {
      await prisma.$disconnect();
    },
  };
}

/**
 * Argon2 parameters for tests: the cheapest the validator permits.
 *
 * The shipped cost (19 MiB, 2 passes) is deliberately slow, and a suite that
 * hashes dozens of passwords at that cost takes minutes. `DEFAULT_ARGON2_PARAMS`
 * remains what the application actually uses.
 */
export const TEST_ARGON2_PARAMS = {
  memoryKib: 8192,
  iterations: 1,
  parallelism: 1,
} as const;

export const TEST_RATE_LIMIT = {
  maxAttempts: 5,
  windowSeconds: 900,
  lockoutSeconds: 900,
} as const;

export const TEST_LOGIN_CONFIG = {
  argon: TEST_ARGON2_PARAMS,
  rateLimit: TEST_RATE_LIMIT,
  sessionMaxAgeSeconds: 28800,
  rememberMaxAgeSeconds: 60 * 60 * 24 * 30,
} as const;
