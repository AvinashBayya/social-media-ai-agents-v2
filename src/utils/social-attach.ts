/**
 * Direct-lookup social posts → CollectorEvidence (2026-08-31, ported from the
 * teammate's fork).
 *
 * Projects a set of ALREADY-FETCHED posts from a DIRECT identifier lookup into
 * the common collector contract, by REUSING `socialCollector.normalize` — the
 * one place that conversion is defined. Nothing is re-implemented here; this is a
 * thin adapter that hands the collector a synthesised, already-completed run
 * outcome so `case-attach.ts` can attach the result to a case.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY DIRECT-ONLY, AND WHY THIS MATTERS.
 *
 * `socialCollector.normalize` treats a DIRECT lookup (the target IS the account
 * being read — a Bluesky author feed, a Telegram channel) as warranting a
 * `USES_USERNAME` identity edge, and a SEARCH (Reddit keyword) as evidence-only
 * with no identity claim.
 *
 * The Bluesky FIREHOSE is NOT a lookup: its posts are arbitrary accounts that
 * happened to match a keyword monitor, and projecting them through here would
 * fabricate a `USES_USERNAME` edge asserting the searched handle owns them. That
 * is why `/social`'s live stream is deliberately NOT routed through this helper —
 * it has no safe mapping to CollectorEvidence within the existing contract, and
 * is reported as such.
 */

import type { InvestigationResult } from "./collectors/result";
import { socialCollector } from "./collectors/existing/social";
import { finishExecution, startExecution } from "./collectors/existing/shared";
import type { SocialPost } from "./social";

/** Platforms the social collector treats as a direct identifier lookup. */
export type DirectSocialPlatform = "bluesky" | "telegram";

/**
 * Builds the InvestigationResult a direct-lookup post set would have produced,
 * with the collector's own semantics — target entity, one social_account entity,
 * a `USES_USERNAME` edge, and one evidence record per post carrying the post's
 * url, author and declared time.
 *
 * `collectedAt` on the evidence is the moment of THIS projection, matching the
 * collector, which stamps the run's completion time — not the posts' own
 * `createdAt`, which is preserved inside each record's `normalizedValue`.
 */
export function directSocialPostsToResult(
  platform: DirectSocialPlatform,
  handle: string,
  posts: readonly SocialPost[],
): InvestigationResult {
  const clock = startExecution();
  const execution = finishExecution(clock, "completed", posts.length);
  return socialCollector.normalize({
    execution,
    raw: {
      targetValue: handle,
      targetType: "username",
      platforms: [{ platform, posts: [...posts] }],
      failures: [],
    },
  });
}
