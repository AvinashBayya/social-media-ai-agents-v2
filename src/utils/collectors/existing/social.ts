/**
 * Social adapter — OSINT-INTEGRATION-PLAN.md §5 "Social" / §31 P1.
 *
 * Wraps three existing plain functions from `src/utils/social.ts` verbatim:
 * `fetchAuthorFeed` (Bluesky), `fetchTelegramChannel`, `fetchRedditSearch`.
 * Mastodon (`fetchMastodonTag`) is not included — it takes a hashtag, not a
 * username, and forcing a person/username target into a tag lookup would be
 * a guess this adapter has no basis for.
 *
 * Bluesky and Telegram are DIRECT identifier lookups: the target value IS
 * the actor/channel being read, so posts returned are genuinely authored by
 * it — `USES_USERNAME` is warranted. Reddit is a SEARCH: the target value is
 * a query, and the returned posts' authors are not the search target — per
 * plan §18 ("do not infer identity merely from a matching name"), those
 * become evidence only, with no entity/relationship claiming the searched
 * person owns any of those accounts.
 */

import {
  fetchAuthorFeed,
  fetchRedditSearch,
  fetchTelegramChannel,
  SocialUnavailableError,
} from "../../social";
import type { SocialPost } from "../../social";
import { CollectorError } from "../errors";
import type { CollectorEntity, CollectorEvidence, CollectorRelationship } from "../result";
import { InvestigationResultSchema, UNSCORED } from "../result";
import type {
  Collector,
  CollectorHealth,
  CollectorRunOutcome,
  CollectorTarget,
  TargetType,
} from "../types";
import { classifyError, finishExecution, normalizeGuard, startExecution } from "./shared";

type DirectPlatform = "bluesky" | "telegram";

interface PlatformOutcome {
  platform: DirectPlatform | "reddit";
  posts: SocialPost[];
}

interface PlatformFailure {
  platform: DirectPlatform | "reddit";
  reason: string;
}

export interface SocialRaw {
  targetValue: string;
  targetType: TargetType;
  platforms: PlatformOutcome[];
  failures: PlatformFailure[];
}

async function tryPlatform(
  platform: PlatformOutcome["platform"],
  fetcher: () => Promise<SocialPost[]>,
): Promise<PlatformOutcome | PlatformFailure> {
  try {
    return { platform, posts: await fetcher() };
  } catch (err) {
    const reason =
      err instanceof SocialUnavailableError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    return { platform, reason };
  }
}

export const socialCollector: Collector<SocialRaw> = {
  id: "social",
  name: "Social (Bluesky, Telegram, Reddit)",
  category: "social",
  supportedTargetTypes: ["username", "person"],
  requiresCredentials: false,
  isOptional: true,

  async execute(target: CollectorTarget): Promise<CollectorRunOutcome<SocialRaw>> {
    const clock = startExecution();
    const value = (target.value || "").trim();
    if (!value) {
      const err = new CollectorError(
        "social",
        "invalid-target",
        "A username or search term is required.",
      );
      return { execution: finishExecution(clock, "failed", 0, err.toInfo()), raw: null };
    }

    const results = await Promise.all([
      tryPlatform("bluesky", () => fetchAuthorFeed(value)),
      tryPlatform("telegram", () => fetchTelegramChannel(value)),
      tryPlatform("reddit", () => fetchRedditSearch(value)),
    ]);

    const platforms = results.filter((r): r is PlatformOutcome => "posts" in r);
    const failures = results.filter((r): r is PlatformFailure => "reason" in r);
    const resultCount = platforms.reduce((sum, p) => sum + p.posts.length, 0);

    if (platforms.length === 0) {
      const combined = failures.map((f) => `${f.platform} (${f.reason})`).join("; ");
      const classified = classifyError("social", new Error(`All platforms failed: ${combined}`));
      return { execution: finishExecution(clock, "failed", 0, classified.toInfo()), raw: null };
    }

    const status = failures.length > 0 ? "partial" : "completed";
    return {
      execution: finishExecution(clock, status, resultCount),
      raw: { targetValue: value, targetType: target.type, platforms, failures },
    };
  },

  normalize(outcome) {
    const guard = normalizeGuard(outcome);
    if (guard) return guard;
    const { targetValue, targetType, platforms, failures } = outcome.raw!;
    const collectedAt = outcome.execution.completedAt ?? outcome.execution.startedAt;

    const targetId = `social:target:${targetValue}`;
    const entities: CollectorEntity[] = [
      {
        id: targetId,
        type: targetType,
        value: targetValue,
        displayName: targetValue,
        source: "social",
        confidence: UNSCORED,
        metadata: {},
      },
    ];
    const relationships: CollectorRelationship[] = [];
    const evidence: CollectorEvidence[] = [];

    for (const { platform, posts } of platforms) {
      const direct = platform === "bluesky" || platform === "telegram";

      if (direct && posts.length > 0) {
        const accountId = `social:account:${platform}:${posts[0]!.authorId || posts[0]!.author}`;
        entities.push({
          id: accountId,
          type: "social_account",
          value: posts[0]!.authorId || posts[0]!.author,
          displayName: posts[0]!.author,
          source: "social",
          confidence: UNSCORED,
          metadata: { platform },
        });
        relationships.push({
          sourceEntity: targetId,
          relationshipType: "USES_USERNAME",
          targetEntity: accountId,
          confidence: {
            value: 1,
            reasons: [`direct ${platform} account lookup by handle/channel name — not inferred`],
          },
          source: "social",
        });
      }

      for (const post of posts) {
        evidence.push({
          source: platform,
          sourceUrl: post.url || null,
          collector: "social",
          collectedAt,
          rawValue: post,
          normalizedValue: {
            platform,
            author: post.author,
            authorId: post.authorId,
            text: post.text,
            createdAt: post.createdAt,
          },
          confidence: direct
            ? null
            : {
                value: null,
                reasons: [
                  "Reddit keyword search match — author identity not verified against the target",
                ],
              },
          metadata: {},
        });
      }
    }

    const warnings = failures.map((f) => `${f.platform}: ${f.reason}`);
    if (platforms.some((p) => p.platform === "reddit")) {
      warnings.push(
        "Reddit results are keyword-search matches, not confirmed accounts belonging to the target — no identity relationship was created for them.",
      );
    }

    return InvestigationResultSchema.parse({
      entities,
      relationships,
      evidence,
      warnings,
      errors: [],
      metadata: {
        platformsQueried: platforms.map((p) => p.platform),
        platformsFailed: failures.map((f) => f.platform),
      },
      execution: outcome.execution,
    });
  },

  async healthCheck(): Promise<CollectorHealth> {
    const checkedAt = new Date().toISOString();
    try {
      await fetchAuthorFeed("bsky.app", 1);
      return { state: "ready", detail: "Bluesky AppView answered a known-good actor", checkedAt };
    } catch (err) {
      return { state: "degraded", detail: classifyError("social", err).message, checkedAt };
    }
  },
};
