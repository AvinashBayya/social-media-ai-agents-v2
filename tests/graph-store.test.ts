import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// bun test runs with no DOM: `typeof window` is "undefined" and there is no
// global `localStorage`. graph-store.ts's every function starts with
// `if (typeof window === "undefined") return` for exactly that reason (it's
// also imported by server-rendered code paths). To exercise the actual
// localStorage read/write behavior — not just the no-DOM early return — this
// polyfills the minimum both `window` and `localStorage` need to exist.
class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

let graphStore: typeof import("../src/utils/graph-store");

beforeEach(async () => {
  (globalThis as Record<string, unknown>).window = globalThis;
  (globalThis as Record<string, unknown>).localStorage = new MemoryStorage();
  // Re-import per test so each gets a fresh module (no cross-test localStorage bleed via caching).
  graphStore = await import(`../src/utils/graph-store?t=${Date.now()}-${Math.random()}`);
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).localStorage;
});

const snapshot = () => ({
  investigationId: "INV-1",
  target: "example.com",
  savedAt: "2026-08-14T00:00:00.000Z",
  entities: [
    {
      id: "e1",
      type: "domain" as const,
      value: "example.com",
      displayName: "example.com",
      source: "dns",
      confidence: null,
      metadata: {},
    },
  ],
  relationships: [],
});

describe("graph-store round trip", () => {
  test("readGraphSnapshot returns null when nothing has been saved", () => {
    expect(graphStore.readGraphSnapshot()).toBeNull();
  });

  test("saveGraphSnapshot then readGraphSnapshot returns the same data", () => {
    const s = snapshot();
    graphStore.saveGraphSnapshot(s);
    expect(graphStore.readGraphSnapshot()).toEqual(s);
  });

  test("clearGraphSnapshot removes it — read returns null again", () => {
    graphStore.saveGraphSnapshot(snapshot());
    graphStore.clearGraphSnapshot();
    expect(graphStore.readGraphSnapshot()).toBeNull();
  });

  test("saving a second snapshot replaces the first — this is a hand-off, not a history", () => {
    graphStore.saveGraphSnapshot(snapshot());
    const second = { ...snapshot(), investigationId: "INV-2", target: "other.com" };
    graphStore.saveGraphSnapshot(second);
    expect(graphStore.readGraphSnapshot()).toEqual(second);
  });

  test("malformed JSON in the storage slot is treated as absent, not thrown", () => {
    localStorage.setItem("sentinel_graph_snapshot_version", "1");
    localStorage.setItem("sentinel_graph_snapshot", "{not valid json");
    expect(graphStore.readGraphSnapshot()).toBeNull();
  });

  test("a value missing entities/relationships arrays is rejected, never coerced", () => {
    localStorage.setItem("sentinel_graph_snapshot_version", "1");
    localStorage.setItem("sentinel_graph_snapshot", JSON.stringify({ investigationId: "x" }));
    expect(graphStore.readGraphSnapshot()).toBeNull();
  });

  test("a stale version tag is rejected even if the payload itself is well-formed", () => {
    localStorage.setItem("sentinel_graph_snapshot_version", "0");
    localStorage.setItem("sentinel_graph_snapshot", JSON.stringify(snapshot()));
    expect(graphStore.readGraphSnapshot()).toBeNull();
  });
});
