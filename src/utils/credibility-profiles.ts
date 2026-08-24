/**
 * Module 1 — weight profile persistence, server side.
 *
 * `loadCustomProfiles` and `saveCustomProfiles` in `credibility.ts` write to
 * `localStorage`, which means profiles are per-browser and lost when the
 * browser profile is cleared. This module replaces that with a server-function
 * pair that persists to `data/credibility-profiles.json`, following the same
 * pattern as `credential-vault.ts`.
 *
 * MIGRATION. On the first call to `serverLoadProfiles()` the client passes any
 * profiles it already has in localStorage; the server writes them and returns
 * the canonical set. Subsequent mounts send nothing and receive the file
 * contents. Sources.tsx clears the localStorage key after a successful
 * migration so it is a genuine one-shot.
 *
 * STORAGE HONESTY. `data/` is excluded from the Docker build context and is
 * not a mounted volume. Profiles stored here die when the Container Apps
 * replica restarts, exactly as vault credentials do. For a production deploy
 * with durable profiles, mount a persistent volume at `data/` or move storage
 * to a database. This is noted here and in the UI, not hidden.
 *
 * ADDITIVE-ONLY RULE. Do not remove or rename any exported symbol. The export
 * registry in PROJECT_MEMORY.md tracks this module.
 */

import { createServerFn } from "@tanstack/react-start";
import type { WeightProfile } from "./credibility";

// ─── File path ─────────────────────────────────────────────────────────────

/**
 * Plain relative string literals, not `path.join(process.cwd(), ...)` —
 * matching `credential-vault.ts`'s own `VAULT_PATH` exactly. `node:path`
 * gets the same "externalized for browser compatibility" throw `node:fs/
 * promises` did (see the dynamic-import notes below): sources.tsx, a client
 * route, imports this module for its `createServerFn` exports, so anything
 * evaluated at this file's top level ships into the browser bundle. A plain
 * string needs no import, static or dynamic, so there's nothing to leak.
 */
const DATA_DIR = "./data";
const PROFILES_FILE = "./data/credibility-profiles.json";

// ─── Errors ────────────────────────────────────────────────────────────────

export class ProfileStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileStoreError";
  }
}

// ─── Pure I/O ──────────────────────────────────────────────────────────────

/**
 * Read `data/credibility-profiles.json` and return the array.
 * Returns `[]` when the file does not exist yet — no error, just an empty set.
 */
export async function readProfilesFile(): Promise<WeightProfile[]> {
  try {
    // Dynamic import, not a static top-level one — see this file's header
    // change note: sources.tsx (a client route) imports this module for the
    // createServerFn exports below, and a static `node:fs/promises` import
    // would ship into the browser bundle the same way `bun:sqlite` did in
    // job-store-sqlite.ts, crashing on mere import evaluation. Matches
    // credential-vault.ts's existing, already-working `await import("fs")`
    // pattern for the same reason.
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(PROFILES_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Never expose builtin profiles that snuck in through an old write path.
    return parsed.filter((p): p is WeightProfile => p && typeof p === "object" && !p.builtin);
  } catch (err: unknown) {
    // ENOENT on first run is expected; any other error should surface.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new ProfileStoreError(
      `Could not read profiles file: ${(err as Error).message ?? String(err)}`,
    );
  }
}

/**
 * Overwrite `data/credibility-profiles.json` with the supplied profiles.
 * Creates `data/` if it does not exist. Only non-builtin profiles are written.
 */
export async function writeProfilesFile(profiles: WeightProfile[]): Promise<void> {
  try {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(DATA_DIR, { recursive: true });
    const custom = profiles.filter((p) => !p.builtin);
    await writeFile(PROFILES_FILE, JSON.stringify(custom, null, 2), "utf-8");
  } catch (err: unknown) {
    throw new ProfileStoreError(
      `Could not write profiles file: ${(err as Error).message ?? String(err)}`,
    );
  }
}

// ─── Server functions ──────────────────────────────────────────────────────

/**
 * Load the stored custom weight profiles.
 *
 * `migrateFromLocalStorage` is the array an operator had in their browser's
 * localStorage before this server-side store existed. When non-empty, the
 * server writes them once and returns the merged set, so the next call with no
 * migration payload picks up the persisted data. Callers clear localStorage
 * after a successful migration.
 */
export const serverLoadProfiles = createServerFn({ method: "POST" })
  .validator(
    (d: { migrateFromLocalStorage?: WeightProfile[] } | undefined) => d ?? {},
  )
  .handler(async ({ data }) => {
    const existing = await readProfilesFile();

    const incoming = Array.isArray(data?.migrateFromLocalStorage)
      ? data.migrateFromLocalStorage.filter((p) => p && !p.builtin)
      : [];

    if (incoming.length > 0) {
      // Merge: server wins on id conflict (server has the last-written state),
      // incoming fills in ids the server does not know.
      const existingIds = new Set(existing.map((p) => p.id));
      const novel = incoming.filter((p) => !existingIds.has(p.id));
      const merged = [...existing, ...novel];
      await writeProfilesFile(merged);
      return { profiles: merged };
    }

    return { profiles: existing };
  });

/**
 * Persist the full set of custom profiles.
 * Builtin profiles are filtered out before writing — they are always
 * re-derived from `builtinProfiles()` and must not be stored on disk.
 */
export const serverSaveProfiles = createServerFn({ method: "POST" })
  .validator((d: { profiles: WeightProfile[] }) => d)
  .handler(async ({ data }) => {
    await writeProfilesFile(data.profiles);
    return { ok: true };
  });

/**
 * Delete a single custom profile by id.
 * Returns the updated list of profiles.
 */
export const serverDeleteProfile = createServerFn({ method: "POST" })
  .validator((d: { id: string }) => d)
  .handler(async ({ data }) => {
    const existing = await readProfilesFile();
    const updated = existing.filter((p) => p.id !== data.id);
    await writeProfilesFile(updated);
    return { profiles: updated };
  });

/**
 * The localStorage key the legacy client used, exported so sources.tsx can
 * clear it after a successful server-side migration without importing a magic
 * string constant from somewhere else.
 */
export const LEGACY_PROFILE_LOCALSTORAGE_KEY = "sentinel_credibility_profiles";
