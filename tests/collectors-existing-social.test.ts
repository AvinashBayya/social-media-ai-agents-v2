import { describe, expect, test } from "bun:test";
import { socialCollector } from "../src/utils/collectors/existing/social";
import type { CollectorRunOutcome } from "../src/utils/collectors/types";
import type { SocialRaw } from "../src/utils/collectors/existing/social";
import type { SocialPost } from "../src/utils/social";

/**
 * `fetchAuthorFeed`/`fetchTelegramChannel`/`fetchRedditSearch` are plain
 * `fetch()`-based functions (unlike the RSS path in dorks.ts), but Reddit's
 * path alone involves an OAuth token exchange plus retry/backoff logic
 * (see `tests/social-reddit.test.ts`) that is already covered by its own
 * dedicated test file. Re-deriving that here to exercise `execute()`'s
 * happy path would duplicate that coverage rather than add to it, so this
 * file tests `execute()`'s validation path and `normalize()` (the adapter's
 * own actual logic — the direct-lookup vs. search-result distinction)
 * directly against hand-built fixtures.
 */

function post(overrides: Partial<SocialPost> = {}): SocialPost {
  return {
    id: "post-1",
    platform: "bluesky",
    author: "alice.bsky.social",
    authorId: "did:plc:alice",
    text: "hello world",
    createdAt: "2026-08-14T00:00:00Z",
    url: "https://bsky.app/profile/alice.bsky.social/post/1",
    langs: [],
    links: [],
    ...overrides,
  } as SocialPost;
}

function completedOutcome(raw: SocialRaw): CollectorRunOutcome<SocialRaw> {
  return {
    execution: {
      status: "completed",
      startedAt: "2026-08-14T00:00:00.000Z",
      completedAt: "2026-08-14T00:00:01.000Z",
      durationMs: 1000,
      resultCount: raw.platforms.reduce((s, p) => s + p.posts.length, 0),
      error: null,
    },
    raw,
  };
}

describe("socialCollector.execute — validation path", () => {
  test("an empty target fails as invalid-target without attempting any platform", async () => {
    const outcome = await socialCollector.execute({ type: "username", value: "  " });
    expect(outcome.raw).toBeNull();
    expect(outcome.execution.status).toBe("failed");
    expect(outcome.execution.error?.reason).toBe("invalid-target");
  });

  test("execute() itself — not just a hand-built fixture — reports failed/raw:null when every platform genuinely fails, never a fabricated empty completion", async () => {
    // This collector used to always report `status: "completed"` from
    // execute() regardless of outcome, so a total outage (all three
    // platforms throwing) was indistinguishable from a real search that
    // came back empty. Unlike the fixture-based test below (which only
    // proves normalize() handles this shape correctly), this drives the
    // REAL execute() path with every underlying fetch failing, to prove the
    // fix actually engages rather than just being asserted against a shape
    // nothing produced.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("upstream error", { status: 500 })) as typeof fetch;
    try {
      const outcome = await socialCollector.execute({ type: "username", value: "nonexistent-handle" });
      expect(outcome.execution.status).toBe("failed");
      expect(outcome.raw).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("socialCollector.normalize", () => {
  test("a direct Bluesky lookup produces a social_account entity linked by USES_USERNAME", () => {
    const raw: SocialRaw = {
      targetValue: "alice.bsky.social",
      targetType: "username",
      platforms: [{ platform: "bluesky", posts: [post()] }],
      failures: [],
    };
    const result = socialCollector.normalize(completedOutcome(raw));

    const account = result.entities.find((e) => e.type === "social_account");
    expect(account?.value).toBe("did:plc:alice");
    expect(result.relationships).toHaveLength(1);
    expect(result.relationships[0]!.relationshipType).toBe("USES_USERNAME");
    expect(result.relationships[0]!.confidence.value).toBe(1);
  });

  test("Reddit search hits do NOT produce a social_account entity or a USES_USERNAME claim (§18: no identity from a name match)", () => {
    const raw: SocialRaw = {
      targetValue: "alice",
      targetType: "username",
      platforms: [
        {
          platform: "reddit",
          posts: [
            post({ platform: "reddit", author: "totally_unrelated_user", authorId: "t2_xyz" }),
          ],
        },
      ],
      failures: [],
    };
    const result = socialCollector.normalize(completedOutcome(raw));

    expect(result.entities.some((e) => e.type === "social_account")).toBe(false);
    expect(result.relationships).toEqual([]);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]!.confidence?.value).toBeNull();
    expect(result.warnings.some((w) => w.includes("keyword-search matches"))).toBe(true);
  });

  test("a partial run (one platform failed) is reported as a warning naming which platform and why", () => {
    const raw: SocialRaw = {
      targetValue: "alice",
      targetType: "username",
      platforms: [{ platform: "bluesky", posts: [post()] }],
      failures: [{ platform: "telegram", reason: "channel not found" }],
    };
    const result = socialCollector.normalize(completedOutcome(raw));
    expect(
      result.warnings.some((w) => w.includes("telegram") && w.includes("channel not found")),
    ).toBe(true);
  });

  test("all platforms failing produces raw:null and a combined error, not a fabricated empty success", async () => {
    // Simulated at the execute() contract level, since normalize()'s null-raw
    // guard is what actually enforces this — see shared.ts normalizeGuard.
    const outcome: CollectorRunOutcome<SocialRaw> = {
      execution: {
        status: "failed",
        startedAt: "2026-08-14T00:00:00.000Z",
        completedAt: "2026-08-14T00:00:01.000Z",
        durationMs: 500,
        resultCount: 0,
        error: {
          collector: "social",
          reason: "upstream-error",
          message: "All platforms failed: bluesky (...); telegram (...); reddit (...)",
        },
      },
      raw: null,
    };
    const result = socialCollector.normalize(outcome);
    expect(result.entities).toEqual([]);
    expect(result.errors[0]).toContain("All platforms failed");
  });
});
