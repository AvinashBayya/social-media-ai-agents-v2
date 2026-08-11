import { describe, expect, test } from "bun:test";
import { calculateSocialVelocity } from "../src/utils/social-velocity";
import type { SocialPost } from "../src/utils/social";

describe("Social Velocity Engine", () => {
  test("returns empty summary when provided empty posts", () => {
    const summary = calculateSocialVelocity([]);
    expect(summary.totalPostsProcessed).toBe(0);
    expect(summary.topVelocityTerms).toHaveLength(0);
    expect(summary.spikesDetected).toBe(0);
  });

  test("computes term frequency and detects velocity spikes", () => {
    const now = Date.now();
    const posts: SocialPost[] = [
      {
        id: "p1",
        platform: "bluesky",
        author: "user1",
        authorId: "user1",
        text: "urgent missile strike alert in sector alpha",
        createdAt: new Date(now - 5 * 60 * 1000).toISOString(),
        url: "https://bsky.app/post/1",
        langs: ["en"],
        links: [],
      },
      {
        id: "p2",
        platform: "telegram",
        author: "chan1",
        authorId: "chan1",
        text: "urgent missile strike confirmed in sector alpha",
        createdAt: new Date(now - 10 * 60 * 1000).toISOString(),
        url: "https://t.me/chan1/2",
        langs: ["en"],
        links: [],
      },
      {
        id: "p3",
        platform: "mastodon",
        author: "user3@masto.social",
        authorId: "user3",
        text: "missile strike report updated",
        createdAt: new Date(now - 12 * 60 * 1000).toISOString(),
        url: "https://masto.social/@user3/3",
        langs: ["en"],
        links: [],
      },
    ];

    const summary = calculateSocialVelocity(posts, 60, 2);
    expect(summary.totalPostsProcessed).toBe(3);
    expect(summary.topVelocityTerms.length).toBeGreaterThan(0);
    const missileTerm = summary.topVelocityTerms.find((t) => t.term === "missile");
    expect(missileTerm).toBeDefined();
    expect(missileTerm?.count).toBeGreaterThanOrEqual(2);
  });
});
