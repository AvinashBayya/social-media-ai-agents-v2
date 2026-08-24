import { describe, expect, test } from "bun:test";
import { migrateWatchlists, type Watchlist } from "../src/utils/watchlist-store";

/**
 * The v1 → v2 migration exists because correcting DEFAULT_WATCHLISTS was NOT
 * enough.
 *
 * `getWatchlists()` writes the defaults to localStorage on the first ever load
 * and reads from storage on every load after, and it had no version key. So a
 * fresh browser picked up the corrected `riskScore: null` while every browser
 * that had already opened the app — including any demo machine — kept the seeded
 * 78 and 42 and went on rendering "78/100" and "42/100". The fabrication
 * survived precisely where it would be seen.
 */

function wl(over: Partial<Watchlist> = {}): Watchlist {
  return {
    id: "wl-9",
    name: "Analyst filter",
    description: "",
    filters: {
      keywords: [],
      organizations: [],
      people: [],
      countries: [],
      domains: [],
      emails: [],
      phones: [],
      hashtags: [],
      socialAccounts: [],
    },
    riskScore: null,
    createdAt: "2026-08-17T00:00:00.000Z",
    ...over,
  };
}

describe("migrateWatchlists", () => {
  test("nulls the seeded risk scores that v1 persisted", () => {
    const out = migrateWatchlists([
      wl({ id: "wl-1", name: "[SAMPLE] Global Conflict Pulse", riskScore: 78 }),
      wl({ id: "wl-2", name: "[SAMPLE] Enterprise Brand Protection", riskScore: 42 }),
    ]);
    expect(out.map((w) => w.riskScore)).toEqual([null, null]);
  });

  test("nulls ANY non-null score, not just the two seeded ids", () => {
    // Nothing in this system has ever computed a watchlist risk score, so every
    // non-null value in storage is by definition invented — whatever record it
    // is sitting on.
    const out = migrateWatchlists([wl({ id: "wl-custom", riskScore: 91 })]);
    expect(out[0].riskScore).toBeNull();
  });

  test("migrates rather than wipes — analyst watchlists survive intact", () => {
    const mine = wl({
      id: "wl-mine",
      name: "Airfield activity",
      description: "my own filter",
    });
    const out = migrateWatchlists([wl({ id: "wl-1", riskScore: 78 }), mine]);
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual(mine);
  });

  test("leaves an already-null record untouched by identity", () => {
    const clean = wl({ id: "wl-clean" });
    const out = migrateWatchlists([clean]);
    expect(out[0]).toBe(clean);
  });

  test("every other field is preserved", () => {
    const before = wl({
      id: "wl-1",
      riskScore: 78,
      name: "[SAMPLE] Global Conflict Pulse",
      createdAt: "2026-08-06T00:00:00.000Z",
    });
    const [after] = migrateWatchlists([before]);
    expect(after.name).toBe(before.name);
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.filters).toEqual(before.filters);
  });

  test("junk is dropped rather than producing a record with no id", () => {
    expect(migrateWatchlists([null, 7, {}, "x", { id: 5 }])).toEqual([]);
    expect(migrateWatchlists("not an array")).toEqual([]);
    expect(migrateWatchlists(undefined)).toEqual([]);
  });
});
