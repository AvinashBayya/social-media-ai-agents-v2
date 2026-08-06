import { PrismaLibSql } from "@prisma/adapter-libsql";

import { PrismaClient } from "@/generated/prisma/client";

import { authEnv } from "./env";
import { logger } from "./logger";

/**
 * Prisma client singleton.
 *
 * Prisma 7 has no Rust query engine — the client is TypeScript driving a
 * driver adapter, so the driver is the only native artefact at runtime.
 *
 * The driver is libSQL, not better-sqlite3, and the reason is concrete:
 * better-sqlite3 is a node-gyp addon that Bun cannot dlopen at all
 * (`ERR_DLOPEN_FAILED`, oven-sh/bun#4290). Since `bun run dev` executes Vite —
 * and therefore this code — inside Bun, better-sqlite3 breaks the dev server,
 * the seed script and `bun test` alike. libSQL ships as a napi module, which
 * Bun loads happily, and it was verified working under both Bun and Node
 * before being adopted here.
 *
 * libSQL reads and writes ordinary SQLite files, so the schema, the migrations
 * and any existing data file are unaffected by that choice. `better-sqlite3`
 * remains a devDependency purely because the Prisma CLI declares it as a peer
 * for `migrate`, which runs under Node.
 *
 * SQLite tolerates exactly one writer at a time, so this module owns the only
 * connection and everything goes through `db()`.
 */

let client: PrismaClient | null = null;

function create(): PrismaClient {
  const env = authEnv();

  const adapter = new PrismaLibSql({ url: env.DATABASE_URL });

  const prisma = new PrismaClient({ adapter });

  logger.info("database connected", {
    provider: "sqlite",
    // The URL can carry a path but never a password for SQLite; still, only
    // the filename is logged.
    database: env.DATABASE_URL.replace(/^file:/, "")
      .split(/[\\/]/)
      .pop(),
  });

  return prisma;
}

/** The process-wide Prisma client, connected on first use. */
export function db(): PrismaClient {
  if (!client) client = create();
  return client;
}

/**
 * The shape every service in this tree accepts, so callers can hand in a
 * throwaway `:memory:` client under test. Nothing below the server-function
 * layer reaches for `db()` itself — that call happens once, at the edge.
 */
export type Database = PrismaClient;

/** Close the connection. Used by tests and by the seed script. */
export async function disconnectDb(): Promise<void> {
  if (!client) return;
  await client.$disconnect();
  client = null;
}
