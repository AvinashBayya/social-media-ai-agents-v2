import { loadEnvFile } from "node:process";

import { defineConfig, env } from "@prisma/config";

// Prisma 7 no longer reads .env implicitly, and the CLI runs as its own Node
// process outside Vite — so without this, `migrate` and `generate` cannot see
// DATABASE_URL. `loadEnvFile` is built into Node (>=20.12) and does not
// overwrite variables already set, so a real environment still wins.
try {
  loadEnvFile();
} catch {
  // No .env on disk: expected in CI and in the container, where the variables
  // are injected directly. If DATABASE_URL is genuinely absent, env() below
  // raises a clearer error than anything we could throw here.
}

/**
 * Prisma 7 configuration.
 *
 * Prisma 7 dropped the Rust query engine — the client is compiled TypeScript
 * driving a driver adapter (`@prisma/adapter-better-sqlite3`), so nothing but
 * the better-sqlite3 native binding is needed at runtime. The schema engine
 * referenced by `migrate` is a CLI-only binary and is never shipped.
 *
 * The datasource URL lives here rather than in schema.prisma so the schema
 * stays environment-agnostic; `migrate` and `studio` read it from the same
 * DATABASE_URL the application uses.
 */
export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: env("DATABASE_URL"),
  },
  migrations: {
    path: "prisma/migrations",
    seed: "bun run prisma/seed.ts",
  },
});
